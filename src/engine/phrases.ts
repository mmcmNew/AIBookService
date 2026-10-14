import type { SentenceItem } from '../types/book';
import { useBookStore } from '../store/bookStore';
import { usePagedStore } from '../store/pagedStore';
import { nextTextStep } from './audio/textSource';
import {
  firstSentenceAtOrAfterPage,
  nextStep,
  prevSentenceOf,
  type ComposedBook,
} from './pdf/composer';
import { pageOfSentenceId } from './pdf/pageSentences';

/**
 * Поставщик фраз (b_dom_source): зона «Библиотека и книги». Знает, как устроена книга (текст глав или страницы PDF),
 * и отвечает на вопрос «какая фраза нужна» одним из трёх ответов: фраза, ждём страницу, конец.
 * Наружу (к Координатору) его ответы выдаёт Менеджер книги (src/engine/library.ts).
 */

/** Фраза с ключом «главы» для аудиокэша */
export interface PhraseRef {
  chapterKey: string;
  sentence: SentenceItem;
}

/** Фраза, с которой нужно начать озвучку (или причина, почему начинать нечего) */
export type CurrentPhrase =
  | { kind: 'none' }
  | { kind: 'wait'; page: number }
  | { kind: 'end' }
  | {
      kind: 'phrase';
      bookId: string;
      chapterKey: string;
      sentence: SentenceItem;
      /** Позиция чтения указывала в пустоту: Координатор должен записать позицию на эту фразу */
      positionFix: boolean;
      /** Название главы для объявления (null, если главы нет) */
      chapterTitle: string | null;
      /** Индекс фразы для решения «объявлять ли главу» (0 — фраза открывает главу) */
      announceIndex: number;
      /** Следующая фраза — для подготовки озвучки заранее */
      next: PhraseRef | null;
    };

/** Что делать после окончания фразы / по команде «следующая» */
export type NextPhrase =
  | { kind: 'none' }
  | { kind: 'sentence'; sentenceId: number; trigger: 'navigate' | 'chapter' }
  | { kind: 'chapter'; chapterIndex: number }
  | { kind: 'wait'; page: number }
  | { kind: 'end'; notice: 'Конец книги' | 'Конец главы' };

/** Ключ «главы» для аудиокэша: по странице, а не по главе — главы достраиваются и могут менять id */
const pagedKey = (sentence: SentenceItem) => `pg${pageOfSentenceId(sentence.id)}`;

const isPaged = () => Boolean(useBookStore.getState().currentBook?.metadata.paged);

const readyPageState = (composed: ComposedBook, page: number) =>
  usePagedStore.getState().stateOf(page) === 'done' && composed.pages[page - 1]?.state === 'done';

/** Страница распознана и вошла в сборку книги */
export function isPageReady(page: number): boolean {
  const composed = usePagedStore.getState().composed;
  return Boolean(composed) && readyPageState(composed as ComposedBook, page);
}

/** Фраза, с которой начнётся озвучка (по текущей позиции чтения) */
export function currentPhrase(autoAdvanceChapter: boolean): CurrentPhrase {
  const book = useBookStore.getState();
  if (isPaged()) {
    const paged = usePagedStore.getState();
    const composed = paged.composed;
    if (!book.currentBook || !composed) return { kind: 'none' };
    let sentenceId = book.currentSentenceId;
    let positionFix = false;
    if (sentenceId == null || !composed.indexById.has(sentenceId)) {
      // Позиция не определена: страница не распознана (ждём её) либо пуста (берём ближайший текст дальше)
      const page = book.currentPage;
      if (!readyPageState(composed, page)) return { kind: 'wait', page };
      const first = firstSentenceAtOrAfterPage(composed, page);
      if (!first) {
        for (let p = page + 1; p <= composed.pageCount; p++) {
          if (paged.stateOf(p) !== 'done') return { kind: 'wait', page: p };
        }
        return { kind: 'end' };
      }
      sentenceId = first.id;
      positionFix = true;
    }
    const sentence = composed.order[composed.indexById.get(sentenceId) as number];
    const chapterIndex = composed.chapterOfSentence.get(sentenceId) ?? 0;
    const chapter = composed.chapters[chapterIndex];

    // Следующая фраза (только если следующая страница уже распознана)
    const step = nextStep(composed, (p) => paged.stateOf(p), sentence.id);
    let next: PhraseRef | null = null;
    if (step.kind === 'sentence' && (step.chapterIndex === chapterIndex || autoAdvanceChapter)) {
      next = { chapterKey: pagedKey(step.sentence), sentence: step.sentence };
    }
    // Название главы озвучиваем только в её начале; переход между страницами внутри главы — без объявления
    const startsChapter =
      Boolean(chapter) &&
      chapter.sentences[0]?.id === sentence.id &&
      composed.pages[(chapter.startPage ?? 1) - 1]?.state === 'done';
    return {
      kind: 'phrase',
      bookId: book.currentBook.metadata.id,
      chapterKey: pagedKey(sentence),
      sentence,
      positionFix,
      chapterTitle: chapter ? chapter.title : null,
      announceIndex: startsChapter ? 0 : 1,
      next,
    };
  }

  const chapter = book.getCurrentChapter();
  if (!book.currentBook || !chapter || chapter.sentences.length === 0) return { kind: 'none' };
  const sentenceIndex = book.getCurrentSentenceIndex();
  const sentence = chapter.sentences[sentenceIndex];
  // Следующая фраза (в т.ч. первая в следующей главе)
  let next: PhraseRef | null = null;
  if (sentenceIndex + 1 < chapter.sentences.length) {
    next = { chapterKey: chapter.id, sentence: chapter.sentences[sentenceIndex + 1] };
  } else if (autoAdvanceChapter) {
    const following = book.currentBook.chapters.slice(book.currentChapterIndex + 1).find((c) => c.sentences.length > 0);
    if (following) next = { chapterKey: following.id, sentence: following.sentences[0] };
  }
  return {
    kind: 'phrase',
    bookId: book.currentBook.metadata.id,
    chapterKey: chapter.id,
    sentence,
    positionFix: false,
    chapterTitle: chapter.title,
    announceIndex: sentenceIndex,
    next,
  };
}

/**
 * Какая фраза следующая. autoAdvanceChapter=false — на границе главы остановиться («Конец главы»).
 * PDF: если между текущей и следующей фразой есть нераспознанная страница — «ждём страницу».
 */
export function nextPhrase(autoAdvanceChapter: boolean): NextPhrase {
  const book = useBookStore.getState();
  if (isPaged()) {
    const paged = usePagedStore.getState();
    const composed = paged.composed;
    const cur = book.currentSentenceId;
    if (!composed || cur == null) return { kind: 'none' };
    const step = nextStep(composed, (p) => paged.stateOf(p), cur);
    if (step.kind === 'sentence') {
      const sameChapter = step.chapterIndex === book.currentChapterIndex;
      if (!sameChapter && !autoAdvanceChapter) return { kind: 'end', notice: 'Конец главы' };
      return { kind: 'sentence', sentenceId: step.sentence.id, trigger: sameChapter ? 'navigate' : 'chapter' };
    }
    if (step.kind === 'wait') return { kind: 'wait', page: step.page };
    return { kind: 'end', notice: 'Конец книги' };
  }

  const bookData = book.currentBook;
  if (!bookData) return { kind: 'none' };
  const result = nextTextStep({
    book: bookData,
    currentChapterIndex: book.currentChapterIndex,
    currentSentenceIndex: book.getCurrentSentenceIndex(),
    autoAdvanceChapter,
  });
  if (result.kind === 'sentence') return { kind: 'sentence', sentenceId: result.sentence.id, trigger: 'navigate' };
  if (result.kind === 'chapter') return { kind: 'chapter', chapterIndex: result.chapterIndex };
  return { kind: 'end', notice: result.kind === 'end-of-book' ? 'Конец книги' : 'Конец главы' };
}

/** Предыдущая фраза (id) или null, если идти некуда */
export function previousPhraseId(): number | null {
  const book = useBookStore.getState();
  if (isPaged()) {
    const composed = usePagedStore.getState().composed;
    const cur = book.currentSentenceId;
    const prev = composed && cur != null ? prevSentenceOf(composed, cur) : null;
    return prev ? prev.sentence.id : null;
  }
  const chapter = book.getCurrentChapter();
  if (!chapter || chapter.sentences.length === 0) return null;
  const prevIndex = Math.max(0, book.getCurrentSentenceIndex() - 1);
  return chapter.sentences[prevIndex].id;
}
