/**
 * Планировщик постраничного распознавания PDF («скользящее окно»). Чистая логика без DOM/Tauri:
 * всё внешнее (запуск распознавания, таймеры, часы) приходит через зависимости, поэтому покрывается юнит-тестами.
 *
 * Приоритет страниц:
 *   1. текущая страница (центр окна);
 *   2. опережающие center+1 … center+lookahead (по умолчанию 3) — «срочные»;
 *   3. фон: дальше вперёд по возрастанию (если разрешён фон), затем назад center-1, center-2 … 1.
 *
 * Правила:
 *   - одновременно не более maxConcurrent вызовов (по умолчанию 2); второй слот берут только срочные страницы,
 *     чтобы длинный фоновый вызов (OCR) не задерживал текущую страницу;
 *   - соседние страницы одной «группы» (одинаковый движок) пакетируются в один вызов: для срочной — urgentBatchSize,
 *     для фона — batchSize (холодный старт sidecar ~1.3 с, лимит страниц за вызов — maxPagesPerCall = 20);
 *   - при смене центра (прыжок) очередь не хранится — следующая задача выбирается заново при каждом pump(),
 *     запущенные вызовы заканчиваются, незапущенные «отменяются» сами собой;
 *   - ошибка: страница возвращается в pending с экспоненциальной задержкой (retryBaseMs·2^(n-1) ≤ retryMaxMs),
 *     после maxRetries попыток (или при fatal) становится error; неудавшийся пакет разбирается на одиночные запросы;
 *   - при создании состояние running превращается в pending (возобновление после закрытия книги).
 */

export type SchedState = 'pending' | 'running' | 'done' | 'error';

export interface SchedulerConfig {
  /** Сколько страниц после текущей считаются срочными */
  lookahead: number;
  /** Максимум одновременных вызовов (1–2) */
  maxConcurrent: number;
  /** Размер пакета для фоновых страниц */
  batchSize: number;
  /** Размер пакета, начинающегося со срочной страницы */
  urgentBatchSize: number;
  /** Жёсткий лимит страниц за вызов (sidecar: 20) */
  maxPagesPerCall: number;
  /** Сколько попыток делать до состояния error */
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /** Распознавать ли страницы вне окна опережения (для платных движков можно выключить) */
  background: boolean;
}

export const DEFAULT_LOOKAHEAD = 3;

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  lookahead: DEFAULT_LOOKAHEAD,
  maxConcurrent: 2,
  batchSize: 3,
  urgentBatchSize: 2,
  maxPagesPerCall: 20,
  maxRetries: 3,
  retryBaseMs: 1500,
  retryMaxMs: 30000,
  background: true,
};

export interface BatchOutcome {
  page: number;
  ok: boolean;
  error?: string;
  /** Повторять бессмысленно (неверный ключ, нет Tesseract): сразу error */
  fatal?: boolean;
}

export interface SchedulerDeps {
  /** Распознаёт пакет; результаты сохраняет сам вызывающий. isStale(page) — страницу сбросили во время вызова. */
  run(pages: number[], ctx: { isStale: (page: number) => boolean }): Promise<BatchOutcome[]>;
  onStatus?(page: number, state: SchedState, info: { error?: string; attempts: number }): void;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  /** Страницы с разным ключом не попадают в один пакет (например, разные движки) */
  groupOf?(page: number): string;
}

/** Порядок приоритета страниц: центр, вперёд по возрастанию, затем назад. */
export function priorityOrder(pageCount: number, center: number, _lookahead = DEFAULT_LOOKAHEAD): number[] {
  const c = Math.min(Math.max(1, Math.round(center) || 1), Math.max(1, pageCount));
  const out: number[] = [];
  for (let p = c; p <= pageCount; p++) out.push(p);
  for (let p = c - 1; p >= 1; p--) out.push(p);
  return out;
}

export function isUrgentPage(page: number, center: number, lookahead: number): boolean {
  return page >= center && page <= center + lookahead;
}

/** Экспоненциальная задержка перед повтором (attempt — номер уже сделанной неудачной попытки, с 1). */
export function retryDelay(attempt: number, cfg: Pick<SchedulerConfig, 'retryBaseMs' | 'retryMaxMs'>): number {
  return Math.min(cfg.retryMaxMs, cfg.retryBaseMs * Math.pow(2, Math.max(0, attempt - 1)));
}

interface PageSlot {
  state: SchedState;
  attempts: number;
  retryAt: number;
  gen: number;
  solo: boolean;
  error?: string;
}

export class PageScheduler {
  readonly pageCount: number;
  private cfg: SchedulerConfig;
  private deps: SchedulerDeps;
  private slots: PageSlot[];
  private center = 1;
  private calls = 0;
  private timer: unknown = null;
  private disposed = false;
  private paused = false;

  constructor(
    pageCount: number,
    initial: (page: number) => SchedState,
    deps: SchedulerDeps,
    cfg: Partial<SchedulerConfig> = {},
  ) {
    this.pageCount = pageCount;
    this.deps = deps;
    this.cfg = { ...DEFAULT_SCHEDULER_CONFIG, ...cfg };
    this.slots = Array.from({ length: pageCount + 1 }, (_, p) => {
      const s = p === 0 ? 'done' : initial(p);
      return { state: s === 'running' ? 'pending' : s, attempts: 0, retryAt: 0, gen: 0, solo: false };
    });
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  getConfig(): SchedulerConfig {
    return { ...this.cfg };
  }

  setConfig(patch: Partial<SchedulerConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    this.pump();
  }

  getState(page: number): SchedState {
    return this.slots[page]?.state ?? 'done';
  }

  getError(page: number): string | undefined {
    return this.slots[page]?.error;
  }

  getCenter(): number {
    return this.center;
  }

  counts(): Record<SchedState, number> {
    const c: Record<SchedState, number> = { pending: 0, running: 0, done: 0, error: 0 };
    for (let p = 1; p <= this.pageCount; p++) c[this.slots[p].state]++;
    return c;
  }

  /** Страницы в порядке запуска (только ожидающие) — для отладки и тестов. */
  queued(limit = Infinity): number[] {
    const out: number[] = [];
    for (const p of priorityOrder(this.pageCount, this.center, this.cfg.lookahead)) {
      if (this.slots[p].state === 'pending') out.push(p);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Центр окна (текущая страница). Очередь перестраивается: следующая задача выбирается заново. */
  setCenter(page: number): void {
    const c = Math.min(Math.max(1, Math.round(page) || 1), this.pageCount);
    this.center = c;
    this.pump();
  }

  private emit(page: number): void {
    const s = this.slots[page];
    this.deps.onStatus?.(page, s.state, { error: s.error, attempts: s.attempts });
  }

  private sameGroup(a: number, b: number): boolean {
    const g = this.deps.groupOf;
    return !g || g(a) === g(b);
  }

  private eligible(page: number, now: number): boolean {
    const s = this.slots[page];
    return s.state === 'pending' && s.retryAt <= now;
  }

  private pickBatch(now: number): number[] | null {
    const { lookahead, background, maxPagesPerCall } = this.cfg;
    for (const p of priorityOrder(this.pageCount, this.center, lookahead)) {
      if (!this.eligible(p, now)) continue;
      const urgent = isUrgentPage(p, this.center, lookahead);
      if (!urgent && (!background || this.calls >= 1)) continue; // второй слот — только срочным
      const size = Math.max(1, Math.min(maxPagesPerCall, urgent ? this.cfg.urgentBatchSize : this.cfg.batchSize));
      const pages = [p];
      if (!this.slots[p].solo) {
        const down = p < this.center; // фон «назад»: пакет растёт вниз
        let q = down ? p - 1 : p + 1;
        while (
          pages.length < size &&
          q >= 1 &&
          q <= this.pageCount &&
          this.eligible(q, now) &&
          !this.slots[q].solo &&
          this.sameGroup(p, q)
        ) {
          pages.push(q);
          q += down ? -1 : 1;
        }
      }
      return pages.sort((a, b) => a - b);
    }
    return null;
  }

  /** Остановить/продолжить запуск новых вызовов распознавания. */
  setPaused(on: boolean): void {
    if (this.paused === on) return;
    this.paused = on;
    this.pump();
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Запускает доступные задачи; вызывается при любом изменении состояния. */
  pump(): void {
    if (this.disposed) return;
    if (this.timer !== null) {
      this.deps.clearTimer ? this.deps.clearTimer(this.timer) : clearTimeout(this.timer as ReturnType<typeof setTimeout>);
      this.timer = null;
    }
    // Пауза: новые вызовы не стартуют (идущие дорабатывают), ожидание backoff не планируем
    if (this.paused) return;
    const now = this.now();
    while (this.calls < this.cfg.maxConcurrent) {
      const batch = this.pickBatch(now);
      if (!batch) break;
      this.start(batch);
    }
    // Если всё, что осталось, ждёт backoff — разбудим себя позже
    let next = Infinity;
    for (let p = 1; p <= this.pageCount; p++) {
      const s = this.slots[p];
      if (s.state === 'pending' && s.retryAt > now) next = Math.min(next, s.retryAt);
    }
    if (next !== Infinity && this.calls < this.cfg.maxConcurrent) {
      const delay = Math.max(0, next - now);
      const cb = () => {
        this.timer = null;
        this.pump();
      };
      this.timer = this.deps.setTimer ? this.deps.setTimer(cb, delay) : setTimeout(cb, delay);
    }
  }

  private start(pages: number[]): void {
    const gens = new Map<number, number>();
    for (const p of pages) {
      const s = this.slots[p];
      s.state = 'running';
      s.error = undefined;
      gens.set(p, s.gen);
      this.emit(p);
    }
    this.calls++;
    const isStale = (page: number) => this.slots[page]?.gen !== gens.get(page);
    let promise: Promise<BatchOutcome[]>;
    try {
      promise = this.deps.run(pages, { isStale });
    } catch (e) {
      promise = Promise.reject(e);
    }
    promise
      .then(
        (outcomes) => outcomes,
        (err): BatchOutcome[] => {
          const msg = err instanceof Error ? err.message : String(err);
          return pages.map((page) => ({ page, ok: false, error: msg }));
        },
      )
      .then((outcomes) => this.finish(pages, gens, outcomes));
  }

  private finish(pages: number[], gens: Map<number, number>, outcomes: BatchOutcome[]): void {
    this.calls = Math.max(0, this.calls - 1);
    const byPage = new Map(outcomes.map((o) => [o.page, o]));
    const now = this.now();
    const anyFailed = pages.some((p) => !(byPage.get(p)?.ok ?? false));
    for (const p of pages) {
      const s = this.slots[p];
      if (s.gen !== gens.get(p)) continue; // страницу сбросили (перераспознавание) — результат устарел
      const o = byPage.get(p);
      if (o?.ok) {
        s.state = 'done';
        s.attempts = 0;
        s.error = undefined;
        s.solo = false;
      } else {
        s.attempts++;
        s.error = o?.error || 'Не удалось распознать страницу';
        if (o?.fatal || s.attempts >= this.cfg.maxRetries) {
          s.state = 'error';
        } else {
          s.state = 'pending';
          s.retryAt = now + retryDelay(s.attempts, this.cfg);
          if (anyFailed && pages.length > 1) s.solo = true;
        }
      }
      this.emit(p);
    }
    this.pump();
  }

  /** Страница уже готова (результат внешний: ручная правка, пропуск). */
  markDone(page: number): void {
    const s = this.slots[page];
    if (!s) return;
    s.gen++;
    s.state = 'done';
    s.attempts = 0;
    s.error = undefined;
    this.emit(page);
    this.pump();
  }

  /** Сбросить страницы в pending (перераспознавание). Идущие вызовы по ним станут «устаревшими». */
  invalidate(pages: number[]): void {
    for (const p of pages) {
      const s = this.slots[p];
      if (!s) continue;
      s.gen++;
      s.state = 'pending';
      s.attempts = 0;
      s.retryAt = 0;
      s.solo = false;
      s.error = undefined;
      this.emit(p);
    }
    this.pump();
  }

  /** Повторить страницу в состоянии error. */
  retry(page: number): void {
    const s = this.slots[page];
    if (!s || s.state !== 'error') return;
    s.state = 'pending';
    s.attempts = 0;
    s.retryAt = 0;
    s.solo = true;
    s.error = undefined;
    this.emit(page);
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      this.deps.clearTimer ? this.deps.clearTimer(this.timer) : clearTimeout(this.timer as ReturnType<typeof setTimeout>);
      this.timer = null;
    }
  }
}
