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
      /** Последующие фразы — для буферизации наперёд (до N предложений) */
      following: PhraseRef[];
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
export function currentPhrase(autoAdvanceChapter: boolean, prefetchCount = 2): CurrentPhrase {
  const book = useBookStore.getState();
  const maxAhead = Math.max(1, Math.min(10, prefetchCount));

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
    const curIdx = composed.indexById.get(sentenceId) as number;
    const sentence = composed.order[curIdx];
    const chapterIndex = composed.chapterOfSentence.get(sentenceId) ?? 0;
    const chapter = composed.chapters[chapterIndex];

    // Последующие фразы для буферизации (только пока следующие страницы уже распознаны)
    const following: PhraseRef[] = [];
    let curCheckId = sentence.id;
    while (following.length < maxAhead) {
      const step = nextStep(composed, (p) => paged.stateOf(p), curCheckId);
      if (step.kind !== 'sentence') break;
      if (step.chapterIndex !== chapterIndex && !autoAdvanceChapter) break;
      following.push({ chapterKey: pagedKey(step.sentence), sentence: step.sentence });
      curCheckId = step.sentence.id;
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
      next: following[0] ?? null,
      following,
    };
  }

  const chapter = book.getCurrentChapter();
  if (!book.currentBook || !chapter || chapter.sentences.length === 0) return { kind: 'none' };
  const sentenceIndex = book.getCurrentSentenceIndex();
  const sentence = chapter.sentences[sentenceIndex];

  // Последующие фразы для текстовых книг (в т.ч. через границы глав)
  const following: PhraseRef[] = [];
  for (let i = sentenceIndex + 1; i < chapter.sentences.length && following.length < maxAhead; i++) {
    following.push({ chapterKey: chapter.id, sentence: chapter.sentences[i] });
  }
  if (autoAdvanceChapter && following.length < maxAhead && book.currentBook.chapters) {
    for (let cIdx = book.currentChapterIndex + 1; cIdx < book.currentBook.chapters.length && following.length < maxAhead; cIdx++) {
      const nextCh = book.currentBook.chapters[cIdx];
      if (!nextCh || !nextCh.sentences) continue;
      for (let s = 0; s < nextCh.sentences.length && following.length < maxAhead; s++) {
        following.push({ chapterKey: nextCh.id, sentence: nextCh.sentences[s] });
      }
    }
  }

  return {
    kind: 'phrase',
    bookId: book.currentBook.metadata.id,
    chapterKey: chapter.id,
    sentence,
    positionFix: false,
    chapterTitle: chapter.title,
    announceIndex: sentenceIndex,
    next: following[0] ?? null,
    following,
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
