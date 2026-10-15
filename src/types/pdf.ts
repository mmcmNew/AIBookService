import type { Chapter, ManualChapterStart, PagedOutlineItem, PdfEngine, SentenceItem } from './book';

export type { PdfEngine };

export type PageState = 'pending' | 'running' | 'done' | 'error';
export type PageSource = 'text' | 'ocr' | 'gemini' | 'manual';

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
  /** Образец сырого текста первых страниц для проверки качества в Домене */
  textSample?: string;
}

export interface PdfPageResult {
  page: number;
  source: 'text' | 'ocr' | 'gemini';
  width: number;
  height: number;
  blocks: PdfBlock[];
  text: string;
  warnings: string[];
}

export type PdfPagesMode = 'auto' | 'ocr' | 'text';

export interface PdfPagesOptions {
  mode?: PdfPagesMode;
  lang?: string;
  bodyFontSize?: number | null;
}

/** Запись таблицы Dexie pdfPages: ключ [bookId+page]. */
export interface PdfPageRecord {
  bookId: string;
  /** 1-based */
  page: number;
  status: PageState;
  source?: PageSource;
  blocks: PdfBlock[];
  /** Размер страницы, pt (нужен для пересчёта bbox в координаты PDF) */
  width?: number;
  height?: number;
  warnings: string[];
  /** Страница правилась вручную: перераспознавание не затирает её без подтверждения */
  editedByUser: boolean;
  /** Пользователь пропустил страницу, на которой не удалось распознать текст */
  skipped?: boolean;
  /** Движок, которым нужно распознать страницу (перераспознавание диапазона другим режимом) */
  engine?: PdfEngine;
  error?: string;
  attempts?: number;
  updatedAt: number;
}

export interface PagePart {
  page: number;
  bbox?: [number, number, number, number];
  fontSize?: number;
  /** Высота страницы, pt — для пересчёта bbox (начало координат сверху) в координаты PDF */
  pageHeight?: number;
  /** Диапазон символов этой части внутри текста абзаца */
  start: number;
  end: number;
}

export type ParagraphKind = 'paragraph' | 'heading' | 'list' | 'caption';

export interface ComposedParagraph {
  /** Страница-владелец */
  page: number;
  /** Индекс блока в записи страницы (стабилен, нужен для id предложений) */
  block: number;
  type: ParagraphKind;
  level?: 1 | 2 | 3;
  text: string;
  parts: PagePart[];
}

export interface ComposedPage {
  page: number;
  /** done — есть данные; missing — страница не распознана (ожидает/идёт/ошибка) */
  state: 'done' | 'missing';
  skipped: boolean;
  paragraphs: ComposedParagraph[];
  hidden: number;
}

export type ChapterSource = 'manual' | 'outline' | 'headings' | 'ranges';

export interface ChapterSpec {
  id: string;
  title: string;
  level: number;
  startPage: number;
  /** Первый абзац (индекс блока) страницы startPage, входящий в главу */
  startBlock: number;
  source: ChapterSource;
  /** Абзацы заголовка (page:block), которые не читаются как текст — название озвучивается отдельно */
  hide: Array<[number, number]>;
}

export interface ComposedBook {
  pageCount: number;
  pages: ComposedPage[];
  specs: ChapterSpec[];
  chapters: Chapter[];
  /** Все читаемые предложения в порядке чтения (id по возрастанию) */
  order: SentenceItem[];
  indexById: Map<number, number>;
  chapterOfSentence: Map<number, number>;
  /** Предложения по странице-владельцу */
  sentencesByPage: Map<number, SentenceItem[]>;
  /** Абзацы, не читаемые как текст (заголовок главы): ключ `${page}:${block}` */
  hidden: Set<string>;
  /** Главы, начинающиеся на странице */
  specsByPage: Map<number, ChapterSpec[]>;
  /** Число распознанных страниц и число страниц с текстом */
  doneCount: number;
}

export interface RerecognizeRequest {
  from: number;
  to: number;
  engine: PdfEngine;
  /** Перезаписать и страницы с ручными правками (требует подтверждения в UI) */
  overwriteEdited: boolean;
}
