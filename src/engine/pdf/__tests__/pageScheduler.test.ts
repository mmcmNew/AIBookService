import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PageScheduler,
  priorityOrder,
  retryDelay,
  isUrgentPage,
  type BatchOutcome,
  type SchedState,
  DEFAULT_SCHEDULER_CONFIG,
} from '../pageScheduler';

/** Управляемый «движок»: каждый вызов run() ждёт, пока тест его завершит. */
function makeHarness(pageCount: number, cfg: Parameters<typeof PageScheduler.prototype.setConfig>[0] = {}, initial: (p: number) => SchedState = () => 'pending') {
  let clock = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const calls: Array<{ pages: number[]; resolve: (o: BatchOutcome[]) => void; isStale: (p: number) => boolean }> = [];
  const log: string[] = [];
  const sched = new PageScheduler(
    pageCount,
    initial,
    {
      run: (pages, ctx) =>
        new Promise<BatchOutcome[]>((resolve) => {
          calls.push({ pages, resolve, isStale: ctx.isStale });
        }),
      onStatus: (page, state) => log.push(`${page}:${state}`),
      now: () => clock,
      setTimer: (fn, ms) => {
        const t = { at: clock + ms, fn };
        timers.push(t);
        return t;
      },
      clearTimer: (h) => {
        const i = timers.indexOf(h as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
    },
    cfg,
  );
  const ok = (pages: number[]): BatchOutcome[] => pages.map((page) => ({ page, ok: true }));
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    sched,
    calls,
    log,
    ok,
    flush,
    advance(ms: number) {
      clock += ms;
      for (const t of timers.slice()) {
        if (t.at <= clock) {
          timers.splice(timers.indexOf(t), 1);
          t.fn();
        }
      }
    },
    pendingTimers: () => timers.length,
  };
}

test('порядок приоритета: текущая, вперёд по возрастанию, затем назад', () => {
  assert.deepEqual(priorityOrder(8, 4), [4, 5, 6, 7, 8, 3, 2, 1]);
  assert.deepEqual(priorityOrder(5, 1), [1, 2, 3, 4, 5]);
  assert.deepEqual(priorityOrder(5, 99), [5, 4, 3, 2, 1]);
  assert.equal(isUrgentPage(4, 4, 3), true);
  assert.equal(isUrgentPage(7, 4, 3), true);
  assert.equal(isUrgentPage(8, 4, 3), false);
  assert.equal(isUrgentPage(3, 4, 3), false);
});

test('экспоненциальный backoff с потолком', () => {
  const c = { retryBaseMs: 1000, retryMaxMs: 5000 };
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => retryDelay(n, c)), [1000, 2000, 4000, 5000, 5000]);
});

test('первый запуск: пакет начинается с текущей страницы, размер срочного пакета ограничен', async () => {
  const h = makeHarness(50, { maxConcurrent: 1, urgentBatchSize: 2, batchSize: 3 });
  h.sched.setCenter(10);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].pages, [10, 11]);
  h.calls[0].resolve(h.ok([10, 11]));
  await h.flush();
  // Следующий пакет — страницы 12.. (срочное окно 10..13 -> urgentBatch=2: 12,13)
  assert.deepEqual(h.calls[1].pages, [12, 13]);
  h.calls[1].resolve(h.ok([12, 13]));
  await h.flush();
  // Дальше фон: пачками по 3 вперёд
  assert.deepEqual(h.calls[2].pages, [14, 15, 16]);
});

test('не более maxConcurrent вызовов; второй слот только для срочных страниц', async () => {
  const h = makeHarness(100, { maxConcurrent: 2, urgentBatchSize: 1, batchSize: 3, lookahead: 3 });
  h.sched.setCenter(1);
  // Слот 1: страница 1; слот 2: срочная страница 2 (фон во второй слот не идёт)
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls.map((c) => c.pages), [[1], [2]]);
  h.calls[0].resolve(h.ok([1]));
  await h.flush();
  assert.equal(h.sched.counts().running <= 2, true);
  assert.deepEqual(h.calls[2].pages, [3]);
  h.calls[1].resolve(h.ok([2]));
  h.calls[2].resolve(h.ok([3]));
  await h.flush();
  // Срочные закончились: фон занимает только один слот
  await h.flush();
  const open = h.calls.filter((c) => c.pages[0] >= 4);
  assert.equal(open.length, 1, 'в фоне одновременно не более одного вызова');
  assert.deepEqual(open[0].pages, [4], 'страница 4 ещё в окне опережения (1+3)');
});

test('прыжок на другую страницу: следующая задача выбирается заново, идущие вызовы заканчиваются', async () => {
  const h = makeHarness(100, { maxConcurrent: 1, urgentBatchSize: 1, batchSize: 3 });
  h.sched.setCenter(1);
  assert.deepEqual(h.calls[0].pages, [1]);
  h.sched.setCenter(60); // прыжок во время вызова
  assert.equal(h.calls.length, 1, 'новый вызов не стартует, пока занят единственный слот');
  assert.deepEqual(h.sched.queued(3), [60, 61, 62]);
  h.calls[0].resolve(h.ok([1]));
  await h.flush();
  assert.deepEqual(h.calls[1].pages, [60]);
  assert.equal(h.sched.getState(2), 'pending', 'старые срочные задачи не запускались');
});

test('фон идёт вперёд от текущей, затем назад', async () => {
  const h = makeHarness(6, { maxConcurrent: 1, urgentBatchSize: 1, batchSize: 1, lookahead: 1 });
  h.sched.setCenter(3);
  const seen: number[] = [];
  for (let i = 0; i < 6; i++) {
    await h.flush();
    const c = h.calls[i];
    if (!c) break;
    seen.push(...c.pages);
    c.resolve(h.ok(c.pages));
  }
  assert.deepEqual(seen, [3, 4, 5, 6, 2, 1]);
});

test('background=false: вне окна опережения ничего не запускается', async () => {
  const h = makeHarness(30, { maxConcurrent: 1, urgentBatchSize: 1, background: false, lookahead: 2 });
  h.sched.setCenter(5);
  for (let i = 0; i < 6; i++) {
    await h.flush();
    const c = h.calls[i];
    if (!c) break;
    c.resolve(h.ok(c.pages));
  }
  await h.flush();
  assert.deepEqual(h.calls.flatMap((c) => c.pages), [5, 6, 7]);
  assert.equal(h.sched.getState(8), 'pending');
});

test('готовые страницы пропускаются, пакет не включает чужие', async () => {
  const h = makeHarness(10, { maxConcurrent: 1, urgentBatchSize: 3, batchSize: 3 }, (p) => (p === 2 ? 'done' : 'pending'));
  h.sched.setCenter(1);
  assert.deepEqual(h.calls[0].pages, [1]); // страница 2 готова: пакет не тянется через неё
});

test('ошибка: backoff, затем повтор; после maxRetries — error, retry() возвращает в работу', async () => {
  const h = makeHarness(3, { maxConcurrent: 1, urgentBatchSize: 1, batchSize: 1, maxRetries: 2, retryBaseMs: 1000 }, (p) => (p === 1 ? 'pending' : 'done'));
  h.sched.setCenter(1);
  h.calls[0].resolve([{ page: 1, ok: false, error: 'boom' }]);
  await h.flush();
  assert.equal(h.sched.getState(1), 'pending');
  assert.equal(h.calls.length, 1, 'повтор ждёт backoff');
  assert.equal(h.pendingTimers(), 1);
  h.advance(999);
  assert.equal(h.calls.length, 1);
  h.advance(1);
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve([{ page: 1, ok: false, error: 'boom2' }]);
  await h.flush();
  assert.equal(h.sched.getState(1), 'error');
  assert.equal(h.sched.getError(1), 'boom2');
  h.sched.retry(1);
  assert.equal(h.calls.length, 3);
  h.calls[2].resolve(h.ok([1]));
  await h.flush();
  assert.equal(h.sched.getState(1), 'done');
});

test('fatal-ошибка сразу переводит страницу в error без повторов', async () => {
  const h = makeHarness(2, { maxConcurrent: 1, urgentBatchSize: 1, batchSize: 1, maxRetries: 5 }, (p) => (p === 1 ? 'pending' : 'done'));
  h.sched.setCenter(1);
  h.calls[0].resolve([{ page: 1, ok: false, error: 'нет ключа', fatal: true }]);
  await h.flush();
  assert.equal(h.sched.getState(1), 'error');
});

test('сбой пакета: страницы повторяются поодиночке', async () => {
  const h = makeHarness(3, { maxConcurrent: 1, urgentBatchSize: 3, batchSize: 3, retryBaseMs: 10 });
  h.sched.setCenter(1);
  assert.deepEqual(h.calls[0].pages, [1, 2, 3]);
  h.calls[0].resolve([{ page: 1, ok: true }, { page: 2, ok: false, error: 'x' }, { page: 3, ok: true }]);
  await h.flush();
  h.advance(20);
  assert.deepEqual(h.calls[1].pages, [2]);
});

test('исключение из run() трактуется как ошибка пакета', async () => {
  let n = 0;
  const sched = new PageScheduler(
    2,
    () => 'pending',
    {
      run: async () => {
        n++;
        throw new Error('crash');
      },
    },
    { ...DEFAULT_SCHEDULER_CONFIG, maxConcurrent: 1, maxRetries: 1 },
  );
  sched.setCenter(1);
  await new Promise((r) => setImmediate(r));
  assert.equal(sched.getState(1), 'error');
  assert.equal(sched.getError(1), 'crash');
  assert.ok(n >= 1);
  sched.dispose();
});

test('invalidate во время вызова: результат устарел, страница заново в очереди', async () => {
  const h = makeHarness(3, { maxConcurrent: 1, urgentBatchSize: 1, batchSize: 1 }, (p) => (p === 1 ? 'pending' : 'done'));
  h.sched.setCenter(1);
  const call = h.calls[0];
  h.sched.invalidate([1]);
  assert.equal(call.isStale(1), true);
  call.resolve(h.ok([1]));
  await h.flush();
  assert.equal(h.sched.getState(1), 'running', 'новый запуск после сброса');
  assert.equal(h.calls.length, 2);
});

test('возобновление: running при создании превращается в pending', () => {
  const h = makeHarness(3, { maxConcurrent: 1 }, (p) => (p === 1 ? 'running' : 'done'));
  assert.equal(h.sched.getState(1), 'pending');
  assert.deepEqual(h.sched.queued(), [1]);
});

test('пакеты не смешивают группы (разные движки)', async () => {
  const calls: number[][] = [];
  const sched = new PageScheduler(
    6,
    () => 'pending',
    {
      run: (pages) => {
        calls.push(pages);
        return new Promise<BatchOutcome[]>(() => undefined);
      },
      groupOf: (p) => (p <= 3 ? 'ocr' : 'text'),
    },
    { maxConcurrent: 1, urgentBatchSize: 6, batchSize: 6 },
  );
  sched.setCenter(1);
  assert.deepEqual(calls[0], [1, 2, 3]);
  sched.dispose();
});

test('лимит страниц за вызов', () => {
  const calls: number[][] = [];
  const sched = new PageScheduler(
    100,
    () => 'pending',
    { run: (pages) => (calls.push(pages), new Promise<BatchOutcome[]>(() => undefined)) },
    { maxConcurrent: 1, urgentBatchSize: 50, batchSize: 50, maxPagesPerCall: 20 },
  );
  sched.setCenter(1);
  assert.equal(calls[0].length, 20);
  sched.dispose();
});

test('пауза: новые вызовы не стартуют, после продолжения очередь идёт дальше', async () => {
  const h = makeHarness(10);
  h.sched.setPaused(true);
  h.sched.setCenter(1);
  await h.flush();
  assert.equal(h.calls.length, 0, 'при паузе вызовов нет');
  assert.equal(h.sched.isPaused(), true);
  h.sched.setPaused(false);
  await h.flush();
  assert.ok(h.calls.length > 0, 'после продолжения вызовы стартуют');
});
