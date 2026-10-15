export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface PlayerState {
  status: PlayerStatus;
  error: string | null;
  /** Номер актуальной команды воспроизведения; любое событие с другим токеном — устаревшее */
  token: number;
}

export type PlayerEvent =
  | { type: 'request' }
  | { type: 'started'; token: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'failed'; token: number; message: string };

export const INITIAL_PLAYER_STATE: PlayerState = { status: 'idle', error: null, token: 0 };

/** Что вызвало запуск воспроизведения */
export type PlayTrigger =
  | 'start' // пользователь запустил озвучку (из idle/error)
  | 'chapter' // переход на другую главу (автоматический или ручной во время воспроизведения)
  | 'navigate'; // навигация внутри главы (стрелки, клик по предложению, следующее предложение)

export interface AnnounceInput {
  enabled: boolean;
  title: string | null | undefined;
  /** Индекс предложения, с которого начнётся чтение */
  sentenceIndex: number;
  trigger: PlayTrigger;
}
