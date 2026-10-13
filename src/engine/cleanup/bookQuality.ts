import type { BookQuality, ParsedBook } from '../../types/book';
import { assessTextQuality } from './quality';
import type { QualityReport } from './types';

/** Полный отчёт о качестве книги (для редактора). */
export function assessBook(book: Pick<ParsedBook, 'metadata' | 'chapters' | 'rawPdfBuffer'>): QualityReport {
  const isPdf = Boolean(book.rawPdfBuffer) || /\.pdf$/i.test(book.metadata.fileName ?? '');
  return assessTextQuality(book.chapters, book.metadata.lang || 'ru', { isPdf, pdfMode: book.metadata.pdfMode });
}

/** Краткая оценка для хранения в записи книги. */
export function computeBookQuality(book: Pick<ParsedBook, 'metadata' | 'chapters' | 'rawPdfBuffer'>): BookQuality {
  const r = assessBook(book);
  return {
    score: r.score,
    grade: r.grade,
    checkedAt: Date.now(),
    issueCodes: r.issues.map((i) => i.code),
    summary: r.summary,
    recommendation: r.recommendation,
  };
}

/** Нужно ли предложить пользователю исправление (низкий балл или тяжёлые дефекты кодировки). */
export function needsAttention(q: BookQuality | undefined | null): boolean {
  if (!q) return false;
  return q.score < 60 || q.issueCodes.includes('SHIFTED_CYRILLIC') || q.issueCodes.includes('EMPTY_BOOK') || q.issueCodes.includes('SINGLE_CHAPTER');
}
