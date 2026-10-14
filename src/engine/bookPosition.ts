import { useBookStore } from '../store/bookStore';
import { usePagedStore } from '../store/pagedStore';
import type { ParsedBook } from '../types/book';
import {
  chapterIndexForPage,
  firstSentenceAtOrAfterPage,
  firstSentenceOnPage,
  sentencePage,
} from './pdf/composer';
import { currentPhrase as sourceCurrentPhrase, nextPhrase as sourceNextPhrase, previousPhraseId, type CurrentPhrase } from './phrases';

/**
 * Позиция чтения: где мы в книге (фраза, глава, страница, страница просмотра).
 * Часть Менеджера книги (b_dom_library, src/engine/library.ts): ЕДИНСТВЕННОЕ место, где пишутся поля позиции
 * в сторе книги. Без pdfjs и IndexedDB, поэтому проверяется тестами без браузера: побочные действия
 * (сохранение прогресса, показ страницы, сигнал обновления видов PDF) подключает Менеджер через configurePosition.
 *
 * Менеджер сам двигает позицию и сам копит прогресс. Если переход пришёл НЕ от Координатора (клик по предложению,
 * выбор главы или страницы, кнопки «предыдущая/следующая фраза») — он сообщает Координатору событием «внешний переход».
 * Переходы по запросу Координатора (nextPhrase, currentPhrase) событие не вызывают.
 */

export interface ProgressPatch {
  'metadata.lastReadAt'?: number;
  'metadata.lastChapterId'?: string;
  'metadata.lastSentenceId'?: number;
  'metadata.lastPage'?: number;
}

/** Побочные действия, которые выполняет Менеджер книги при смене позиции */
export interface PositionEffects {
  /** Накопить прогресс чтения (запись в базу с задержкой) */
  saveProgress: (bookId: string, patch: ProgressPatch) => void;
  /** Записать накопленный прогресс сейчас */
  flushProgress: () => Promise<void>;
  /** Показать страницу PDF «в фокусе» (onlyIfChanged — не трогать, если фокус уже на ней) */
  showPage: (page: number, onlyIfChanged?: boolean) => void;
  /** Явная навигация по PDF: виды прокручиваются */
  bumpNavNonce: () => void;
}

const noEffects: PositionEffects = {
  saveProgress: () => {},
  flushProgress: () => Promise.resolve(),
  showPage: () => {},
  bumpNavNonce: () => {},
};

let effects: PositionEffects = noEffects;

export function configurePosition(next: Partial<PositionEffects>): void {
  effects = { ...noEffects, ...next };
}

/** Ответ Менеджера на «следующая фраза»: позиция уже сдвинута (phrase) либо сдвигать некуда */
export type StepResult =
  | { kind: 'none' }
  | { kind: 'phrase'; trigger: 'navigate' | 'chapter' }
  | { kind: 'wait'; page: number }
  | { kind: 'end'; notice: 'Конец книги' | 'Конец главы' };

/** Внешний переход: позицию сдвинул не Координатор, а пользователь (через Менеджера) */
export type ExternalMove =
  | { kind: 'jump' } // клик по предложению
  | { kind: 'step'; result: StepResult } // кнопка/стрелка «предыдущая/следующая фраза»
  | { kind: 'chapter' } // выбор главы текстовой книги
  | { kind: 'page' }; // навигация по страницам PDF (в т.ч. выбор главы PDF)

let moveHandler: ((move: ExternalMove) => void) | null = null;

/** Координатор регистрирует обработчик «внешний переход» при загрузке модуля */
export function onExternalMove(handler: ((move: ExternalMove) => void) | null): void {
  moveHandler = handler;
}

function announce(move: ExternalMove): void {
  moveHandler?.(move);
}

/** Страница, на которую перешли, но она ещё не распознана: позиция выставится, когда страница будет готова */
let pendingJump: number | null = null;

export function getPendingJump(): number | null {
  return pendingJump;
}

export function setPendingJump(page: number | null): void {
  pendingJump = page;
}

export function pagedBookOpen(): ParsedBook | null {
  const b = useBookStore.getState().currentBook;
  return b && b.metadata.paged && usePagedStore.getState().bookId === b.metadata.id ? b : null;
}

// ---------------------------------------------------------------------------
// Запись позиции (только здесь)
// ---------------------------------------------------------------------------

export function writePosition(pos: { chapterIndex?: number; sentenceId?: number | null; page?: number }): void {
  useBookStore.getState().setPosition(pos);
}

export function resetPosition(): void {
  useBookStore.getState().resetPosition();
}

/** Где в постраничной книге лежит предложение (null — это не постраничная книга или предложения нет в сборке) */
export function sentenceLocation(id: number): { page: number; chapterIndex: number | undefined } | null {
  if (!pagedBookOpen()) return null;
  const composed = usePagedStore.getState().composed;
  const idx = composed?.indexById.get(id);
  if (!composed || idx === undefined) return null;
  return { page: sentencePage(composed.order[idx]), chapterIndex: composed.chapterOfSentence.get(id) };
}

/** Книга и глава для записи прогресса чтения (null — книга не открыта) */
function progressRef(chapterIndex: number): { bookId: string; chapterId: string | undefined } | null {
  const book = useBookStore.getState().currentBook;
  return book ? { bookId: book.metadata.id, chapterId: book.chapters[chapterIndex]?.id } : null;
}

/** Выставляет предложение (и страницу/главу, если книга постраничная) и копит прогресс */
export function setSentenceId(id: number | null): void {
  const store = useBookStore.getState();
  if (id !== null && store.currentSentenceId === id) return;
  if (id === null) {
    store.setSentenceId(null);
    return;
  }
  const located = sentenceLocation(id);
  if (located) {
    const chapterIndex = located.chapterIndex ?? store.currentChapterIndex;
    writePosition({ sentenceId: id, page: located.page, chapterIndex });
    effects.showPage(located.page, true);
    const ref = progressRef(chapterIndex);
    if (ref) {
      effects.saveProgress(ref.bookId, {
        'metadata.lastReadAt': Date.now(),
        'metadata.lastPage': located.page,
        'metadata.lastChapterId': ref.chapterId,
        'metadata.lastSentenceId': id,
      });
    }
    return;
  }
  store.setSentenceId(id);
  const ref = progressRef(useBookStore.getState().currentChapterIndex);
  if (ref) {
    effects.saveProgress(ref.bookId, {
      'metadata.lastReadAt': Date.now(),
      'metadata.lastChapterId': ref.chapterId,
      'metadata.lastSentenceId': id,
    });
  }
}

/** Страница просмотра PDF (без сдвига чтения); pagedBookOpen — иначе игнорируется */
export function setViewPage(page: number): void {
  const book = pagedBookOpen();
  if (!book) return;
  const p = Math.min(Math.max(1, Math.round(page) || 1), book.metadata.paged!.pageCount);
  if (p === useBookStore.getState().currentPage) return;
  useBookStore.getState().setViewPage(p);
  effects.showPage(p);
  effects.saveProgress(book.metadata.id, { 'metadata.lastPage': p, 'metadata.lastReadAt': Date.now() });
}

/** Навигация PDF (страница + предложение): повышает navNonce, чтобы виды прокрутились, а плеер перестроился */
export function navigatePaged(page: number, sentenceId: number | null, jumpIfUnready: boolean): void {
  const book = pagedBookOpen();
  if (!book) return;
  const composed = usePagedStore.getState().composed;
  const p = Math.min(Math.max(1, Math.round(page) || 1), book.metadata.paged!.pageCount);
  const chapterIndex =
    composed && sentenceId != null && composed.chapterOfSentence.has(sentenceId)
      ? (composed.chapterOfSentence.get(sentenceId) as number)
      : composed
        ? chapterIndexForPage(composed, p)
        : 0;
  pendingJump = jumpIfUnready ? p : null;
  writePosition({ chapterIndex, sentenceId, page: p });
  effects.bumpNavNonce();
  announce({ kind: 'page' });
  effects.showPage(p);
  effects.saveProgress(book.metadata.id, {
    'metadata.lastReadAt': Date.now(),
    'metadata.lastPage': p,
    'metadata.lastChapterId': book.chapters[chapterIndex]?.id,
    'metadata.lastSentenceId': sentenceId ?? undefined,
  });
}

/** Перейти на страницу PDF (первая фраза страницы, если она уже распознана) */
export function goToPage(page: number): void {
  const book = pagedBookOpen();
  if (!book) return;
  const composed = usePagedStore.getState().composed;
  const p = Math.min(Math.max(1, Math.round(page) || 1), book.metadata.paged!.pageCount);
  const ready = composed?.pages[p - 1]?.state === 'done';
  const target = ready && composed ? firstSentenceOnPage(composed, p) ?? firstSentenceAtOrAfterPage(composed, p) : null;
  navigatePaged(p, target?.id ?? null, !ready);
}

type ChapterTarget =
  | { kind: 'paged-sentence'; page: number; sentenceId: number }
  | { kind: 'paged-page'; page: number }
  | { kind: 'text'; bookId: string; chapterId: string; sentenceId: number | null };

/** Куда перейти при выборе главы (null — такой главы нет) */
function chapterTarget(index: number): ChapterTarget | null {
  const book = useBookStore.getState().currentBook;
  if (!book || index < 0 || index >= book.chapters.length) return null;
  const ch = book.chapters[index];
  if (book.metadata.paged) {
    const composed = usePagedStore.getState().composed;
    const startPage = ch.startPage ?? 1;
    const first = ch.sentences[0];
    if (composed && first && composed.pages[startPage - 1]?.state === 'done' && sentencePage(first) === startPage) {
      return { kind: 'paged-sentence', page: startPage, sentenceId: first.id };
    }
    return { kind: 'paged-page', page: startPage };
  }
  return { kind: 'text', bookId: book.metadata.id, chapterId: ch.id, sentenceId: ch.sentences[0]?.id ?? null };
}

/** Переход к главе: двигает позицию и копит прогресс; announceChange — сообщить Координатору, если глава сменилась */
function applyChapter(index: number, announceChange: boolean): void {
  const target = chapterTarget(index);
  if (!target) return;
  if (target.kind === 'paged-sentence') {
    navigatePaged(target.page, target.sentenceId, false);
    return;
  }
  if (target.kind === 'paged-page') {
    goToPage(target.page);
    return;
  }

  const before = useBookStore.getState().currentChapterIndex;
  writePosition({ chapterIndex: index, sentenceId: target.sentenceId });
  if (announceChange && before !== index) announce({ kind: 'chapter' });

  effects.saveProgress(target.bookId, {
    'metadata.lastReadAt': Date.now(),
    'metadata.lastChapterId': target.chapterId,
    'metadata.lastSentenceId': target.sentenceId ?? undefined,
  });
  void effects.flushProgress();
}

// ---------------------------------------------------------------------------
// Фразы для Координатора (позиция двигается по его запросу; события нет)
// ---------------------------------------------------------------------------

/** Текущая фраза (позиция не сдвигается; если позиция указывала в пустоту — исправляется на найденную фразу) */
export function currentPhrase(autoAdvanceChapter: boolean): CurrentPhrase {
  const phrase = sourceCurrentPhrase(autoAdvanceChapter);
  if (phrase.kind === 'phrase' && phrase.positionFix) setSentenceId(phrase.sentence.id);
  return phrase;
}

/** Следующая фраза: позиция сдвигается сразу. Ответ — фраза | ждём страницу | конец */
export function nextPhrase(autoAdvanceChapter: boolean): StepResult {
  const next = sourceNextPhrase(autoAdvanceChapter);
  if (next.kind === 'sentence') {
    setSentenceId(next.sentenceId);
    return { kind: 'phrase', trigger: next.trigger };
  }
  if (next.kind === 'chapter') {
    applyChapter(next.chapterIndex, false);
    return { kind: 'phrase', trigger: 'chapter' };
  }
  return next;
}

/** Предыдущая фраза: позиция сдвигается сразу (null-ответ «none» — идти некуда) */
export function previousPhrase(): StepResult {
  const prevId = previousPhraseId();
  if (prevId === null) return { kind: 'none' };
  setSentenceId(prevId);
  return { kind: 'phrase', trigger: 'navigate' };
}

// ---------------------------------------------------------------------------
// Навигация пользователя (UI -> Менеджер книги): после сдвига сообщаем Координатору
// ---------------------------------------------------------------------------

/** Клик по предложению */
export function jumpToSentence(sentenceId: number): void {
  setSentenceId(sentenceId);
  announce({ kind: 'jump' });
}

/** Выбор главы */
export function selectChapter(index: number): void {
  applyChapter(index, true);
}

/** Шаг на одну фразу: delta > 0 — следующая (с переходом через главы), иначе предыдущая */
export function stepPhrase(delta: 1 | -1): void {
  const result = delta > 0 ? nextPhrase(true) : previousPhrase();
  if (result.kind === 'none') return;
  announce({ kind: 'step', result });
}
