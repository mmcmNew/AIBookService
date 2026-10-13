import { create } from 'zustand';
import {
  INITIAL_PLAYER_STATE,
  PlayerState,
  PlayerStatus,
  isPausedStatus,
  isPlayingStatus,
} from '../engine/audio/playerState';

export interface AudioState {
  /** ЕДИНСТВЕННЫЙ источник истины о плеере (см. engine/audio/playerState.ts) */
  status: PlayerStatus;
  error: string | null;
  /** Информационное сообщение об остановке («Конец книги», «Конец главы»); сбрасывается при новом запуске */
  notice: string | null;
  /** Номер актуальной команды воспроизведения (защита от устаревших событий) */
  playToken: number;
  /** Постраничные PDF: чтение ждёт распознавания этой страницы (status = loading) */
  waitingPage: number | null;

  /** Производные (только чтение): isPlaying = loading|playing, isPaused = paused */
  isPlaying: boolean;
  isPaused: boolean;
  isBuffering: boolean;

  applyPlayerState: (next: PlayerState) => void;
  clearError: () => void;
  setNotice: (notice: string | null) => void;
  setWaitingPage: (page: number | null) => void;
  reset: () => void;
}

function derive(status: PlayerStatus) {
  return {
    isPlaying: isPlayingStatus(status),
    isPaused: isPausedStatus(status),
    isBuffering: status === 'loading',
  };
}

export const useAudioStore = create<AudioState>((set) => ({
  status: INITIAL_PLAYER_STATE.status,
  error: null,
  notice: null,
  playToken: INITIAL_PLAYER_STATE.token,
  waitingPage: null,
  ...derive('idle'),

  applyPlayerState: (next: PlayerState) =>
    set({
      status: next.status,
      error: next.error,
      playToken: next.token,
      ...derive(next.status),
    }),

  clearError: () => set({ error: null }),
  setNotice: (notice: string | null) => set({ notice }),
  setWaitingPage: (waitingPage: number | null) => set({ waitingPage }),
  reset: () =>
    set({
      status: INITIAL_PLAYER_STATE.status,
      error: null,
      notice: null,
      playToken: INITIAL_PLAYER_STATE.token,
      waitingPage: null,
      ...derive('idle'),
    }),
}));

if (typeof window !== 'undefined' && (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __aibrAudio?: typeof useAudioStore }).__aibrAudio = useAudioStore;
}
