import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { Database } from '../src/db.js';
import { parseTrustProxy } from '../src/config.js';

const SAVED = { ...process.env };
let dir: string;
let server: Server;
let base: string;
let db: Database;

async function boot() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abr-proxy-'));
  db = new Database(dir);
  const { app } = createApp({ db });
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function stop() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (db) {
    await db.flush();
  }
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(async () => {
  await stop();
  process.env = { ...SAVED };
});

test('parseTrustProxy корректно разбирает все варианты значений', () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('0'), false);
  assert.equal(parseTrustProxy('true'), 'loopback, linklocal, uniquelocal');
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy('loopback, uniquelocal'), 'loopback, uniquelocal');
});

test('при TRUST_PROXY=true разные X-Forwarded-For дают разные ведра лимита (оба получают 201)', async () => {
  process.env = { ...SAVED };
  delete process.env.DATABASE_URL;
  process.env.NODE_ENV = 'test';
  process.env.TRUST_PROXY = 'true';
  process.env.REGISTER_LIMIT_PER_HOUR = '2';

  await boot();

  const r1 = await fetch(`${base}/api/user/register`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': '1.1.1.1, 172.18.0.5' },
  });
  assert.equal(r1.status, 201);

  const r2 = await fetch(`${base}/api/user/register`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': '2.2.2.2, 172.18.0.5' },
  });
  assert.equal(r2.status, 201);
});

test('подделка X-Forwarded-For: запросы от одного проксируемого IP считаются одним клиентом (третий получает 429)', async () => {
  process.env = { ...SAVED };
  delete process.env.DATABASE_URL;
  process.env.NODE_ENV = 'test';
  process.env.TRUST_PROXY = 'true';
  process.env.REGISTER_LIMIT_PER_HOUR = '2';

  await boot();

  const r1 = await fetch(`${base}/api/user/register`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': '9.9.9.9, 1.1.1.1, 172.18.0.5' },
  });
  assert.equal(r1.status, 201);

  const r2 = await fetch(`${base}/api/user/register`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': '8.8.8.8, 1.1.1.1, 172.18.0.5' },
  });
  assert.equal(r2.status, 201);

  const r3 = await fetch(`${base}/api/user/register`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': '7.7.7.7, 1.1.1.1, 172.18.0.5' },
  });
  assert.equal(r3.status, 429);
  const body = (await r3.json()) as { error: string };
  assert.ok(body.error.includes('Слишком много регистраций'));
});

test('без TRUST_PROXY заголовок X-Forwarded-For игнорируется (все идут в общее ведро socket IP)', async () => {
  process.env = { ...SAVED };
  delete process.env.DATABASE_URL;
  process.env.NODE_ENV = 'test';
  delete process.env.TRUST_PROXY;
  process.env.REGISTER_LIMIT_PER_HOUR = '2';

  await boot();

  const r1 = await fetch(`${base}/api/user/register`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': '1.1.1.1, 172.18.0.5' },
  });
  assert.equal(r1.status, 201);

  const r2 = await fetch(`${base}/api/user/register`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': '2.2.2.2, 172.18.0.5' },
  });
  assert.equal(r2.status, 201);

  const r3 = await fetch(`${base}/api/user/register`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': '3.3.3.3, 172.18.0.5' },
  });
  assert.equal(r3.status, 429);
});
