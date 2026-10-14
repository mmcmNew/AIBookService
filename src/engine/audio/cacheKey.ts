import type { SynthesisOptions, TTSProviderType } from '../../types/tts';

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
