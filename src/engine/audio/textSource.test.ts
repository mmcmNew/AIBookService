import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextTextStep } from './textSource';
import type { BookData, Chapter, SentenceItem } from '../../types/book';

function makeSentence(id: number, text = `Sentence ${id}`): SentenceItem {
  return { id, rawText: text, speechText: text, paragraphIndex: 0 };
}

function makeChapter(id: string, title: string, sentences: SentenceItem[]): Chapter {
  return { id, title, level: 1, contentHtml: '', sentences };
}

function makeBook(chapters: Chapter[]): BookData {
  return {
    metadata: { id: 'book1', title: 'Test Book', author: 'Author', addedAt: 0 },
    chapters,
    notes: {},
  };
}

test('nextTextStep: следующее предложение в текущей главе', () => {
  const book = makeBook([
    makeChapter('c1', 'Chapter 1', [makeSentence(1), makeSentence(2), makeSentence(3)]),
    makeChapter('c2', 'Chapter 2', [makeSentence(4), makeSentence(5)]),
  ]);

  const res = nextTextStep({
    book,
    currentChapterIndex: 0,
    currentSentenceIndex: 0,
    autoAdvanceChapter: true,
  });

  assert.equal(res.kind, 'sentence');
  if (res.kind === 'sentence') {
    assert.equal(res.chapterIndex, 0);
    assert.equal(res.sentenceIndex, 1);
    assert.equal(res.sentence.id, 2);
    assert.equal(res.chapterId, 'c1');
  }
});

test('nextTextStep: переход к следующей главе при autoAdvanceChapter = true', () => {
  const book = makeBook([
    makeChapter('c1', 'Chapter 1', [makeSentence(1)]),
    makeChapter('c2', 'Chapter 2', [makeSentence(2)]),
  ]);

  const res = nextTextStep({
    book,
    currentChapterIndex: 0,
    currentSentenceIndex: 0,
    autoAdvanceChapter: true,
  });

  assert.equal(res.kind, 'chapter');
  if (res.kind === 'chapter') {
    assert.equal(res.chapterIndex, 1);
    assert.equal(res.chapterId, 'c2');
  }
});

test('nextTextStep: пропуск пустых глав при переходе к следующей главе', () => {
  const book = makeBook([
    makeChapter('c1', 'Chapter 1', [makeSentence(1)]),
    makeChapter('c2', 'Empty Chapter', []),
    makeChapter('c3', 'Chapter 3', [makeSentence(2)]),
  ]);

  const res = nextTextStep({
    book,
    currentChapterIndex: 0,
    currentSentenceIndex: 0,
    autoAdvanceChapter: true,
  });

  assert.equal(res.kind, 'chapter');
  if (res.kind === 'chapter') {
    assert.equal(res.chapterIndex, 2);
    assert.equal(res.chapterId, 'c3');
  }
});

test('nextTextStep: остановка в конце главы при autoAdvanceChapter = false', () => {
  const book = makeBook([
    makeChapter('c1', 'Chapter 1', [makeSentence(1)]),
    makeChapter('c2', 'Chapter 2', [makeSentence(2)]),
  ]);

  const res = nextTextStep({
    book,
    currentChapterIndex: 0,
    currentSentenceIndex: 0,
    autoAdvanceChapter: false,
  });

  assert.equal(res.kind, 'end-of-chapter');
});

test('nextTextStep: конец книги в последней главе', () => {
  const book = makeBook([
    makeChapter('c1', 'Chapter 1', [makeSentence(1)]),
  ]);

  const res = nextTextStep({
    book,
    currentChapterIndex: 0,
    currentSentenceIndex: 0,
    autoAdvanceChapter: true,
  });

  assert.equal(res.kind, 'end-of-book');
});

test('nextTextStep: пустая книга или невалидный индекс возвращает end-of-book', () => {
  assert.equal(
    nextTextStep({
      book: null,
      currentChapterIndex: 0,
      currentSentenceIndex: 0,
      autoAdvanceChapter: true,
    }).kind,
    'end-of-book'
  );

  const book = makeBook([]);
  assert.equal(
    nextTextStep({
      book,
      currentChapterIndex: 5,
      currentSentenceIndex: 0,
      autoAdvanceChapter: true,
    }).kind,
    'end-of-book'
  );
});

test('nextTextStep: автопереход выключен, глав дальше нет → конец книги, а не конец главы', () => {
  const book = makeBook([makeChapter('c1', 'Chapter 1', [makeSentence(1), makeSentence(2), makeSentence(3)])]);

  const res = nextTextStep({ book, currentChapterIndex: 0, currentSentenceIndex: 2, autoAdvanceChapter: false });

  assert.equal(res.kind, 'end-of-book');
});

test('nextTextStep: автопереход выключен, дальше только пустые главы → конец книги', () => {
  const book = makeBook([
    makeChapter('c1', 'Chapter 1', [makeSentence(1), makeSentence(2)]),
    makeChapter('c2', 'Chapter 2 (пустая)', []),
    makeChapter('c3', 'Chapter 3 (пустая)', []),
  ]);

  const res = nextTextStep({ book, currentChapterIndex: 0, currentSentenceIndex: 1, autoAdvanceChapter: false });

  assert.equal(res.kind, 'end-of-book');
});

test('nextTextStep: автопереход выключен, дальше есть непустая глава → конец главы', () => {
  const book = makeBook([
    makeChapter('c1', 'Chapter 1', [makeSentence(1)]),
    makeChapter('c2', 'Chapter 2 (пустая)', []),
    makeChapter('c3', 'Chapter 3', [makeSentence(2)]),
  ]);

  const res = nextTextStep({ book, currentChapterIndex: 0, currentSentenceIndex: 0, autoAdvanceChapter: false });

  assert.equal(res.kind, 'end-of-chapter');
});
