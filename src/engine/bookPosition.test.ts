import test from 'node:test';
import assert from 'node:assert/strict';
import type { Chapter, ParsedBook, SentenceItem } from '../types/book';
import type { ComposedBook, PageState } from '../types/pdf';
import { useBookStore } from '../store/bookStore';
import { usePagedStore } from '../store/pagedStore';
import {
  configurePosition,
  currentPhrase,
  getPendingJump,
  goToPage,
  jumpToSentence,
  nextPhrase,
  onExternalMove,
  previousPhrase,
  selectChapter,
  setPendingJump,
  setSentenceId,
  setViewPage,
  stepPhrase,
  type ExternalMove,
  type ProgressPatch,
} from './bookPosition';

const sent = (id: number, text = `Фраза ${id}.`): SentenceItem => ({ id, rawText: text, speechText: text, paragraphIndex: 0 });
const chapter = (id: string, title: string, sentences: SentenceItem[], startPage?: number): Chapter => ({
  id, title, level: 1, contentHtml: '', sentences, startPage,
});

/** Журнал побочных действий Менеджера: что накоплено в прогрессе, какие события ушли Координатору */
function recorder() {
  const saved: { bookId: string; patch: ProgressPatch }[] = [];
  const moves: ExternalMove[] = [];
  const shown: number[] = [];
  let flushes = 0;
  let bumps = 0;
  configurePosition({
    saveProgress: (bookId, patch) => saved.push({ bookId, patch }),
    flushProgress: () => {
      flushes++;
      return Promise.resolve();
    },
    showPage: (page) => shown.push(page),
    bumpNavNonce: () => {
      bumps++;
    },
  });
  onExternalMove((m) => moves.push(m));
  return { saved, moves, shown, flushes: () => flushes, bumps: () => bumps };
}

function setTextBook(chapters: Chapter[], chapterIndex: number, sentenceId: number | null) {
  usePagedStore.getState().reset();
  setPendingJump(null);
  useBookStore.setState({
    currentBook: { metadata: { id: 'txt', title: 'T' }, chapters, notes: {} } as unknown as ParsedBook,
    currentChapterIndex: chapterIndex,
    currentSentenceId: sentenceId,
    currentPage: 1,
  });
}

const pos = () => {
  const s = useBookStore.getState();
  return { chapter: s.currentChapterIndex, sentence: s.currentSentenceId, page: s.currentPage };
};

const two = () => [chapter('c0', 'Глава 1', [sent(1), sent(2)]), chapter('c1', 'Глава 2', [sent(3)])];

// --- Менеджер двигает позицию и копит прогресс ------------------------------

test('Менеджер: следующая фраза сдвигает позицию, копит прогресс и не сообщает Координатору', () => {
  const r = recorder();
  setTextBook(two(), 0, 1);
  assert.deepEqual(nextPhrase(true), { kind: 'phrase', trigger: 'navigate' });
  assert.deepEqual(pos(), { chapter: 0, sentence: 2, page: 1 });
  assert.equal(r.saved.length, 1);
  assert.equal(r.saved[0].bookId, 'txt');
  assert.equal(r.saved[0].patch['metadata.lastSentenceId'], 2);
  assert.equal(r.saved[0].patch['metadata.lastChapterId'], 'c0');
  assert.deepEqual(r.moves, [], 'переход по запросу Координатора — не внешний');
});

test('Менеджер: переход в следующую главу двигает главу и фразу, сохраняет прогресс сразу, события нет', () => {
  const r = recorder();
  setTextBook(two(), 0, 2);
  assert.deepEqual(nextPhrase(true), { kind: 'phrase', trigger: 'chapter' });
  assert.deepEqual(pos(), { chapter: 1, sentence: 3, page: 1 });
  assert.equal(r.saved.at(-1)?.patch['metadata.lastChapterId'], 'c1');
  assert.equal(r.flushes(), 1);
  assert.deepEqual(r.moves, []);
});

test('Менеджер: конец главы при выключенном автопереходе и конец книги — позиция не сдвигается', () => {
  const r = recorder();
  setTextBook(two(), 0, 2);
  assert.deepEqual(nextPhrase(false), { kind: 'end', notice: 'Конец главы' });
  assert.deepEqual(pos(), { chapter: 0, sentence: 2, page: 1 });
  setTextBook(two(), 1, 3);
  assert.deepEqual(nextPhrase(true), { kind: 'end', notice: 'Конец книги' });
  assert.deepEqual(pos(), { chapter: 1, sentence: 3, page: 1 });
  assert.equal(r.saved.length, 0);
});

test('Менеджер: нет книги — ответ «ничего», ничего не пишется', () => {
  const r = recorder();
  usePagedStore.getState().reset();
  useBookStore.setState({ currentBook: null, currentSentenceId: null });
  assert.deepEqual(nextPhrase(true), { kind: 'none' });
  assert.deepEqual(previousPhrase(), { kind: 'none' });
  assert.equal(currentPhrase(true).kind, 'none');
  assert.equal(r.saved.length, 0);
});

test('Менеджер: предыдущая фраза двигает позицию назад, а на первой остаётся на месте', () => {
  const r = recorder();
  setTextBook([chapter('c0', 'Глава 1', [sent(1), sent(2), sent(3)])], 0, 3);
  assert.deepEqual(previousPhrase(), { kind: 'phrase', trigger: 'navigate' });
  assert.equal(pos().sentence, 2);
  previousPhrase();
  assert.equal(pos().sentence, 1);
  previousPhrase();
  assert.equal(pos().sentence, 1);
  assert.deepEqual(r.moves, []);
});

test('Менеджер: текущая фраза позицию не сдвигает', () => {
  const r = recorder();
  setTextBook(two(), 0, 1);
  const phrase = currentPhrase(true);
  assert.equal(phrase.kind === 'phrase' && phrase.sentence.id, 1);
  assert.deepEqual(pos(), { chapter: 0, sentence: 1, page: 1 });
  assert.equal(r.saved.length, 0);
  assert.deepEqual(r.moves, []);
});

test('Менеджер: одну и ту же фразу повторно не записывает', () => {
  const r = recorder();
  setTextBook(two(), 0, 1);
  setSentenceId(1);
  assert.equal(r.saved.length, 0);
  setSentenceId(2);
  assert.equal(r.saved.length, 1);
});

// --- Внешний переход против перехода Координатора -------------------------------

test('внешний переход: клик по предложению двигает позицию и сообщает Координатору', () => {
  const r = recorder();
  setTextBook(two(), 0, 1);
  jumpToSentence(2);
  assert.equal(pos().sentence, 2);
  assert.deepEqual(r.moves, [{ kind: 'jump' }]);
  assert.equal(r.saved.at(-1)?.patch['metadata.lastSentenceId'], 2);
});

test('внешний переход: клик по тому же предложению тоже сообщается (играть отсюда)', () => {
  const r = recorder();
  setTextBook(two(), 0, 1);
  jumpToSentence(1);
  assert.deepEqual(r.moves, [{ kind: 'jump' }]);
});

test('внешний переход: кнопка «следующая фраза» несёт ответ Менеджера (фраза | глава | конец)', () => {
  const r = recorder();
  setTextBook(two(), 0, 1);
  stepPhrase(1);
  stepPhrase(1);
  stepPhrase(1);
  assert.deepEqual(r.moves, [
    { kind: 'step', result: { kind: 'phrase', trigger: 'navigate' } },
    { kind: 'step', result: { kind: 'phrase', trigger: 'chapter' } },
    { kind: 'step', result: { kind: 'end', notice: 'Конец книги' } },
  ]);
  assert.deepEqual(pos(), { chapter: 1, sentence: 3, page: 1 });
});

test('внешний переход: кнопка «предыдущая фраза» сообщает, а без книги молчит', () => {
  const r = recorder();
  setTextBook(two(), 0, 2);
  stepPhrase(-1);
  assert.equal(pos().sentence, 1);
  assert.deepEqual(r.moves, [{ kind: 'step', result: { kind: 'phrase', trigger: 'navigate' } }]);
  r.moves.length = 0;
  useBookStore.setState({ currentBook: null });
  stepPhrase(-1);
  stepPhrase(1);
  assert.deepEqual(r.moves, []);
});

test('внешний переход: выбор главы сообщается, только если глава сменилась', () => {
  const r = recorder();
  setTextBook(two(), 0, 2);
  selectChapter(1);
  assert.deepEqual(pos(), { chapter: 1, sentence: 3, page: 1 });
  assert.deepEqual(r.moves, [{ kind: 'chapter' }]);
  assert.equal(r.flushes(), 1);
  selectChapter(1);
  assert.deepEqual(r.moves, [{ kind: 'chapter' }], 'та же глава — события нет');
  selectChapter(5);
  assert.deepEqual(r.moves, [{ kind: 'chapter' }], 'главы нет — события нет');
});

test('без обработчика Менеджер просто двигает позицию (Координатор не загружен)', () => {
  recorder();
  onExternalMove(null);
  setTextBook(two(), 0, 1);
  jumpToSentence(2);
  stepPhrase(1);
  assert.equal(pos().sentence, 3);
  assert.equal(pos().chapter, 1);
});

// --- PDF ------------------------------------------------------------------------

const PAGE = 1_000_000;

function setPagedBook(states: PageState[], sentenceId: number | null, chapterIndex = 0, page = 1) {
  const a = sent(1 * PAGE), b = sent(1 * PAGE + 1), c = sent(3 * PAGE);
  const chapters = [chapter('p0', 'Начало', [a, b], 1), chapter('p1', 'Дальше', [c], 3)];
  const order = [a, b, c];
  const composed = {
    pageCount: 3,
    pages: states.map((state) => ({ state })),
    chapters,
    specs: [{ startPage: 1 }, { startPage: 3 }],
    order,
    indexById: new Map(order.map((s, i) => [s.id, i])),
    chapterOfSentence: new Map([[a.id, 0], [b.id, 0], [c.id, 1]]),
    sentencesByPage: new Map(),
  } as unknown as ComposedBook;
  setPendingJump(null);
  usePagedStore.setState({ bookId: 'pdf', pageCount: 3, states, composed });
  useBookStore.setState({
    currentBook: { metadata: { id: 'pdf', title: 'P', paged: { pageCount: 3 } }, chapters, notes: {} } as unknown as ParsedBook,
    currentChapterIndex: chapterIndex,
    currentSentenceId: sentenceId,
    currentPage: page,
  });
}

test('PDF: следующая фраза на другой странице двигает страницу и главу, показывает страницу, события нет', () => {
  const r = recorder();
  setPagedBook(['done', 'done', 'done'], 1 * PAGE + 1);
  assert.deepEqual(nextPhrase(true), { kind: 'phrase', trigger: 'chapter' });
  assert.deepEqual(pos(), { chapter: 1, sentence: 3 * PAGE, page: 3 });
  assert.deepEqual(r.shown, [3]);
  assert.equal(r.saved.at(-1)?.patch['metadata.lastPage'], 3);
  assert.deepEqual(r.moves, []);
});

test('PDF: нераспознанная страница — «ждём страницу», позиция остаётся на месте', () => {
  const r = recorder();
  setPagedBook(['done', 'pending', 'done'], 1 * PAGE + 1);
  assert.deepEqual(nextPhrase(true), { kind: 'wait', page: 2 });
  assert.deepEqual(pos(), { chapter: 0, sentence: 1 * PAGE + 1, page: 1 });
  assert.equal(r.saved.length, 0);
});

test('PDF: текущая фраза с «пустой» позицией записывает найденную фразу, не создавая события', () => {
  const r = recorder();
  setPagedBook(['done', 'done', 'done'], null, 0, 2);
  const phrase = currentPhrase(true);
  assert.equal(phrase.kind === 'phrase' && phrase.sentence.id, 3 * PAGE);
  assert.equal(pos().sentence, 3 * PAGE);
  assert.deepEqual(r.moves, []);
});

test('PDF: выбор страницы — внешний переход «страница»: виды прокручиваются, прогресс копится', () => {
  const r = recorder();
  setPagedBook(['done', 'done', 'done'], 1 * PAGE);
  goToPage(3);
  assert.deepEqual(pos(), { chapter: 1, sentence: 3 * PAGE, page: 3 });
  assert.equal(r.bumps(), 1);
  assert.deepEqual(r.moves, [{ kind: 'page' }]);
  assert.equal(r.saved.at(-1)?.patch['metadata.lastPage'], 3);
  assert.equal(getPendingJump(), null);
});

test('PDF: переход на нераспознанную страницу запоминает ожидаемую страницу', () => {
  const r = recorder();
  setPagedBook(['done', 'pending', 'done'], 1 * PAGE);
  goToPage(2);
  assert.equal(getPendingJump(), 2);
  assert.equal(pos().page, 2);
  assert.deepEqual(r.moves, [{ kind: 'page' }]);
});

test('PDF: выбор главы — переход «страница»; страница просмотра чтение не сдвигает и события не даёт', () => {
  const r = recorder();
  setPagedBook(['done', 'done', 'done'], 1 * PAGE);
  selectChapter(1);
  assert.deepEqual(r.moves, [{ kind: 'page' }]);
  r.moves.length = 0;
  setViewPage(2);
  assert.equal(pos().page, 2);
  assert.equal(pos().sentence, 3 * PAGE, 'предложение чтения не менялось');
  assert.deepEqual(r.moves, []);
  setViewPage(2);
  assert.equal(r.saved.filter((s) => s.patch['metadata.lastPage'] === 2).length, 1, 'та же страница не пишется повторно');
});
