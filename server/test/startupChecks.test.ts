import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { collectConfigWarnings } from '../src/startupChecks.js';
import { sanitizeReturnUrl } from '../src/config.js';

const SAVED = { ...process.env };

beforeEach(() => {
  process.env = { ...SAVED };
});

afterEach(() => {
  process.env = { ...SAVED };
});

test('collectConfigWarnings возвращает пустой список вне production', () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'development',
  };
  const warnings = collectConfigWarnings(env);
  assert.deepEqual(warnings, []);
});

test('collectConfigWarnings выявляет все проблемы конфигурации в production', () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    YOOKASSA_SHOP_ID: '',
    YOOKASSA_SECRET_KEY: '',
    ALLOWED_RETURN_ORIGINS: '',
    DATABASE_URL: '',
    CORS_ORIGINS: '',
  };

  const warnings = collectConfigWarnings(env);
  assert.equal(warnings.length, 4);
  assert.ok(warnings.some((w) => w.includes('Платежи отключены')));
  assert.ok(warnings.some((w) => w.includes('ALLOWED_RETURN_ORIGINS')));
  assert.ok(warnings.some((w) => w.includes('DATABASE_URL')));
  assert.ok(warnings.some((w) => w.includes('CORS_ORIGINS')));
});

test('collectConfigWarnings возвращает пустой список при полностью заполненном production env', () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    YOOKASSA_SHOP_ID: '123456',
    YOOKASSA_SECRET_KEY: 'sec_xyz',
    ALLOWED_RETURN_ORIGINS: 'https://books.ndomen.ru',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    CORS_ORIGINS: 'https://books.ndomen.ru',
  };

  const warnings = collectConfigWarnings(env);
  assert.deepEqual(warnings, []);
});

test('sanitizeReturnUrl с ALLOWED_RETURN_ORIGINS=https://books.ndomen.ru пропускает валидные и фильтрует зловредные URL', () => {
  process.env.ALLOWED_RETURN_ORIGINS = 'https://books.ndomen.ru';

  // 1. Валидный адрес с query параметрами проходит как есть
  const valid = sanitizeReturnUrl('https://books.ndomen.ru/x?y=1');
  assert.equal(valid, 'https://books.ndomen.ru/x?y=1');

  // 2. Чужой домен заменяется на основной разрешенный origin
  const evil = sanitizeReturnUrl('https://evil.example/');
  assert.equal(evil, 'https://books.ndomen.ru');

  // 3. javascript: протокол заменяется на основной разрешенный origin
  const js = sanitizeReturnUrl('javascript:alert(1)');
  assert.equal(js, 'https://books.ndomen.ru');
});
