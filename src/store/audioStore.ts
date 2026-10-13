import { create } from 'zustand';
import {
  INITIAL_PLAYER_STATE,
  PlayerEvent,
  PlayerState,
  PlayerStatus,
  isPausedStatus,
  isPlayingStatus,
  reducePlayer,
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

  dispatch: (event: PlayerEvent) => PlayerState;
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

export const useAudioStore = create<AudioState>((set, get) => ({
  status: INITIAL_PLAYER_STATE.status,
  error: null,
  notice: null,
  playToken: INITIAL_PLAYER_STATE.token,
  waitingPage: null,
  ...derive('idle'),

  dispatch: (event: PlayerEvent): PlayerState => {
    const cur = get();
    const prev: PlayerState = { status: cur.status, error: cur.error, token: cur.playToken };
    const next = reducePlayer(prev, event);
    if (next !== prev) {
      set({ status: next.status, error: next.error, playToken: next.token, ...derive(next.status) });
    }
    return next;
  },

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
