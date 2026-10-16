import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerError, registerUser, getBalance, createPayment as apiCreatePayment, confirmMockPayment as apiConfirmMockPayment } from '../../infra/serverApi';
import {
  ensureRegistered,
  reRegister,
  fetchBalance,
  createPayment,
  confirmMockPayment,
  reportBalance,
  requestTopUp,
  clearTopUpRequest,
  setServerUrl,
} from '../account';
import { useUserStore } from '../../store/userStore';
import { CloudTTSProvider, InsufficientFundsError, AuthExpiredError } from '../providers/cloudTts';
import { synthesizeOnce } from '../audio/audioFetch';
import { getProvider } from '../providers';

// ---------------------------------------------------------------------------
// 1. serverApi: ошибки с HTTP кодом бросают ServerError
// ---------------------------------------------------------------------------

test('serverApi: registerUser при HTTP ошибке бросает ServerError с кодом', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: 'Пользователь уже существует' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;

  try {
    await assert.rejects(
      () => registerUser('http://localhost:4000'),
      (err: any) => {
        assert.ok(err instanceof ServerError);
        assert.equal(err.status, 400);
        assert.match(err.message, /Пользователь уже существует/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('serverApi: getBalance при 401 бросает ServerError со статусом 401', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;

  try {
    await assert.rejects(
      () => getBalance('http://localhost:4000', 'bad-token'),
      (err: any) => {
        assert.ok(err instanceof ServerError);
        assert.equal(err.status, 401);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('serverApi: createPayment и confirmMockPayment бросают ServerError при сбое', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: 'Платёж не найден' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;

  try {
    await assert.rejects(
      () => apiCreatePayment('http://localhost:4000', 'tok', 'pack1'),
      (err: any) => err instanceof ServerError && err.status === 404
    );
    await assert.rejects(
      () => apiConfirmMockPayment('http://localhost:4000', 'tok', 'mock-1'),
      (err: any) => err instanceof ServerError && err.status === 404
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 2. account: ensureRegistered возвращает один и тот же промис при параллельных вызовах
// ---------------------------------------------------------------------------

test('account: ensureRegistered возвращает один и тот же промис при параллельных вызовах', async () => {
  useUserStore.setState({ userId: '', token: '', balance: 0 });
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = (async () => {
    fetchCount++;
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ userId: 'u_123', token: 'tok_abc', balance: 5000 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;

  try {
    const p1 = ensureRegistered();
    const p2 = ensureRegistered();
    assert.equal(p1, p2, 'Параллельные вызовы должны делить один промис');

    const res1 = await p1;
    const res2 = await p2;

    assert.deepEqual(res1, { userId: 'u_123', token: 'tok_abc' });
    assert.deepEqual(res2, { userId: 'u_123', token: 'tok_abc' });
    assert.equal(fetchCount, 1, 'Должен быть только 1 сетевой запрос на регистрацию');
    assert.equal(useUserStore.getState().userId, 'u_123');
    assert.equal(useUserStore.getState().token, 'tok_abc');
    assert.equal(useUserStore.getState().balance, 5000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 3. account: fetchBalance обновляет баланс в сторе
// ---------------------------------------------------------------------------

test('account: fetchBalance обновляет баланс в сторе', async () => {
  useUserStore.setState({ userId: 'u1', token: 't1', balance: 0, isLoadingBalance: false });
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('/api/user/balance')) {
      return new Response(JSON.stringify({ balance: 42000 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected url: ${url}`);
  }) as any;

  try {
    const bal = await fetchBalance();
    assert.equal(bal, 42000);
    assert.equal(useUserStore.getState().balance, 42000);
    assert.equal(useUserStore.getState().isLoadingBalance, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 4. account: fetchBalance повторяет запрос после 401
// ---------------------------------------------------------------------------

test('account: fetchBalance повторяет запрос после 401', async () => {
  useUserStore.setState({ userId: 'old_uid', token: 'expired_tok', balance: 100 });
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    calls.push(urlStr);

    if (urlStr.includes('/api/user/balance')) {
      const authHeader = (init?.headers as Record<string, string>)?.['Authorization'] ||
        (init?.headers as Headers)?.get?.('Authorization');
      if (authHeader === 'Bearer expired_tok') {
        return new Response(JSON.stringify({ error: 'Token expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (authHeader === 'Bearer new_valid_tok') {
        return new Response(JSON.stringify({ balance: 7777 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (urlStr.includes('/api/user/register')) {
      return new Response(JSON.stringify({ userId: 'new_uid', token: 'new_valid_tok', balance: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected request: ${urlStr}`);
  }) as any;

  try {
    const bal = await fetchBalance();
    assert.equal(bal, 7777);
    assert.equal(useUserStore.getState().token, 'new_valid_tok');
    assert.equal(useUserStore.getState().userId, 'new_uid');
    assert.equal(useUserStore.getState().balance, 7777);
    assert.equal(calls.length, 3, 'Должно быть: balance (401) -> register (200) -> balance (200)');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 5. cloudTts: 402 бросает InsufficientFundsError, 401 бросает AuthExpiredError, баланс извлекается из заголовка
// ---------------------------------------------------------------------------

test('cloudTts: 402 бросает InsufficientFundsError, 401 бросает AuthExpiredError, баланс извлекается из заголовка', async () => {
  const provider = new CloudTTSProvider();
  const originalFetch = globalThis.fetch;

  // 402 Payment Required
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: 'No funds' }), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;

  await assert.rejects(
    () => provider.synthesize('текст', { voiceId: 'Aoede', speed: 1, serverUrl: 'http://loc', token: 'tok' }),
    (err: any) => {
      assert.ok(err instanceof InsufficientFundsError);
      assert.match(err.message, /Недостаточно символов на балансе/);
      return true;
    }
  );

  // 401 Unauthorized
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: 'Expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;

  await assert.rejects(
    () => provider.synthesize('текст', { voiceId: 'Aoede', speed: 1, serverUrl: 'http://loc', token: 'tok' }),
    (err: any) => err instanceof AuthExpiredError
  );

  // 200 OK with X-Remaining-Balance
  globalThis.fetch = (async () => {
    const headers = new Headers();
    headers.set('X-Remaining-Balance', '8888');
    return new Response(new Uint8Array([1, 2, 3]).buffer, {
      status: 200,
      headers,
    });
  }) as any;

  const resultBuffer = await provider.synthesize('текст', {
    voiceId: 'Aoede',
    speed: 1,
    serverUrl: 'http://loc',
    token: 'tok',
  });
  assert.equal(resultBuffer.byteLength, 3);
  assert.equal((resultBuffer as any).remainingBalance, 8888);

  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// 6. audioFetch: при InsufficientFundsError зовёт requestTopUp
// ---------------------------------------------------------------------------

test('audioFetch: при InsufficientFundsError зовёт requestTopUp', async () => {
  useUserStore.setState({
    userId: 'u_test',
    token: 'tok_test',
    serverUrl: 'http://localhost:4000',
    topUpRequest: false,
  });

  const cloudProv = getProvider('cloud');
  const originalSynthesize = cloudProv.synthesize;
  cloudProv.synthesize = async () => {
    throw new InsufficientFundsError();
  };

  try {
    assert.equal(useUserStore.getState().topUpRequest, false);

    await assert.rejects(
      () => synthesizeOnce('cloud', 'Фраза для синтеза', { voiceId: 'Aoede', speed: 1 }),
      (err: any) => err instanceof InsufficientFundsError
    );

    assert.equal(
      useUserStore.getState().topUpRequest,
      true,
      'При ошибке нехватки средств должен быть выставлен флаг topUpRequest в сторе'
    );
  } finally {
    cloudProv.synthesize = originalSynthesize;
    clearTopUpRequest();
  }
});

// ---------------------------------------------------------------------------
// 7. userStore: нет HTTP и верные сеттеры
// ---------------------------------------------------------------------------

test('userStore: стор не содержит HTTP логики, только данные и чистые сеттеры', () => {
  const state: any = useUserStore.getState();

  assert.equal(typeof state.authFetch, 'undefined', 'authFetch не должен существовать в userStore');
  assert.equal(typeof state.ensureRegistered, 'undefined', 'ensureRegistered не должен существовать в userStore');
  assert.equal(typeof state.fetchBalance, 'undefined', 'fetchBalance не должен существовать в userStore');
  assert.equal(typeof state.createPayment, 'undefined', 'createPayment не должен существовать в userStore');

  assert.equal(typeof state.setAuth, 'function');
  assert.equal(typeof state.setBalance, 'function');
  assert.equal(typeof state.setLoadingBalance, 'function');
  assert.equal(typeof state.setServerUrl, 'function');
  assert.equal(typeof state.setTopUpRequest, 'function');

  // Проверка работы сеттеров
  state.setAuth('user-1', 'tok-1');
  assert.equal(useUserStore.getState().userId, 'user-1');
  assert.equal(useUserStore.getState().token, 'tok-1');

  state.setBalance(350);
  assert.equal(useUserStore.getState().balance, 350);

  state.setTopUpRequest(true);
  assert.equal(useUserStore.getState().topUpRequest, true);

  clearTopUpRequest();
  assert.equal(useUserStore.getState().topUpRequest, false);
});
