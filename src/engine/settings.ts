import { useSettingsStore, getEnvApiKey, getAggregatorApiKey, normalizeBaseUrl } from '../store/settingsStore';
import type { FontFamily, PdfRecognitionMode, ReaderTheme } from '../types/settings';
import type { AggregatorApiMode, AggregatorModelInfo, SynthesisOptions, TTSProviderType, VoiceOption } from '../types/tts';
import {
  listProviders,
  listVoices,
  listModels,
  voiceOptionsForModel,
  isVoiceValidForModel,
  getModelCatalogVoices,
  normalizeVoiceForModel,
  type ProviderMetadata,
} from './audio/audioCatalog';
import { synthesizeOnce } from './audio/audioFetch';
import { audioManager } from './audio/audioManager';
import {
  isTauriEnvironment,
  getDesktopProxy,
  setDesktopProxy,
  restartDesktopApp,
  type DesktopProxyConfig,
} from './proxy/proxyManager';

export function isDesktopApp(): boolean {
  return isTauriEnvironment();
}

export async function loadDesktopProxy(): Promise<DesktopProxyConfig | null> {
  const desktopCfg = await getDesktopProxy();
  if (desktopCfg) {
    useSettingsStore.getState().setProxy(desktopCfg);
  }
  return desktopCfg;
}

export async function saveProxy(config: { enabled: boolean; server: string }, restart = false): Promise<void> {
  useSettingsStore.getState().setProxy(config);
  if (isTauriEnvironment()) {
    await setDesktopProxy(config);
    if (restart) {
      await restartDesktopApp();
    }
  }
}


/**
 * Установка модели OpenRouter с валидацией выбранного голоса.
 * Вынесено из стора в слой Domain, чтобы стор не зависел от логики каталога и валидации.
 */
export function setOpenRouterModel(openRouterModel: string): void {
  const state = useSettingsStore.getState();
  const cur = state.selectedVoiceIds.openrouter ?? '';
  const keep = isVoiceValidForModel(
    cur,
    openRouterModel,
    [],
    getModelCatalogVoices(state.openRouterBaseUrl, openRouterModel)
  );
  const cleanUrl = normalizeBaseUrl(state.openRouterBaseUrl);
  useSettingsStore.setState({
    openRouterModel,
    selectedVoiceIds: keep ? state.selectedVoiceIds : { ...state.selectedVoiceIds, openrouter: '' },
    aggregatorModels: {
      ...(state.aggregatorModels || {}),
      [cleanUrl]: openRouterModel,
    },
  });
}

export function setAggregatorApiKey(key: string, baseUrl?: string): void {
  useSettingsStore.getState().setAggregatorApiKey(key, baseUrl);
}

/** Запомнить режим распознавания PDF по умолчанию и перестать спрашивать при каждой загрузке. */
export function rememberPdfRecognitionMode(mode: PdfRecognitionMode): void {
  useSettingsStore.setState({ pdfRecognitionMode: mode, alwaysAskPdfMode: false });
}

type ApiKeyProvider = 'gemini' | 'openai' | 'elevenlabs' | 'openrouter';

/*
 * Команды записи настроек читалки. Каждая вызывает одноимённый сеттер стора:
 * валидация и ограничения (clamp, смена класса темы на <html>) остаются в сторе.
 */

export function setTheme(theme: ReaderTheme): void {
  useSettingsStore.getState().setTheme(theme);
}

export function setFontFamily(font: FontFamily): void {
  useSettingsStore.getState().setFontFamily(font);
}

export function setFontSize(size: number): void {
  useSettingsStore.getState().setFontSize(size);
}

export function setLineHeight(height: number): void {
  useSettingsStore.getState().setLineHeight(height);
}

export function setAutoscroll(enabled: boolean): void {
  useSettingsStore.getState().setAutoscroll(enabled);
}

export function setAnnounceChapters(enabled: boolean): void {
  useSettingsStore.getState().setAnnounceChapters(enabled);
}

export function setChapterChime(enabled: boolean): void {
  useSettingsStore.getState().setChapterChime(enabled);
}

export function setAutoAdvanceChapter(enabled: boolean): void {
  useSettingsStore.getState().setAutoAdvanceChapter(enabled);
}

export function setPrefetchSentences(count: number): void {
  useSettingsStore.getState().setPrefetchSentences(count);
}

export function setActiveProvider(provider: TTSProviderType): void {
  useSettingsStore.getState().setActiveProvider(provider);
}

export function setSelectedVoiceId(voiceId: string): void {
  useSettingsStore.getState().setSelectedVoiceId(voiceId);
}

export function setOpenRouterApiMode(mode: AggregatorApiMode): void {
  useSettingsStore.getState().setOpenRouterApiMode(mode);
}

export function setSpeed(speed: number): void {
  useSettingsStore.getState().setSpeed(speed);
}

export function setVolume(volume: number): void {
  useSettingsStore.getState().setVolume(volume);
}

export function setApiKey(provider: ApiKeyProvider, key: string): void {
  useSettingsStore.getState().setApiKey(provider, key);
}

export function setGeminiModel(model: string): void {
  useSettingsStore.getState().setGeminiModel(model);
}

export function setOpenRouterBaseUrl(baseUrl: string): void {
  useSettingsStore.getState().setOpenRouterBaseUrl(baseUrl);
}

export function setPdfRecognitionMode(mode: PdfRecognitionMode): void {
  useSettingsStore.getState().setPdfRecognitionMode(mode);
}

export function setAlwaysAskPdfMode(ask: boolean): void {
  useSettingsStore.getState().setAlwaysAskPdfMode(ask);
}

export function setProxy(proxy: { enabled: boolean; server: string }): void {
  useSettingsStore.getState().setProxy(proxy);
}

export function addReplacementRule(pattern: string, replacement: string, isRegex?: boolean, bookId?: string): void {
  useSettingsStore.getState().addReplacementRule(pattern, replacement, isRegex, bookId);
}

export function removeReplacementRule(id: string): void {
  useSettingsStore.getState().removeReplacementRule(id);
}

export function toggleReplacementRule(id: string): void {
  useSettingsStore.getState().toggleReplacementRule(id);
}

/**
 * «Проверить озвучку»: разовый синтез фразы активным провайдером с текущими настройками голоса
 * через Поставщика озвучки, затем воспроизведение через Оркестратор.
 * Возвращает размер полученного аудио в байтах. Ошибку синтеза отдаёт вызывающему.
 */
export async function checkVoice(text: string): Promise<{ bytes: number }> {
  const { activeProvider, volume } = useSettingsStore.getState();
  const options = buildSynthesisOptions();
  const buffer = await synthesizeOnce(activeProvider, text, options);
  if (!buffer || buffer.byteLength === 0) {
    throw new Error('Получен пустой аудио-ответ.');
  }
  const vol = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
  await audioManager.playPreview(buffer, vol);
  return { bytes: buffer.byteLength };
}

/** Остановка пробного звука при закрытии окна настроек */
export function stopVoiceCheck(): void {
  audioManager.stopPreview();
}

/**
 * Собирает параметры синтеза из текущих настроек (общая точка для плеера и кнопки «Тест озвучки»).
 * Голос берётся отдельно для каждого провайдера; для агрегатора пустой голос = «по умолчанию модели».
 */
export function buildSynthesisOptions(settings = useSettingsStore.getState()): SynthesisOptions {
  const provider = settings.activeProvider;
  const baseUrl = provider === 'openrouter' ? (settings.openRouterBaseUrl || 'https://openrouter.ai/api/v1') : undefined;
  const apiKey = provider === 'gemini' ? (settings.apiKeys.gemini || getEnvApiKey('gemini'))
    : provider === 'openai' ? (settings.apiKeys.openai || getEnvApiKey('openai'))
    : provider === 'elevenlabs' ? (settings.apiKeys.elevenlabs || getEnvApiKey('elevenlabs'))
    : provider === 'openrouter' ? getAggregatorApiKey(baseUrl, settings)
    : undefined;

  const model = provider === 'gemini' ? settings.geminiModel
    : provider === 'openrouter' ? (settings.openRouterModel?.trim() || 'openai/gpt-audio-mini')
    : undefined;

  let voiceId = settings.selectedVoiceIds?.[provider] ?? '';
  if (provider === 'openrouter') {
    voiceId = normalizeVoiceForModel(voiceId, model, settings.openRouterBaseUrl);
  }

  const speed = Number.isFinite(settings.speed) ? Math.max(0.5, Math.min(2.5, settings.speed)) : 1;
  const volume = Number.isFinite(settings.volume) ? Math.max(0, Math.min(1, settings.volume)) : 1;

  return {
    voiceId,
    speed,
    pitch: Number.isFinite(settings.pitch) ? settings.pitch : 0,
    volume,
    apiKey,
    model,
    baseUrl,
    apiMode: provider === 'openrouter' ? (settings.openRouterApiMode || 'auto') : undefined,
  };
}

export { listProviders, getAggregatorApiKey, normalizeBaseUrl };
export type { ProviderMetadata };

/** Загружает каталог голосов через Поставщика озвучки */
export async function loadCatalogVoices(
  apiKeys: { gemini?: string; openai?: string; elevenlabs?: string; openrouter?: string },
  openRouterBaseUrl?: string
): Promise<VoiceOption[]> {
  const effectiveAggKey = getAggregatorApiKey(openRouterBaseUrl);
  const effectiveKeys = {
    ...apiKeys,
    openrouter: effectiveAggKey || apiKeys.openrouter,
  };
  return listVoices(effectiveKeys, openRouterBaseUrl);
}

/** Запрашивает каталог моделей агрегатора (OpenRouter) через Поставщика озвучки */
export async function fetchAggregatorModels(
  apiKey?: string,
  baseUrl?: string,
  force?: boolean
): Promise<AggregatorModelInfo[]> {
  const resolvedKey = apiKey || getAggregatorApiKey(baseUrl);
  return listModels(resolvedKey, baseUrl, force);
}

/** Получает список доступных голосов для модели агрегатора */
export function getAggregatorVoiceOptions(
  model: string | undefined,
  gatewayVoices: VoiceOption[] = [],
  catalogVoices?: string[]
): VoiceOption[] {
  return voiceOptionsForModel(model, gatewayVoices, catalogVoices);
}

/** Проверяет валидность голоса для модели агрегатора */
export function isAggregatorVoiceValid(
  voiceId: string,
  model: string | undefined,
  gatewayVoices: VoiceOption[] = [],
  catalogVoices?: string[]
): boolean {
  return isVoiceValidForModel(voiceId, model, gatewayVoices, catalogVoices);
}

export function getSettingsForSync(): { settings: Record<string, any>; replacementRules: any[] } {
  const settingsState = useSettingsStore.getState();
  const settings = {
    theme: settingsState.theme,
    fontFamily: settingsState.fontFamily,
    fontSize: settingsState.fontSize,
    lineHeight: settingsState.lineHeight,
    autoscroll: settingsState.autoscroll,
    announceChapters: settingsState.announceChapters,
    chapterChime: settingsState.chapterChime,
    autoAdvanceChapter: settingsState.autoAdvanceChapter,
    prefetchSentences: settingsState.prefetchSentences,
    activeProvider: settingsState.activeProvider,
    selectedVoiceIds: settingsState.selectedVoiceIds,
    speed: settingsState.speed,
    pitch: settingsState.pitch,
    volume: settingsState.volume,
    geminiModel: settingsState.geminiModel,
    openRouterModel: settingsState.openRouterModel,
    openRouterBaseUrl: settingsState.openRouterBaseUrl,
    openRouterApiMode: settingsState.openRouterApiMode,
    pdfRecognitionMode: settingsState.pdfRecognitionMode,
  };
  return {
    settings,
    replacementRules: settingsState.replacementRules || [],
  };
}

export function applySyncedSettings(settings?: Record<string, any>, replacementRules?: any[]): void {
  if (settings && typeof settings === 'object') {
    useSettingsStore.setState((state) => ({
      ...state,
      ...settings,
    }));
  }
  if (Array.isArray(replacementRules)) {
    useSettingsStore.setState({ replacementRules });
  }
}

export function applyRestoredApiKeys(apiKeys?: Record<string, string>, aggregatorKeys?: Record<string, string>): void {
  useSettingsStore.setState((state) => ({
    apiKeys: {
      ...state.apiKeys,
      ...(apiKeys || {}),
    },
    aggregatorKeys: {
      ...(state.aggregatorKeys || {}),
      ...(aggregatorKeys || {}),
    },
  }));
}
export function getApiKeysForEncryption(): { apiKeys: Record<string, string>; aggregatorKeys: Record<string, string> } {
  const state = useSettingsStore.getState();
  return {
    apiKeys: state.apiKeys || {},
    aggregatorKeys: state.aggregatorKeys || {},
  };
}
