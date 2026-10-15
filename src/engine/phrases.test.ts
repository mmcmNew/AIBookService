import test from 'node:test';
import assert from 'node:assert/strict';
import type { Chapter, ParsedBook, SentenceItem } from '../types/book';
import type { ComposedBook, PageState } from '../types/pdf';
import { useBookStore } from '../store/bookStore';
import { usePagedStore } from '../store/pagedStore';
import { currentPhrase, isPageReady, nextPhrase, previousPhraseId } from './phrases';

const sent = (id: number, text = `Фраза ${id}.`): SentenceItem => ({ id, rawText: text, speechText: text, paragraphIndex: 0 });
const chapter = (id: string, title: string, sentences: SentenceItem[], startPage?: number): Chapter => ({
  id, title, level: 1, contentHtml: '', sentences, startPage,
});

function textBook(chapters: Chapter[]): ParsedBook {
  return { metadata: { id: 'txt', title: 'T' }, chapters, notes: {} } as unknown as ParsedBook;
}

function setTextBook(chapters: Chapter[], chapterIndex: number, sentenceId: number | null) {
  usePagedStore.getState().reset();
  useBookStore.setState({
    currentBook: textBook(chapters),
    currentChapterIndex: chapterIndex,
    currentSentenceId: sentenceId,
    currentPage: 1,
  });
}

test('текст: следующая фраза, переход главы, конец главы и конец книги', () => {
  const ch = [chapter('c0', 'Глава 1', [sent(1), sent(2)]), chapter('c1', 'Глава 2', [sent(3)])];
  setTextBook(ch, 0, 1);
  assert.deepEqual(nextPhrase(true), { kind: 'sentence', sentenceId: 2, trigger: 'navigate' });

  setTextBook(ch, 0, 2);
  assert.deepEqual(nextPhrase(true), { kind: 'chapter', chapterIndex: 1 });
  assert.deepEqual(nextPhrase(false), { kind: 'end', notice: 'Конец главы' });

  setTextBook(ch, 1, 3);
  assert.deepEqual(nextPhrase(true), { kind: 'end', notice: 'Конец книги' });
  assert.deepEqual(nextPhrase(false), { kind: 'end', notice: 'Конец книги' });
});

test('текст: нет книги — ответ «ничего»', () => {
  usePagedStore.getState().reset();
  useBookStore.setState({ currentBook: null });
  assert.deepEqual(nextPhrase(true), { kind: 'none' });
  assert.deepEqual(currentPhrase(true), { kind: 'none' });
  assert.equal(previousPhraseId(), null);
});

test('текст: текущая фраза знает следующую, в том числе первую в следующей главе (только при автопереходе)', () => {
  const ch = [chapter('c0', 'Глава 1', [sent(1), sent(2)]), chapter('c1', 'Глава 2', [sent(3)])];
  setTextBook(ch, 0, 1);
  const first = currentPhrase(false);
  assert.equal(first.kind, 'phrase');
  if (first.kind !== 'phrase') return;
  assert.equal(first.sentence.id, 1);
  assert.equal(first.chapterTitle, 'Глава 1');
  assert.equal(first.announceIndex, 0);
  assert.deepEqual(first.next && [first.next.chapterKey, first.next.sentence.id], ['c0', 2]);

  setTextBook(ch, 0, 2);
  const last = currentPhrase(false);
  assert.equal(last.kind === 'phrase' && last.next, null);
  const crossing = currentPhrase(true);
  assert.deepEqual(crossing.kind === 'phrase' && crossing.next && [crossing.next.chapterKey, crossing.next.sentence.id], ['c1', 3]);
});

test('текст: предыдущая фраза и начало главы', () => {
  const ch = [chapter('c0', 'Глава 1', [sent(1), sent(2), sent(3)])];
  setTextBook(ch, 0, 3);
  assert.equal(previousPhraseId(), 2);
  setTextBook(ch, 0, 1);
  assert.equal(previousPhraseId(), 1);
});

// --- PDF ---------------------------------------------------------------

const PAGE = 1_000_000;

function setPagedBook(states: PageState[], currentSentenceId: number | null, currentChapterIndex = 0, currentPage = 1) {
  const a = sent(1 * PAGE), b = sent(1 * PAGE + 1), c = sent(3 * PAGE);
  const chapters = [chapter('p0', 'Начало', [a, b], 1), chapter('p1', 'Дальше', [c], 3)];
  const order = [a, b, c];
  const composed = {
    pageCount: 3,
    pages: states.map((state) => ({ state })),
    chapters,
    order,
    indexById: new Map(order.map((s, i) => [s.id, i])),
    chapterOfSentence: new Map([[a.id, 0], [b.id, 0], [c.id, 1]]),
    sentencesByPage: new Map(),
  } as unknown as ComposedBook;
  usePagedStore.setState({ bookId: 'pdf', pageCount: 3, states, composed });
  useBookStore.setState({
    currentBook: { metadata: { id: 'pdf', title: 'P', paged: { pageCount: 3 } }, chapters, notes: {} } as unknown as ParsedBook,
    currentChapterIndex,
    currentSentenceId,
    currentPage,
  });
}

test('PDF: следующая фраза на той же странице', () => {
  setPagedBook(['done', 'done', 'done'], 1 * PAGE);
  assert.deepEqual(nextPhrase(true), { kind: 'sentence', sentenceId: 1 * PAGE + 1, trigger: 'navigate' });
});

test('PDF: нераспознанная страница между фразами — «ждём страницу», перескакивать нельзя', () => {
  setPagedBook(['done', 'pending', 'done'], 1 * PAGE + 1);
  assert.deepEqual(nextPhrase(true), { kind: 'wait', page: 2 });
  setPagedBook(['done', 'done', 'done'], 1 * PAGE + 1);
  assert.deepEqual(nextPhrase(true), { kind: 'sentence', sentenceId: 3 * PAGE, trigger: 'chapter' });
});

test('PDF: граница главы при выключенном автопереходе — «Конец главы», в конце книги — «Конец книги»', () => {
  setPagedBook(['done', 'done', 'done'], 1 * PAGE + 1);
  assert.deepEqual(nextPhrase(false), { kind: 'end', notice: 'Конец главы' });
  setPagedBook(['done', 'done', 'done'], 3 * PAGE, 1, 3);
  assert.deepEqual(nextPhrase(true), { kind: 'end', notice: 'Конец книги' });
});

test('PDF: позиция в нераспознанной странице — ждём её; на распознанной пустой — ближайший текст дальше', () => {
  setPagedBook(['done', 'pending', 'done'], null, 0, 2);
  assert.deepEqual(currentPhrase(true), { kind: 'wait', page: 2 });

  setPagedBook(['done', 'done', 'done'], null, 0, 2);
  const phrase = currentPhrase(true);
  assert.equal(phrase.kind === 'phrase' && phrase.sentence.id, 3 * PAGE);
  assert.equal(phrase.kind === 'phrase' && phrase.positionFix, true);
});

test('PDF: следующая фраза для подготовки озвучки не берётся через нераспознанную страницу', () => {
  setPagedBook(['done', 'pending', 'done'], 1 * PAGE + 1);
  const phrase = currentPhrase(true);
  assert.equal(phrase.kind === 'phrase' && phrase.next, null);
  setPagedBook(['done', 'done', 'done'], 1 * PAGE + 1);
  const ready = currentPhrase(true);
  assert.deepEqual(ready.kind === 'phrase' && ready.next && [ready.next.chapterKey, ready.next.sentence.id], ['pg3', 3 * PAGE]);
  const sameChapterOnly = currentPhrase(false);
  assert.equal(sameChapterOnly.kind === 'phrase' && sameChapterOnly.next, null);
});

test('PDF: страница готова, только если распознана и вошла в сборку', () => {
  setPagedBook(['done', 'pending', 'done'], 1 * PAGE);
  assert.equal(isPageReady(1), true);
  assert.equal(isPageReady(2), false);
  usePagedStore.setState({ composed: null });
  assert.equal(isPageReady(1), false);
});

test('PDF: предыдущая фраза', () => {
  setPagedBook(['done', 'done', 'done'], 1 * PAGE + 1);
  assert.equal(previousPhraseId(), 1 * PAGE);
  setPagedBook(['done', 'done', 'done'], 1 * PAGE);
  assert.equal(previousPhraseId(), null);
});
