/**
 * Чистая (без DOM/React) машина состояний плеера. ЕДИНЫЙ источник истины о том, что делает плеер.
 * Владелец состояния — audioStore (хранит PlayerState); AudioManager состояния воспроизведения не хранит,
 * а только исполняет команды и сообщает события с токеном.
 *
 * Таблица переходов (event → из статуса → в статус):
 *   request            любой                    → loading   (token++; error=null) — новая команда «играть»
 *   started(token)     loading                  → playing   (только свой токен)
 *   pause              playing                  → paused
 *   pause              loading                  → idle      (token++; пауза во время загрузки = остановка)
 *   resume             paused                   → playing
 *   stop               любой                    → idle      (token++)
 *   failed(token,msg)  loading | playing        → error     (только свой токен; token++)
 *   прочее                                      → без изменений (устаревшие/лишние события игнорируются)
 *
 * Конец фразы: acceptEnded(state, token) истинно только при status==='playing' и своём токене;
 * после этого хранилище сразу делает request (следующая фраза) либо stop (конец книги).
 * Производные флаги: isPlaying = loading|playing; isPaused = paused.
 */

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

export function reducePlayer(state: PlayerState, event: PlayerEvent): PlayerState {
  switch (event.type) {
    case 'request':
      return { status: 'loading', error: null, token: state.token + 1 };
    case 'started':
      if (event.token !== state.token || state.status !== 'loading') return state;
      return { ...state, status: 'playing' };
    case 'pause':
      if (state.status === 'playing') return { ...state, status: 'paused' };
      if (state.status === 'loading') return { status: 'idle', error: null, token: state.token + 1 };
      return state;
    case 'resume':
      return state.status === 'paused' ? { ...state, status: 'playing' } : state;
    case 'stop':
      if (state.status === 'idle' && state.error === null) return { ...state, token: state.token + 1 };
      return { status: 'idle', error: null, token: state.token + 1 };
    case 'failed':
      if (event.token !== state.token) return state;
      if (state.status !== 'loading' && state.status !== 'playing') return state;
      return { status: 'error', error: event.message || 'Ошибка воспроизведения.', token: state.token + 1 };
    default:
      return state;
  }
}

export function isPlayingStatus(status: PlayerStatus): boolean {
  return status === 'loading' || status === 'playing';
}

export function isPausedStatus(status: PlayerStatus): boolean {
  return status === 'paused';
}

/** Можно ли принять событие «фраза закончилась» от движка */
export function acceptEnded(state: PlayerState, token: number): boolean {
  return state.status === 'playing' && state.token === token;
}

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

/**
 * Озвучивать ли название главы перед первым предложением.
 * Нет — если выключено, название пустое/отсутствует, чтение идёт с середины главы
 * или это обычная навигация внутри главы.
 */
export function shouldAnnounceChapter({ enabled, title, sentenceIndex, trigger }: AnnounceInput): boolean {
  if (!enabled) return false;
  if (!title || title.trim().length === 0) return false;
  if (sentenceIndex !== 0) return false;
  return trigger === 'start' || trigger === 'chapter';
}
