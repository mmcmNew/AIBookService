import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { Database } from '../src/db.js';
import { YooKassaService } from '../src/services/yookassa.js';

const SAVED = { ...process.env };
let dir: string;
let server: Server;
let base: string;
let db: Database;
let ttsFails = false;
let remoteStatus = 'succeeded';
let remoteAmount = '490.00';

const fakeFetch = (async (url: any) => {
  const body = { id: String(url).split('/').pop(), status: remoteStatus, amount: { value: remoteAmount, currency: 'RUB' } };
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

async function boot() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abr-'));
  db = new Database(dir);
  const yookassa = new YooKassaService(db, fakeFetch);
  const gemini = {
    async synthesize() {
      if (ttsFails) throw new Error('boom');
      return Buffer.from('RIFF');
    },
  };
  const { app } = createApp({ db, yookassa, gemini });
  await new Promise<void>((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function register() {
  const r = await fetch(`${base}/api/user/register`, { method: 'POST' });
  assert.equal(r.status, 201);
  return (await r.json()) as { userId: string; token: string; balance: number };
}

const authH = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

beforeEach(async () => {
  process.env = { ...SAVED };
  delete process.env.YOOKASSA_SHOP_ID;
  delete process.env.YOOKASSA_SECRET_KEY;
  process.env.NODE_ENV = 'test';
  ttsFails = false;
  remoteStatus = 'succeeded';
  remoteAmount = '490.00';
  await boot();
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  await db.flush();
  fs.rmSync(dir, { recursive: true, force: true });
  process.env = SAVED;
});

test('регистрация выдаёт токен, в хранилище только хэш', async () => {
  const u = await register();
  assert.equal(u.balance, 15000);
  await db.flush();
  const raw = fs.readFileSync(path.join(dir, 'users.json'), 'utf-8');
  assert.ok(!raw.includes(u.token));
  const noAuth = await fetch(`${base}/api/user/balance`);
  assert.equal(noAuth.status, 401);
});

test('вебхук идемпотентен и берёт символы из PaymentRecord', async () => {
  process.env.YOOKASSA_SHOP_ID = 'shop';
  process.env.YOOKASSA_SECRET_KEY = 'secret';
  const u = await register();
  db.savePayment({
    id: 'pay_1', userId: u.userId, amountRub: 490, characters: 1000000,
    status: 'pending', createdAt: 1, updatedAt: 1,
  });
  // Подделанные metadata/characters в теле не должны влиять на начисление.
  const evt = { event: 'payment.succeeded', object: { id: 'pay_1', status: 'succeeded', metadata: { userId: u.userId, characters: '999999999' } } };
  const post = () => fetch(`${base}/api/payments/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evt) });

  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 200);
  assert.equal(db.getUser(u.userId)!.balance, 15000 + 1000000);
  assert.equal(db.getPayment('pay_1')!.status, 'succeeded');
});

test('вебхук: неизвестный платёж и несовпадение суммы игнорируются', async () => {
  process.env.YOOKASSA_SHOP_ID = 'shop';
  process.env.YOOKASSA_SECRET_KEY = 'secret';
  const u = await register();
  db.savePayment({ id: 'pay_2', userId: u.userId, amountRub: 149, characters: 200000, status: 'pending', createdAt: 1, updatedAt: 1 });
  remoteAmount = '1.00';
  const send = (id: string) => fetch(`${base}/api/payments/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'payment.succeeded', object: { id } }) });
  assert.equal((await send('nope')).status, 200);
  assert.equal((await send('pay_2')).status, 200);
  assert.equal(db.getUser(u.userId)!.balance, 15000);
  assert.equal(db.getPayment('pay_2')!.status, 'pending');
});

test('confirm-mock работает в dev и отказывает в production', async () => {
  const u = await register();
  const create = await fetch(`${base}/api/payments/create`, { method: 'POST', headers: authH(u.token), body: JSON.stringify({ packId: 'starter', returnUrl: 'https://evil.example/x' }) });
  assert.equal(create.status, 200);
  const { paymentId, confirmationUrl } = (await create.json()) as any;
  assert.ok(confirmationUrl.startsWith('http://localhost:3000'), 'returnUrl подменён на разрешённый');
  assert.ok(paymentId.startsWith('mock_pay_'));

  process.env.NODE_ENV = 'production';
  const denied = await fetch(`${base}/api/payments/confirm-mock`, { method: 'POST', headers: authH(u.token), body: JSON.stringify({ mockPaymentId: paymentId }) });
  assert.equal(denied.status, 404);
  assert.equal(db.getUser(u.userId)!.balance, 15000);

  process.env.NODE_ENV = 'test';
  const ok = await fetch(`${base}/api/payments/confirm-mock`, { method: 'POST', headers: authH(u.token), body: JSON.stringify({ mockPaymentId: paymentId }) });
  assert.equal(ok.status, 200);
  const again = await fetch(`${base}/api/payments/confirm-mock`, { method: 'POST', headers: authH(u.token), body: JSON.stringify({ mockPaymentId: paymentId }) });
  assert.equal(again.status, 404);
  assert.equal(db.getUser(u.userId)!.balance, 15000 + 200000);
});

test('нельзя списать больше баланса', async () => {
  const u = await register();
  assert.equal(db.deductBalance(u.userId, 15001), null);
  assert.deepEqual(db.deductBalance(u.userId, 15000), { balance: 0 });
  assert.equal(db.deductBalance(u.userId, 1), null);
  assert.equal(db.getUser(u.userId)!.balance, 0);
  assert.throws(() => db.deductBalance(u.userId, NaN));
  assert.throws(() => db.deductBalance(u.userId, -5));

  const r = await fetch(`${base}/api/tts/stream`, { method: 'POST', headers: authH(u.token), body: JSON.stringify({ text: 'hello' }) });
  assert.equal(r.status, 402);
});

test('возврат символов при сбое TTS и валидация text', async () => {
  const u = await register();
  ttsFails = true;
  const r = await fetch(`${base}/api/tts/stream`, { method: 'POST', headers: authH(u.token), body: JSON.stringify({ text: 'hello world' }) });
  assert.equal(r.status, 500);
  assert.equal(db.getUser(u.userId)!.balance, 15000);

  ttsFails = false;
  const ok = await fetch(`${base}/api/tts/stream`, { method: 'POST', headers: authH(u.token), body: JSON.stringify({ text: 'hello' }) });
  assert.equal(ok.status, 200);
  assert.equal(db.getUser(u.userId)!.balance, 15000 - 5);

  for (const text of ['', 'a'.repeat(5001), 123]) {
    const bad = await fetch(`${base}/api/tts/stream`, { method: 'POST', headers: authH(u.token), body: JSON.stringify({ text }) });
    assert.equal(bad.status, 400);
  }
});

test('повреждённый JSON переименовывается, а не затирается', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'abr-corrupt-'));
  fs.writeFileSync(path.join(d, 'users.json'), '{broken');
  const d2 = new Database(d);
  assert.ok(fs.readdirSync(d).some((f) => f.startsWith('users.json.corrupt-')));
  d2.createUser();
  await d2.flush();
  fs.rmSync(d, { recursive: true, force: true });
});
