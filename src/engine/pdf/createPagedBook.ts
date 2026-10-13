import type { ParsedBook, PdfEngine } from '../../types/book';
import { ScannedPdfError } from '../parsers/pdfParser';
import { isSidecarAvailable } from '../parsers/pdfSidecar';
import { closeSidecarHandle, openAndInspect } from './recognizers';
import { releasePdfjsDocument } from './pdfjsDoc';

/**
 * Создание постраничной PDF-книги: открывает PDF движком (sidecar: pdf_open + pdf_info, pdf.js: getDocument),
 * читает info (число страниц, оглавление, обложка, рекомендуемый режим) и возвращает книгу БЕЗ глав и текста —
 * страницы распознаются позже, по требованию и в фоне (engine/pdf/pagedSession.ts). Занимает секунды даже для 1000 страниц.
 */

/** Какой режим записать в metadata.pdfMode (для рекомендаций по качеству). */
export function legacyModeFor(engine: PdfEngine): 'pdfjs' | 'pymupdf' | 'gemini' {
  return engine === 'pdfjs' ? 'pdfjs' : engine === 'gemini' ? 'gemini' : 'pymupdf';
}

export function newPdfBookId(): string {
  return `pdf_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

export async function createPagedPdfBook(file: File, requested: PdfEngine): Promise<ParsedBook> {
  const buffer = await file.arrayBuffer();
  const bookId = newPdfBookId();
  let opened;
  try {
    opened = await openAndInspect(bookId, buffer, file.name, requested);
  } catch (e) {
    releasePdfjsDocument(bookId);
    await closeSidecarHandle(bookId);
    const msg = e instanceof Error && e.message ? e.message : String(e);
    throw new Error(`Не удалось открыть PDF: ${msg}`);
  }
  const { info, engine } = opened;

  // Текстовый слой pdf.js бесполезен для скана/битого слоя: предлагаем OCR (как раньше — через ScannedPdfError)
  if (engine === 'pdfjs' && (!info.hasTextLayer || info.corruptedLayerSuspected)) {
    releasePdfjsDocument(bookId);
    const corrupted = info.corruptedLayerSuspected;
    throw new ScannedPdfError(
      corrupted
        ? 'В этом PDF обнаружен повреждённый текстовый слой (псевдокириллица или сдвинутая кириллица старого OCR). Для качественного чтения нужно оптическое распознавание: встроенный OCR (Tesseract) или AI (Gemini).'
        : `PDF-файл не содержит текстового слоя. Скорее всего это скан. Рекомендуется оптическое распознавание: ${isSidecarAvailable() ? 'встроенный OCR или ' : ''}AI (Gemini).`,
      info.pageCount,
      0,
      corrupted,
    );
  }

  return {
    metadata: {
      id: bookId,
      title: info.metadata.title || file.name.replace(/\.[^/.]+$/, ''),
      author: info.metadata.author || 'Не указан',
      coverUrl: info.coverUrl ?? undefined,
      fileName: file.name,
      fileSize: file.size,
      lang: 'ru',
      addedAt: Date.now(),
      lastPage: 1,
      pdfMode: legacyModeFor(engine),
      paged: {
        version: 1,
        pageCount: info.pageCount,
        engine,
        outline: info.outline ?? [],
        bodyFontSize: info.bodyFontSize,
        hasTextLayer: info.hasTextLayer,
        corruptedLayerSuspected: info.corruptedLayerSuspected,
        recommendedMode: info.recommendedMode,
        pageSize: info.pageSize,
        pagesDone: 0,
        pagesError: 0,
        autoClean: true,
      },
    },
    chapters: [],
    notes: {},
    rawPdfBuffer: buffer,
  };
}
