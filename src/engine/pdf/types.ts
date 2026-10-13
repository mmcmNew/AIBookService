import type { PdfBlock } from '../parsers/pdfSidecar';
import type { PdfEngine } from '../../types/book';

export type { PdfEngine };

export type PageState = 'pending' | 'running' | 'done' | 'error';
export type PageSource = 'text' | 'ocr' | 'gemini' | 'manual';

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

export function emptyRecord(bookId: string, page: number): PdfPageRecord {
  return { bookId, page, status: 'pending', blocks: [], warnings: [], editedByUser: false, updatedAt: Date.now() };
}
