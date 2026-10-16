import { db } from '../../storage/db';
import { SentenceItem } from '../../types/book';
import { SynthesisOptions, TTSProviderType } from '../../types/tts';
import { getProvider } from '../providers';
import { applyPronunciationDictionary } from '../tokenizer/dictionaryReplacer';
import { useSettingsStore } from '../../store/settingsStore';
import { sniffAudioMime } from './mime';
import { buildCacheKey, buildChapterCacheKey } from './cacheKey';
import { ensureRegistered, reRegister, reportBalance, requestTopUp } from '../account';
import { useUserStore } from '../../store/userStore';
import { AuthExpiredError, InsufficientFundsError } from '../providers/cloudTts';

export interface FetchAudioJob {
  bookId: string;
  chapterId: string;
  sentence: SentenceItem;
  providerType: TTSProviderType;
  options: SynthesisOptions;
  signal?: AbortSignal;
}

export interface FetchChapterAudioJob {
  bookId: string;
  chapterId: string;
  title: string;
  providerType: TTSProviderType;
  options: SynthesisOptions;
  signal?: AbortSignal;
}

const MEMORY_CACHE_LIMIT = 40;

const memoryAudioCache = new Map<string, ArrayBuffer>();
const inflight = new Map<string, Promise<ArrayBuffer>>();

function rememberInMemory(key: string, buffer: ArrayBuffer): void {
  memoryAudioCache.set(key, buffer);
  while (memoryAudioCache.size > MEMORY_CACHE_LIMIT) {
    const oldest = memoryAudioCache.keys().next().value;
    if (oldest === undefined) break;
    memoryAudioCache.delete(oldest);
  }
}

/**
 * Текст с применённым словарём произношения (для Web Speech и синтеза).
 * Владелец правил и словаря: b_dom_fetch.
 */
export function getSpeechText(bookId: string, sentence: SentenceItem): string {
  const rules = useSettingsStore.getState().replacementRules;
  return applyPronunciationDictionary(sentence.rawText, rules, bookId);
}

function resolveSentenceJob(
  bookId: string,
  chapterId: string,
  sentence: SentenceItem,
  providerType: TTSProviderType,
  options: SynthesisOptions
): { key: string; text: string } {
  const text = getSpeechText(bookId, sentence);
  const key = buildCacheKey(bookId, chapterId, sentence.id, providerType, options, text);
  return { key, text };
}

/**
 * Команда «возьми аудио»: аудио из памяти, IndexedDB или сети (с сохранением в кэш). Запрос ЖДЁТ внутри, пока аудио не готово.
 * Блок b_dom_fetch (Поставщик озвучки), ответственный за res_audioCache.
 */
export async function getOrFetchAudio(job: FetchAudioJob): Promise<ArrayBuffer> {
  const { bookId, chapterId, sentence, providerType, options, signal } = job;
  const { key: cacheKey, text: speechText } = resolveSentenceJob(
    bookId,
    chapterId,
    sentence,
    providerType,
    options
  );

  const mem = memoryAudioCache.get(cacheKey);
  if (mem) return mem;

  // Такой же запрос уже выполняется (например, «приготовь») — ждём его, а не дублируем
  const pending = inflight.get(cacheKey);
  if (pending) {
    try {
      return await pending;
    } catch {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      // подготовка упала/отменена — пробуем сами
    }
  }

  try {
    const cached = await db.audioCache.get(cacheKey);
    if (cached && cached.audioBlob) {
      const buffer = await cached.audioBlob.arrayBuffer();
      rememberInMemory(cacheKey, buffer);
      return buffer;
    }
  } catch (e) {
    console.warn('Ошибка чтения из IndexedDB:', e);
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const request = executeSynthesis(providerType, speechText, options, signal);
  inflight.set(cacheKey, request);
  let audioBuffer: ArrayBuffer;
  try {
    audioBuffer = await request;
  } finally {
    if (inflight.get(cacheKey) === request) inflight.delete(cacheKey);
  }
  if (!audioBuffer || audioBuffer.byteLength === 0) {
    throw new Error('Провайдер вернул пустое аудио.');
  }
  rememberInMemory(cacheKey, audioBuffer);

  // В IndexedDB пишем в фоне (воспроизведение не ждёт)
  db.audioCache
    .put({
      cacheKey,
      bookId,
      chapterId,
      sentenceId: sentence.id,
      voiceId: options.voiceId,
      audioBlob: new Blob([audioBuffer], { type: sniffAudioMime(audioBuffer) }),
      createdAt: Date.now(),
    })
    .catch((e) => console.warn('Ошибка записи аудио в IndexedDB:', e));

  return audioBuffer;
}

/**
 * Внутреннее получение аудио заголовка главы по уже построенному ключу (память, IndexedDB, inflight или синтез).
 */
async function fetchAudioByKey(
  cacheKey: string,
  bookId: string,
  chapterId: string,
  sentenceId: number,
  speechText: string,
  providerType: TTSProviderType,
  options: SynthesisOptions,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const mem = memoryAudioCache.get(cacheKey);
  if (mem) return mem;

  const pending = inflight.get(cacheKey);
  if (pending) {
    try {
      return await pending;
    } catch {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    }
  }

  try {
    const cached = await db.audioCache.get(cacheKey);
    if (cached && cached.audioBlob) {
      const buffer = await cached.audioBlob.arrayBuffer();
      rememberInMemory(cacheKey, buffer);
      return buffer;
    }
  } catch (e) {
    console.warn('Ошибка чтения из IndexedDB:', e);
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const request = executeSynthesis(providerType, speechText, options, signal);
  inflight.set(cacheKey, request);
  let audioBuffer: ArrayBuffer;
  try {
    audioBuffer = await request;
  } finally {
    if (inflight.get(cacheKey) === request) inflight.delete(cacheKey);
  }
  if (!audioBuffer || audioBuffer.byteLength === 0) {
    throw new Error('Провайдер вернул пустое аудио.');
  }
  rememberInMemory(cacheKey, audioBuffer);

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

export async function getOrFetchChapterAudio(job: FetchChapterAudioJob): Promise<ArrayBuffer> {
  const { bookId, chapterId, title, providerType, options, signal } = job;
  const key = buildChapterCacheKey(bookId, chapterId, providerType, options, title);
  return fetchAudioByKey(key, bookId, chapterId, -1, title, providerType, options, signal);
}

async function executeSynthesis(
  providerType: TTSProviderType,
  text: string,
  options: SynthesisOptions,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  if (providerType === 'cloud') {
    await ensureRegistered();
    const { serverUrl, token } = useUserStore.getState();
    const cloudOptions: SynthesisOptions = {
      ...options,
      serverUrl,
      token,
      signal,
    };
    try {
      const buffer = await getProvider('cloud').synthesize(text, cloudOptions);
      const remaining = (buffer as any).remainingBalance;
      if (typeof remaining === 'number') {
        reportBalance(remaining);
      }
      return buffer;
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        const newAuth = await reRegister();
        const retryOptions: SynthesisOptions = {
          ...options,
          serverUrl: useUserStore.getState().serverUrl,
          token: newAuth.token,
          signal,
        };
        const buffer = await getProvider('cloud').synthesize(text, retryOptions);
        const remaining = (buffer as any).remainingBalance;
        if (typeof remaining === 'number') {
          reportBalance(remaining);
        }
        return buffer;
      }
      if (err instanceof InsufficientFundsError) {
        requestTopUp();
        throw err;
      }
      throw err;
    }
  }

  return getProvider(providerType).synthesize(text, { ...options, signal });
}

/** Разовый синтез без кэша и очереди (проверка подключения в окне настроек). */
export async function synthesizeOnce(
  providerType: TTSProviderType,
  text: string,
  options: SynthesisOptions
): Promise<ArrayBuffer> {
  return executeSynthesis(providerType, text, options);
}

let prepareAbort: AbortController | null = null;

/**
 * Команда «приготовь»: готовит аудио фразы заранее (в кэш), пока играет предыдущая.
 * Ключ кэша тот же, что у запроса Оркестратора «возьми аудио» (параметры синтеза одни и те же). Ошибки игнорируются:
 * если подготовка не удалась, Оркестратор получит аудио обычным запросом.
 */
export function prepareAudio(
  bookId: string,
  chapterId: string,
  sentence: SentenceItem,
  providerType: TTSProviderType,
  options: SynthesisOptions
): void {
  if (providerType === 'webspeech') return;
  prepareAbort?.abort();
  prepareAbort = new AbortController();

  getOrFetchAudio({
    bookId,
    chapterId,
    sentence,
    providerType,
    options,
    signal: prepareAbort.signal,
  }).catch(() => undefined);
}

/** Команда «отмени»: бросает подготовку (при прыжке, остановке, ошибке) */
export function cancelPrepare(): void {
  prepareAbort?.abort();
  prepareAbort = null;
}

/** Удаляет записи кэша для предложений, которых больше нет в книге (владелец res_audioCache: b_dom_fetch) */
export async function purgeOrphanAudioCache(
  bookId: string,
  validSentencesByChapter: Map<string, Set<number>>
): Promise<void> {
  await db.audioCache
    .where('bookId')
    .equals(bookId)
    .filter((a) => !validSentencesByChapter.get(a.chapterId)?.has(a.sentenceId))
    .delete();
}

/** Удаляет весь аудиокэш книги */
export async function deleteAudioCacheForBook(bookId: string): Promise<void> {
  await db.audioCache.where('bookId').equals(bookId).delete();
}
