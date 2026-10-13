import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UserState {
  userId: string;
  token: string;
  balance: number;
  serverUrl: string;
  isLoadingBalance: boolean;

  setServerUrl: (url: string) => void;
  updateBalance: (balance: number) => void;
  /** Регистрирует пользователя на сервере при первом обращении (или если force). */
  ensureRegistered: (force?: boolean) => Promise<void>;
  /** fetch с Authorization: Bearer; при 401 один раз перерегистрируется и повторяет запрос. */
  authFetch: (path: string, init?: RequestInit) => Promise<Response>;
  fetchBalance: () => Promise<void>;
  createPayment: (packId: string) => Promise<string>;
}

let registering: Promise<void> | null = null;

export const useUserStore = create<UserState>()(
  persist(
    (set, get) => ({
      userId: '',
      token: '',
      balance: 0, // реальный баланс приходит с сервера
      serverUrl: 'http://localhost:4000',
      isLoadingBalance: false,

      setServerUrl: (serverUrl: string) => set({ serverUrl, userId: '', token: '' }),

      updateBalance: (balance: number) => {
        if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0) return;
        set({ balance });
      },

      ensureRegistered: async (force = false) => {
        if (!force && get().token && get().userId) return;
        if (!registering) {
          registering = (async () => {
            const res = await fetch(`${get().serverUrl}/api/user/register`, { method: 'POST' });
            if (!res.ok) {
              const err = await res.json().catch(() => null);
              throw new Error(err?.error || `Не удалось зарегистрироваться на сервере (${res.status}).`);
            }
            const data = await res.json();
            if (typeof data?.token !== 'string' || typeof data?.userId !== 'string') {
              throw new Error('Некорректный ответ сервера при регистрации.');
            }
            set({
              userId: data.userId,
              token: data.token,
              balance: typeof data.balance === 'number' && Number.isFinite(data.balance) ? data.balance : 0,
            });
          })().finally(() => {
            registering = null;
          });
        }
        await registering;
      },

      authFetch: async (path: string, init: RequestInit = {}) => {
        const send = () => {
          const { serverUrl, token } = get();
          const headers = new Headers(init.headers);
          headers.set('Authorization', `Bearer ${token}`);
          return fetch(`${serverUrl}${path}`, { ...init, headers });
        };
        await get().ensureRegistered();
        let res = await send();
        if (res.status === 401) {
          await get().ensureRegistered(true);
          res = await send();
        }
        return res;
      },

      fetchBalance: async () => {
        set({ isLoadingBalance: true });
        try {
          const res = await get().authFetch('/api/user/balance');
          if (res.ok) {
            const data = await res.json();
            get().updateBalance(data.balance);
          }
        } catch {
          // Игнорируем недоступность сервера при локальной работе
        } finally {
          set({ isLoadingBalance: false });
        }
      },

      createPayment: async (packId: string) => {
        const res = await get().authFetch('/api/payments/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ packId, returnUrl: window.location.href }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => null);
          throw new Error(err?.error || 'Не удалось создать платеж в ЮKassa.');
        }

        const data = await res.json();
        return data.confirmationUrl;
      },
    }),
    {
      name: 'ai-book-reader-user',
      partialize: (s) => ({ userId: s.userId, token: s.token, balance: s.balance, serverUrl: s.serverUrl }),
    }
  )
);
