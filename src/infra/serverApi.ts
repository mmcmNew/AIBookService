/**
 * Адаптер к серверу AIBookReader: регистрация, баланс, платежи (ЮKassa),
 * авторизация, синхронизация и хранение ключей.
 * Блок b_infra_server (Инфраструктура). Чистый HTTP, состояния не знает.
 */

export class ServerError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ServerError';
  }
}

export function cleanServerUrl(serverUrl?: string): string {
  let url = (serverUrl || '').trim();
  if (!url || url === 'http://localhost:4000') {
    if (typeof window !== 'undefined' && window.location?.origin && window.location.protocol === 'https:') {
      return window.location.origin;
    }
  }
  return url || 'http://localhost:4000';
}

// ============================================================================
// Гостевой аккаунт и платежи (существующие методы)
// ============================================================================

export async function registerUser(
  serverUrl: string
): Promise<{ userId: string; token: string; balance?: number }> {
  const url = cleanServerUrl(serverUrl);
  const res = await fetch(`${url}/api/user/register`, {
    method: 'POST',
  });

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new ServerError(res.status, err?.error || err?.message || `Не удалось зарегистрироваться на сервере (${res.status}).`);
  }

  const data = await res.json();
  if (typeof data?.token !== 'string' || typeof data?.userId !== 'string') {
    throw new ServerError(res.status, 'Некорректный ответ сервера при регистрации.');
  }

  return {
    userId: data.userId,
    token: data.token,
    balance: typeof data.balance === 'number' && Number.isFinite(data.balance) ? data.balance : 0,
  };
}

export async function getBalance(
  serverUrl: string,
  token: string
): Promise<{ balance: number }> {
  const res = await fetch(`${cleanServerUrl(serverUrl)}/api/user/balance`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new ServerError(res.status, err?.error || err?.message || `Не удалось получить баланс (${res.status}).`);
  }

  const data = await res.json();
  const balance = typeof data?.balance === 'number' && Number.isFinite(data.balance) ? data.balance : 0;
  return { balance };
}

export async function createPayment(
  serverUrl: string,
  token: string,
  packId: string
): Promise<{ confirmationUrl: string }> {
  const returnUrl = typeof window !== 'undefined' ? window.location.href : '';
  const res = await fetch(`${cleanServerUrl(serverUrl)}/api/payments/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ packId, returnUrl }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new ServerError(res.status, err?.error || err?.message || 'Не удалось создать платеж в ЮKassa.');
  }

  const data = await res.json();
  return data;
}

export async function confirmMockPayment(
  serverUrl: string,
  token: string,
  mockPaymentId: string
): Promise<any> {
  const res = await fetch(`${cleanServerUrl(serverUrl)}/api/payments/confirm-mock`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ mockPaymentId }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new ServerError(res.status, err?.error || err?.message || `Не удалось подтвердить тестовый платёж (${res.status}).`);
  }

  return res.json();
}

// ============================================================================
// Авторизация (Email + Пароль, JWT Refresh)
// ============================================================================

export async function authRegister(
  serverUrl: string,
  email: string,
  password: string,
  guestToken?: string
): Promise<{
  user: { id: string; email: string; balance: number };
  token: string;
  refreshToken: string;
}> {
  const body: Record<string, string> = { email, password };
  if (guestToken) {
    body.guestToken = guestToken;
  }

  const res = await fetch(`${cleanServerUrl(serverUrl)}/api/auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new ServerError(res.status, err?.error || err?.message || `Не удалось зарегистрироваться (${res.status}).`);
  }

  const data = await res.json();
  if (
    typeof data?.token !== 'string' ||
    typeof data?.refreshToken !== 'string' ||
    !data?.user?.id ||
    !data?.user?.email
  ) {
    throw new ServerError(res.status, 'Некорректный ответ сервера при регистрации.');
  }

  return {
    user: {
      id: String(data.user.id),
      email: String(data.user.email),
      balance: typeof data.user.balance === 'number' && Number.isFinite(data.user.balance) ? data.user.balance : 0,
    },
    token: data.token,
    refreshToken: data.refreshToken,
  };
}

export async function authLogin(
  serverUrl: string,
  email: string,
  password: string
): Promise<{
  user: { id: string; email: string; balance: number };
  token: string;
  refreshToken: string;
}> {
  const res = await fetch(`${cleanServerUrl(serverUrl)}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new ServerError(res.status, err?.error || err?.message || `Не удалось войти (${res.status}).`);
  }

  const data = await res.json();
  if (
    typeof data?.token !== 'string' ||
    typeof data?.refreshToken !== 'string' ||
    !data?.user?.id ||
    !data?.user?.email
  ) {
    throw new ServerError(res.status, 'Некорректный ответ сервера при авторизации.');
  }

  return {
    user: {
      id: String(data.user.id),
      email: String(data.user.email),
      balance: typeof data.user.balance === 'number' && Number.isFinite(data.user.balance) ? data.user.balance : 0,
    },
    token: data.token,
    refreshToken: data.refreshToken,
  };
}

export async function authRefresh(
  serverUrl: string,
  refreshToken: string
): Promise<{
  token: string;
  refreshToken: string;
}> {
  const res = await fetch(`${cleanServerUrl(serverUrl)}/api/auth/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refreshToken }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new ServerError(res.status, err?.error || err?.message || `Не удалось обновить токен (${res.status}).`);
  }

  const data = await res.json();
  if (typeof data?.token !== 'string' || typeof data?.refreshToken !== 'string') {
    throw new ServerError(res.status, 'Некорректный ответ сервера при обновлении токена.');
  }

  return {
    token: data.token,
    refreshToken: data.refreshToken,
  };
}

export async function authForgotPassword(
  serverUrl: string,
  email: string
): Promise<{
  success: boolean;
  message: string;
}> {
  const res = await fetch(`${cleanServerUrl(serverUrl)}/api/auth/forgot-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new ServerError(res.status, err?.error || err?.message || `Не удалось отправить запрос на сброс пароля (${res.status}).`);
  }

  const data = await res.json().catch(() => ({}));
  return {
    success: typeof data?.success === 'boolean' ? data.success : true,
    message: typeof data?.message === 'string' ? data.message : 'Инструкции отправлены на email.',
  };
}

// ============================================================================
// Синхронизация данных пользователя и зашифрованных ключей
// ============================================================================

export async function syncUserData(
  serverUrl: string,
  token: string,
  payload: {
    positions?: any[];
    settings?: any;
    replacementRules?: any[];
  }
): Promise<any> {
  const res = await fetch(`${cleanServerUrl(serverUrl)}/api/user/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new ServerError(res.status, err?.error || err?.message || `Не удалось синхронизировать данные (${res.status}).`);
  }

  return res.json();
}

export async function fetchUserKeys(
  serverUrl: string,
  token: string
): Promise<{
  encryptedBlob: string | null;
  iv: string | null;
}> {
  const res = await fetch(`${cleanServerUrl(serverUrl)}/api/user/keys`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new ServerError(res.status, err?.error || err?.message || `Не удалось получить ключи пользователя (${res.status}).`);
  }

  const data = await res.json();
  return {
    encryptedBlob: typeof data?.encryptedBlob === 'string' ? data.encryptedBlob : null,
    iv: typeof data?.iv === 'string' ? data.iv : null,
  };
}

export async function saveUserKeys(
  serverUrl: string,
  token: string,
  encryptedBlob: string,
  iv: string
): Promise<{ success: boolean }> {
  const res = await fetch(`${cleanServerUrl(serverUrl)}/api/user/keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ encryptedBlob, iv }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new ServerError(res.status, err?.error || err?.message || `Не удалось сохранить ключи пользователя (${res.status}).`);
  }

  const data = await res.json().catch(() => ({}));
  return {
    success: typeof data?.success === 'boolean' ? data.success : true,
  };
}
