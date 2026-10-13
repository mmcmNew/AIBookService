import { db } from '../../storage/db';
import { SentenceItem } from '../../types/book';
import { SynthesisOptions, TTSProviderType } from '../../types/tts';
import { getProvider } from '../providers';
import { applyPronunciationDictionary } from '../tokenizer/dictionaryReplacer';
import { useSettingsStore } from '../../store/settingsStore';
import { sniffAudioMime } from '../../infra/audio/htmlAudioPlayer';

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

/**
 * Аудио из памяти, IndexedDB или сети (с сохранением в кэш).
 * Блок b_dom_fetch (Поставщик озвучки), ответственный за res_audioCache.
 */
export async function getOrFetchAudio(
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

  // Такой же запрос уже выполняется (например, prefetch) — ждём его, а не дублируем
  const pending = inflight.get(cacheKey);
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
      rememberInMemory(cacheKey, buffer);
      return buffer;
    }
  } catch (e) {
    console.warn('Ошибка чтения из IndexedDB:', e);
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const request = getProvider(providerType).synthesize(speechText, { ...options, signal });
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
      sentenceId,
      voiceId: options.voiceId,
      audioBlob: new Blob([audioBuffer], { type: sniffAudioMime(audioBuffer) }),
      createdAt: Date.now(),
    })
    .catch((e) => console.warn('Ошибка записи аудио в IndexedDB:', e));

  return audioBuffer;
}

let prefetchAbort: AbortController | null = null;

/** Предзагрузка следующей фразы в фоне; ошибки игнорируются */
export function prefetchAudio(
  bookId: string,
  chapterId: string,
  sentence: SentenceItem,
  providerType: TTSProviderType,
  options: SynthesisOptions
): void {
  if (providerType === 'webspeech') return;
  prefetchAbort?.abort();
  prefetchAbort = new AbortController();

  const rules = useSettingsStore.getState().replacementRules;
  const text = applyPronunciationDictionary(sentence.rawText, rules, bookId);
  const key = buildCacheKey(bookId, chapterId, sentence.id, providerType, options, text);
  getOrFetchAudio(key, bookId, chapterId, sentence.id, text, providerType, options, prefetchAbort.signal).catch(
    () => undefined
  );
}

export function cancelPrefetch(): void {
  prefetchAbort?.abort();
  prefetchAbort = null;
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
