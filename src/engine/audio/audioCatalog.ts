import type { TTSProviderType, VoiceOption, AggregatorModelInfo } from '../../types/tts';
import { normalizeAggregatorVoice } from '../../types/voice';
import { PROVIDERS_MAP, getAllVoices } from '../providers';
import {
  openRouterTTSProvider,
  resolveAggregatorVoiceOptions,
  isVoiceValidForModel as isVoiceValidForModelRaw,
  getCatalogModelInfo,
  getKnownModelVoices,
  isOpenAIModel,
  isOpenAIVoice,
} from '../providers/openRouterTts';

export interface ProviderMetadata {
  id: TTSProviderType;
  name: string;
  description: string;
  requiresApiKey: boolean;
  supportsVoiceCloning: boolean;
  supportsOffline: boolean;
}

/** Возвращает информацию о зарегистрированных провайдерах синтеза */
export function listProviders(): Record<TTSProviderType, ProviderMetadata> {
  const result: Partial<Record<TTSProviderType, ProviderMetadata>> = {};
  for (const [key, p] of Object.entries(PROVIDERS_MAP)) {
    result[key as TTSProviderType] = {
      id: p.id,
      name: p.name,
      description: p.description,
      requiresApiKey: p.requiresApiKey,
      supportsVoiceCloning: p.supportsVoiceCloning,
      supportsOffline: p.supportsOffline,
    };
  }
  return result as Record<TTSProviderType, ProviderMetadata>;
}

/** Собирает список доступных голосов от всех сконфигурированных провайдеров */
export async function listVoices(
  apiKeys: { gemini?: string; openai?: string; elevenlabs?: string; openrouter?: string },
  baseUrl?: string
): Promise<VoiceOption[]> {
  return getAllVoices(apiKeys, baseUrl);
}

/** Запрашивает каталог моделей агрегатора (OpenRouter) */
export async function listModels(
  apiKey?: string,
  baseUrl?: string,
  force?: boolean
): Promise<AggregatorModelInfo[]> {
  return openRouterTTSProvider.fetchModels(apiKey, baseUrl, force);
}

/** Список вариантов голосов для выбранной модели агрегатора */
export function voiceOptionsForModel(
  model: string | undefined,
  gatewayVoices: VoiceOption[] = [],
  catalogVoices?: string[]
): VoiceOption[] {
  return resolveAggregatorVoiceOptions(model, gatewayVoices, catalogVoices);
}

/** Проверяет, подходит ли голос для указанной модели агрегатора */
export function isVoiceValidForModel(
  voiceId: string,
  model: string | undefined,
  gatewayVoices: VoiceOption[] = [],
  catalogVoices?: string[]
): boolean {
  return isVoiceValidForModelRaw(voiceId, model, gatewayVoices, catalogVoices);
}

/** Извлекает список голосов модели из каталога (если каталог загружен) */
export function getModelCatalogVoices(
  baseUrl: string | undefined,
  model: string | undefined
): string[] | undefined {
  return getCatalogModelInfo(baseUrl, model)?.voices;
}

/**
 * Нормализация голоса для модели агрегатора перед синтезом:
 * если голос не подходит известной модели, сбрасывает в пустую строку (по умолчанию модели).
 */
export function normalizeVoiceForModel(
  voiceId: string,
  model: string | undefined,
  baseUrl?: string
): string {
  const norm = normalizeAggregatorVoice(voiceId);
  if (!norm) return '';
  const catalogVoices = getCatalogModelInfo(baseUrl, model)?.voices;
  if (catalogVoices && catalogVoices.length > 0) {
    return catalogVoices.includes(norm) ? norm : '';
  }
  const known = getKnownModelVoices(model);
  if (known && !known.some((v) => v.id === norm)) {
    return '';
  }
  if (!isOpenAIModel(model || '') && isOpenAIVoice(norm)) {
    return '';
  }
  return norm;
}
