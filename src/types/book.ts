export interface Footnote {
  id: string;
  title?: string;
  text: string;
}

export interface PdfBoundingRect {
  pageNumber: number; // 1-based номер страницы
  x: number;          // X в пунктах PDF
  y: number;          // Y в пунктах PDF
  width: number;      // Ширина в пунктах PDF
  height: number;     // Высота в пунктах PDF
}

export interface SentenceItem {
  id: number;
  rawText: string;        // Отображаемый текст с сохранением форматирования
  speechText: string;     // Текст для синтезатора (после словаря замен)
  paragraphIndex: number;
  pageNumber?: number;    // Страница в PDF (для навигации и скролла)
  pdfRects?: PdfBoundingRect[]; // Координаты для караоке-подсветки поверх оригинального PDF
}

export interface Chapter {
  id: string;
  title: string;
  level: number;
  contentHtml: string;
  sentences: SentenceItem[];
  pageNumber?: number;
  /** Только для постраничных PDF: границы главы и прогресс распознавания её страниц */
  startPage?: number;
  /** Абзац на startPage, с которого начинается глава (0 — с начала страницы) */
  startBlock?: number;
  endPage?: number;
  pagesTotal?: number;
  pagesDone?: number;
  /** Заглушка: страницы главы ещё не распознаны (текста нет) */
  stub?: boolean;
}

/** Движок распознавания страниц PDF (на уровне книги или перераспознавания диапазона). */
export type PdfEngine = 'auto' | 'text' | 'ocr' | 'pdfjs' | 'gemini';

export interface PagedOutlineItem {
  level: number;
  title: string;
  page: number;
}

/** Ручная граница главы (результат «Определить главы» или правка): страница + абзац на странице. */
export interface ManualChapterStart {
  page: number;
  block: number;
  title: string;
  level: number;
  /** Абзацы заголовка на странице, которые не читаются как текст */
  hideBlocks?: number[];
}

/** Метаданные постраничной PDF-книги (тексты страниц лежат в таблице Dexie pdfPages). */
export interface PagedMeta {
  version: 1;
  pageCount: number;
  engine: PdfEngine;
  outline: PagedOutlineItem[];
  bodyFontSize: number | null;
  hasTextLayer: boolean;
  corruptedLayerSuspected: boolean;
  recommendedMode: 'text' | 'ocr';
  pageSize?: { width: number; height: number };
  /** Счётчики для карточки в библиотеке (обновляются с задержкой) */
  pagesDone: number;
  pagesError: number;
  /** Автоматически чистить новые страницы (markdown, мусорные символы) */
  autoClean: boolean;
  chapterStarts?: ManualChapterStart[];
}

/** Оценка качества распознанного текста (см. engine/cleanup/quality.ts). Хранится в метаданных книги. */
export interface BookQuality {
  /** 0..100 */
  score: number;
  grade: 'good' | 'fair' | 'poor';
  checkedAt: number;
  /** Коды найденных проблем (QualityIssueCode) */
  issueCodes: string[];
  summary: string;
  recommendation?: string;
}

export interface BookMetadata {
  id: string;
  title: string;
  author: string;
  genre?: string[];
  lang?: string;
  coverUrl?: string;
  annotation?: string;
  fileSize?: number;
  fileName?: string;
  addedAt: number;
  lastReadAt?: number;
  lastChapterId?: string;
  lastSentenceId?: number;
  /** Постраничные PDF: страница последней позиции чтения */
  lastPage?: number;
  /** Постраничная PDF-книга (иначе — «legacy»: все главы лежат в записи книги) */
  paged?: PagedMeta;
  /** Каким режимом распознан PDF (для рекомендаций по качеству) */
  pdfMode?: 'pdfjs' | 'pymupdf' | 'gemini';
  /** Оценка качества текста; пересчитывается при импорте и сохранении правок */
  quality?: BookQuality;
}

export interface ParsedBook {
  metadata: BookMetadata;
  chapters: Chapter[];
  notes: Record<string, Footnote>; // ID сноски -> Сноска
  rawPdfBuffer?: ArrayBuffer;      // Исходный бинарный буфер оригинального PDF
}

export type BookData = ParsedBook;

