/**
 * Адаптер к серверу AIBookReader: регистрация, баланс, платежи (ЮKassa).
 * Блок b_infra_server (Инфраструктура). Чистый HTTP, состояния не знает.
 */

export class ServerError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ServerError';
  }
}

export async function registerUser(
  serverUrl: string
): Promise<{ userId: string; token: string; balance?: number }> {
  const res = await fetch(`${serverUrl}/api/user/register`, {
    method: 'POST',
  });

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new ServerError(res.status, err?.error || `Не удалось зарегистрироваться на сервере (${res.status}).`);
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
  const res = await fetch(`${serverUrl}/api/user/balance`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new ServerError(res.status, err?.error || `Не удалось получить баланс (${res.status}).`);
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
  const res = await fetch(`${serverUrl}/api/payments/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ packId, returnUrl }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new ServerError(res.status, err?.error || 'Не удалось создать платеж в ЮKassa.');
  }

  const data = await res.json();
  return data;
}

export async function confirmMockPayment(
  serverUrl: string,
  token: string,
  mockPaymentId: string
): Promise<any> {
  const res = await fetch(`${serverUrl}/api/payments/confirm-mock`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ mockPaymentId }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new ServerError(res.status, err?.error || `Не удалось подтвердить тестовый платёж (${res.status}).`);
  }

  return res.json();
}
