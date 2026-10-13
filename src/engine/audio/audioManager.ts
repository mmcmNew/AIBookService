import { db } from '../../storage/db';
import { SentenceItem } from '../../types/book';
import { SynthesisOptions, TTSProviderType } from '../../types/tts';
import { getProvider } from '../providers';
import { applyPronunciationDictionary } from '../tokenizer/dictionaryReplacer';
import { useSettingsStore } from '../../store/settingsStore';
import { playChime } from './chime';

/**
 * AudioManager — «исполнитель»: проигрывает одну фразу (при необходимости с объявлением главы)
 * и сообщает о событиях. Состояния воспроизведения (играет/пауза/…) он НЕ хранит —
 * единственный источник истины см. playerState.ts / audioStore.ts.
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
  /** Следующая фраза — для фоновой предзагрузки */
  next?: { chapterId: string; sentence: SentenceItem } | null;
}

const MEMORY_CACHE_LIMIT = 40;
const CHAPTER_PAUSE_MS = 600;
const SPEECH_INTRO_TIMEOUT_MS = 20000;

function sanitizeSpeed(v: number | undefined): number {
  return Number.isFinite(v) ? Math.max(0.25, Math.min(4, v as number)) : 1;
}

function sanitizeVolume(v: number | undefined): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v as number)) : 1;
}

/** Определяет MIME по сигнатуре, чтобы WAV/OGG не подавались как audio/mpeg */
function sniffAudioMime(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf, 0, Math.min(12, buf.byteLength));
  const ascii = (o: number, n: number) => String.fromCharCode(...Array.from(b.subarray(o, o + n)));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  return 'audio/mpeg';
}

/** Ключ кэша учитывает провайдера, модель, голос, шлюз и режим API — кэши разных источников не смешиваются */
export function buildCacheKey(
  bookId: string,
  chapterId: string,
  sentenceId: number,
  providerType: TTSProviderType,
  options: SynthesisOptions,
  text: string
): string {
  return [
    bookId,
    chapterId,
    sentenceId,
    providerType,
    options.model || '',
    options.voiceId || '',
    options.baseUrl || '',
    options.apiMode || '',
    text,
  ].join('_');
}

/** Ключ кэша объявления главы: префикс 'chapter:' отличает его от обычных предложений */
export function buildChapterCacheKey(
  bookId: string,
  chapterId: string,
  providerType: TTSProviderType,
  options: SynthesisOptions,
  title: string
): string {
  return 'chapter:' + buildCacheKey(bookId, chapterId, -1, providerType, options, title);
}

export class AudioManager {
  private audioElement: HTMLAudioElement | null = null;
  private currentObjectUrl: string | null = null;
  private handlers: AudioEngineHandlers = { onStarted: () => {}, onEnded: () => {}, onFailed: () => {} };

  /** Токен актуальной команды; -1 — ничего не играет (всё, что с другим токеном, устарело) */
  private token = -1;
  /** Токен фразы, чьё окончание/ошибку мы ждём от <audio>/speechSynthesis; null — не ждём */
  private mainToken: number | null = null;
  private mode: 'audio' | 'speech' = 'audio';
  private utterance: SpeechSynthesisUtterance | null = null;
  private abort: AbortController | null = null;
  private prefetchAbort: AbortController | null = null;
  /** Функции, будящие ожидающие await (пауза, конец объявления) при отмене */
  private cancelHooks = new Set<() => void>();

  private memoryAudioCache = new Map<string, ArrayBuffer>();
  private inflight = new Map<string, Promise<ArrayBuffer>>();

  constructor() {
    if (typeof window !== 'undefined') {
      this.audioElement = new Audio();
      this.audioElement.addEventListener('ended', this.handleAudioEnded);
      this.audioElement.addEventListener('error', this.handleAudioError);
    }
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
    this.prefetchAbort?.abort();
    this.prefetchAbort = null;
    for (const hook of Array.from(this.cancelHooks)) hook();
    this.cancelHooks.clear();
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.currentTime = 0;
    }
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
      const buffer = await this.getOrFetchAudio(key, job.bookId, job.chapterId, job.sentence.id, text, providerType, options, signal);
      if (!this.isCurrent(token)) return;

      this.setupAudioBuffer(buffer, options.speed, options.volume ?? 1);
      this.mainToken = token;
      await this.audioElement?.play();
      if (!this.isCurrent(token)) return;
      this.handlers.onStarted(token);

      if (job.next) this.prefetch(job.bookId, job.next.chapterId, job.next.sentence, providerType, options);
    } catch (err) {
      if (!this.isCurrent(token)) return;
      const e = err as { name?: string; message?: string };
      if (e?.name === 'AbortError') return;
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
      } else if (this.audioElement) {
        const key = buildChapterCacheKey(job.bookId, job.chapterId, providerType, options, title);
        const buffer = await this.getOrFetchAudio(key, job.bookId, job.chapterId, -1, title, providerType, options, signal);
        if (!this.isCurrent(token)) return;
        this.setupAudioBuffer(buffer, options.speed, options.volume ?? 1);
        const audio = this.audioElement;
        const finished = this.wait<void>((resolve) => {
          const done = () => resolve();
          audio.addEventListener('ended', done, { once: true });
          audio.addEventListener('error', done, { once: true });
          return () => {
            audio.removeEventListener('ended', done);
            audio.removeEventListener('error', done);
          };
        }, undefined);
        await audio.play();
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
    utterance.rate = sanitizeSpeed(options.speed);
    utterance.pitch = (options.pitch ?? 0) / 10 + 1; // приводим к диапазону 0-2
    utterance.volume = sanitizeVolume(options.volume);
    if (options.voiceId) {
      const match = window.speechSynthesis.getVoices().find((v) => v.name === options.voiceId);
      if (match) utterance.voice = match;
    }
    this.utterance = utterance;

    // После cancel() браузеры часто вызывают onend/onerror старой реплики — отсекаем по идентичности и токену
    const stale = () => this.utterance !== utterance || !this.isCurrent(token);
    utterance.onend = () => {
      if (stale()) return;
      this.utterance = null;
      if (role === 'intro') {
        onDone?.();
        return;
      }
      if (this.mainToken === token) {
        this.mainToken = null;
        this.handlers.onEnded(token);
      }
    };
    utterance.onerror = (e) => {
      if (stale() || e.error === 'canceled' || e.error === 'interrupted') return;
      this.utterance = null;
      if (role === 'intro') {
        onDone?.();
        return;
      }
      this.mainToken = null;
      this.handlers.onFailed(token, `Ошибка Web Speech: ${e.error}`);
    };

    window.speechSynthesis.speak(utterance);
    return true;
  }

  /** Предзагрузка следующей фразы в фоне; ошибки игнорируются */
  private prefetch(
    bookId: string,
    chapterId: string,
    sentence: SentenceItem,
    providerType: TTSProviderType,
    options: SynthesisOptions
  ) {
    if (providerType === 'webspeech') return;
    this.prefetchAbort?.abort();
    this.prefetchAbort = new AbortController();

    const rules = useSettingsStore.getState().replacementRules;
    const text = applyPronunciationDictionary(sentence.rawText, rules, bookId);
    const key = buildCacheKey(bookId, chapterId, sentence.id, providerType, options, text);
    this.getOrFetchAudio(key, bookId, chapterId, sentence.id, text, providerType, options, this.prefetchAbort.signal).catch(
      () => undefined
    );
  }

  /** Аудио из памяти, IndexedDB или сети (с сохранением в кэш) */
  private async getOrFetchAudio(
    cacheKey: string,
    bookId: string,
    chapterId: string,
    sentenceId: number,
    speechText: string,
    providerType: TTSProviderType,
    options: SynthesisOptions,
    signal?: AbortSignal
  ): Promise<ArrayBuffer> {
    const mem = this.memoryAudioCache.get(cacheKey);
    if (mem) return mem;

    // Такой же запрос уже выполняется (например, prefetch) — ждём его, а не дублируем
    const pending = this.inflight.get(cacheKey);
    if (pending) {
      try {
        return await pending;
      } catch {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        // prefetch упал/отменён — пробуем сами
      }
    }

    try {
      const cached = await db.audioCache.get(cacheKey);
      if (cached && cached.audioBlob) {
        const buffer = await cached.audioBlob.arrayBuffer();
        this.rememberInMemory(cacheKey, buffer);
        return buffer;
      }
    } catch (e) {
      console.warn('Ошибка чтения из IndexedDB:', e);
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const request = getProvider(providerType).synthesize(speechText, { ...options, signal });
    this.inflight.set(cacheKey, request);
    let audioBuffer: ArrayBuffer;
    try {
      audioBuffer = await request;
    } finally {
      if (this.inflight.get(cacheKey) === request) this.inflight.delete(cacheKey);
    }
    if (!audioBuffer || audioBuffer.byteLength === 0) {
      throw new Error('Провайдер вернул пустое аудио.');
    }
    this.rememberInMemory(cacheKey, audioBuffer);

    // В IndexedDB пишем в фоне (воспроизведение не ждёт)
    db.audioCache
      .put({
        cacheKey,
        bookId,
        chapterId,
        sentenceId,
        voiceId: options.voiceId,
        audioBlob: new Blob([audioBuffer], { type: sniffAudioMime(audioBuffer) }),
        createdAt: Date.now(),
      })
      .catch((e) => console.warn('Ошибка записи аудио в IndexedDB:', e));

    return audioBuffer;
  }

  private rememberInMemory(key: string, buffer: ArrayBuffer) {
    this.memoryAudioCache.set(key, buffer);
    while (this.memoryAudioCache.size > MEMORY_CACHE_LIMIT) {
      const oldest = this.memoryAudioCache.keys().next().value;
      if (oldest === undefined) break;
      this.memoryAudioCache.delete(oldest);
    }
  }

  private setupAudioBuffer(buffer: ArrayBuffer, speed: number, volume: number): void {
    const audio = this.audioElement;
    if (!audio) return;
    if (this.currentObjectUrl) URL.revokeObjectURL(this.currentObjectUrl);
    this.currentObjectUrl = URL.createObjectURL(new Blob([buffer], { type: sniffAudioMime(buffer) }));
    audio.src = this.currentObjectUrl;
    audio.playbackRate = sanitizeSpeed(speed);
    audio.volume = sanitizeVolume(volume);
  }

  /** Пауза текущей фразы (вызывается хранилищем только из статуса playing) */
  public pause() {
    if (this.mode === 'speech') {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.pause();
    } else {
      this.audioElement?.pause();
    }
  }

  /** Продолжение (вызывается хранилищем только из статуса paused) */
  public resume() {
    if (this.mode === 'speech') {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.resume();
      return;
    }
    const token = this.mainToken;
    this.audioElement?.play().catch((e) => {
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
    if (this.audioElement) this.audioElement.playbackRate = sanitizeSpeed(speed);
  }

  public setVolume(volume: number) {
    if (this.audioElement) this.audioElement.volume = sanitizeVolume(volume);
  }
}

export const audioManager = new AudioManager();
