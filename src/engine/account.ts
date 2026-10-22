/**
 * Аккаунт и баланс (Домен). Владелец состояния st_user и единственный писатель в useUserStore.
 * Блок b_dom_account.
 */
import { useUserStore } from '../store/userStore';
import { getBookPositionsForSync, applySyncedBookPositions } from './bookPosition';
import { getSettingsForSync, applySyncedSettings, getApiKeysForEncryption, applyRestoredApiKeys } from './settings';
import {
  registerUser as apiRegisterUser,
  getBalance as apiGetBalance,
  createPayment as apiCreatePayment,
  confirmMockPayment as apiConfirmMockPayment,
  authRegister as apiAuthRegister,
  authLogin as apiAuthLogin,
  authRefresh as apiAuthRefresh,
  authForgotPassword as apiAuthForgotPassword,
  syncUserData as apiSyncUserData,
  fetchUserKeys as apiFetchUserKeys,
  saveUserKeys as apiSaveUserKeys,
  ServerError,
} from '../infra/serverApi';

export { ServerError };
import {
  deriveEncryptionKey,
  encryptPayload,
  decryptPayload,
} from '../infra/crypto/clientCrypto';

let registeringPromise: Promise<{ userId: string; token: string }> | null = null;
let refreshingPromise: Promise<{ token: string; refreshToken: string }> | null = null;

async function doRefresh(serverUrl: string, refreshToken: string): Promise<{ token: string; refreshToken: string }> {
  if (!refreshingPromise) {
    refreshingPromise = apiAuthRefresh(serverUrl, refreshToken).finally(() => {
      refreshingPromise = null;
    });
  }
  return refreshingPromise;
}

/**
 * Обертка для авторизованных вызовов API с авто-обновлением токена:
 * - При 401 проверяет refreshToken:
 *   - Если refreshToken есть, вызывает authRefresh, обновляет стор и повторяет запрос один раз.
 *   - Если refreshToken отсутствует или refresh вернул ошибку:
 *     - Для гостей (isGuest === true) перерегистрирует через reRegister().
 *     - Для зарегистрированных вызывает logout() и выбрасывает ошибку.
 */
async function withAuth<T>(
  operation: (token: string, serverUrl: string) => Promise<T>
): Promise<T> {
  const auth = await ensureRegistered();
  const serverUrl = useUserStore.getState().serverUrl;

  try {
    return await operation(auth.token, serverUrl);
  } catch (err) {
    if (err instanceof ServerError && err.status === 401) {
      const store = useUserStore.getState();
      if (store.refreshToken) {
        try {
          const newTokens = await doRefresh(serverUrl, store.refreshToken);
          useUserStore.getState().setAuth(
            store.userId,
            newTokens.token,
            store.email,
            newTokens.refreshToken,
            store.isGuest
          );
          return await operation(newTokens.token, serverUrl);
        } catch (refreshErr) {
          if (store.isGuest) {
            const newAuth = await reRegister();
            return await operation(newAuth.token, serverUrl);
          } else {
            logout();
            throw refreshErr;
          }
        }
      } else {
        if (store.isGuest) {
          const newAuth = await reRegister();
          return await operation(newAuth.token, serverUrl);
        } else {
          logout();
          throw err;
        }
      }
    }
    throw err;
  }
}

/**
 * Убедиться, что пользователь зарегистрирован (гость или аккаунт). Возвращает один общий промис для параллельных вызовов.
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
 * Сброс токена и гостевая регистрация заново.
 */
export async function reRegister(): Promise<{ userId: string; token: string }> {
  return ensureRegistered(true);
}

/**
 * Вход зарегистрированного пользователя по email и паролю.
 */
export async function login(
  email: string,
  password: string
): Promise<{ success: boolean; balance: number }> {
  const { serverUrl } = useUserStore.getState();
  const data = await apiAuthLogin(serverUrl, email, password);

  useUserStore.getState().setAuth(
    data.user.id,
    data.token,
    data.user.email,
    data.refreshToken,
    false
  );
  useUserStore.getState().setBalance(data.user.balance);

  try {
    await loadEncryptedApiKeys(password);
  } catch (err) {
    console.warn('[Account] Не удалось загрузить или расшифровать ключи API:', err);
  }

  void syncUserData().catch((err) => {
    console.warn('[Account] Ошибка фоновой синхронизации после входа:', err);
  });

  return {
    success: true,
    balance: data.user.balance,
  };
}

/**
 * Регистрация нового аккаунта по email и паролю с переносом гостевого баланса.
 */
export async function register(
  email: string,
  password: string
): Promise<{ success: boolean; balance: number }> {
  const store = useUserStore.getState();
  const guestToken = store.isGuest && store.token ? store.token : undefined;

  const data = await apiAuthRegister(store.serverUrl, email, password, guestToken);

  useUserStore.getState().setAuth(
    data.user.id,
    data.token,
    data.user.email,
    data.refreshToken,
    false
  );
  useUserStore.getState().setBalance(data.user.balance);

  try {
    await saveEncryptedApiKeys(password);
  } catch (err) {
    console.warn('[Account] Не удалось сохранить зашифрованные ключи API после регистрации:', err);
  }

  void syncUserData().catch((err) => {
    console.warn('[Account] Ошибка фоновой синхронизации после регистрации:', err);
  });

  return {
    success: true,
    balance: data.user.balance,
  };
}

/**
 * Выход из аккаунта. Сбрасывает данные сессии в useUserStore.
 */
export function logout(): void {
  useUserStore.getState().logout();
}

/**
 * Запрос ссылки на сброс пароля на указанный email.
 */
export async function requestPasswordReset(
  email: string
): Promise<{ success: boolean; message: string }> {
  const { serverUrl } = useUserStore.getState();
  return apiAuthForgotPassword(serverUrl, email);
}

/**
 * Сохранение зашифрованных ключей API (LLM/TTS) в облачном хранилище пользователя.
 */
export async function saveEncryptedApiKeys(password: string): Promise<void> {
  const { apiKeys, aggregatorKeys } = getApiKeysForEncryption();

  const hasApiKeys =
    Boolean(apiKeys) &&
    Object.values(apiKeys || {}).some((k) => typeof k === 'string' && k.trim().length > 0);
  const hasAggregatorKeys =
    Boolean(aggregatorKeys) &&
    Object.values(aggregatorKeys || {}).some((k) => typeof k === 'string' && k.trim().length > 0);

  if (!hasApiKeys && !hasAggregatorKeys) {
    return;
  }

  const { userId, email } = useUserStore.getState();
  const salt = userId || email;
  if (!salt) {
    return;
  }

  const key = await deriveEncryptionKey(password, salt);
  const { ciphertext, iv } = await encryptPayload({ apiKeys, aggregatorKeys }, key);

  await withAuth((token, serverUrl) =>
    apiSaveUserKeys(serverUrl, token, ciphertext, iv)
  );
}

/**
 * Загрузка и расшифровка сохранённых ключей API с сервера.
 */
export async function loadEncryptedApiKeys(password: string): Promise<void> {
  const data = await withAuth((token, serverUrl) =>
    apiFetchUserKeys(serverUrl, token)
  );

  if (!data.encryptedBlob || !data.iv) {
    return;
  }

  const { userId, email } = useUserStore.getState();
  const salt = userId || email;
  if (!salt) {
    return;
  }

  const key = await deriveEncryptionKey(password, salt);
  const payload = await decryptPayload(data.encryptedBlob, data.iv, key);

  if (payload && typeof payload === 'object') {
    applyRestoredApiKeys(payload.apiKeys, payload.aggregatorKeys);
  }
}

/**
 * Двусторонняя синхронизация позиций чтения, настроек и словаря с сервером.
 */
export async function syncUserData(): Promise<void> {
  // 1. Позиции книг через Менеджера библиотеки (b_dom_library)
  const positions = await getBookPositionsForSync();

  // 2. Настройки и правила словаря через Настройки (b_dom_settings)
  const { settings, replacementRules } = getSettingsForSync();

  // 3. Отправка на сервер
  const res = await withAuth((token, serverUrl) =>
    apiSyncUserData(serverUrl, token, { positions, settings, replacementRules })
  );

  // 4. Применение ответа через Домены
  if (res && typeof res === "object") {
    applySyncedSettings(res.settings, res.replacementRules);
    if (Array.isArray(res.positions)) {
      await applySyncedBookPositions(res.positions);
    }
  }

  // 5. Обновление lastSyncTime
  const serverTime = typeof res?.serverTime === "number" ? res.serverTime : Date.now();
  useUserStore.getState().setLastSyncTime(serverTime);
}

/**
 * Получение актуального баланса с сервера. При 401 повторяет запрос один раз после обновления токена или reRegister().
 */
export async function fetchBalance(): Promise<number> {
  const store = useUserStore.getState();
  store.setLoadingBalance(true);
  try {
    const data = await withAuth((token, serverUrl) => apiGetBalance(serverUrl, token));
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
 * Создание платежа для выбранного пакета. При 401 повторяет запрос один раз после обновления токена или reRegister().
 */
export async function createPayment(packId: string): Promise<string> {
  const data = await withAuth((token, serverUrl) =>
    apiCreatePayment(serverUrl, token, packId)
  );
  return data.confirmationUrl;
}

/**
 * Подтверждение тестового платежа (dev). При 401 повторяет запрос один раз, затем обновляет баланс.
 */
export async function confirmMockPayment(mockPaymentId: string): Promise<any> {
  const data = await withAuth((token, serverUrl) =>
    apiConfirmMockPayment(serverUrl, token, mockPaymentId)
  );
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
