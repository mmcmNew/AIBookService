import { SentenceItem } from '../../types/book';
import { SynthesisOptions, TTSProviderType } from '../../types/tts';
import { applyPronunciationDictionary } from '../tokenizer/dictionaryReplacer';
import { useSettingsStore } from '../../store/settingsStore';
import { useAudioStore } from '../../store/audioStore';
import { PlayerEvent, PlayerState, reducePlayer } from './playerState';
import { playChime } from './chime';
import { htmlAudioPlayer } from '../../infra/audio/htmlAudioPlayer';
import {
  getOrFetchAudio,
  buildCacheKey,
  buildChapterCacheKey,
  purgeOrphanAudioCache,
  deleteAudioCacheForBook,
} from './audioFetch';

export {
  buildCacheKey,
  buildChapterCacheKey,
  getOrFetchAudio,
  purgeOrphanAudioCache,
  deleteAudioCacheForBook,
};

/**
 * AudioManager — «исполнитель»: проигрывает одну фразу (при необходимости с объявлением главы)
 * и сообщает о событиях. Владелец состояния плеера (st_player, b_dom_audio).
 * Каждое событие несёт token команды; всё, что относится к устаревшему токену, молча отбрасывается.
 */

export interface AudioEngineHandlers {
  /** Фраза реально зазвучала */
  onStarted: (token: number) => void;
  /** Фраза доиграла до конца */
  onEnded: (token: number) => void;
  /** Ошибка синтеза/воспроизведения основной фразы */
  onFailed: (token: number, message: string) => void;
}

export interface SpeakJob {
  token: number;
  bookId: string;
  chapterId: string;
  sentence: SentenceItem;
  providerType: TTSProviderType;
  options: SynthesisOptions;
  /** Объявление главы перед фразой (ошибки объявления не блокируют чтение) */
  intro?: { title: string; chime: boolean } | null;
}

const CHAPTER_PAUSE_MS = 600;
const SPEECH_INTRO_TIMEOUT_MS = 20000;

function sanitizeSpeed(v: number | undefined): number {
  return Number.isFinite(v) ? Math.max(0.25, Math.min(4, v as number)) : 1;
}

function sanitizeVolume(v: number | undefined): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v as number)) : 1;
}

export class AudioManager {
  private handlers: AudioEngineHandlers = { onStarted: () => {}, onEnded: () => {}, onFailed: () => {} };

  /** Токен актуальной команды; -1 — ничего не играет (всё, что с другим токеном, устарело) */
  private token = -1;
  /** Токен фразы, чьё окончание/ошибку мы ждём от <audio>/speechSynthesis; null — не ждём */
  private mainToken: number | null = null;
  private mode: 'audio' | 'speech' = 'audio';
  private utterance: SpeechSynthesisUtterance | null = null;
  private abort: AbortController | null = null;
  /** Функции, будящие ожидающие await (пауза, конец объявления) при отмене */
  private cancelHooks = new Set<() => void>();

  constructor() {
    htmlAudioPlayer.setCallbacks({
      onEnded: this.handleAudioEnded,
      onError: this.handleAudioError,
    });
  }

  public setHandlers(handlers: AudioEngineHandlers) {
    this.handlers = handlers;
  }

  private isCurrent(token: number): boolean {
    return token === this.token;
  }

  private handleAudioEnded = () => {
    if (this.mainToken === null || this.mode !== 'audio') return;
    const t = this.mainToken;
    this.mainToken = null;
    this.handlers.onEnded(t);
  };

  private handleAudioError = () => {
    if (this.mainToken === null || this.mode !== 'audio') return; // ошибка от сброса источника или объявления
    const t = this.mainToken;
    this.mainToken = null;
    this.handlers.onFailed(t, 'Ошибка воспроизведения аудио.');
  };

  /** Останавливает всё, что играет/ждёт, и обесценивает токен */
  private halt() {
    this.token = -1;
    this.mainToken = null;
    this.utterance = null;
    this.abort?.abort();
    this.abort = null;
    for (const hook of Array.from(this.cancelHooks)) hook();
    this.cancelHooks.clear();
    htmlAudioPlayer.stop();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume(); // cancel() на паузе в некоторых браузерах оставляет движок «на паузе»
    }
  }

  /** Ожидание, которое прерывается отменой команды */
  private wait<T>(setup: (resolve: (v: T) => void) => (() => void) | void, cancelValue: T): Promise<T> {
    return new Promise<T>((resolve) => {
      let cleanup: (() => void) | void;
      const hook = () => {
        cleanup?.();
        resolve(cancelValue);
      };
      this.cancelHooks.add(hook);
      cleanup = setup((v) => {
        this.cancelHooks.delete(hook);
        cleanup?.();
        resolve(v);
      });
    });
  }

  private sleep(ms: number): Promise<void> {
    return this.wait<void>((resolve) => {
      const timer = setTimeout(() => resolve(), ms);
      return () => clearTimeout(timer);
    }, undefined);
  }

  /**
   * Запускает озвучку фразы (с объявлением главы, если задано). Предыдущая команда отменяется.
   * Результат приходит через handlers (onStarted → onEnded | onFailed).
   */
  public speak(job: SpeakJob): void {
    this.halt();
    this.token = job.token;
    this.abort = new AbortController();
    void this.run(job, this.abort.signal);
  }

  private async run(job: SpeakJob, signal: AbortSignal) {
    const { token, providerType } = job;
    const options: SynthesisOptions = {
      ...job.options,
      speed: sanitizeSpeed(job.options.speed),
      volume: sanitizeVolume(job.options.volume),
    };
    this.mode = providerType === 'webspeech' ? 'speech' : 'audio';

    try {
      if (job.intro) {
        await this.announceChapter(job, options, signal);
        if (!this.isCurrent(token)) return;
      }

      const rules = useSettingsStore.getState().replacementRules;
      const text = applyPronunciationDictionary(job.sentence.rawText, rules, job.bookId);

      if (providerType === 'webspeech') {
        this.mainToken = token;
        this.startUtterance(text, options, token, 'main');
        this.handlers.onStarted(token);
        return;
      }

      const key = buildCacheKey(job.bookId, job.chapterId, job.sentence.id, providerType, options, text);
      const buffer = await getOrFetchAudio(key, job.bookId, job.chapterId, job.sentence.id, text, providerType, options, signal);
      if (!this.isCurrent(token)) return;

      htmlAudioPlayer.setupAudioBuffer(buffer, options.speed, options.volume ?? 1);
      this.mainToken = token;
      await htmlAudioPlayer.play();
      if (!this.isCurrent(token)) return;
      this.handlers.onStarted(token);
    } catch (err) {
      if (!this.isCurrent(token)) return;
      const e = err as { name?: string; message?: string };
      if (e?.name === 'AbortError') return; // отмена — не ошибка: Оркестратор молча выходит
      this.mainToken = null;
      this.handlers.onFailed(token, e?.message || 'Ошибка синтеза речи.');
    }
  }

  /** Сигнал + озвучка названия главы + пауза. Любая ошибка молча пропускается. */
  private async announceChapter(job: SpeakJob, options: SynthesisOptions, signal: AbortSignal) {
    const { token, providerType } = job;
    const title = job.intro!.title.trim();
    try {
      if (job.intro!.chime) {
        const chime = playChime(options.volume ?? 1);
        this.cancelHooks.add(chime.cancel);
        await chime.done;
        this.cancelHooks.delete(chime.cancel);
        if (!this.isCurrent(token)) return;
      }

      if (providerType === 'webspeech') {
        await this.wait<void>((resolve) => {
          if (!this.startUtterance(title, options, token, 'intro', resolve)) {
            resolve();
            return;
          }
          const timer = setTimeout(() => resolve(), SPEECH_INTRO_TIMEOUT_MS);
          return () => clearTimeout(timer);
        }, undefined);
      } else {
        const key = buildChapterCacheKey(job.bookId, job.chapterId, providerType, options, title);
        const buffer = await getOrFetchAudio(key, job.bookId, job.chapterId, -1, title, providerType, options, signal);
        if (!this.isCurrent(token)) return;
        htmlAudioPlayer.setupAudioBuffer(buffer, options.speed, options.volume ?? 1);
        const finished = this.wait<void>((resolve) => {
          void htmlAudioPlayer.waitForEnd().then(resolve);
        }, undefined);
        await htmlAudioPlayer.play();
        await finished;
      }
    } catch {
      // объявление не критично — читаем главу дальше
    }
    if (!this.isCurrent(token)) return;
    await this.sleep(CHAPTER_PAUSE_MS);
  }

  /** Возвращает false, если речевой движок недоступен */
  private startUtterance(
    text: string,
    options: SynthesisOptions,
    token: number,
    role: 'main' | 'intro',
    onDone?: () => void
  ): boolean {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      if (role === 'main') {
        this.mainToken = null;
        this.handlers.onFailed(token, 'Системный синтез речи недоступен в этом браузере.');
      }
      return false;
    }
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    this.utterance = utterance;

    const voices = window.speechSynthesis.getVoices();
    if (options.voiceId) {
      const match = voices.find((v) => v.name === options.voiceId);
      if (match) utterance.voice = match;
    }

    utterance.rate = sanitizeSpeed(options.speed);
    utterance.pitch = Math.max(0, Math.min(2, 1 + (options.pitch || 0) / 10));
    utterance.volume = sanitizeVolume(options.volume);

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      onDone?.();
    };

    utterance.onend = () => {
      if (!this.isCurrent(token)) return;
      if (role === 'main') {
        if (this.mainToken === token) {
          this.mainToken = null;
          this.handlers.onEnded(token);
        }
      } else {
        finish();
      }
    };

    utterance.onerror = (e) => {
      if (!this.isCurrent(token)) return;
      if (role === 'main') {
        if (this.mainToken === token) {
          this.mainToken = null;
          this.handlers.onFailed(token, 'Ошибка системного синтеза речи.');
        }
      } else {
        finish();
      }
    };

    window.speechSynthesis.speak(utterance);
    return true;
  }

  /** Пауза текущей фразы (вызывается хранилищем только из статуса playing) */
  public pause() {
    if (this.mode === 'speech') {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.pause();
    } else {
      htmlAudioPlayer.pause();
    }
  }

  /** Продолжение (вызывается хранилищем только из статуса paused) */
  public resume() {
    if (this.mode === 'speech') {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.resume();
      return;
    }
    const token = this.mainToken;
    htmlAudioPlayer.play().catch((e) => {
      console.error('Audio resume error:', e);
      if (token !== null && token === this.mainToken) {
        this.mainToken = null;
        this.handlers.onFailed(token, 'Не удалось продолжить воспроизведение.');
      }
    });
  }

  public stop() {
    this.halt();
  }

  public setSpeed(speed: number) {
    htmlAudioPlayer.setSpeed(speed);
  }

  public setVolume(volume: number) {
    htmlAudioPlayer.setVolume(volume);
  }

  // ---------------------------------------------------------------------------
  // Управление состоянием плеера (st_player).
  // Блок b_dom_audio — единственный владелец этого среза состояния.
  // ---------------------------------------------------------------------------

  public dispatch(event: PlayerEvent): PlayerState {
    const cur = useAudioStore.getState();
    const prev: PlayerState = { status: cur.status, error: cur.error, token: cur.playToken };
    const next = reducePlayer(prev, event);
    if (next !== prev) {
      useAudioStore.getState().applyPlayerState(next);
    }
    return next;
  }

  public clearError(): void {
    useAudioStore.getState().clearError();
  }

  public setNotice(notice: string | null): void {
    useAudioStore.getState().setNotice(notice);
  }

  public setWaitingPage(page: number | null): void {
    useAudioStore.getState().setWaitingPage(page);
  }

  public clearWaitingPage(): void {
    useAudioStore.getState().setWaitingPage(null);
  }

  public stopPlayer(notice: string | null = null): void {
    this.stop();
    this.dispatch({ type: 'stop' });
    useAudioStore.getState().setNotice(notice);
    useAudioStore.getState().setWaitingPage(null);
  }

  public beginPlayerWait(page: number): void {
    this.stop();
    this.dispatch({ type: 'request' });
    useAudioStore.getState().setNotice(null);
    useAudioStore.getState().setWaitingPage(page);
  }

  public startPlayerRequest(): PlayerState {
    const next = this.dispatch({ type: 'request' });
    useAudioStore.getState().setNotice(null);
    useAudioStore.getState().setWaitingPage(null);
    return next;
  }

  public onPlayerStarted(token: number): void {
    this.dispatch({ type: 'started', token });
  }

  public onPlayerFailed(token: number, message: string): PlayerState {
    return this.dispatch({ type: 'failed', token, message });
  }

  public pausePlayer(): void {
    this.pause();
    this.dispatch({ type: 'pause' });
  }

  public resumePlayer(): void {
    this.dispatch({ type: 'resume' });
    this.resume();
  }
}

export const audioManager = new AudioManager();
