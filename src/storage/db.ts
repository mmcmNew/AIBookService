import Dexie, { type Table } from 'dexie';
import { BookMetadata, Chapter, Footnote } from '../types/book';
import type { PdfPageRecord } from '../engine/pdf/types';

export interface StoredBook {
  id: string;
  metadata: BookMetadata;
  chapters: Chapter[];
  notes: Record<string, Footnote>;
  rawPdfBuffer?: ArrayBuffer;
}

/** Исходный PDF постраничной книги. Лежит отдельно от записи книги, чтобы обновление прогресса не переписывало сотни МБ. */
export interface StoredPdfFile {
  bookId: string;
  buffer: ArrayBuffer;
}

export interface CachedAudio {
  cacheKey: string; // `${bookId}_${chapterId}_${sentenceId}_${voiceId}`
  bookId: string;
  chapterId: string;
  sentenceId: number;
  voiceId: string;
  audioBlob: Blob;
  durationMs?: number;
  createdAt: number;
}

export class ReaderDatabase extends Dexie {
  books!: Table<StoredBook, string>;
  audioCache!: Table<CachedAudio, string>;
  pdfPages!: Table<PdfPageRecord, [string, number]>;
  pdfFiles!: Table<StoredPdfFile, string>;

  constructor() {
    super('AIBookReaderDatabase');
    this.version(1).stores({
      books: 'id, metadata.addedAt, metadata.lastReadAt',
      audioCache: 'cacheKey, bookId, [bookId+chapterId+sentenceId+voiceId], createdAt',
    });

    // v2: постраничное распознавание PDF. Данные существующих таблиц не меняются.
    this.version(2).stores({
      books: 'id, metadata.addedAt, metadata.lastReadAt',
      audioCache: 'cacheKey, bookId, [bookId+chapterId+sentenceId+voiceId], createdAt',
      pdfPages: '[bookId+page], bookId, [bookId+status]',
      pdfFiles: 'bookId',
    });

    // Если другая вкладка обновляет схему БД — закрываем соединение, чтобы не блокировать апгрейд
    this.on('versionchange', () => {
      this.close();
    });
  }
}

export const db = new ReaderDatabase();

/** Исходный PDF книги: сначала отдельная таблица (постраничные книги), затем запись книги (старый формат). */
export async function loadPdfBuffer(bookId: string): Promise<ArrayBuffer | undefined> {
  const file = await db.pdfFiles.get(bookId);
  if (file?.buffer && file.buffer.byteLength > 0) return file.buffer;
  const stored = await db.books.get(bookId);
  return stored?.rawPdfBuffer && stored.rawPdfBuffer.byteLength > 0 ? stored.rawPdfBuffer : undefined;
}
