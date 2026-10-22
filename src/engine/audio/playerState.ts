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
 * Производные флаги считает сам audioStore из status: isPlaying = loading|playing; isPaused = paused.
 */

import type { AnnounceInput, PlayerEvent, PlayerState, PlayerStatus, PlayTrigger } from '../../types/player';
import { INITIAL_PLAYER_STATE } from '../../types/player';

export type { PlayerStatus, PlayerState, PlayerEvent, PlayTrigger, AnnounceInput };
export { INITIAL_PLAYER_STATE };

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

/** Можно ли принять событие «фраза закончилась» от движка */
export function acceptEnded(state: PlayerState, token: number): boolean {
  return state.status === 'playing' && state.token === token;
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
