/**
 * Обёртка над постраничным PDF-sidecar (Tauri-команды pdf_open / pdf_info / pdf_pages / pdf_close).
 *
 * КОНТРАКТ JSON (stdout sidecar-а `pdf_processor`, UTF-8):
 *
 *  info  -> PdfInfo:
 *    { pageCount, metadata{title,author,fileName}, coverUrl (jpeg data URL, 110 dpi, может быть null),
 *      outline[{level,title,page}] (page 1-based), pageSize{width,height} (pt, 1-я страница),
 *      hasTextLayer (по выборке до 8 страниц), corruptedLayerSuspected (псевдокириллица / сдвинутая
 *      кириллица / U+FFFD), bodyFontSize (медиана кегля по выборке ~10 стр., null для сканов),
 *      recommendedMode: 'text' | 'ocr' }
 *
 *  pages -> { pages: PdfPageResult[] }, страницы 1-based, диапазон включительно, <= 20 за вызов:
 *    PdfPageResult { page, source:'text'|'ocr', width, height (pt), blocks: PdfBlock[],
 *                    text (плоский текст тела страницы: без header/footer/pagenum, блоки через '\n\n'),
 *                    warnings: string[] }
 *    PdfBlock { type:'heading'|'paragraph'|'list'|'caption'|'header'|'footer'|'pagenum',
 *               text (без markdown; дефисные переносы внутри страницы уже склеены),
 *               level? (1..3, только heading; 1 — крупнейший), fontSize? (pt), bbox? [x0,y0,x1,y1] (pt),
 *               bold? (true — блок целиком жирный),
 *               continuesParagraph? (ТОЛЬКО первый блок тела страницы: начинается со строчной буквы —
 *                 вероятно, продолжение последнего абзаца предыдущей страницы),
 *               endsWithHyphen? (ТОЛЬКО последний блок тела: оборван переносом; дефис уже убран —
 *                 следующий блок склеивать БЕЗ пробела),
 *               endsWithOpenSentence? (ТОЛЬКО последний блок тела: не заканчивается знаком конца фразы) }
 *    Блоки header/footer/pagenum НЕ удаляются — решает потребитель.
 *    warnings: 'ocr-fallback:<причина>', 'ocr-unavailable', 'ocr-failed: ...', 'shifted-cyrillic:<N>',
 *              'replacement-chars', 'text-extract-failed: ...'.
 *
 *  Режимы pages: 'auto' (по умолчанию: текстовый слой, а для пустой/битой страницы — Tesseract),
 *  'ocr' (принудительно; без Tesseract — ошибка), 'text' (только текстовый слой).
 *
 * Файл НЕ передаётся по IPC повторно: openPdf(bytes) один раз кладёт его во временный файл и
 * возвращает opaque-handle; closePdf(handle) удаляет файл (при выходе приложения — тоже).
 */

export interface PdfOutlineItem {
  level: number;
  title: string;
  page: number;
}

export interface PdfInfo {
  pageCount: number;
  metadata: { title: string; author: string; fileName: string };
  coverUrl: string | null;
  outline: PdfOutlineItem[];
  pageSize: { width: number; height: number };
  hasTextLayer: boolean;
  corruptedLayerSuspected: boolean;
  bodyFontSize: number | null;
  recommendedMode: 'text' | 'ocr';
}

export type PdfBlockType =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'caption'
  | 'header'
  | 'footer'
  | 'pagenum';

export interface PdfBlock {
  type: PdfBlockType;
  text: string;
  level?: 1 | 2 | 3;
  fontSize?: number;
  bbox?: [number, number, number, number];
  bold?: boolean;
  continuesParagraph?: boolean;
  endsWithHyphen?: boolean;
  endsWithOpenSentence?: boolean;
}

export interface PdfPageResult {
  page: number;
  source: 'text' | 'ocr';
  width: number;
  height: number;
  blocks: PdfBlock[];
  text: string;
  warnings: string[];
}

export type PdfPagesMode = 'auto' | 'ocr' | 'text';

export interface PdfPagesOptions {
  mode?: PdfPagesMode;
  /** Языки Tesseract, по умолчанию 'rus+eng'. */
  lang?: string;
  /** PdfInfo.bodyFontSize — чтобы sidecar не пересчитывал медиану кегля на каждый вызов. */
  bodyFontSize?: number | null;
}

/** Максимум страниц за один вызов getPages (лимит на стороне Rust). */
export const PDF_MAX_PAGES_PER_CALL = 20;

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

/** true, если приложение запущено в Tauri (sidecar доступен). Наличие самого exe проверяется при openPdf/getInfo. */
export function isSidecarAvailable(): boolean {
  return isTauriRuntime();
}

async function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) throw new Error('PDF sidecar доступен только в десктопном приложении');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** Сохраняет PDF во временный файл и возвращает handle. */
export async function openPdf(bytes: ArrayBuffer | Uint8Array, fileName?: string): Promise<string> {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return invokeCmd<string>('pdf_open', { fileBytes: Array.from(u8), fileName: fileName ?? null });
}

export async function getInfo(handle: string): Promise<PdfInfo> {
  const json = await invokeCmd<string>('pdf_info', { handle });
  return JSON.parse(json) as PdfInfo;
}

/** Страницы 1-based, включительно; диапазон длиннее PDF_MAX_PAGES_PER_CALL автоматически режется на запросы. */
export async function getPages(
  handle: string,
  from: number,
  to: number,
  opts: PdfPagesOptions = {},
): Promise<PdfPageResult[]> {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    throw new Error(`Некорректный диапазон страниц: ${from}-${to}`);
  }
  const out: PdfPageResult[] = [];
  for (let s = from; s <= to; s += PDF_MAX_PAGES_PER_CALL) {
    const e = Math.min(to, s + PDF_MAX_PAGES_PER_CALL - 1);
    const json = await invokeCmd<string>('pdf_pages', {
      handle,
      from: s,
      to: e,
      mode: opts.mode ?? 'auto',
      lang: opts.lang ?? 'rus+eng',
      bodySize: opts.bodyFontSize ?? null,
    });
    const parsed = JSON.parse(json) as { pages: PdfPageResult[] };
    out.push(...parsed.pages);
  }
  return out;
}

export async function closePdf(handle: string): Promise<void> {
  try {
    await invokeCmd<void>('pdf_close', { handle });
  } catch {
    /* закрытие best-effort */
  }
}
