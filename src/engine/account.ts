/**
 * Аккаунт и баланс (Домен). Владелец состояния st_user и единственный писатель в useUserStore.
 * Блок b_dom_account.
 */
import { useUserStore } from '../store/userStore';
import {
  registerUser as apiRegisterUser,
  getBalance as apiGetBalance,
  createPayment as apiCreatePayment,
  confirmMockPayment as apiConfirmMockPayment,
  ServerError,
} from '../infra/serverApi';

let registeringPromise: Promise<{ userId: string; token: string }> | null = null;

/**
 * Убедиться, что пользователь зарегистрирован. Возвращает один общий промис для параллельных вызовов.
 */
export function ensureRegistered(force = false): Promise<{ userId: string; token: string }> {
  const store = useUserStore.getState();
  if (!force && store.token && store.userId) {
    return Promise.resolve({ userId: store.userId, token: store.token });
  }

  if (!registeringPromise) {
    registeringPromise = (async () => {
      const { serverUrl } = useUserStore.getState();
      const data = await apiRegisterUser(serverUrl);
      useUserStore.getState().setAuth(data.userId, data.token);
      if (typeof data.balance === 'number' && Number.isFinite(data.balance)) {
        useUserStore.getState().setBalance(data.balance);
      }
      return { userId: data.userId, token: data.token };
    })().finally(() => {
      registeringPromise = null;
    });
  }

  return registeringPromise;
}

/**
 * Сброс токена и регистрация заново.
 */
export async function reRegister(): Promise<{ userId: string; token: string }> {
  return ensureRegistered(true);
}

/**
 * Получение актуального баланса с сервера. При 401 повторяет запрос один раз после reRegister().
 */
export async function fetchBalance(): Promise<number> {
  const store = useUserStore.getState();
  store.setLoadingBalance(true);
  try {
    const auth = await ensureRegistered();
    let data;
    try {
      data = await apiGetBalance(useUserStore.getState().serverUrl, auth.token);
    } catch (err) {
      if (err instanceof ServerError && err.status === 401) {
        const newAuth = await reRegister();
        data = await apiGetBalance(useUserStore.getState().serverUrl, newAuth.token);
      } else {
        throw err;
      }
    }
    reportBalance(data.balance);
    return data.balance;
  } catch {
    // Игнорируем сетевые ошибки при локальной работе
    return useUserStore.getState().balance;
  } finally {
    useUserStore.getState().setLoadingBalance(false);
  }
}

/**
 * Создание платежа для выбранного пакета. При 401 повторяет запрос один раз после reRegister().
 */
export async function createPayment(packId: string): Promise<string> {
  const auth = await ensureRegistered();
  let data;
  try {
    data = await apiCreatePayment(useUserStore.getState().serverUrl, auth.token, packId);
  } catch (err) {
    if (err instanceof ServerError && err.status === 401) {
      const newAuth = await reRegister();
      data = await apiCreatePayment(useUserStore.getState().serverUrl, newAuth.token, packId);
    } else {
      throw err;
    }
  }
  return data.confirmationUrl;
}

/**
 * Подтверждение тестового платежа (dev). При 401 повторяет запрос один раз, затем обновляет баланс.
 */
export async function confirmMockPayment(mockPaymentId: string): Promise<any> {
  const auth = await ensureRegistered();
  let data;
  try {
    data = await apiConfirmMockPayment(useUserStore.getState().serverUrl, auth.token, mockPaymentId);
  } catch (err) {
    if (err instanceof ServerError && err.status === 401) {
      const newAuth = await reRegister();
      data = await apiConfirmMockPayment(useUserStore.getState().serverUrl, newAuth.token, mockPaymentId);
    } else {
      throw err;
    }
  }
  await fetchBalance();
  return data;
}

/**
 * Обновление баланса в сторе (например, из заголовка X-Remaining-Balance провайдера).
 */
export function reportBalance(balance: number): void {
  if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0) return;
  useUserStore.getState().setBalance(balance);
}

/**
 * Запрос на открытие окна пополнения баланса.
 */
export function requestTopUp(): void {
  useUserStore.getState().setTopUpRequest(true);
}

/**
 * Сброс флага запроса на пополнение баланса при закрытии окна.
 */
export function clearTopUpRequest(): void {
  useUserStore.getState().setTopUpRequest(false);
}

/**
 * Установка адреса сервера AIBookReader.
 */
export function setServerUrl(url: string): void {
  useUserStore.getState().setServerUrl(url);
}
