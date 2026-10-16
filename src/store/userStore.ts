import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface UserState {
  userId: string;
  token: string;
  balance: number;
  serverUrl: string;
  isLoadingBalance: boolean;
  topUpRequest: boolean;

  setAuth: (userId: string, token: string) => void;
  setBalance: (balance: number) => void;
  setLoadingBalance: (isLoading: boolean) => void;
  setServerUrl: (url: string) => void;
  setTopUpRequest: (topUpRequest: boolean) => void;
}

export const useUserStore = create<UserState>()(
  persist(
    (set) => ({
      userId: '',
      token: '',
      balance: 0,
      serverUrl: 'http://localhost:4000',
      isLoadingBalance: false,
      topUpRequest: false,

      setAuth: (userId: string, token: string) => set({ userId, token }),

      setBalance: (balance: number) => {
        if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0) return;
        set({ balance });
      },

      setLoadingBalance: (isLoadingBalance: boolean) => set({ isLoadingBalance }),

      setServerUrl: (serverUrl: string) => set({ serverUrl, userId: '', token: '' }),

      setTopUpRequest: (topUpRequest: boolean) => set({ topUpRequest }),
    }),
    {
      name: 'ai-book-reader-user',
      partialize: (s) => ({ userId: s.userId, token: s.token, balance: s.balance, serverUrl: s.serverUrl }),
    }
  )
);
