import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ServerError,
  registerUser,
  getBalance,
  createPayment,
  confirmMockPayment,
  authRegister,
  authLogin,
  authRefresh,
  authForgotPassword,
  syncUserData,
  fetchUserKeys,
  saveUserKeys,
} from '../serverApi';

const TEST_SERVER = 'http://api.reader.local';

// ============================================================================
// authRegister
// ============================================================================

test('serverApi: authRegister отправляет корректный запрос и возвращает профиль с токенами', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedOptions: any = null;

  globalThis.fetch = (async (url: string, opts: any) => {
    capturedUrl = url;
    capturedOptions = opts;
    return new Response(
      JSON.stringify({
        user: { id: 'usr-123', email: 'test@example.com', balance: 150 },
        token: 'access-jwt-token',
        refreshToken: 'refresh-jwt-token',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as any;

  try {
    const res = await authRegister(TEST_SERVER, 'test@example.com', 'pass1234', 'guest-tok-99');
    assert.equal(capturedUrl, `${TEST_SERVER}/api/auth/register`);
    assert.equal(capturedOptions.method, 'POST');
    assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
    const sentBody = JSON.parse(capturedOptions.body);
    assert.equal(sentBody.email, 'test@example.com');
    assert.equal(sentBody.password, 'pass1234');
    assert.equal(sentBody.guestToken, 'guest-tok-99');

    assert.equal(res.user.id, 'usr-123');
    assert.equal(res.user.email, 'test@example.com');
    assert.equal(res.user.balance, 150);
    assert.equal(res.token, 'access-jwt-token');
    assert.equal(res.refreshToken, 'refresh-jwt-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('serverApi: authRegister при HTTP ошибке бросает ServerError', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: 'Пользователь с таким email уже существует' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;

  try {
    await assert.rejects(
      () => authRegister(TEST_SERVER, 'existing@example.com', 'pass'),
      (err: any) => {
        assert.ok(err instanceof ServerError);
        assert.equal(err.status, 409);
        assert.match(err.message, /уже существует/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('serverApi: authRegister бросает ServerError при некорректном теле ответа', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ token: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;

  try {
    await assert.rejects(
      () => authRegister(TEST_SERVER, 'test@example.com', 'pass'),
      (err: any) => {
        assert.ok(err instanceof ServerError);
        assert.match(err.message, /Некорректный ответ/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================================
// authLogin
// ============================================================================

test('serverApi: authLogin успешно возвращает данные пользователя и токены', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedOptions: any = null;

  globalThis.fetch = (async (url: string, opts: any) => {
    capturedUrl = url;
    capturedOptions = opts;
    return new Response(
      JSON.stringify({
        user: { id: 'usr-login', email: 'login@example.com', balance: 50 },
        token: 'login-access-token',
        refreshToken: 'login-refresh-token',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as any;

  try {
    const res = await authLogin(TEST_SERVER, 'login@example.com', 'secret123');
    assert.equal(capturedUrl, `${TEST_SERVER}/api/auth/login`);
    assert.equal(capturedOptions.method, 'POST');
    assert.deepEqual(JSON.parse(capturedOptions.body), { email: 'login@example.com', password: 'secret123' });
    assert.equal(res.user.id, 'usr-login');
    assert.equal(res.token, 'login-access-token');
    assert.equal(res.refreshToken, 'login-refresh-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('serverApi: authLogin при 401 Unauthorized бросает ServerError', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ message: 'Неверный email или пароль' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;

  try {
    await assert.rejects(
      () => authLogin(TEST_SERVER, 'bad@example.com', 'wrongpass'),
      (err: any) => {
        assert.ok(err instanceof ServerError);
        assert.equal(err.status, 401);
        assert.match(err.message, /Неверный email или пароль/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================================
// authRefresh
// ============================================================================

test('serverApi: authRefresh отправляет refreshToken и возвращает новую пару токенов', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedOptions: any = null;

  globalThis.fetch = (async (url: string, opts: any) => {
    capturedUrl = url;
    capturedOptions = opts;
    return new Response(
      JSON.stringify({
        token: 'new-access-token',
        refreshToken: 'new-refresh-token',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as any;

  try {
    const res = await authRefresh(TEST_SERVER, 'old-refresh-token');
    assert.equal(capturedUrl, `${TEST_SERVER}/api/auth/refresh`);
    assert.equal(capturedOptions.method, 'POST');
    assert.deepEqual(JSON.parse(capturedOptions.body), { refreshToken: 'old-refresh-token' });
    assert.equal(res.token, 'new-access-token');
    assert.equal(res.refreshToken, 'new-refresh-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('serverApi: authRefresh при протухшем refresh-токене бросает ServerError(401)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: 'Refresh token expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;

  try {
    await assert.rejects(
      () => authRefresh(TEST_SERVER, 'expired-refresh-token'),
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

// ============================================================================
// authForgotPassword
// ============================================================================

test('serverApi: authForgotPassword отправляет запрос на восстановление пароля', async () => {
  const originalFetch = globalThis.fetch;
  let capturedOptions: any = null;

  globalThis.fetch = (async (_url: string, opts: any) => {
    capturedOptions = opts;
    return new Response(
      JSON.stringify({ success: true, message: 'Ссылка для сброса пароля отправлена' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as any;

  try {
    const res = await authForgotPassword(TEST_SERVER, 'user@test.org');
    assert.deepEqual(JSON.parse(capturedOptions.body), { email: 'user@test.org' });
    assert.equal(res.success, true);
    assert.equal(res.message, 'Ссылка для сброса пароля отправлена');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================================
// syncUserData
// ============================================================================

test('serverApi: syncUserData отправляет авторизованный POST с полезной нагрузкой', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedOptions: any = null;

  const mockPayload = {
    positions: [{ bookId: 'b1', chapterIndex: 2, paragraphIndex: 5 }],
    settings: { fontSize: 16 },
    replacementRules: [{ pattern: 'a', replacement: 'b' }],
  };

  globalThis.fetch = (async (url: string, opts: any) => {
    capturedUrl = url;
    capturedOptions = opts;
    return new Response(
      JSON.stringify({ syncedAt: '2026-10-21T10:00:00Z', success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as any;

  try {
    const res = await syncUserData(TEST_SERVER, 'jwt-bearer-token', mockPayload);
    assert.equal(capturedUrl, `${TEST_SERVER}/api/user/sync`);
    assert.equal(capturedOptions.method, 'POST');
    assert.equal(capturedOptions.headers.Authorization, 'Bearer jwt-bearer-token');
    assert.deepEqual(JSON.parse(capturedOptions.body), mockPayload);
    assert.equal(res.success, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('serverApi: syncUserData при ошибке сервера бросает ServerError', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: 'Sync conflict' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;

  try {
    await assert.rejects(
      () => syncUserData(TEST_SERVER, 'tok', {}),
      (err: any) => err instanceof ServerError && err.status === 409
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================================
// fetchUserKeys & saveUserKeys
// ============================================================================

test('serverApi: fetchUserKeys и saveUserKeys работают с зашифрованными блобами', async () => {
  const originalFetch = globalThis.fetch;
  let saveCaptured: any = null;

  globalThis.fetch = (async (url: string, opts: any) => {
    if (url.endsWith('/api/user/keys') && opts?.method === 'POST') {
      saveCaptured = { url, opts };
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/api/user/keys')) {
      return new Response(
        JSON.stringify({ encryptedBlob: 'blob-base64-string', iv: 'iv-base64-string' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    throw new Error('Unknown url: ' + url);
  }) as any;

  try {
    const fetched = await fetchUserKeys(TEST_SERVER, 'auth-token');
    assert.equal(fetched.encryptedBlob, 'blob-base64-string');
    assert.equal(fetched.iv, 'iv-base64-string');

    const saved = await saveUserKeys(TEST_SERVER, 'auth-token', 'new-blob', 'new-iv');
    assert.equal(saved.success, true);
    assert.equal(saveCaptured.opts.headers.Authorization, 'Bearer auth-token');
    assert.deepEqual(JSON.parse(saveCaptured.opts.body), { encryptedBlob: 'new-blob', iv: 'new-iv' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================================
// Существующие методы
// ============================================================================

test('serverApi: registerUser, getBalance, createPayment, confirmMockPayment остаются работоспособными', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (url: string) => {
    if (url.endsWith('/api/user/register')) {
      return new Response(JSON.stringify({ userId: 'u1', token: 't1', balance: 10 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/api/user/balance')) {
      return new Response(JSON.stringify({ balance: 25 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/api/payments/create')) {
      return new Response(JSON.stringify({ confirmationUrl: 'https://pay.test' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/api/payments/confirm-mock')) {
      return new Response(JSON.stringify({ status: 'succeeded' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('Unknown url: ' + url);
  }) as any;

  try {
    const reg = await registerUser(TEST_SERVER);
    assert.equal(reg.userId, 'u1');

    const bal = await getBalance(TEST_SERVER, 't1');
    assert.equal(bal.balance, 25);

    const pay = await createPayment(TEST_SERVER, 't1', 'pack1');
    assert.equal(pay.confirmationUrl, 'https://pay.test');

    const conf = await confirmMockPayment(TEST_SERVER, 't1', 'mock1');
    assert.equal(conf.status, 'succeeded');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
