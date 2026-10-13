import { create } from 'zustand';
import type { UpdateSpec } from 'dexie';
import { db, loadPdfBuffer, type StoredBook } from '../storage/db';
import { BookMetadata, BookQuality, Chapter, Footnote, ParsedBook } from '../types/book';
import { computeBookQuality, needsAttention } from '../engine/cleanup/bookQuality';
import { mapReadingPosition } from '../engine/cleanup/bookModel';
import { usePagedStore } from './pagedStore';
import { closePagedSession, openPagedSession } from '../engine/pdf/pagedSession';
import {
  chapterIndexForPage,
  firstSentenceAtOrAfterPage,
  firstSentenceOnPage,
  locateSentence,
  sentencePage,
  type ComposedBook,
} from '../engine/pdf/composer';

/** Метаданные книги + доля прочитанного (0..1), вычисляемая при загрузке списка. */
export type SavedBook = BookMetadata & { progress: number };

/** Уведомление «качество распознавания низкое» после импорта книги (показывается один раз). */
export interface QualityNotice {
  bookId: string;
  title: string;
  quality: BookQuality;
}

interface BookState {
  currentBook: ParsedBook | null;
  /** Ожидающее показа уведомление о низком качестве текста (обрабатывает QualityWatcher) */
  qualityNotice: QualityNotice | null;
  clearQualityNotice: () => void;
  /**
   * Заменить главы текущей книги после редактирования: сохраняет в IndexedDB, пересчитывает оценку качества,
   * подбирает ближайшую позицию чтения и очищает устаревший аудиокэш.
   */
  replaceBookChapters: (chapters: Chapter[], options?: { title?: string }) => Promise<void>;
  currentChapterIndex: number;
  currentSentenceId: number | null;
  activeFootnote: Footnote | null;
  savedBooks: SavedBook[];
  isLoading: boolean;
  error: string | null;

  pdfViewMode: 'original' | 'reflow';
  setPdfViewMode: (mode: 'original' | 'reflow') => void;
  /** Постраничные PDF: текущая страница (читаемая или просматриваемая) */
  currentPage: number;
  /** Явный переход к странице (номер страницы, «перейти к странице», оглавление): позиция = {страница, предложение} */
  goToPage: (page: number) => void;
  /** Страница, которую пользователь прокрутил вручную: двигает окно распознавания, предложение не меняет */
  setViewPage: (page: number) => void;
  loadBook: (book: ParsedBook) => Promise<void>;
  selectSavedBook: (bookId: string) => Promise<void>;
  loadSavedBooksList: () => Promise<void>;
  deleteBook: (bookId: string) => Promise<void>;
  /** Закрыть текущую книгу (с сохранением позиции) и вернуться в библиотеку */
  closeBook: () => Promise<void>;
  clearError: () => void;
  setChapterIndex: (index: number) => void;
  setSentenceId: (id: number) => void;
  setActiveFootnote: (footnote: Footnote | null) => void;
  getCurrentChapter: () => Chapter | null;
  getCurrentSentenceIndex: () => number;
}

// ---------------------------------------------------------------------------
// Сохранение прогресса чтения: накапливаем патчи и пишем в IndexedDB с задержкой,
// чтобы не делать запись на каждое озвученное предложение и не получать гонки.
// ---------------------------------------------------------------------------
interface ProgressPatch {
  'metadata.lastReadAt'?: number;
  'metadata.lastChapterId'?: string;
  'metadata.lastSentenceId'?: number;
  'metadata.lastPage'?: number;
}

const PROGRESS_DEBOUNCE_MS = 600;
const pendingProgress = new Map<string, ProgressPatch>();
let progressTimer: ReturnType<typeof setTimeout> | null = null;
let progressWriteChain: Promise<void> = Promise.resolve();

function queueProgress(bookId: string, patch: ProgressPatch): void {
  pendingProgress.set(bookId, { ...(pendingProgress.get(bookId) ?? {}), ...patch });
  if (progressTimer) clearTimeout(progressTimer);
  progressTimer = setTimeout(() => {
    void flushProgress();
  }, PROGRESS_DEBOUNCE_MS);
}

/** Немедленно записать накопленный прогресс. Записи выстраиваются в очередь (без гонок). */
function flushProgress(): Promise<void> {
  if (progressTimer) {
    clearTimeout(progressTimer);
    progressTimer = null;
  }
  const batch = Array.from(pendingProgress.entries());
  pendingProgress.clear();
  if (batch.length === 0) return progressWriteChain;

  progressWriteChain = progressWriteChain.then(async () => {
    for (const [bookId, patch] of batch) {
      try {
        await db.books.update(bookId, patch as UpdateSpec<StoredBook>);
      } catch (e) {
        console.warn('[BookStore] Не удалось сохранить прогресс чтения:', e);
      }
    }
  });
  return progressWriteChain;
}

function discardPendingProgress(bookId: string): void {
  pendingProgress.delete(bookId);
}

// Не теряем позицию при закрытии вкладки / сворачивании приложения
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    void flushProgress();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushProgress();
  });
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/** Доля прочитанного 0..1 по числу предложений до текущей позиции. */
function computeProgress(chapters: Chapter[], lastChapterId?: string, lastSentenceId?: number): number {
  if (!lastChapterId) return 0;
  let total = 0;
  let before = 0;
  let found = false;
  for (const chapter of chapters) {
    const count = chapter.sentences.length;
    if (!found && chapter.id === lastChapterId) {
      const idx = lastSentenceId == null ? 0 : chapter.sentences.findIndex((s) => s.id === lastSentenceId);
      before += idx > 0 ? idx : 0;
      found = true;
    } else if (!found) {
      before += count;
    }
    total += count;
  }
  if (!found || total === 0) return 0;
  return Math.min(1, before / total);
}

/** Доля прочитанного постраничной книги: по номеру последней страницы. */
function pagedProgress(m: BookMetadata): number {
  const total = m.paged?.pageCount ?? 0;
  if (!total || (m.lastPage == null && m.lastSentenceId == null)) return 0;
  return Math.max(0, Math.min(1, ((m.lastPage ?? 1) - 1) / total));
}

/** blob:-ссылки обложек умирают после перезагрузки страницы — превращаем их в data:-URL. */
async function makeCoverPersistent(metadata: BookMetadata): Promise<BookMetadata> {
  const url = metadata.coverUrl;
  if (!url || !url.startsWith('blob:')) return metadata;
  try {
    const blob = await (await fetch(url)).blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    URL.revokeObjectURL(url);
    return { ...metadata, coverUrl: dataUrl };
  } catch (e) {
    console.warn('[BookStore] Не удалось сохранить обложку, продолжаем без неё:', e);
    return { ...metadata, coverUrl: undefined };
  }
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

let selectToken = 0;
let listToken = 0;

export const useBookStore = create<BookState>((set, get) => {
  /** Страница, на которую перешли, но она ещё не распознана: позиция выставится, когда страница будет готова */
  let pendingJump: number | null = null;

  const pagedBookOpen = () => {
    const b = get().currentBook;
    return b && b.metadata.paged && usePagedStore.getState().bookId === b.metadata.id ? b : null;
  };

  /** Новая сборка глав из страниц: обновляем главы, не сдвигая позицию чтения (она определяется по предложению). */
  const applyComposed = (composed: ComposedBook) => {
    const st = get();
    const book = pagedBookOpen();
    if (!book) return;
    let sentenceId = st.currentSentenceId;
    if (pendingJump != null && composed.pages[pendingJump - 1]?.state === 'done') {
      const target = firstSentenceOnPage(composed, pendingJump) ?? firstSentenceAtOrAfterPage(composed, pendingJump);
      sentenceId = target?.id ?? null;
      pendingJump = null;
    } else if (sentenceId != null && !composed.indexById.has(sentenceId)) {
      const page = st.currentPage;
      // Страница перераспознаётся: id вернётся вместе с ней. Иначе берём ближайшее следующее предложение
      if (composed.pages[page - 1]?.state === 'done' && composed.order.length > 0) {
        sentenceId = composed.order[locateSentence(composed, sentenceId)]?.id ?? null;
      }
    }
    const chapterIndex =
      sentenceId != null && composed.chapterOfSentence.has(sentenceId)
        ? (composed.chapterOfSentence.get(sentenceId) as number)
        : chapterIndexForPage(composed, st.currentPage);
    const ps = usePagedStore.getState();
    const paged = book.metadata.paged!;
    const base = ps.meta ?? paged;
    const unchanged =
      paged === base &&
      paged.pagesDone === ps.doneCount &&
      paged.pagesError === ps.errorCount &&
      (ps.quality === null || book.metadata.quality === ps.quality);
    const metadata = unchanged
      ? book.metadata
      : {
          ...book.metadata,
          quality: ps.quality ?? book.metadata.quality,
          paged: { ...base, pagesDone: ps.doneCount, pagesError: ps.errorCount },
        };
    set({
      currentBook: { ...book, metadata, chapters: composed.chapters },
      currentChapterIndex: chapterIndex,
      currentSentenceId: sentenceId,
    });
  };

  usePagedStore.subscribe((state, prev) => {
    if (state.composed && state.composed !== prev.composed) applyComposed(state.composed);
    else if ((state.quality !== prev.quality && state.quality) || (state.meta !== prev.meta && state.meta)) {
      const book = pagedBookOpen();
      if (book) {
        set({
          currentBook: {
            ...book,
            metadata: {
              ...book.metadata,
              quality: state.quality ?? book.metadata.quality,
              paged: state.meta ? { ...state.meta, pagesDone: state.doneCount, pagesError: state.errorCount } : book.metadata.paged,
            },
          },
        });
      }
    }
  });

  /** Открывает сессию постраничного распознавания и выставляет позицию чтения. */
  const activatePaged = async (metadata: BookMetadata, rawPdfBuffer: ArrayBuffer | undefined) => {
    const paged = metadata.paged!;
    const startPage = Math.min(Math.max(1, metadata.lastPage ?? 1), paged.pageCount);
    await openPagedSession({
      metadata,
      startPage,
      getBuffer: async () => (rawPdfBuffer && rawPdfBuffer.byteLength > 0 ? rawPdfBuffer : loadPdfBuffer(metadata.id)),
    });
    const composed = usePagedStore.getState().composed as ComposedBook;
    let sentenceId: number | null = metadata.lastSentenceId ?? null;
    let currentPage = startPage;
    if (sentenceId != null && composed.indexById.has(sentenceId)) {
      currentPage = metadata.lastPage ?? sentencePage(composed.order[composed.indexById.get(sentenceId) as number]);
    } else {
      sentenceId = null;
    }
    pendingJump = null;
    if (sentenceId == null) {
      // Позиция ещё не распознана: первое предложение страницы появится, когда страница будет готова
      if (composed.pages[currentPage - 1]?.state === 'done') {
        sentenceId = (firstSentenceOnPage(composed, currentPage) ?? firstSentenceAtOrAfterPage(composed, currentPage))?.id ?? null;
      } else {
        pendingJump = currentPage;
      }
    }
    const chapterIndex =
      sentenceId != null && composed.chapterOfSentence.has(sentenceId)
        ? (composed.chapterOfSentence.get(sentenceId) as number)
        : chapterIndexForPage(composed, currentPage);
    set({
      currentBook: { metadata, chapters: composed.chapters, notes: {}, rawPdfBuffer },
      currentChapterIndex: chapterIndex,
      currentSentenceId: sentenceId,
      currentPage,
      pdfViewMode: rawPdfBuffer ? 'original' : 'reflow',
      isLoading: false,
      qualityNotice: null,
    });
    usePagedStore.getState().setFocusPage(currentPage);
  };

  /** Навигация (страница + предложение): повышает navNonce, чтобы виды прокрутились, а плеер перестроился. */
  const navigatePaged = (page: number, sentenceId: number | null, jumpIfUnready: boolean) => {
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
    set({ currentPage: p, currentSentenceId: sentenceId, currentChapterIndex: chapterIndex });
    usePagedStore.setState((s) => ({ navNonce: s.navNonce + 1 }));
    usePagedStore.getState().setFocusPage(p);
    queueProgress(book.metadata.id, {
      'metadata.lastReadAt': Date.now(),
      'metadata.lastPage': p,
      'metadata.lastChapterId': book.chapters[chapterIndex]?.id,
      'metadata.lastSentenceId': sentenceId ?? undefined,
    });
  };

  return {
  currentBook: null,
  qualityNotice: null,
  currentChapterIndex: 0,
  currentSentenceId: null,
  activeFootnote: null,
  savedBooks: [],
  isLoading: false,
  error: null,
  pdfViewMode: 'original',
  currentPage: 1,

  goToPage: (page) => {
    const book = pagedBookOpen();
    if (!book) return;
    const composed = usePagedStore.getState().composed;
    const p = Math.min(Math.max(1, Math.round(page) || 1), book.metadata.paged!.pageCount);
    const ready = composed?.pages[p - 1]?.state === 'done';
    const target = ready && composed ? firstSentenceOnPage(composed, p) ?? firstSentenceAtOrAfterPage(composed, p) : null;
    navigatePaged(p, target?.id ?? null, !ready);
  },

  setViewPage: (page) => {
    const book = pagedBookOpen();
    if (!book) return;
    const p = Math.min(Math.max(1, Math.round(page) || 1), book.metadata.paged!.pageCount);
    if (p === get().currentPage) return;
    set({ currentPage: p });
    usePagedStore.getState().setFocusPage(p);
    queueProgress(book.metadata.id, { 'metadata.lastPage': p, 'metadata.lastReadAt': Date.now() });
  },

  setPdfViewMode: (mode: 'original' | 'reflow') => {
    set({ pdfViewMode: mode });
  },

  clearError: () => set({ error: null }),

  clearQualityNotice: () => set({ qualityNotice: null }),

  replaceBookChapters: async (chapters: Chapter[], options?: { title?: string }) => {
    const state = get();
    const book = state.currentBook;
    if (!book) throw new Error('Нет открытой книги');
    if (chapters.length === 0) throw new Error('В книге должна остаться хотя бы одна глава с текстом');

    await flushProgress();
    const oldChapter = book.chapters[state.currentChapterIndex];
    const pos = mapReadingPosition(book.chapters, chapters, oldChapter?.id, state.currentSentenceId);

    const next: ParsedBook = {
      ...book,
      chapters,
      metadata: {
        ...book.metadata,
        title: options?.title?.trim() || book.metadata.title,
        lastReadAt: Date.now(),
        lastChapterId: chapters[pos.chapterIndex]?.id,
        lastSentenceId: pos.sentenceId ?? undefined,
      },
    };
    next.metadata.quality = computeBookQuality(next);

    discardPendingProgress(book.metadata.id);
    await progressWriteChain;

    // rawPdfBuffer остаётся в записи: обновляем только изменившиеся поля
    await db.transaction('rw', db.books, db.audioCache, async () => {
      await db.books.update(book.metadata.id, { chapters, metadata: next.metadata } as UpdateSpec<StoredBook>);
      // Аудиокэш ключуется по id предложения и тексту: неизменённые предложения сохраняют id и остаются в кэше,
      // у изменённых id новые. Удаляем только записи для предложений, которых в книге больше нет.
      const valid = new Map<string, Set<number>>();
      for (const c of chapters) valid.set(c.id, new Set(c.sentences.map((s) => s.id)));
      await db.audioCache
        .where('bookId')
        .equals(book.metadata.id)
        .filter((a) => !valid.get(a.chapterId)?.has(a.sentenceId))
        .delete();
    });

    set({
      currentBook: next,
      currentChapterIndex: pos.chapterIndex,
      currentSentenceId: pos.sentenceId,
      // Правки относятся к текстовому режиму — показываем его, чтобы изменения были видны
      pdfViewMode: next.rawPdfBuffer ? 'reflow' : get().pdfViewMode,
    });
    void get().loadSavedBooksList();
  },

  loadBook: async (parsed: ParsedBook) => {
    set({ isLoading: true, error: null });
    try {
      const metadata = await makeCoverPersistent(parsed.metadata);
      if (metadata.paged) {
        // Постраничный PDF: книга появляется сразу, текст распознаётся по требованию и в фоне
        await flushProgress();
        const buffer = parsed.rawPdfBuffer;
        if (!buffer || buffer.byteLength === 0) throw new Error('Не найден исходный PDF для постраничного распознавания.');
        const prev = await db.books.get(metadata.id);
        const meta: BookMetadata = { ...metadata, addedAt: prev?.metadata.addedAt ?? metadata.addedAt, lastReadAt: Date.now() };
        discardPendingProgress(meta.id);
        await progressWriteChain;
        await db.transaction('rw', db.books, db.pdfFiles, async () => {
          await db.books.put({ id: meta.id, metadata: meta, chapters: [], notes: {} });
          await db.pdfFiles.put({ bookId: meta.id, buffer });
        });
        await activatePaged(meta, buffer);
        void get().loadSavedBooksList();
        return;
      }
      await closePagedSession();
      const book: ParsedBook = { ...parsed, metadata };
      // Оценка качества распознанного текста (хранится в записи книги)
      try {
        book.metadata = { ...book.metadata, quality: computeBookQuality(book) };
      } catch (qe) {
        console.warn('[BookStore] Не удалось оценить качество текста:', qe);
      }

      // Если такая книга уже есть (повторная загрузка / перераспознавание) — сохраняем дату добавления и позицию
      const previous = await db.books.get(metadata.id);
      let chapterIndex = 0;
      let sentenceId: number | null = book.chapters[0]?.sentences[0]?.id ?? null;
      if (previous) {
        book.metadata = { ...book.metadata, addedAt: previous.metadata.addedAt ?? metadata.addedAt };
        const prevIdx = book.chapters.findIndex((c) => c.id === previous.metadata.lastChapterId);
        const prevSentence = previous.metadata.lastSentenceId;
        if (prevIdx >= 0 && prevSentence != null && book.chapters[prevIdx].sentences.some((s) => s.id === prevSentence)) {
          chapterIndex = prevIdx;
          sentenceId = prevSentence;
        }
      }
      book.metadata = {
        ...book.metadata,
        lastReadAt: Date.now(),
        lastChapterId: book.chapters[chapterIndex]?.id,
        lastSentenceId: sentenceId ?? undefined,
      };

      // Отбрасываем отложенные записи прогресса для этой книги, чтобы они не перезаписали свежую запись
      discardPendingProgress(book.metadata.id);
      await progressWriteChain;

      try {
        await db.books.put({
          id: book.metadata.id,
          metadata: book.metadata,
          chapters: book.chapters,
          notes: book.notes,
          rawPdfBuffer: book.rawPdfBuffer,
        });
      } catch (putErr) {
        console.warn('[BookStore] Ошибка сохранения с rawPdfBuffer, повторная попытка без бинарника:', putErr);
        await db.books.put({
          id: book.metadata.id,
          metadata: book.metadata,
          chapters: book.chapters,
          notes: book.notes,
        });
      }

      set({
        currentBook: book,
        currentChapterIndex: chapterIndex,
        currentSentenceId: sentenceId,
        pdfViewMode: book.rawPdfBuffer ? 'original' : 'reflow',
        isLoading: false,
        qualityNotice:
          book.metadata.quality && needsAttention(book.metadata.quality)
            ? { bookId: book.metadata.id, title: book.metadata.title, quality: book.metadata.quality }
            : null,
      });

      void get().loadSavedBooksList();
    } catch (err) {
      console.error('[BookStore] Ошибка в loadBook:', err);
      set({ error: errorText(err, 'Не удалось сохранить книгу в локальную базу данных'), isLoading: false });
      throw err;
    }
  },

  selectSavedBook: async (bookId: string) => {
    const token = ++selectToken;
    set({ isLoading: true, error: null });
    try {
      await flushProgress();
      const stored = await db.books.get(bookId);
      if (token !== selectToken) return; // пользователь уже выбрал другую книгу
      if (!stored) throw new Error('Книга не найдена в локальной базе данных.');
      if (stored.metadata.paged) {
        const buffer = await loadPdfBuffer(bookId);
        if (token !== selectToken) return;
        if (!buffer) throw new Error('Исходный PDF книги не найден в локальной базе.');
        await activatePaged({ ...stored.metadata, lastReadAt: Date.now() }, buffer);
        return;
      }
      await closePagedSession();

      const book: ParsedBook = {
        metadata: stored.metadata,
        chapters: stored.chapters,
        notes: stored.notes,
        rawPdfBuffer: stored.rawPdfBuffer,
      };
      // Книги, сохранённые до появления проверки качества, оцениваем при первом открытии
      if (!book.metadata.quality) {
        try {
          book.metadata = { ...book.metadata, quality: computeBookQuality(book) };
          void db.books
            .update(bookId, { 'metadata.quality': book.metadata.quality } as UpdateSpec<StoredBook>)
            .catch((e) => console.warn('[BookStore] Не удалось сохранить оценку качества:', e));
        } catch (qe) {
          console.warn('[BookStore] Не удалось оценить качество текста:', qe);
        }
      }

      const chapterIndex = book.chapters.findIndex((c) => c.id === stored.metadata.lastChapterId);
      const safeChapterIndex = chapterIndex >= 0 ? chapterIndex : 0;
      const chapterSentences = book.chapters[safeChapterIndex]?.sentences ?? [];
      const savedSentence = stored.metadata.lastSentenceId;
      // Сохранённое предложение должно принадлежать выбранной главе, иначе начинаем с её начала
      const lastSentenceId =
        savedSentence != null && chapterSentences.some((s) => s.id === savedSentence)
          ? savedSentence
          : chapterSentences[0]?.id ?? null;

      set({
        currentBook: book,
        currentChapterIndex: safeChapterIndex,
        currentSentenceId: lastSentenceId,
        pdfViewMode: book.rawPdfBuffer ? 'original' : 'reflow',
        isLoading: false,
      });
    } catch (err) {
      if (token !== selectToken) return;
      set({ error: errorText(err, 'Не удалось открыть книгу'), isLoading: false });
    }
  },

  loadSavedBooksList: async () => {
    const token = ++listToken;
    try {
      const list: SavedBook[] = [];
      // each() обрабатывает записи по одной, не удерживая в памяти все PDF-буферы сразу
      await db.books.each((b) => {
        list.push({
          ...b.metadata,
          progress: b.metadata.paged
            ? pagedProgress(b.metadata)
            : computeProgress(b.chapters, b.metadata.lastChapterId, b.metadata.lastSentenceId),
        });
      });
      if (token !== listToken) return; // пришёл более свежий запрос
      list.sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt));
      set({ savedBooks: list });
    } catch (e) {
      console.warn('Ошибка загрузки списка сохранённых книг:', e);
    }
  },

  deleteBook: async (bookId: string) => {
    discardPendingProgress(bookId);
    try {
      await progressWriteChain;
      if (get().currentBook?.metadata.id === bookId) await closePagedSession();
      await db.transaction('rw', db.books, db.audioCache, db.pdfPages, db.pdfFiles, async () => {
        await db.books.delete(bookId);
        // Очищаем также аудиокэш, страницы и исходный PDF этой книги
        await db.audioCache.where('bookId').equals(bookId).delete();
        await db.pdfPages.where('bookId').equals(bookId).delete();
        await db.pdfFiles.delete(bookId);
      });

      if (get().currentBook?.metadata.id === bookId) {
        set({ currentBook: null, currentSentenceId: null, currentChapterIndex: 0 });
      }
      await get().loadSavedBooksList();
    } catch (e) {
      console.error('Ошибка удаления книги:', e);
      throw e;
    }
  },

  closeBook: async () => {
    await flushProgress();
    set({ currentBook: null, currentSentenceId: null, currentChapterIndex: 0, activeFootnote: null, currentPage: 1 });
    pendingJump = null;
    await closePagedSession();
    await get().loadSavedBooksList();
  },

  setChapterIndex: (index: number) => {
    const book = get().currentBook;
    if (!book || index < 0 || index >= book.chapters.length) return;
    if (book.metadata.paged) {
      // Глава ведёт на первую страницу главы
      const ch = book.chapters[index];
      const composed = usePagedStore.getState().composed;
      const startPage = ch.startPage ?? 1;
      const first = ch.sentences[0];
      if (composed && first && composed.pages[startPage - 1]?.state === 'done' && sentencePage(first) === startPage) {
        navigatePaged(startPage, first.id, false);
      } else {
        get().goToPage(startPage);
      }
      return;
    }

    const firstSentenceId = book.chapters[index]?.sentences[0]?.id ?? null;
    set({
      currentChapterIndex: index,
      currentSentenceId: firstSentenceId,
    });

    // Сохраняем прогресс (смена главы — значимое событие, пишем сразу)
    queueProgress(book.metadata.id, {
      'metadata.lastReadAt': Date.now(),
      'metadata.lastChapterId': book.chapters[index].id,
      'metadata.lastSentenceId': firstSentenceId ?? undefined,
    });
    void flushProgress();
  },

  setSentenceId: (id: number) => {
    if (get().currentSentenceId === id) return;
    const pagedBook = pagedBookOpen();
    if (pagedBook) {
      const composed = usePagedStore.getState().composed;
      const idx = composed?.indexById.get(id);
      if (composed && idx !== undefined) {
        const page = sentencePage(composed.order[idx]);
        const chapterIndex = composed.chapterOfSentence.get(id) ?? get().currentChapterIndex;
        pendingJump = null;
        set({ currentSentenceId: id, currentPage: page, currentChapterIndex: chapterIndex });
        if (usePagedStore.getState().focusPage !== page) usePagedStore.getState().setFocusPage(page);
        queueProgress(pagedBook.metadata.id, {
          'metadata.lastReadAt': Date.now(),
          'metadata.lastPage': page,
          'metadata.lastChapterId': pagedBook.chapters[chapterIndex]?.id,
          'metadata.lastSentenceId': id,
        });
        return;
      }
    }
    set({ currentSentenceId: id });
    const { currentBook: book, currentChapterIndex } = get();
    if (book) {
      queueProgress(book.metadata.id, {
        'metadata.lastReadAt': Date.now(),
        // Глава сохраняется вместе с предложением, чтобы позиция не «разъезжалась»
        'metadata.lastChapterId': book.chapters[currentChapterIndex]?.id,
        'metadata.lastSentenceId': id,
      });
    }
  },

  setActiveFootnote: (activeFootnote) => set({ activeFootnote }),

  getCurrentChapter: () => {
    const { currentBook, currentChapterIndex } = get();
    if (!currentBook || !currentBook.chapters[currentChapterIndex]) return null;
    return currentBook.chapters[currentChapterIndex];
  },

  getCurrentSentenceIndex: () => {
    const chapter = get().getCurrentChapter();
    const sentenceId = get().currentSentenceId;
    if (!chapter || sentenceId === null) return 0;
    const idx = chapter.sentences.findIndex((s) => s.id === sentenceId);
    return idx >= 0 ? idx : 0;
  },
  };
});

if (typeof window !== 'undefined' && (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __aibrBook?: typeof useBookStore }).__aibrBook = useBookStore;
}
