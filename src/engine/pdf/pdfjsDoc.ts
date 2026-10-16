import * as pdfjsLib from 'pdfjs-dist';
import * as pdfWorkerModule from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';

const pdfWorker = (pdfWorkerModule as { default?: string }).default ?? '';
if (pdfWorker) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
}

/**
 * Единый кэш документа pdf.js на открытую книгу: им пользуются и вид «Страницы» (канвас), и распознавание
 * страниц в режимах pdfjs / Gemini, поэтому большой PDF держится в памяти один раз.
 */
let cached: { bookId: string; promise: Promise<PDFDocumentProxy> } | null = null;

export function loadPdfjsDocument(bookId: string, getBuffer: () => Promise<ArrayBuffer | undefined>): Promise<PDFDocumentProxy> {
  if (cached && cached.bookId === bookId) return cached.promise;
  releasePdfjsDocument();
  const promise = (async () => {
    const buffer = await getBuffer();
    if (!buffer || buffer.byteLength === 0) {
      throw new Error('Файл оригинального PDF не найден в локальной базе. Попробуйте режим «Текст книги».');
    }
    // Копия: worker pdf.js «отсоединяет» переданный ArrayBuffer
    const task = pdfjsLib.getDocument({
      data: new Uint8Array(buffer.slice(0)),
      cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/cmaps/',
      cMapPacked: true,
      isEvalSupported: false,
    });
    return task.promise;
  })();
  const entry = { bookId, promise };
  cached = entry;
  // Неудачная загрузка не должна залипать в кэше
  promise.catch(() => {
    if (cached === entry) cached = null;
  });
  return promise;
}

export function releasePdfjsDocument(bookId?: string): void {
  if (!cached || (bookId && cached.bookId !== bookId)) return;
  const old = cached.promise;
  cached = null;
  void old.then((d) => d.destroy()).catch(() => undefined);
}

export interface PdfOutlineEntry {
  title: string;
  level: number;
  page?: number;
}

/** Оглавление (outline) PDF с номерами страниц; пустой массив, если оглавления нет или его не удалось разобрать. */
export async function loadOutline(pdfDoc: any): Promise<PdfOutlineEntry[]> {
  try {
    const outline = await pdfDoc.getOutline();
    if (!outline || outline.length === 0) return [];
    const result: PdfOutlineEntry[] = [];
    const visit = async (items: any[], level: number) => {
      for (const item of items) {
        let page: number | undefined;
        try {
          let dest = item.dest;
          if (typeof dest === 'string') dest = await pdfDoc.getDestination(dest);
          if (Array.isArray(dest) && dest[0] !== undefined) {
            const ref = dest[0];
            page = typeof ref === 'object' ? (await pdfDoc.getPageIndex(ref)) + 1 : Number(ref) + 1;
          }
        } catch {
          page = undefined;
        }
        const t = typeof item.title === 'string' ? item.title.trim() : '';
        if (t) result.push({ title: t, level, page });
        if (level < 2 && item.items?.length) await visit(item.items, level + 1);
      }
    };
    await visit(outline, 1);
    return result;
  } catch (e) {
    console.warn('[PDF Parser] Не удалось прочитать оглавление PDF:', e);
    return [];
  }
}

/**
 * Рендерит первую страницу книги на холст и возвращает data-url обложки
 */
export async function extractCover(page: any): Promise<string | undefined> {
  try {
    const viewport = page.getViewport({ scale: 0.6 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch (err) {
    console.warn('[PDF Parser] ⚠️ Предупреждение: не удалось отрендерить обложку:', err);
    return undefined;
  }
}
