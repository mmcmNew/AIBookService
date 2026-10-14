import { db } from '../../storage/db';
import { useSettingsStore } from '../../store/settingsStore';
import { usePagedStore, type PagedController, type RerecognizeRequest } from '../../store/pagedStore';
import type { BookMetadata, ManualChapterStart, PagedMeta, PdfEngine } from '../../types/book';
import type { PdfBlock } from '../parsers/pdfSidecar';
import { computeBookQuality } from '../cleanup/bookQuality';
import { detectShiftedCyrillic } from '../cleanup/shiftedCyrillic';
import { composeBook, createComposeCache } from './composer';
import { cleanBlocks, repairBlocksShifted } from './pageClean';
import { PageScheduler, type BatchOutcome, type SchedulerConfig, type SchedState } from './pageScheduler';
import { closeSidecarHandle, effectiveEngine, recognizePages, RecognitionError, type RecognizerContext } from './recognizers';
import { releasePdfjsDocument } from './pdfjsDoc';
import type { PageState, PdfPageRecord } from './types';

/**
 * Сессия открытой постраничной PDF-книги: загрузка записей страниц из Dexie, планировщик «скользящего окна»,
 * запись результатов, пересборка глав/предложений (ComposedBook) и публикация в pagedStore.
 * Одновременно живёт одна сессия (открыта одна книга).
 */

export interface SessionInit {
  metadata: BookMetadata;
  /** Исходный PDF (лениво; нужен только распознавателю) */
  getBuffer: () => Promise<ArrayBuffer | undefined>;
  startPage: number;
  /** Сохранить метаданные книги (запись в таблицу книг выполняет Библиотека — её владелец) */
  saveBookMeta?: (bookId: string, patch: Record<string, unknown>) => Promise<void>;
}

/** Конфигурация планировщика под движок. Платные/медленные движки не распознают всю книгу в фоне без нужды. */
export function schedulerConfigFor(engine: PdfEngine, meta?: Pick<PagedMeta, 'recommendedMode'>): Partial<SchedulerConfig> {
  switch (effectiveEngine(engine)) {
    case 'gemini':
      // Каждая страница — платный запрос: только окно опережения, по одной странице, с длинным backoff
      return { maxConcurrent: 2, batchSize: 1, urgentBatchSize: 1, background: false, lookahead: 4, retryBaseMs: 4000 };
    case 'ocr':
      return { maxConcurrent: 2, batchSize: 2, urgentBatchSize: 1, background: true };
    case 'pdfjs':
      return { maxConcurrent: 2, batchSize: 4, urgentBatchSize: 2, background: true };
    default:
      // sidecar auto/text: для сканов (OCR по умолчанию) пакеты меньше
      return meta?.recommendedMode === 'ocr'
        ? { maxConcurrent: 2, batchSize: 2, urgentBatchSize: 1, background: true }
        : { maxConcurrent: 2, batchSize: 3, urgentBatchSize: 2, background: true };
  }
}

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : String(e));

class PagedSession {
  readonly bookId: string;
  meta: PagedMeta;
  private metadata: BookMetadata;
  private records = new Map<number, PdfPageRecord>();
  private overrides = new Map<number, PdfEngine>();
  private states: PageState[] = [];
  private errors: Record<number, string> = {};
  private scheduler!: PageScheduler;
  private cache = createComposeCache();
  private composeTimer: ReturnType<typeof setTimeout> | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private metaTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private unsubSettings: (() => void) | null = null;
  private lastRules: unknown = null;
  private onHidden: (() => void) | null = null;
  private init: SessionInit;

  constructor(init: SessionInit) {
    this.init = init;
    this.metadata = init.metadata;
    this.bookId = init.metadata.id;
    this.meta = { ...(init.metadata.paged as PagedMeta) };
  }

  private rctx(): RecognizerContext {
    return {
      bookId: this.bookId,
      fileName: this.metadata.fileName || `${this.metadata.title}.pdf`,
      getBuffer: this.init.getBuffer,
      bodyFontSize: this.meta.bodyFontSize,
      getGeminiKey: () => useSettingsStore.getState().apiKeys.gemini,
    };
  }

  private engineOf(page: number): PdfEngine {
    return effectiveEngine(this.overrides.get(page) ?? this.meta.engine);
  }

  async open(): Promise<void> {
    const n = this.meta.pageCount;
    const rows = await db.pdfPages.where('bookId').equals(this.bookId).toArray();
    this.states = Array.from({ length: n }, () => 'pending' as PageState);
    for (const r of rows) {
      if (r.page < 1 || r.page > n) continue;
      if (r.status === 'done') {
        this.records.set(r.page, r);
        this.states[r.page - 1] = 'done';
      } else if (r.engine) {
        // running/pending/error -> pending при открытии (возобновление); запрос другого движка сохраняется
        this.overrides.set(r.page, r.engine);
      }
    }
    this.meta.pagesDone = this.states.filter((x) => x === 'done').length;
    this.scheduler = new PageScheduler(
      n,
      (p) => this.states[p - 1] as SchedState,
      {
        run: (pages, ctx) => this.run(pages, ctx),
        onStatus: (page, state, info) => this.onStatus(page, state, info),
        groupOf: (p) => this.engineOf(p),
      },
      schedulerConfigFor(this.meta.engine, this.meta),
    );
    // Не теряем счётчики/качество при сворачивании окна и закрытии вкладки
    this.onHidden = () => {
      if (document.visibilityState === 'hidden') void this.persistMeta();
    };
    document.addEventListener('visibilitychange', this.onHidden);
    window.addEventListener('pagehide', this.onHidden);
    this.lastRules = useSettingsStore.getState().replacementRules;
    this.unsubSettings = useSettingsStore.subscribe((s) => {
      if (s.replacementRules !== this.lastRules) {
        this.lastRules = s.replacementRules;
        this.scheduleCompose();
      }
    });

    const st = usePagedStore.getState();
    st.reset();
    usePagedStore.setState({
      bookId: this.bookId,
      pageCount: n,
      engine: this.meta.engine,
      meta: { ...this.meta },
      controller: this.controller(),
      focusPage: Math.min(Math.max(1, this.init.startPage), n),
    });
    this.publishStatesNow();
    this.composeNow();
  }

  /** Запускает распознавание от стартовой страницы. */
  start(): void {
    this.scheduler.setCenter(usePagedStore.getState().focusPage);
  }

  // ------------------------------------------------------------------ распознавание

  private async run(pages: number[], ctx: { isStale: (p: number) => boolean }): Promise<BatchOutcome[]> {
    const engine = this.engineOf(pages[0]);
    let results;
    try {
      results = await recognizePages(engine, pages, this.rctx());
    } catch (e) {
      const fatal = e instanceof RecognitionError ? e.fatal : false;
      return pages.map((page) => ({ page, ok: false, error: errText(e), fatal }));
    }
    const outcomes: BatchOutcome[] = [];
    const toStore: PdfPageRecord[] = [];
    for (const page of pages) {
      const r = results.find((x) => x.page === page);
      if (!r) {
        outcomes.push({ page, ok: false, error: 'Распознаватель не вернул страницу' });
        continue;
      }
      if (ctx.isStale(page)) {
        outcomes.push({ page, ok: true });
        continue;
      }
      let blocks: PdfBlock[] = r.blocks;
      if (this.meta.autoClean) blocks = cleanBlocks(blocks).blocks;
      const rec: PdfPageRecord = {
        bookId: this.bookId,
        page,
        status: 'done',
        source: r.source,
        blocks,
        width: r.width,
        height: r.height,
        warnings: r.warnings,
        editedByUser: false,
        updatedAt: Date.now(),
      };
      this.records.set(page, rec);
      this.overrides.delete(page);
      toStore.push(rec);
      outcomes.push({ page, ok: true });
    }
    if (toStore.length) {
      try {
        await db.pdfPages.bulkPut(toStore);
      } catch (e) {
        console.warn('[PagedSession] Не удалось сохранить страницы:', e);
      }
    }
    return outcomes;
  }

  private onStatus(page: number, state: SchedState, info: { error?: string; attempts: number }): void {
    this.states[page - 1] = state;
    if (state === 'error') {
      this.errors[page] = info.error || 'Не удалось распознать страницу';
      const row: PdfPageRecord = {
        bookId: this.bookId,
        page,
        status: 'error',
        blocks: [],
        warnings: [],
        editedByUser: false,
        engine: this.overrides.get(page),
        error: this.errors[page],
        attempts: info.attempts,
        updatedAt: Date.now(),
      };
      void db.pdfPages.put(row).catch(() => undefined);
    } else {
      delete this.errors[page];
    }
    if (state === 'done') {
      this.scheduleCompose();
      this.scheduleMeta();
    }
    this.schedulePublish();
  }

  // ------------------------------------------------------------------ публикация

  private schedulePublish(): void {
    if (this.disposed || this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.publishStatesNow();
    }, 40);
  }

  private publishStatesNow(): void {
    if (this.disposed) return;
    let done = 0;
    let err = 0;
    let running = 0;
    for (const s of this.states) {
      if (s === 'done') done++;
      else if (s === 'error') err++;
      else if (s === 'running') running++;
    }
    usePagedStore.setState({ states: this.states.slice(), errors: { ...this.errors }, doneCount: done, errorCount: err, runningCount: running });
  }

  private scheduleCompose(): void {
    if (this.disposed || this.composeTimer) return;
    this.composeTimer = setTimeout(() => {
      this.composeTimer = null;
      this.composeNow();
    }, 80);
  }

  private composeNow(): void {
    if (this.disposed) return;
    if (this.composeTimer) {
      clearTimeout(this.composeTimer);
      this.composeTimer = null;
    }
    const composed = composeBook(
      {
        pageCount: this.meta.pageCount,
        outline: this.meta.outline,
        getRecord: (p) => this.records.get(p),
        rules: useSettingsStore.getState().replacementRules,
        manual: this.meta.chapterStarts,
        lang: this.metadata.lang || 'ru',
      },
      this.cache,
    );
    usePagedStore.setState({ composed });
  }

  // ------------------------------------------------------------------ метаданные и качество

  private scheduleMeta(): void {
    if (this.disposed || this.metaTimer) return;
    this.metaTimer = setTimeout(() => {
      this.metaTimer = null;
      void this.persistMeta();
    }, 2500);
  }

  async persistMeta(): Promise<void> {
    if (this.metaTimer) {
      clearTimeout(this.metaTimer);
      this.metaTimer = null;
    }
    let done = 0;
    let err = 0;
    for (const s of this.states) {
      if (s === 'done') done++;
      else if (s === 'error') err++;
    }
    this.meta.pagesDone = done;
    this.meta.pagesError = err;
    if (!this.disposed) usePagedStore.setState({ meta: { ...this.meta } });
    const composed = usePagedStore.getState().composed;
    let quality = usePagedStore.getState().quality;
    if (composed && done >= 3) {
      try {
        quality = computeBookQuality({
          metadata: { ...this.metadata, paged: this.meta },
          chapters: composed.chapters.filter((c) => c.sentences.length > 0),
          rawPdfBuffer: undefined,
        });
        if (!this.disposed) usePagedStore.setState({ quality });
      } catch (e) {
        console.warn('[PagedSession] Не удалось оценить качество:', e);
      }
    }
    try {
      const patch: Record<string, unknown> = { 'metadata.paged': this.meta };
      if (quality) patch['metadata.quality'] = quality;
      await this.init.saveBookMeta?.(this.bookId, patch);
    } catch (e) {
      console.warn('[PagedSession] Не удалось сохранить метаданные книги:', e);
    }
  }

  // ------------------------------------------------------------------ команды

  private controller(): PagedController {
    return {
      setCenter: (page) => this.scheduler.setCenter(page),
      retryPage: (page) => this.scheduler.retry(page),
      skipPage: (page) => this.skipPage(page),
      rerecognize: (req) => this.rerecognize(req),
      savePageBlocks: (page, blocks) => this.savePageBlocks(page, blocks),
      setEngine: (engine) => this.setEngine(engine),
      setPaused: (on) => {
        this.scheduler.setPaused(on);
        usePagedStore.setState({ paused: on });
      },
      switchEngine: (engine, fromPage) => this.switchEngine(engine, fromPage),
      setAutoClean: (on) => {
        this.meta.autoClean = on;
        void this.persistMeta();
      },
      cleanRecognizedPages: () => this.mapRecords((b) => cleanBlocks(b)),
      repairShiftedPages: () => this.mapRecords((b) => repairBlocksShifted(b)),
      setManualChapters: (starts) => this.setManualChapters(starts),
      getPageBlocks: (page) => this.records.get(page)?.blocks ?? null,
      isEdited: (page) => Boolean(this.records.get(page)?.editedByUser),
      getPageMeta: (page) => {
        const r = this.records.get(page);
        return r ? { source: r.source, edited: r.editedByUser, skipped: Boolean(r.skipped), warnings: r.warnings } : null;
      },
      countShiftedPages: () => {
        let n = 0;
        for (const r of this.records.values()) if (r.blocks.some((b) => detectShiftedCyrillic(b.text).isShifted)) n++;
        return n;
      },
    };
  }

  private async skipPage(page: number): Promise<void> {
    const rec: PdfPageRecord = {
      bookId: this.bookId,
      page,
      status: 'done',
      source: 'manual',
      blocks: [],
      warnings: ['skipped-by-user'],
      editedByUser: false,
      skipped: true,
      updatedAt: Date.now(),
    };
    this.records.set(page, rec);
    await db.pdfPages.put(rec).catch(() => undefined);
    this.scheduler.markDone(page);
    this.composeNow();
    this.scheduleMeta();
  }

  private async rerecognize(req: RerecognizeRequest): Promise<{ queued: number; skippedEdited: number }> {
    const from = Math.max(1, req.from);
    const to = Math.min(this.meta.pageCount, req.to);
    const pages: number[] = [];
    let skippedEdited = 0;
    for (let p = from; p <= to; p++) {
      if (!req.overwriteEdited && this.records.get(p)?.editedByUser) {
        skippedEdited++;
        continue;
      }
      pages.push(p);
    }
    if (pages.length === 0) return { queued: 0, skippedEdited };
    const whole = from === 1 && to === this.meta.pageCount && skippedEdited === 0;
    if (whole && req.engine !== this.meta.engine) this.setEngine(req.engine);
    const rows: PdfPageRecord[] = [];
    for (const p of pages) {
      this.records.delete(p);
      delete this.errors[p];
      if (whole) this.overrides.delete(p);
      else this.overrides.set(p, req.engine);
      rows.push({
        bookId: this.bookId,
        page: p,
        status: 'pending',
        blocks: [],
        warnings: [],
        editedByUser: false,
        engine: whole ? undefined : req.engine,
        updatedAt: Date.now(),
      });
    }
    await db.pdfPages.bulkPut(rows).catch(() => undefined);
    this.composeNow();
    this.scheduler.invalidate(pages);
    this.scheduleMeta();
    return { queued: pages.length, skippedEdited };
  }

  private async savePageBlocks(page: number, blocks: PdfBlock[]): Promise<void> {
    const prev = this.records.get(page);
    const rec: PdfPageRecord = {
      bookId: this.bookId,
      page,
      status: 'done',
      source: 'manual',
      blocks,
      width: prev?.width,
      height: prev?.height,
      warnings: prev?.warnings ?? [],
      editedByUser: true,
      updatedAt: Date.now(),
    };
    this.records.set(page, rec);
    await db.pdfPages.put(rec).catch(() => undefined);
    if (this.scheduler.getState(page) !== 'done') this.scheduler.markDone(page);
    this.composeNow();
    this.scheduleMeta();
  }

  private async switchEngine(engine: PdfEngine, fromPage: number): Promise<number> {
    this.setEngine(engine);
    this.scheduler.setPaused(false);
    usePagedStore.setState({ paused: false });
    const redo: number[] = [];
    const rows: PdfPageRecord[] = [];
    for (let p = Math.max(1, fromPage); p <= this.meta.pageCount; p++) {
      this.overrides.delete(p); // индивидуальные движки страниц больше не нужны — берётся движок книги
      const st = this.scheduler.getState(p);
      if (st === 'error' || st === 'pending') {
        this.records.delete(p);
        delete this.errors[p];
        redo.push(p);
        rows.push({ bookId: this.bookId, page: p, status: 'pending', blocks: [], warnings: [], editedByUser: false, updatedAt: Date.now() });
      }
    }
    if (rows.length) await db.pdfPages.bulkPut(rows).catch(() => undefined);
    if (redo.length) this.scheduler.invalidate(redo);
    this.scheduleMeta();
    return redo.length;
  }

  private setEngine(engine: PdfEngine): void {
    this.meta.engine = engine;
    this.scheduler.setConfig(schedulerConfigFor(engine, this.meta));
    usePagedStore.setState({ engine });
    void this.persistMeta();
  }

  private async mapRecords(fn: (b: PdfBlock[]) => { blocks: PdfBlock[]; changed: number }): Promise<number> {
    const rows: PdfPageRecord[] = [];
    let changedBlocks = 0;
    for (const r of this.records.values()) {
      if (r.editedByUser || r.blocks.length === 0) continue;
      const res = fn(r.blocks);
      if (res.changed > 0) {
        changedBlocks += res.changed;
        const next = { ...r, blocks: res.blocks, updatedAt: Date.now() };
        this.records.set(r.page, next);
        rows.push(next);
      }
    }
    if (rows.length) {
      await db.pdfPages.bulkPut(rows).catch(() => undefined);
      this.composeNow();
      this.scheduleMeta();
    }
    return changedBlocks;
  }

  private async setManualChapters(starts: ManualChapterStart[] | undefined): Promise<void> {
    this.meta.chapterStarts = starts && starts.length ? starts : undefined;
    usePagedStore.setState({ meta: { ...this.meta } });
    this.composeNow();
    await this.persistMeta();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.persistMeta();
    this.disposed = true;
    this.scheduler.dispose();
    this.unsubSettings?.();
    if (this.onHidden) {
      document.removeEventListener('visibilitychange', this.onHidden);
      window.removeEventListener('pagehide', this.onHidden);
    }
    for (const t of [this.composeTimer, this.publishTimer, this.metaTimer]) if (t) clearTimeout(t);
    await closeSidecarHandle(this.bookId);
    releasePdfjsDocument(this.bookId);
  }
}

let active: PagedSession | null = null;

export async function openPagedSession(init: SessionInit): Promise<void> {
  await closePagedSession();
  if (!init.metadata.paged) throw new Error('Книга не является постраничной');
  const s = new PagedSession(init);
  active = s;
  await s.open();
  s.start();
}

export async function closePagedSession(): Promise<void> {
  const s = active;
  active = null;
  if (s) {
    await s.dispose();
    usePagedStore.getState().reset();
  }
}

/** Выставляет страницу фокуса распознавания (владелец st_paged: b_dom_pdf) */
export function setFocusPage(page: number): void {
  usePagedStore.getState().setFocusPage(page);
}

/** Увеличивает navNonce при явной навигации для обновления видов (владелец st_paged: b_dom_pdf) */
export function bumpNavNonce(): void {
  usePagedStore.setState((s) => ({ navNonce: s.navNonce + 1 }));
}
