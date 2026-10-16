import { create } from 'zustand';
import type { BookQuality, PagedMeta, PdfEngine } from '../types/book';
import type { ComposedBook, PageState } from '../types/pdf';

/**
 * Состояние постраничного распознавания открытой PDF-книги (для UI и плеера).
 * Данные страниц живут в таблице Dexie pdfPages; сюда попадает только производное: статусы, счётчики и
 * собранный из страниц ComposedBook. Команды вызываются через API Домена (engine/pdf/pagedSession.ts).
 */

interface PagedState {
  bookId: string | null;
  pageCount: number;
  states: PageState[];
  errors: Record<number, string>;
  doneCount: number;
  errorCount: number;
  runningCount: number;
  engine: PdfEngine;
  paused: boolean;
  /** Актуальные метаданные постраничной книги (движок, авто-очистка, ручные главы) */
  meta: PagedMeta | null;
  composed: ComposedBook | null;
  quality: BookQuality | null;
  /** Страница, на которую смотрит пользователь / которую читают */
  focusPage: number;
  /** Увеличивается при явной навигации (переход к странице/главе) — виды прокручиваются к currentPage */
  navNonce: number;

  reset(): void;
  stateOf(page: number): PageState;
  setFocusPage(page: number): void;
}

export const usePagedStore = create<PagedState>((set, get) => ({
  bookId: null,
  pageCount: 0,
  states: [],
  errors: {},
  doneCount: 0,
  errorCount: 0,
  runningCount: 0,
  engine: 'auto',
  paused: false,
  meta: null,
  composed: null,
  quality: null,
  focusPage: 1,
  navNonce: 0,

  reset: () =>
    set({
      bookId: null,
      pageCount: 0,
      states: [],
      errors: {},
      doneCount: 0,
      errorCount: 0,
      runningCount: 0,
      paused: false,
      meta: null,
      composed: null,
      quality: null,
      focusPage: 1,
    }),

  stateOf: (page) => get().states[page - 1] ?? 'pending',

  setFocusPage: (page) => {
    const p = Math.max(1, Math.min(get().pageCount || 1, Math.round(page) || 1));
    if (p !== get().focusPage) set({ focusPage: p });
  },
}));

// Отладка в dev-режиме (консоль браузера / проверка из инструментов): window.__aibrPaged
if (typeof window !== 'undefined' && (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __aibrPaged?: typeof usePagedStore }).__aibrPaged = usePagedStore;
}
