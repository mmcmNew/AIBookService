import { useSettingsStore } from '../store/settingsStore';
import type { FontFamily, PdfRecognitionMode, ReaderTheme } from '../types/settings';
import type { AggregatorApiMode, TTSProviderType } from '../types/tts';
import { isVoiceValidForModel, getCatalogModelInfo } from './providers/openRouterTts';

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
    getCatalogModelInfo(state.openRouterBaseUrl, openRouterModel)?.voices
  );
  useSettingsStore.setState({
    openRouterModel,
    selectedVoiceIds: keep ? state.selectedVoiceIds : { ...state.selectedVoiceIds, openrouter: '' },
  });
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
