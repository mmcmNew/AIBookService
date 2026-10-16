import type { UpdateSpec } from 'dexie';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { db, loadPdfBuffer, type StoredBook } from '../storage/db';
import { BookMetadata, Chapter, Footnote, ParsedBook } from '../types/book';
import { computeBookQuality, needsAttention } from './cleanup/bookQuality';
import { mapReadingPosition } from './cleanup/bookModel';
import { useBookStore, type SavedBook } from '../store/bookStore';
import { usePagedStore } from '../store/pagedStore';
import { useSettingsStore } from '../store/settingsStore';
import { loadPdfjsDocument } from './pdf/pdfjsDoc';
import { bumpNavNonce, closePagedSession, deletePagesForBook, openPagedSession, setFocusPage } from './pdf/pagedSession';
import {
  chapterIndexForPage,
  firstSentenceAtOrAfterPage,
  firstSentenceOnPage,
  locateSentence,
  sentencePage,
  type ComposedBook,
} from './pdf/composer';
import { isPageReady, type CurrentPhrase } from './phrases';
import {
  configurePosition,
  currentPhrase as positionCurrentPhrase,
  getPendingJump,
  goToPage as positionGoToPage,
  jumpToSentence as positionJumpToSentence,
  nextPhrase as positionNextPhrase,
  onExternalMove,
  pagedBookOpen,
  resetPosition,
  selectChapter as positionSelectChapter,
  setPendingJump,
  setViewPage as positionSetViewPage,
  stepPhrase as positionStepPhrase,
  writePosition,
  type ExternalMove,
  type ProgressPatch,
  type StepResult,
} from './bookPosition';
import { deleteAudioCacheForBook, purgeOrphanAudioCache } from './audio/audioFetch';
import { parseBookFile, type ParseOptions } from './parsers';
import type { ReplacementRule } from '../types/settings';

// ---------------------------------------------------------------------------
// Сохранение прогресса чтения: накапливаем патчи и пишем в IndexedDB с задержкой,
// чтобы не делать запись на каждое озвученное предложение и не получать гонки.
// ---------------------------------------------------------------------------
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

/** Сохранить прогресс сейчас (накопленное по позиции). Записи выстраиваются в очередь (без гонок). */
export function flushProgress(): Promise<void> {
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
        console.warn('[Library] Не удалось сохранить прогресс чтения:', e);
      }
    }
  });
  return progressWriteChain;
}

export function discardPendingProgress(bookId: string): void {
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
    console.warn('[Library] Не удалось сохранить обложку, продолжаем без неё:', e);
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

// Позиция чтения — зона Менеджера книги (bookPosition.ts): побочные действия подключаем здесь
configurePosition({
  saveProgress: queueProgress,
  flushProgress,
  showPage: (page, onlyIfChanged = false) => {
    if (onlyIfChanged && usePagedStore.getState().focusPage === page) return;
    setFocusPage(page);
  },
  bumpNavNonce,
});

/** Новая сборка глав из страниц: обновляем главы, не сдвигая позицию чтения (она определяется по предложению). */
export function applyComposed(composed: ComposedBook): void {
  const st = useBookStore.getState();
  const book = pagedBookOpen();
  if (!book) return;
  let sentenceId = st.currentSentenceId;
  const jumpPage = getPendingJump();
  if (jumpPage != null && composed.pages[jumpPage - 1]?.state === 'done') {
    const target = firstSentenceOnPage(composed, jumpPage) ?? firstSentenceAtOrAfterPage(composed, jumpPage);
    sentenceId = target?.id ?? null;
    setPendingJump(null);
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

  useBookStore.setState({
    currentBook: { ...book, metadata, chapters: composed.chapters },
  });
  writePosition({ chapterIndex, sentenceId });
}

// Слушаем изменения распознанных страниц из usePagedStore
export function onPagedStoreChange(
  state: ReturnType<typeof usePagedStore.getState>,
  prev: ReturnType<typeof usePagedStore.getState>
): void {
  if (state.composed && state.composed !== prev.composed) {
    applyComposed(state.composed);
  } else if ((state.quality !== prev.quality && state.quality) || (state.meta !== prev.meta && state.meta)) {
    const book = pagedBookOpen();
    if (book) {
      useBookStore.setState({
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
}

usePagedStore.subscribe(onPagedStoreChange);

/** Открывает сессию постраничного распознавания и выставляет позицию чтения. */
export async function activatePaged(metadata: BookMetadata, rawPdfBuffer: ArrayBuffer | undefined): Promise<void> {
  const paged = metadata.paged!;
  const startPage = Math.min(Math.max(1, metadata.lastPage ?? 1), paged.pageCount);
  await openPagedSession({
    metadata,
    startPage,
    getBuffer: async () => (rawPdfBuffer && rawPdfBuffer.byteLength > 0 ? rawPdfBuffer : loadPdfBuffer(metadata.id)),
    saveBookMeta: async (bookId, patch) => {
      await db.books.update(bookId, patch as UpdateSpec<StoredBook>);
    },
  });
  const composed = usePagedStore.getState().composed as ComposedBook;
  let sentenceId: number | null = metadata.lastSentenceId ?? null;
  let currentPage = startPage;
  if (sentenceId != null && composed.indexById.has(sentenceId)) {
    currentPage = metadata.lastPage ?? sentencePage(composed.order[composed.indexById.get(sentenceId) as number]);
  } else {
    sentenceId = null;
  }
  setPendingJump(null);
  if (sentenceId == null) {
    // Позиция ещё не распознана: первое предложение страницы появится, когда страница будет готова
    if (composed.pages[currentPage - 1]?.state === 'done') {
      sentenceId = (firstSentenceOnPage(composed, currentPage) ?? firstSentenceAtOrAfterPage(composed, currentPage))?.id ?? null;
    } else {
      setPendingJump(currentPage);
    }
  }
  const chapterIndex =
    sentenceId != null && composed.chapterOfSentence.has(sentenceId)
      ? (composed.chapterOfSentence.get(sentenceId) as number)
      : chapterIndexForPage(composed, currentPage);

  useBookStore.setState({
    currentBook: { metadata, chapters: composed.chapters, notes: {}, rawPdfBuffer },
    pdfViewMode: rawPdfBuffer ? 'original' : 'reflow',
    isLoading: false,
    qualityNotice: null,
  });
  writePosition({ chapterIndex, sentenceId, page: currentPage });
  setFocusPage(currentPage);
}

// ---------------------------------------------------------------------------
// Публичные команды библиотеки (UI -> Domain)
// ---------------------------------------------------------------------------

/** Загрузить книгу из файла: парсит файл (с учётом правил замены и настроек) и сохраняет книгу. */
export async function loadBookFromFile(
  file: File,
  replacementRules?: ReplacementRule[],
  options?: ParseOptions
): Promise<void> {
  const rules = replacementRules ?? useSettingsStore.getState().replacementRules;
  const parsedBook = await parseBookFile(file, rules, options);
  await loadBook(parsedBook);
}

/**
 * Перераспознать PDF уже открытой книги: парсит файл в заданном режиме и загружает результат.
 * Если парсер не вернул исходный PDF, подставляется переданный буфер.
 */
export async function reparsePdfBook(
  file: File,
  replacementRules: ReplacementRule[],
  options: ParseOptions,
  fallbackBuffer?: ArrayBuffer
): Promise<void> {
  const newBook = await parseBookFile(file, replacementRules, options);
  if (!newBook.rawPdfBuffer && fallbackBuffer) {
    newBook.rawPdfBuffer = fallbackBuffer;
  }
  await loadBook(newBook);
}

export async function loadBook(parsed: ParsedBook): Promise<void> {
  useBookStore.setState({ isLoading: true, error: null });
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
      void loadSavedBooksList();
      return;
    }
    await closePagedSession();
    const book: ParsedBook = { ...parsed, metadata };
    // Оценка качества распознанного текста (хранится в записи книги)
    try {
      book.metadata = { ...book.metadata, quality: computeBookQuality(book) };
    } catch (qe) {
      console.warn('[Library] Не удалось оценить качество текста:', qe);
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
      console.warn('[Library] Ошибка сохранения с rawPdfBuffer, повторная попытка без бинарника:', putErr);
      await db.books.put({
        id: book.metadata.id,
        metadata: book.metadata,
        chapters: book.chapters,
        notes: book.notes,
      });
    }

    useBookStore.setState({
      currentBook: book,
      pdfViewMode: book.rawPdfBuffer ? 'original' : 'reflow',
      isLoading: false,
      qualityNotice:
        book.metadata.quality && needsAttention(book.metadata.quality)
          ? { bookId: book.metadata.id, title: book.metadata.title, quality: book.metadata.quality }
          : null,
    });
    writePosition({ chapterIndex, sentenceId, page: 1 });

    void loadSavedBooksList();
  } catch (err) {
    console.error('[Library] Ошибка в loadBook:', err);
    useBookStore.setState({ error: errorText(err, 'Не удалось сохранить книгу в локальную базу данных'), isLoading: false });
    throw err;
  }
}

export async function selectSavedBook(bookId: string): Promise<void> {
  const token = ++selectToken;
  useBookStore.setState({ isLoading: true, error: null });
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
          .catch((e) => console.warn('[Library] Не удалось сохранить оценку качества:', e));
      } catch (qe) {
        console.warn('[Library] Не удалось оценить качество текста:', qe);
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

    useBookStore.setState({
      currentBook: book,
      pdfViewMode: book.rawPdfBuffer ? 'original' : 'reflow',
      isLoading: false,
    });
    writePosition({ chapterIndex: safeChapterIndex, sentenceId: lastSentenceId, page: 1 });
  } catch (err) {
    if (token !== selectToken) return;
    useBookStore.setState({ error: errorText(err, 'Не удалось открыть книгу'), isLoading: false });
  }
}

export async function loadSavedBooksList(): Promise<void> {
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
    useBookStore.setState({ savedBooks: list });
  } catch (e) {
    console.warn('[Library] Ошибка загрузки списка сохранённых книг:', e);
  }
}

export async function deleteBook(bookId: string): Promise<void> {
  discardPendingProgress(bookId);
  try {
    await progressWriteChain;
    if (useBookStore.getState().currentBook?.metadata.id === bookId) await closePagedSession();
    await db.transaction('rw', db.books, db.pdfFiles, async () => {
      await db.books.delete(bookId);
      await db.pdfFiles.delete(bookId);
    });
    // Удаление страниц через владельца ресурса res_pdfPages (b_dom_pdf)
    await deletePagesForBook(bookId);
    // Удаление аудиокэша через владельца ресурса res_audioCache (b_dom_fetch)
    await deleteAudioCacheForBook(bookId);

    if (useBookStore.getState().currentBook?.metadata.id === bookId) {
      useBookStore.setState({ currentBook: null });
      resetPosition();
    }
    await loadSavedBooksList();
  } catch (e) {
    console.error('[Library] Ошибка удаления книги:', e);
    throw e;
  }
}

export async function closeBook(): Promise<void> {
  bookObserver?.onBookClosing();
  await flushProgress();
  useBookStore.setState({ currentBook: null, activeFootnote: null });
  resetPosition();
  setPendingJump(null);
  await closePagedSession();
  await loadSavedBooksList();
}

export async function replaceBookChapters(chapters: Chapter[], options?: { title?: string }): Promise<void> {
  const state = useBookStore.getState();
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
  await db.transaction('rw', db.books, async () => {
    await db.books.update(book.metadata.id, { chapters, metadata: next.metadata } as UpdateSpec<StoredBook>);
  });

  // Аудиокэш ключуется по id предложения и тексту: неизменённые предложения сохраняют id и остаются в кэше,
  // у изменённых id новые. Удаляем через ответственного b_dom_fetch записи для предложений, которых в книге больше нет.
  const valid = new Map<string, Set<number>>();
  for (const c of chapters) valid.set(c.id, new Set(c.sentences.map((s) => s.id)));
  await purgeOrphanAudioCache(book.metadata.id, valid);

  useBookStore.setState({
    currentBook: next,
    pdfViewMode: next.rawPdfBuffer ? 'reflow' : state.pdfViewMode,
  });
  writePosition({ chapterIndex: pos.chapterIndex, sentenceId: pos.sentenceId });

  void loadSavedBooksList();
}

// ---------------------------------------------------------------------------
// Вход зоны для Координатора: ответы о книге («какая фраза сейчас / следующая?»).
// Координатор не читает книгу и страницы PDF сам и позицию не меняет — он спрашивает здесь.
// ---------------------------------------------------------------------------

/** Текущая фраза (позиция не сдвигается): фраза | ждём страницу | конец (внутри — Поставщик фраз) */
export function currentPhrase(autoAdvanceChapter: boolean): CurrentPhrase {
  return positionCurrentPhrase(autoAdvanceChapter);
}

/** Следующая фраза: позиция сдвигается сразу, ответ — фраза | ждём страницу | конец */
export function nextPhrase(autoAdvanceChapter: boolean): StepResult {
  return positionNextPhrase(autoAdvanceChapter);
}

/** Страница PDF распознана и вошла в сборку книги */
export function pageReady(page: number): boolean {
  return isPageReady(page);
}

// ---------------------------------------------------------------------------
// Навигация для UI: Менеджер сам двигает позицию, копит прогресс и, если переход пришёл не от Координатора,
// сообщает ему событием «внешний переход».
// ---------------------------------------------------------------------------

/** Клик по предложению */
export function jumpToSentence(sentenceId: number): void {
  positionJumpToSentence(sentenceId);
}

/** Выбор главы */
export function selectChapter(index: number): void {
  positionSelectChapter(index);
}

/** Перейти на страницу PDF (первая фраза страницы, если она уже распознана) */
export function goToPage(page: number): void {
  positionGoToPage(page);
}

/** Страница просмотра PDF (чтение не сдвигается) */
export function setViewPage(page: number): void {
  positionSetViewPage(page);
}

/** Шаг на одну фразу: 1 — следующая (через главы), -1 — предыдущая */
export function stepPhrase(delta: 1 | -1): void {
  positionStepPhrase(delta);
}

/** Показать страницу PDF как «в фокусе» (onlyIfChanged — не трогать, если фокус уже на ней) */
export function focusPage(page: number, onlyIfChanged = false): void {
  if (onlyIfChanged && usePagedStore.getState().focusPage === page) return;
  setFocusPage(page);
}

export type { ExternalMove };

export interface BookObserver {
  /** Пользователь сдвинул позицию (клик, глава, страница, шаг ±1 фраза): переход не от Координатора */
  onExternalMove: (move: ExternalMove) => void;
  /** Распознаны страницы PDF: возможно, дождались нужной («страница готова») */
  onPagesChanged: () => void;
  /** Книга сменена или закрыта */
  onBookChanged: () => void;
  /** Книгу сейчас закроют (до сохранения прогресса): воспроизведение нужно остановить */
  onBookClosing: () => void;
}

let bookObserver: BookObserver | null = null;

/** Координатор подписывается на события зоны книги (подписки на сторы живут внутри зоны книги) */
export function observeBook(observer: BookObserver): void {
  bookObserver = observer;
  onExternalMove(observer.onExternalMove);
  usePagedStore.subscribe((state, prev) => {
    // Явную навигацию по PDF (navNonce) Менеджер сообщает сам событием «внешний переход»
    if (state.navNonce !== prev.navNonce) return;
    observer.onPagesChanged();
  });
  useBookStore.subscribe((state, prev) => {
    if (state.currentBook?.metadata.id !== prev.currentBook?.metadata.id) observer.onBookChanged();
  });
}

export function setActiveFootnote(activeFootnote: Footnote | null): void {
  useBookStore.setState({ activeFootnote });
}

export function clearQualityNotice(): void {
  useBookStore.setState({ qualityNotice: null });
}

export function setPdfViewMode(mode: 'original' | 'reflow'): void {
  useBookStore.setState({ pdfViewMode: mode });
}

export function clearBookError(): void {
  useBookStore.setState({ error: null });
}

/** Исходный PDF книги из базы данных (db.pdfFiles / db.books) */
export async function getPdfBuffer(bookId: string): Promise<ArrayBuffer | undefined> {
  return loadPdfBuffer(bookId);
}

/** Загружает и кэширует документ pdf.js для оригинального просмотра страниц */
export async function getPdfDocument(bookId: string): Promise<PDFDocumentProxy> {
  const getBuffer = async () => {
    const inMemory = useBookStore.getState().currentBook?.rawPdfBuffer;
    if (inMemory && inMemory.byteLength > 0) return inMemory;
    const file = await db.pdfFiles.get(bookId);
    const restored = file?.buffer && file.buffer.byteLength > 0 ? file.buffer : await loadPdfBuffer(bookId);
    if (restored) {
      useBookStore.setState((state) =>
        state.currentBook && state.currentBook.metadata.id === bookId
          ? { currentBook: { ...state.currentBook, rawPdfBuffer: restored } }
          : {}
      );
    }
    return restored;
  };
  return loadPdfjsDocument(bookId, getBuffer);
}
