import type { BookData, Chapter, SentenceItem } from '../../types/book';

export type TextStepResult =
  | { kind: 'sentence'; chapterIndex: number; sentenceIndex: number; sentence: SentenceItem; chapterId: string }
  | { kind: 'chapter'; chapterIndex: number; chapterId: string }
  | { kind: 'end-of-chapter' }
  | { kind: 'end-of-book' };

export interface TextStepOptions {
  book: BookData | null;
  currentChapterIndex: number;
  currentSentenceIndex: number;
  autoAdvanceChapter: boolean;
}

/**
 * Определяет следующую фразу для FB2 / EPUB / TXT книг:
 * следующее предложение в текущей главе, переход к следующей главе или завершение книги.
 */
export function nextTextStep(options: TextStepOptions): TextStepResult {
  const { book, currentChapterIndex, currentSentenceIndex, autoAdvanceChapter } = options;
  if (!book || !book.chapters || !book.chapters[currentChapterIndex]) {
    return { kind: 'end-of-book' };
  }

  const chapter = book.chapters[currentChapterIndex];
  if (currentSentenceIndex + 1 < chapter.sentences.length) {
    return {
      kind: 'sentence',
      chapterIndex: currentChapterIndex,
      sentenceIndex: currentSentenceIndex + 1,
      sentence: chapter.sentences[currentSentenceIndex + 1],
      chapterId: chapter.id,
    };
  }

  const nextChapterIdx = book.chapters.findIndex(
    (c, idx) => idx > currentChapterIndex && c.sentences && c.sentences.length > 0
  );

  if (!autoAdvanceChapter) {
    // «Конец книги» важнее: если глав с предложениями дальше нет, это конец книги, а не только главы
    return nextChapterIdx !== -1 ? { kind: 'end-of-chapter' } : { kind: 'end-of-book' };
  }

  if (nextChapterIdx !== -1) {
    return {
      kind: 'chapter',
      chapterIndex: nextChapterIdx,
      chapterId: book.chapters[nextChapterIdx].id,
    };
  }

  return { kind: 'end-of-book' };
}
