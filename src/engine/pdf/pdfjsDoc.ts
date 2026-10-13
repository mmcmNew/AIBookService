import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { loadPdfBuffer } from '../../storage/db';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

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

export async function getPdfBuffer(bookId: string): Promise<ArrayBuffer | undefined> {
  return loadPdfBuffer(bookId);
}
