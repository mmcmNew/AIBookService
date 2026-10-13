import { create } from 'zustand';
import { BookMetadata, BookQuality, Chapter, Footnote, ParsedBook } from '../types/book';

/** Метаданные книги + доля прочитанного (0..1), вычисляемая при загрузке списка. */
export type SavedBook = BookMetadata & { progress: number };

/** Уведомление «качество распознавания низкое» после импорта книги (показывается один раз). */
export interface QualityNotice {
  bookId: string;
  title: string;
  quality: BookQuality;
}

export interface BookState {
  currentBook: ParsedBook | null;
  /** Ожидающее показа уведомление о низком качестве текста (обрабатывает QualityWatcher) */
  qualityNotice: QualityNotice | null;
  currentChapterIndex: number;
  currentSentenceId: number | null;
  activeFootnote: Footnote | null;
  savedBooks: SavedBook[];
  isLoading: boolean;
  error: string | null;
  pdfViewMode: 'original' | 'reflow';
  /** Постраничные PDF: текущая страница (читаемая или просматриваемая) */
  currentPage: number;

  // Чистые сеттеры состояния (без вызовов Домена, Data и Infra)
  setCurrentBook: (book: ParsedBook | null) => void;
  setSavedBooks: (savedBooks: SavedBook[]) => void;
  setIsLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
  setQualityNotice: (notice: QualityNotice | null) => void;
  clearQualityNotice: () => void;
  setPdfViewMode: (mode: 'original' | 'reflow') => void;
  setActiveFootnote: (footnote: Footnote | null) => void;

  // Позиция чтения (владелец: b_dom_coord)
  setPosition: (pos: { chapterIndex?: number; sentenceId?: number | null; page?: number }) => void;
  setChapterIndex: (index: number) => void;
  setSentenceId: (id: number | null) => void;
  setViewPage: (page: number) => void;
  resetPosition: () => void;

  // Геттеры текущей позиции
  getCurrentChapter: () => Chapter | null;
  getCurrentSentenceIndex: () => number;
}

export const useBookStore = create<BookState>((set, get) => ({
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

  setCurrentBook: (currentBook) => set({ currentBook }),
  setSavedBooks: (savedBooks) => set({ savedBooks }),
  setIsLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
  setQualityNotice: (qualityNotice) => set({ qualityNotice }),
  clearQualityNotice: () => set({ qualityNotice: null }),
  setPdfViewMode: (pdfViewMode) => set({ pdfViewMode }),
  setActiveFootnote: (activeFootnote) => set({ activeFootnote }),

  setPosition: (pos) =>
    set((state) => ({
      currentChapterIndex: pos.chapterIndex !== undefined ? pos.chapterIndex : state.currentChapterIndex,
      currentSentenceId: pos.sentenceId !== undefined ? pos.sentenceId : state.currentSentenceId,
      currentPage: pos.page !== undefined ? pos.page : state.currentPage,
    })),

  setChapterIndex: (index) => set({ currentChapterIndex: index }),
  setSentenceId: (id) => set({ currentSentenceId: id }),
  setViewPage: (page) => set({ currentPage: page }),
  resetPosition: () => set({ currentChapterIndex: 0, currentSentenceId: null, currentPage: 1 }),

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
}));

if (typeof window !== 'undefined' && (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __aibrBook?: typeof useBookStore }).__aibrBook = useBookStore;
}
