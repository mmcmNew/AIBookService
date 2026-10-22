import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type express from 'express';
import { createApp } from '../src/app.js';
import { Database, IDatabase, UserRecord } from '../src/db.js';
import { PostgresDatabase } from '../src/postgresDb.js';
import { FakePgPool } from './helpers/fakePgPool.js';
import { createGracefulShutdown } from '../src/shutdown.js';

const SAVED = { ...process.env };
let dir: string;
const serversToClean: Server[] = [];

async function startServer(app: express.Express): Promise<{ server: Server; base: string }> {
  let s!: Server;
  await new Promise<void>((resolve) => {
    s = app.listen(0, resolve);
  });
  serversToClean.push(s);
  return {
    server: s,
    base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
  };
}

beforeEach(() => {
  process.env = { ...SAVED };
  delete process.env.DATABASE_URL;
  process.env.NODE_ENV = 'test';
});

afterEach(async () => {
  while (serversToClean.length > 0) {
    const s = serversToClean.pop();
    if (s) {
      if (typeof (s as any).closeAllConnections === 'function') {
        (s as any).closeAllConnections();
      }
      await new Promise<void>((r) => s.close(() => r()));
    }
  }
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.env = { ...SAVED };
});

test('(а) db.authenticate отклоняется -> GET /api/user/balance отвечает 503, следующий запрос успешен', async () => {
  let dbFails = true;
  const mockUser: UserRecord = {
    id: 'u-auth-test',
    tokenHash: 'abc',
    balance: 5000,
    totalPurchased: 0,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };

  const mockDb: IDatabase = {
    async createUser() {
      return { user: mockUser, token: 'test-token' };
    },
    async authenticate(_token: string) {
      if (dbFails) {
        const err = new Error('Connection terminated unexpectedly');
        (err as any).code = 'ECONNRESET';
        throw err;
      }
      return mockUser;
    },
    async getUser() {
      return mockUser;
    },
    async deductBalance() {
      return { balance: 4000 };
    },
    async refundBalance() {},
    async savePayment() {},
    async getPayment() {
      return null;
    },
    async settlePayment() {
      return 5000;
    },
    async cancelPayment() {
      return true;
    },
    async flush() {},
  };

  const { app } = createApp({ db: mockDb });
  const { base } = await startServer(app);

  // 1. При сбое базы получаем 503 с заголовком Retry-After: 5
  const res1 = await fetch(`${base}/api/user/balance`, {
    headers: { Authorization: 'Bearer test-token' },
  });
  assert.equal(res1.status, 503);
  assert.equal(res1.headers.get('Retry-After'), '5');
  const body1 = (await res1.json()) as any;
  assert.equal(body1.error, 'Сервис временно недоступен. Попробуйте позже.');

  // 2. После «восстановления» базы следующий запрос проходит
  dbFails = false;
  const res2 = await fetch(`${base}/api/user/balance`, {
    headers: { Authorization: 'Bearer test-token' },
  });
  assert.equal(res2.status, 200);
  const body2 = (await res2.json()) as any;
  assert.equal(body2.userId, 'u-auth-test');
  assert.equal(body2.balance, 5000);
});

test('(б) createUser отклоняется -> POST /api/user/register отвечает 503', async () => {
  const mockDb: Partial<IDatabase> = {
    async createUser() {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:5432');
      (err as any).code = 'ECONNREFUSED';
      throw err;
    },
    async flush() {},
  };

  const { app } = createApp({ db: mockDb as IDatabase });
  const { base } = await startServer(app);

  const res = await fetch(`${base}/api/user/register`, { method: 'POST' });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('Retry-After'), '5');
  const body = (await res.json()) as any;
  assert.equal(body.error, 'Сервис временно недоступен. Попробуйте позже.');
});

test('(в) /api/tts/stream: deductBalance отклоняется -> 503; синтез упал и refundBalance отклоняется -> в логе [BILLING]', async () => {
  let deductThrows = true;
  let refundThrows = false;
  let synthThrows = false;

  const mockUser: UserRecord = {
    id: 'u-tts-test',
    tokenHash: 'abc',
    balance: 5000,
    totalPurchased: 0,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };

  const mockDb: IDatabase = {
    async createUser() {
      return { user: mockUser, token: 'test-token' };
    },
    async authenticate() {
      return mockUser;
    },
    async getUser() {
      return mockUser;
    },
    async deductBalance() {
      if (deductThrows) {
        const err = new Error('Database connection failed');
        (err as any).code = '57P01';
        throw err;
      }
      return { balance: 4000 };
    },
    async refundBalance() {
      if (refundThrows) {
        throw new Error('Database is completely offline');
      }
    },
    async savePayment() {},
    async getPayment() {
      return null;
    },
    async settlePayment() {
      return 5000;
    },
    async cancelPayment() {
      return true;
    },
    async flush() {},
  };

  const mockTts = {
    async synthesize() {
      if (synthThrows) {
        throw new Error('TTS provider failed');
      }
      return Buffer.from('RIFF-audio');
    },
  };

  const { app } = createApp({ db: mockDb, tts: mockTts as any });
  const { base } = await startServer(app);

  // 1. deductBalance упал -> 503
  const res1 = await fetch(`${base}/api/tts/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ text: 'Привет мир' }),
  });
  assert.equal(res1.status, 503);
  assert.equal(res1.headers.get('Retry-After'), '5');

  // 2. deductBalance успешен, но синтез упал И refundBalance упал -> ответ 500, в лог [BILLING]
  deductThrows = false;
  synthThrows = true;
  refundThrows = true;

  const logs: string[] = [];
  const origError = console.error;
  console.error = (...args: any[]) => {
    logs.push(args.join(' '));
    origError(...args);
  };

  try {
    const res2 = await fetch(`${base}/api/tts/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ text: 'Привет мир' }),
    });
    assert.equal(res2.status, 500);
    const body2 = (await res2.json()) as any;
    assert.equal(body2.refunded, 10);
    assert.ok(
      logs.some((l) => l.includes('[BILLING] возврат не выполнен user=u-tts-test chars=10')),
      'Лог должен содержать [BILLING] метку о невыполненном возврате',
    );
  } finally {
    console.error = origError;
  }
});

test('(г) PostgresDatabase с заглушкой пула, у которой первый connect() отклоняется: следующий запрос повторяет инициализацию и успешен', async () => {
  const fakePool = new FakePgPool();
  fakePool.connectFails = new Error('Database is starting up...');

  const pgDb = new PostgresDatabase('postgres://fake:fake@localhost:5432/fakedb', fakePool);

  // Первый вызов отклоняется, но сбрасывает initPromise
  await assert.rejects(async () => {
    await pgDb.createUser();
  }, /Database is starting up/);

  // Восстанавливаем connect
  fakePool.connectFails = null;

  // Следующий запрос повторяет инициализацию схемы и успешно создает пользователя
  const { user, token } = await pgDb.createUser();
  assert.ok(user.id);
  assert.ok(token);
  assert.equal(user.balance, 15000);
});

test('(д) заглушка пула на EventEmitter: pool.emit("error", new Error("x")) не бросает исключение', async () => {
  const fakePool = new FakePgPool();
  const pgDb = new PostgresDatabase('postgres://fake:fake@localhost:5432/fakedb', fakePool);

  // Эмуляция сбоя пула соединений — слушатель ловит ошибку без падения процесса
  let loggedError = false;
  const origError = console.error;
  console.error = (...args: any[]) => {
    if (args.some((a) => String(a).includes('Непредвиденная ошибка пула PostgreSQL'))) {
      loggedError = true;
    }
  };

  try {
    fakePool.emit('error', new Error('pg pool socket error'));
    assert.equal(loggedError, true);
  } finally {
    console.error = origError;
  }
  await pgDb.close();
});

test('(е) shutdown: активный запрос дожидается, зависший обрывается по таймауту', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abr-shutdown-'));
  const db = new Database(dir);

  // 1. Активный запрос дожидается
  let reqFinished = false;
  let exitCodeReceived: number | null = null;

  const { app: testApp1 } = createApp({ db });
  testApp1.get('/slow', async (_req, res) => {
    await new Promise((r) => setTimeout(r, 60));
    reqFinished = true;
    res.json({ ok: true });
  });

  const { server: testServer1, base: b1 } = await startServer(testApp1);

  const shutdown1 = createGracefulShutdown(testServer1, db, {
    timeoutMs: 500,
    onExit: (code) => {
      exitCodeReceived = code;
    },
  });

  const fetchPromise = fetch(`${b1}/slow`).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 10)); // Даем запросу начаться
  await shutdown1('SIGTERM');

  const result = await fetchPromise;
  assert.equal((result as any).ok, true);
  assert.equal(reqFinished, true);
  assert.equal(exitCodeReceived, 0);

  // 2. Зависший запрос обрывается по таймауту
  let timeoutExitCode: number | null = null;
  const { app: testApp2 } = createApp({ db });
  testApp2.get('/hang', (_req, _res) => {
    // Никогда не отвечает
  });

  const { server: testServer2, base: b2 } = await startServer(testApp2);

  const shutdown2 = createGracefulShutdown(testServer2, db, {
    timeoutMs: 100,
    onExit: (code) => {
      timeoutExitCode = code;
    },
  });

  const abortCtrl = new AbortController();
  fetch(`${b2}/hang`, { signal: abortCtrl.signal }).catch(() => {});
  await new Promise((r) => setTimeout(r, 10));

  const startMs = Date.now();
  await shutdown2('SIGINT');
  const elapsed = Date.now() - startMs;
  abortCtrl.abort();

  assert.ok(elapsed >= 90, `Должен был сработать таймаут (прошло ${elapsed}мс)`);
  assert.equal(timeoutExitCode, 0);
});

test('X-Remaining-Balance после /api/tts/stream равен балансу после списания (JSON и Postgres)', async () => {
  // 1. Тест для JSON хранилища
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abr-rem-'));
  const jsonDb = new Database(dir);
  const geminiMock = {
    async synthesize() {
      return Buffer.from('RIFF');
    },
  };

  const { app: jsonApp } = createApp({ db: jsonDb, gemini: geminiMock as any });
  const { base: jsonBase } = await startServer(jsonApp);

  const regRes = await fetch(`${jsonBase}/api/user/register`, { method: 'POST' });
  const { token, userId } = (await regRes.json()) as any;
  assert.equal(jsonDb.getUser(userId)!.balance, 15000);

  const ttsRes1 = await fetch(`${jsonBase}/api/tts/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: 'x'.repeat(1000) }),
  });

  assert.equal(ttsRes1.status, 200);
  assert.equal(ttsRes1.headers.get('X-Remaining-Balance'), '14000');
  assert.equal(ttsRes1.headers.get('X-Characters-Used'), '1000');
  assert.equal(jsonDb.getUser(userId)!.balance, 14000);

  // 2. Тест для Postgres хранилища (через FakePgPool)
  const fakePool = new FakePgPool();
  const pgDb = new PostgresDatabase('postgres://fake:fake@localhost:5432/fakedb', fakePool);
  const { app: pgApp } = createApp({ db: pgDb, gemini: geminiMock as any });
  const { base: pgBase } = await startServer(pgApp);

  const pgRegRes = await fetch(`${pgBase}/api/user/register`, { method: 'POST' });
  const { token: pgToken, userId: pgUserId } = (await pgRegRes.json()) as any;
  assert.equal(fakePool.users.get(pgUserId)!.balance, 15000);

  const ttsRes2 = await fetch(`${pgBase}/api/tts/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pgToken}` },
    body: JSON.stringify({ text: 'x'.repeat(1000) }),
  });

  assert.equal(ttsRes2.status, 200);
  assert.equal(ttsRes2.headers.get('X-Remaining-Balance'), '14000');
  assert.equal(ttsRes2.headers.get('X-Characters-Used'), '1000');
  assert.equal(fakePool.users.get(pgUserId)!.balance, 14000);

  // 3. Граничный случай: списание всего оставшегося баланса (остаток 0) — успех (200), а не 402
  fakePool.users.get(pgUserId)!.balance = 2000;
  const ttsRes3 = await fetch(`${pgBase}/api/tts/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pgToken}` },
    body: JSON.stringify({ text: 'x'.repeat(2000) }),
  });
  assert.equal(ttsRes3.status, 200);
  assert.equal(ttsRes3.headers.get('X-Remaining-Balance'), '0');
  assert.equal(ttsRes3.headers.get('X-Characters-Used'), '2000');
  assert.equal(fakePool.users.get(pgUserId)!.balance, 0);

  // Баланс 0: следующая попытка списать 1 символ возвращает 402
  const ttsRes4 = await fetch(`${pgBase}/api/tts/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pgToken}` },
    body: JSON.stringify({ text: 'x' }),
  });
  assert.equal(ttsRes4.status, 402);

  await pgDb.close();
});
