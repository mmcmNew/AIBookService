import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfBlock, PdfBlockType, PdfPageResult } from '../parsers/pdfSidecar';
import { finalizePageBlocks } from './pageClean';

/**
 * Постраничное распознавание через Gemini с ключом пользователя: страница рендерится в JPEG (pdf.js),
 * отправляется напрямую в Gemini API, ответ — JSON-блоки в порядке чтения. Серверный /api/pdf/parse-gemini
 * не используется (он принимает книгу целиком и списывает фиксированную стоимость).
 */

export const GEMINI_PAGE_MODEL = 'gemini-2.5-flash';
const ENDPOINT = (model: string) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
const MAX_SIDE_PX = 1800;

export const GEMINI_PAGE_PROMPT =
  'Ты — движок оцифровки книг. На изображении одна страница книги. Распознай текст страницы и верни СТРОГО JSON без markdown-обрамления:\n' +
  '{"blocks":[{"type":"heading|paragraph|list|caption|header|footer|pagenum","text":"...","level":1}]}\n' +
  'Правила: блоки в порядке чтения (учитывай колонки); один абзац — один блок; ' +
  'type=heading для заголовков глав и разделов (level 1 — название главы/части, 2 — раздел, 3 — подзаголовок); ' +
  'колонтитулы (бегущие строки) — header или footer, номер страницы — pagenum, подписи к рисункам — caption, пункты списков — list; ' +
  'склей слова, разорванные переносом внутри страницы; не добавляй markdown и свои комментарии, не пересказывай и не переводи; ' +
  'сохрани язык оригинала. Если текста на странице нет — верни {"blocks":[]}.';

export class GeminiPageError extends Error {
  fatal: boolean;
  constructor(message: string, fatal = false) {
    super(message);
    this.name = 'GeminiPageError';
    this.fatal = fatal;
  }
}

const TYPES = new Set<PdfBlockType>(['heading', 'paragraph', 'list', 'caption', 'header', 'footer', 'pagenum']);

/** Разбор ответа модели: допускает ```json-обрамление и лишний текст вокруг JSON. */
export function parseGeminiBlocks(raw: string): PdfBlock[] {
  let t = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1];
  let data: unknown;
  try {
    data = JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a < 0 || b <= a) throw new GeminiPageError('Gemini вернул ответ не в формате JSON');
    try {
      data = JSON.parse(t.slice(a, b + 1));
    } catch {
      throw new GeminiPageError('Gemini вернул некорректный JSON');
    }
  }
  const arr = Array.isArray(data) ? data : (data as { blocks?: unknown })?.blocks;
  if (!Array.isArray(arr)) throw new GeminiPageError('В ответе Gemini нет списка блоков');
  const out: PdfBlock[] = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const o = it as { type?: unknown; text?: unknown; level?: unknown };
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!text) continue;
    const type = (typeof o.type === 'string' && TYPES.has(o.type as PdfBlockType) ? o.type : 'paragraph') as PdfBlockType;
    const block: PdfBlock = { type, text };
    if (type === 'heading') {
      const lvl = Number(o.level);
      block.level = (lvl === 1 || lvl === 2 || lvl === 3 ? lvl : 2) as 1 | 2 | 3;
    }
    out.push(block);
  }
  return out;
}

export function explainGeminiHttp(status: number, body: unknown): GeminiPageError {
  const msg: string = (body as { error?: { message?: string } })?.error?.message ?? '';
  if (status === 400 && /API key/i.test(msg)) return new GeminiPageError('Ключ Gemini API недействителен. Проверьте его в настройках.', true);
  if (status === 401 || status === 403) return new GeminiPageError(`Доступ к Gemini запрещён (HTTP ${status}). Проверьте ключ и его права. ${msg}`.trim(), true);
  if (status === 429) return new GeminiPageError('Превышен лимит запросов Gemini (429). Повторим позже.');
  if (status >= 500) return new GeminiPageError(`Сервис Gemini временно недоступен (HTTP ${status}).`);
  return new GeminiPageError(`Ошибка Gemini (HTTP ${status}). ${msg}`.trim());
}

async function renderJpeg(doc: PDFDocumentProxy, pageNo: number): Promise<{ base64: string; width: number; height: number }> {
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2.5, MAX_SIDE_PX / Math.max(base.width, base.height));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new GeminiPageError('Не удалось создать холст для рендера страницы', true);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // intent: 'print' — рендер не зависит от requestAnimationFrame и работает, даже если вкладка/окно скрыты
  await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
  const url = canvas.toDataURL('image/jpeg', 0.85);
  canvas.width = 0;
  canvas.height = 0;
  page.cleanup();
  return { base64: url.split(',')[1] ?? '', width: base.width, height: base.height };
}

export interface GeminiPageOptions {
  apiKey: string;
  model?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function geminiRecognizePage(doc: PDFDocumentProxy, pageNo: number, opts: GeminiPageOptions): Promise<PdfPageResult> {
  if (!opts.apiKey) throw new GeminiPageError('Не задан ключ Gemini API (Настройки → Ключи API).', true);
  const img = await renderJpeg(doc, pageNo);
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(ENDPOINT(opts.model ?? GEMINI_PAGE_MODEL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: GEMINI_PAGE_PROMPT }, { inlineData: { mimeType: 'image/jpeg', data: img.base64 } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw e;
    throw new GeminiPageError('Нет связи с Gemini API. Проверьте подключение к интернету.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw explainGeminiHttp(res.status, body);
  const text: string | undefined = body?.candidates?.[0]?.content?.parts?.find((p: { text?: string }) => typeof p.text === 'string')?.text;
  if (!text) {
    const reason = body?.promptFeedback?.blockReason ?? body?.candidates?.[0]?.finishReason;
    throw new GeminiPageError(`Gemini не вернул текст страницы${reason ? ` (${reason})` : ''}`);
  }
  const blocks = parseGeminiBlocks(text);
  const flat = finalizePageBlocks(blocks);
  return {
    page: pageNo,
    source: 'text', // источник переопределяется вызывающим кодом на 'gemini'
    width: Math.round(img.width * 10) / 10,
    height: Math.round(img.height * 10) / 10,
    blocks,
    text: flat,
    warnings: blocks.length === 0 ? ['gemini-empty-page'] : [],
  };
}
