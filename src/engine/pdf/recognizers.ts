import type { PdfEngine } from '../../types/book';
import { closePdf, getInfo, getPages, isSidecarAvailable, openPdf, type PdfInfo, type PdfPageResult } from '../parsers/pdfSidecar';
import type { PageSource } from './types';

/**
 * Движки распознавания страниц. Единый интерфейс: recognize(pages) -> результаты в формате sidecar.
 *  auto | text | ocr — встроенный sidecar (Tauri): openPdf один раз -> handle, дальше только номера страниц;
 *  pdfjs             — текстовый слой pdf.js в рендерере (браузер и запасной вариант);
 *  gemini            — Gemini по странице с ключом пользователя (рендер страницы pdf.js -> JPEG).
 */

export interface RecognizedPage extends Omit<PdfPageResult, 'source'> {
  source: PageSource;
}

export interface RecognizerContext {
  bookId: string;
  fileName: string;
  /** Исходный PDF; вызывается лениво и только когда нужен */
  getBuffer: () => Promise<ArrayBuffer | undefined>;
  bodyFontSize: number | null;
  getGeminiKey: () => string | undefined;
}

export class RecognitionError extends Error {
  fatal: boolean;
  constructor(message: string, fatal = false) {
    super(message);
    this.name = 'RecognitionError';
    this.fatal = fatal;
  }
}

/** Движок, который реально можно запустить в текущей среде (sidecar только в Tauri). */
export function effectiveEngine(engine: PdfEngine): PdfEngine {
  if ((engine === 'auto' || engine === 'text' || engine === 'ocr') && !isSidecarAvailable()) return 'pdfjs';
  return engine;
}

export function isSidecarEngine(engine: PdfEngine): boolean {
  return engine === 'auto' || engine === 'text' || engine === 'ocr';
}

// --- handle sidecar: один на книгу, открывается лениво или передаётся после info -----------------------

const handles = new Map<string, Promise<string>>();

export function registerSidecarHandle(bookId: string, handle: string): void {
  handles.set(bookId, Promise.resolve(handle));
}

async function ensureHandle(ctx: RecognizerContext, forceReopen = false): Promise<string> {
  if (forceReopen) {
    const old = handles.get(ctx.bookId);
    handles.delete(ctx.bookId);
    if (old) void old.then((h) => closePdf(h)).catch(() => undefined);
  }
  let p = handles.get(ctx.bookId);
  if (!p) {
    p = (async () => {
      const buf = await ctx.getBuffer();
      if (!buf || buf.byteLength === 0) throw new RecognitionError('Исходный PDF не найден в локальной базе.', true);
      return openPdf(buf, ctx.fileName);
    })();
    handles.set(ctx.bookId, p);
    p.catch(() => {
      if (handles.get(ctx.bookId) === p) handles.delete(ctx.bookId);
    });
  }
  return p;
}

export async function closeSidecarHandle(bookId: string): Promise<void> {
  const p = handles.get(bookId);
  handles.delete(bookId);
  if (p) {
    try {
      await closePdf(await p);
    } catch {
      /* best-effort */
    }
  }
}

const LOST_HANDLE = /handle|PDF-handle|закрыт/i;

/** Страницы подряд -> диапазоны [from, to] для вызовов sidecar. */
export function toRanges(pages: number[]): Array<[number, number]> {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else out.push([p, p]);
  }
  return out;
}

const FATAL_SIDECAR = /Tesseract не найден|защищён паролем|слишком большой|Некорректный язык/i;

async function recognizeSidecar(engine: PdfEngine, pages: number[], ctx: RecognizerContext): Promise<RecognizedPage[]> {
  const mode = engine === 'ocr' ? 'ocr' : engine === 'text' ? 'text' : 'auto';
  const out: RecognizedPage[] = [];
  for (const [from, to] of toRanges(pages)) {
    let res: PdfPageResult[];
    try {
      const handle = await ensureHandle(ctx);
      res = await getPages(handle, from, to, { mode, bodyFontSize: ctx.bodyFontSize });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!LOST_HANDLE.test(msg)) throw new RecognitionError(msg, FATAL_SIDECAR.test(msg));
      // handle потерян (перезапуск sidecar-состояния): переоткрываем один раз из сохранённого файла
      try {
        const handle = await ensureHandle(ctx, true);
        res = await getPages(handle, from, to, { mode, bodyFontSize: ctx.bodyFontSize });
      } catch (e2) {
        const m2 = e2 instanceof Error ? e2.message : String(e2);
        throw new RecognitionError(m2, FATAL_SIDECAR.test(m2));
      }
    }
    for (const r of res) out.push({ ...r, source: r.source });
  }
  return out;
}

export async function recognizePages(engine: PdfEngine, pages: number[], ctx: RecognizerContext): Promise<RecognizedPage[]> {
  const eff = effectiveEngine(engine);
  if (isSidecarEngine(eff)) return recognizeSidecar(eff, pages, ctx);

  // pdf.js подгружается лениво: sidecar-путь и тесты не тянут его за собой
  const { loadPdfjsDocument } = await import('./pdfjsDoc');
  const doc = await loadPdfjsDocument(ctx.bookId, ctx.getBuffer);
  const out: RecognizedPage[] = [];
  const gem = eff === 'gemini' ? await import('./geminiPages') : null;
  const pj = eff === 'gemini' ? null : await import('./pdfjsPages');
  for (const p of [...pages].sort((a, b) => a - b)) {
    if (gem) {
      try {
        const r = await gem.geminiRecognizePage(doc, p, { apiKey: ctx.getGeminiKey() ?? '' });
        out.push({ ...r, source: 'gemini' });
      } catch (e) {
        if (e instanceof gem.GeminiPageError) throw new RecognitionError(e.message, e.fatal);
        throw e;
      }
    } else {
      const r = await (pj as typeof import('./pdfjsPages')).pdfjsRecognizePage(doc, p, ctx.bodyFontSize);
      out.push({ ...r, source: 'text' });
    }
  }
  return out;
}

// --- info -----------------------------------------------------------------------------------------

export interface OpenedPdf {
  info: PdfInfo;
  engine: PdfEngine;
}

/** Открывает PDF выбранным движком и возвращает info; sidecar-handle запоминается для последующих вызовов. */
export async function openAndInspect(
  bookId: string,
  bytes: ArrayBuffer,
  fileName: string,
  engine: PdfEngine,
): Promise<OpenedPdf> {
  const eff = effectiveEngine(engine);
  if (isSidecarEngine(eff)) {
    const handle = await openPdf(bytes, fileName);
    try {
      const info = await getInfo(handle);
      registerSidecarHandle(bookId, handle);
      return { info, engine: eff };
    } catch (e) {
      await closePdf(handle);
      throw e;
    }
  }
  const { loadPdfjsDocument } = await import('./pdfjsDoc');
  const { pdfjsGetInfo } = await import('./pdfjsPages');
  const doc = await loadPdfjsDocument(bookId, async () => bytes);
  const info = await pdfjsGetInfo(doc, fileName);
  return { info, engine: eff };
}
