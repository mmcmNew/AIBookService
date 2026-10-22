import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface UserState {
  userId: string;
  token: string;
  email: string;
  refreshToken: string;
  isGuest: boolean;
  balance: number;
  serverUrl: string;
  isLoadingBalance: boolean;
  topUpRequest: boolean;
  lastSyncTime: number | null;

  setAuth: (userId: string, token: string, email?: string, refreshToken?: string, isGuest?: boolean) => void;
  setBalance: (balance: number) => void;
  setLoadingBalance: (isLoading: boolean) => void;
  setServerUrl: (url: string) => void;
  setTopUpRequest: (topUpRequest: boolean) => void;
  setLastSyncTime: (time: number | null) => void;
  logout: () => void;
}

export function getDefaultServerUrl(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    if (window.location.protocol === 'https:') {
      return window.location.origin;
    }
  }
  return 'http://localhost:4000';
}

export const useUserStore = create<UserState>()(
  persist(
    (set) => ({
      userId: '',
      token: '',
      email: '',
      refreshToken: '',
      isGuest: true,
      balance: 0,
      serverUrl: getDefaultServerUrl(),
      isLoadingBalance: false,
      topUpRequest: false,
      lastSyncTime: null,

      setAuth: (userId: string, token: string, email?: string, refreshToken?: string, isGuest?: boolean) =>
        set({
          userId,
          token,
          email: email ?? '',
          refreshToken: refreshToken ?? '',
          isGuest: isGuest !== undefined ? isGuest : true,
        }),

      setBalance: (balance: number) => {
        if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0) return;
        set({ balance });
      },

      setLoadingBalance: (isLoadingBalance: boolean) => set({ isLoadingBalance }),

      setServerUrl: (serverUrl: string) =>
        set({
          serverUrl,
          userId: '',
          token: '',
          refreshToken: '',
          email: '',
          isGuest: true,
          lastSyncTime: null,
        }),

      setTopUpRequest: (topUpRequest: boolean) => set({ topUpRequest }),

      setLastSyncTime: (lastSyncTime: number | null) => set({ lastSyncTime }),

      logout: () =>
        set({
          userId: '',
          token: '',
          refreshToken: '',
          email: '',
          balance: 0,
          isGuest: true,
          lastSyncTime: null,
        }),
    }),
    {
      name: 'ai-book-reader-user',
      partialize: (s) => ({
        userId: s.userId,
        token: s.token,
        refreshToken: s.refreshToken,
        email: s.email,
        isGuest: s.isGuest,
        balance: s.balance,
        serverUrl: s.serverUrl,
        lastSyncTime: s.lastSyncTime,
      }),
      onRehydrateStorage: () => (state) => {
        if (state && typeof window !== 'undefined' && window.location?.protocol === 'https:') {
          if (!state.serverUrl || state.serverUrl === 'http://localhost:4000') {
            state.serverUrl = window.location.origin;
          }
        }
      },
    }
  )
);
