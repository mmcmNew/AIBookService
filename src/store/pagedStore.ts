import { create } from 'zustand';
import type { BookQuality, ManualChapterStart, PagedMeta, PdfEngine } from '../types/book';
import type { ComposedBook, PageSource, PageState, PdfBlock } from '../types/pdf';

/**
 * Состояние постраничного распознавания открытой PDF-книги (для UI и плеера).
 * Данные страниц живут в таблице Dexie pdfPages; сюда попадает только производное: статусы, счётчики и
 * собранный из страниц ComposedBook. Команды делегируются контроллеру активной сессии (engine/pdf/pagedSession.ts).
 */

export interface RerecognizeRequest {
  from: number;
  to: number;
  engine: PdfEngine;
  /** Перезаписать и страницы с ручными правками (требует подтверждения в UI) */
  overwriteEdited: boolean;
}

export interface PagedController {
  /** Центр окна распознавания (текущая страница) */
  setCenter(page: number): void;
  retryPage(page: number): void;
  /** Пропустить страницу: помечается готовой и пустой, чтение идёт дальше */
  skipPage(page: number): Promise<void>;
  rerecognize(req: RerecognizeRequest): Promise<{ queued: number; skippedEdited: number }>;
  /** Сохранить ручную правку страницы (editedByUser = true, source = manual) */
  savePageBlocks(page: number, blocks: PdfBlock[]): Promise<void>;
  setEngine(engine: PdfEngine): void;
  /** Остановить/продолжить распознавание (идущий вызов дорабатывает, новые не стартуют) */
  setPaused(on: boolean): void;
  /**
   * Сменить движок для всей книги с указанной страницы: уже распознанные страницы не трогаются,
   * страницы с ошибкой и ещё не распознанные идут новым движком.
   */
  switchEngine(engine: PdfEngine, fromPage: number): Promise<number>;
  setAutoClean(on: boolean): void;
  /** Очистка уже распознанных страниц (markdown, мусорные символы, пробелы); правленые вручную не трогает */
  cleanRecognizedPages(): Promise<number>;
  /** Исправление сдвинутой кириллицы на распознанных страницах (по решению пользователя) */
  repairShiftedPages(): Promise<number>;
  setManualChapters(starts: ManualChapterStart[] | undefined): Promise<void>;
  getPageBlocks(page: number): PdfBlock[] | null;
  isEdited(page: number): boolean;
  /** Источник и предупреждения распознавания страницы (null — страница ещё не готова) */
  getPageMeta(page: number): { source?: PageSource; edited: boolean; skipped: boolean; warnings: string[] } | null;
  /** Сколько распознанных страниц содержат сдвинутую кириллицу */
  countShiftedPages(): number;
}

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
  controller: PagedController | null;

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
  controller: null,

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
      controller: null,
    }),

  stateOf: (page) => get().states[page - 1] ?? 'pending',

  setFocusPage: (page) => {
    const p = Math.max(1, Math.min(get().pageCount || 1, Math.round(page) || 1));
    if (p !== get().focusPage) set({ focusPage: p });
    get().controller?.setCenter(p);
  },
}));

// Отладка в dev-режиме (консоль браузера / проверка из инструментов): window.__aibrPaged
if (typeof window !== 'undefined' && (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __aibrPaged?: typeof usePagedStore }).__aibrPaged = usePagedStore;
}
