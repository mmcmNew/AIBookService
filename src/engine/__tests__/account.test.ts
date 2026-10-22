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
  login,
  register,
  logout,
  requestPasswordReset,
  saveEncryptedApiKeys,
  loadEncryptedApiKeys,
  syncUserData,
} from '../account';
import { useUserStore } from '../../store/userStore';
import { useSettingsStore } from '../../store/settingsStore';
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
  assert.equal(typeof state.setLastSyncTime, 'function');
  assert.equal(typeof state.logout, 'function');

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

// ---------------------------------------------------------------------------
// 8. account: login обновляет стор, выставляет isGuest: false и баланс
// ---------------------------------------------------------------------------

test('account: login обновляет стор, выставляет isGuest: false и баланс', async () => {
  useUserStore.setState({
    userId: 'guest_1',
    token: 'guest_tok',
    email: '',
    refreshToken: '',
    isGuest: true,
    balance: 0,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes('/api/auth/login')) {
      const body = JSON.parse(init?.body as string);
      assert.equal(body.email, 'user@test.com');
      assert.equal(body.password, 'secret123');
      return new Response(
        JSON.stringify({
          user: { id: 'user_99', email: 'user@test.com', balance: 15000 },
          token: 'token_jwt_99',
          refreshToken: 'refresh_jwt_99',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (urlStr.includes('/api/user/keys')) {
      return new Response(
        JSON.stringify({ encryptedBlob: null, iv: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (urlStr.includes('/api/user/sync')) {
      return new Response(
        JSON.stringify({ success: true, serverTime: 123456789 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    throw new Error(`Unexpected request: ${urlStr}`);
  }) as any;

  try {
    const res = await login('user@test.com', 'secret123');
    assert.equal(res.success, true);
    assert.equal(res.balance, 15000);

    const state = useUserStore.getState();
    assert.equal(state.userId, 'user_99');
    assert.equal(state.token, 'token_jwt_99');
    assert.equal(state.refreshToken, 'refresh_jwt_99');
    assert.equal(state.email, 'user@test.com');
    assert.equal(state.isGuest, false);
    assert.equal(state.balance, 15000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 9. account: register передаёт guestToken если пользователь был гостем
// ---------------------------------------------------------------------------

test('account: register передаёт guestToken если пользователь был гостем', async () => {
  useUserStore.setState({
    userId: 'guest_42',
    token: 'guest_tok_42',
    email: '',
    refreshToken: '',
    isGuest: true,
    balance: 500,
  });

  let capturedGuestToken: string | undefined;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes('/api/auth/register')) {
      const body = JSON.parse(init?.body as string);
      capturedGuestToken = body.guestToken;
      return new Response(
        JSON.stringify({
          user: { id: 'reg_user_1', email: 'reg@test.com', balance: 500 },
          token: 'reg_tok_1',
          refreshToken: 'reg_refresh_1',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (urlStr.includes('/api/user/keys')) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (urlStr.includes('/api/user/sync')) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected request: ${urlStr}`);
  }) as any;

  try {
    const res = await register('reg@test.com', 'mypassword');
    assert.equal(res.success, true);
    assert.equal(capturedGuestToken, 'guest_tok_42');

    const state = useUserStore.getState();
    assert.equal(state.userId, 'reg_user_1');
    assert.equal(state.token, 'reg_tok_1');
    assert.equal(state.refreshToken, 'reg_refresh_1');
    assert.equal(state.email, 'reg@test.com');
    assert.equal(state.isGuest, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 10. account: logout сбрасывает данные сессии
// ---------------------------------------------------------------------------

test('account: logout сбрасывает данные сессии', () => {
  useUserStore.setState({
    userId: 'user_active',
    token: 'tok_active',
    refreshToken: 'ref_active',
    email: 'user@active.com',
    balance: 9999,
    isGuest: false,
    lastSyncTime: 1234567,
  });

  logout();

  const state = useUserStore.getState();
  assert.equal(state.userId, '');
  assert.equal(state.token, '');
  assert.equal(state.refreshToken, '');
  assert.equal(state.email, '');
  assert.equal(state.balance, 0);
  assert.equal(state.isGuest, true);
  assert.equal(state.lastSyncTime, null);
});

// ---------------------------------------------------------------------------
// 11. account: 401 при наличии refreshToken вызывает authRefresh и повторяет запрос
// ---------------------------------------------------------------------------

test('account: 401 при наличии refreshToken вызывает authRefresh и повторяет запрос', async () => {
  useUserStore.setState({
    userId: 'u_auth',
    token: 'expired_access_token',
    refreshToken: 'valid_refresh_token',
    email: 'u@test.com',
    isGuest: false,
    balance: 100,
  });

  const calls: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    calls.push(urlStr);

    if (urlStr.includes('/api/auth/refresh')) {
      const body = JSON.parse(init?.body as string);
      assert.equal(body.refreshToken, 'valid_refresh_token');
      return new Response(
        JSON.stringify({
          token: 'new_fresh_token',
          refreshToken: 'new_fresh_refresh_token',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (urlStr.includes('/api/user/balance')) {
      const authHeader = (init?.headers as Record<string, string>)?.['Authorization'] ||
        (init?.headers as Headers)?.get?.('Authorization');
      if (authHeader === 'Bearer expired_access_token') {
        return new Response(JSON.stringify({ error: 'Token expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (authHeader === 'Bearer new_fresh_token') {
        return new Response(JSON.stringify({ balance: 8888 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    throw new Error(`Unexpected request: ${urlStr}`);
  }) as any;

  try {
    const bal = await fetchBalance();
    assert.equal(bal, 8888);
    assert.equal(useUserStore.getState().token, 'new_fresh_token');
    assert.equal(useUserStore.getState().refreshToken, 'new_fresh_refresh_token');
    assert.equal(useUserStore.getState().balance, 8888);
    assert.equal(calls.length, 3, 'Запросы: balance (401) -> refresh (200) -> balance (200)');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 12. account: saveEncryptedApiKeys и loadEncryptedApiKeys корректно шифруют и расшифровывают ключи
// ---------------------------------------------------------------------------

test('account: saveEncryptedApiKeys и loadEncryptedApiKeys корректно шифруют и расшифровывают ключи', async () => {
  useUserStore.setState({
    userId: 'crypto_user_1',
    token: 'tok_crypto',
    email: 'crypto@test.com',
    isGuest: false,
  });

  useSettingsStore.setState({
    apiKeys: {
      gemini: 'AIza-test-gemini-key',
      openai: 'sk-test-openai-key',
      elevenlabs: 'xi-test-eleven-key',
      openrouter: 'sk-or-test-key',
    },
    aggregatorKeys: {
      'https://routerai.ru/api/v1': 'routerai-secret-key',
    },
  });

  const captured = {
    savedEncryptedBlob: null as string | null,
    savedIv: null as string | null,
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);

    if (urlStr.includes('/api/user/keys')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        captured.savedEncryptedBlob = body.encryptedBlob;
        captured.savedIv = body.iv;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } else {
        return new Response(
          JSON.stringify({
            encryptedBlob: captured.savedEncryptedBlob,
            iv: captured.savedIv,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    throw new Error(`Unexpected request: ${urlStr}`);
  }) as any;

  try {
    const password = 'StrongMasterPassword!2026';

    // 1. Сохраняем ключи
    await saveEncryptedApiKeys(password);
    assert.ok(captured.savedEncryptedBlob, 'encryptedBlob должен быть сохранен на сервере');
    assert.ok(captured.savedIv, 'iv должен быть сохранен на сервере');

    const blobStr = captured.savedEncryptedBlob;
    // Убедимся, что открытый текст ключей не содержится в зашифрованном блобе
    assert.ok(!blobStr.includes('AIza-test-gemini-key'));
    assert.ok(!blobStr.includes('routerai-secret-key'));

    // 2. Сбрасываем ключи в settingsStore
    useSettingsStore.setState({
      apiKeys: {},
      aggregatorKeys: {},
    });
    assert.equal(useSettingsStore.getState().apiKeys.gemini, undefined);

    // 3. Загружаем и расшифровываем ключи обратно
    await loadEncryptedApiKeys(password);

    const loadedSettings = useSettingsStore.getState();
    assert.equal(loadedSettings.apiKeys.gemini, 'AIza-test-gemini-key');
    assert.equal(loadedSettings.apiKeys.openai, 'sk-test-openai-key');
    assert.equal(loadedSettings.apiKeys.elevenlabs, 'xi-test-eleven-key');
    assert.equal(loadedSettings.apiKeys.openrouter, 'sk-or-test-key');
    assert.equal(loadedSettings.aggregatorKeys?.['https://routerai.ru/api/v1'], 'routerai-secret-key');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 13. account: requestPasswordReset отправляет запрос на сервер
// ---------------------------------------------------------------------------

test('account: requestPasswordReset отправляет email для сброса пароля', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes('/api/auth/forgot-password')) {
      const body = JSON.parse(init?.body as string);
      assert.equal(body.email, 'reset@example.com');
      return new Response(JSON.stringify({ success: true, message: 'Ссылка отправлена' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected request: ${urlStr}`);
  }) as any;

  try {
    const res = await requestPasswordReset('reset@example.com');
    assert.equal(res.success, true);
    assert.equal(res.message, 'Ссылка отправлена');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 14. account: syncUserData отправляет полезную нагрузку и обновляет lastSyncTime
// ---------------------------------------------------------------------------

test('account: syncUserData собирает настройки и обновляет lastSyncTime', async () => {
  useUserStore.setState({
    userId: 'u_sync',
    token: 'tok_sync',
    serverUrl: 'http://localhost:4000',
    lastSyncTime: null,
  });

  const originalFetch = globalThis.fetch;
  let sentPayload: any = null;

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes('/api/user/sync')) {
      sentPayload = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          success: true,
          serverTime: 1700000000,
          settings: { fontSize: 24 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    throw new Error(`Unexpected request: ${urlStr}`);
  }) as any;

  try {
    await syncUserData();
    assert.ok(sentPayload, 'Payload должен быть отправлен');
    assert.ok(sentPayload.settings, 'Settings должны быть в payload');
    assert.ok(Array.isArray(sentPayload.positions), 'Positions должны быть массивом');
    assert.equal(useSettingsStore.getState().fontSize, 24);
    assert.equal(useUserStore.getState().lastSyncTime, 1700000000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

