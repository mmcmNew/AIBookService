import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { FontFamily, PdfRecognitionMode, ReaderTheme, ReplacementRule, UserSettings } from '../types/settings';
import { AggregatorApiMode, TTSProviderType } from '../types/tts';
import { getCatalogModelInfo, isVoiceValidForModel, normalizeAggregatorVoice } from '../engine/providers/openRouterTts';
import { DEFAULT_RULES } from '../engine/tokenizer/dictionaryReplacer';

interface SettingsState extends UserSettings {
  setTheme: (theme: ReaderTheme) => void;
  setFontFamily: (font: FontFamily) => void;
  setFontSize: (size: number) => void;
  setLineHeight: (height: number) => void;
  setAutoscroll: (enabled: boolean) => void;
  setAnnounceChapters: (enabled: boolean) => void;
  setChapterChime: (enabled: boolean) => void;
  setAutoAdvanceChapter: (enabled: boolean) => void;
  setActiveProvider: (provider: TTSProviderType) => void;
  /** Сохраняет голос для текущего активного провайдера */
  setSelectedVoiceId: (voiceId: string) => void;
  /** Голос указанного провайдера ('' = по умолчанию) */
  getSelectedVoiceId: (provider?: TTSProviderType) => string;
  setOpenRouterApiMode: (mode: AggregatorApiMode) => void;
  setSpeed: (speed: number) => void;
  setPitch: (pitch: number) => void;
  setVolume: (volume: number) => void;
  setApiKey: (provider: 'gemini' | 'openai' | 'elevenlabs' | 'openrouter', key: string) => void;
  setGeminiModel: (model: string) => void;
  setOpenRouterModel: (model: string) => void;
  setOpenRouterBaseUrl: (baseUrl: string) => void;
  pdfRecognitionMode: PdfRecognitionMode;
  alwaysAskPdfMode: boolean;
  setPdfRecognitionMode: (mode: PdfRecognitionMode) => void;
  setAlwaysAskPdfMode: (ask: boolean) => void;
  setProxy: (proxy: { enabled: boolean; server: string }) => void;
  addReplacementRule: (pattern: string, replacement: string, isRegex?: boolean, bookId?: string) => void;
  removeReplacementRule: (id: string) => void;
  toggleReplacementRule: (id: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      fontFamily: 'serif',
      fontSize: 19,
      lineHeight: 1.7,
      autoscroll: true,
      announceChapters: true,
      chapterChime: true,
      autoAdvanceChapter: true,
      activeProvider: 'webspeech',
      selectedVoiceIds: {},
      speed: 1.0,
      pitch: 0,
      volume: 1.0,
      geminiModel: 'gemini-3.8-flash-tts',
      openRouterModel: 'openai/gpt-audio-mini',
      openRouterBaseUrl: 'https://openrouter.ai/api/v1',
      openRouterApiMode: 'auto',
      // В десктопном приложении по умолчанию «Авто» (sidecar: текст или OCR по странице), в браузере — PDF.js
      pdfRecognitionMode:
        typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window) ? 'pymupdf' : 'pdfjs',
      alwaysAskPdfMode: true,
      proxy: { enabled: false, server: 'http://127.0.0.1:7890' },
      apiKeys: {},
      replacementRules: DEFAULT_RULES,

      setTheme: (theme) => {
        set({ theme });
        document.documentElement.classList.remove('dark', 'sepia', 'oled');
        if (theme === 'dark') document.documentElement.classList.add('dark');
        if (theme === 'sepia') document.documentElement.classList.add('sepia');
        if (theme === 'oled') document.documentElement.classList.add('dark', 'oled');
      },
      setFontFamily: (fontFamily) => set({ fontFamily }),
      setFontSize: (fontSize) => set({ fontSize }),
      setLineHeight: (lineHeight) => set({ lineHeight }),
      setAutoscroll: (autoscroll) => set({ autoscroll }),
      setAnnounceChapters: (announceChapters) => set({ announceChapters }),
      setChapterChime: (chapterChime) => set({ chapterChime }),
      setAutoAdvanceChapter: (autoAdvanceChapter) => set({ autoAdvanceChapter }),
      setActiveProvider: (activeProvider) => set({ activeProvider }),
      setSelectedVoiceId: (voiceId) =>
        set((state) => ({
          selectedVoiceIds: { ...state.selectedVoiceIds, [state.activeProvider]: voiceId },
        })),
      getSelectedVoiceId: (provider) => {
        const st = get();
        return st.selectedVoiceIds[provider ?? st.activeProvider] ?? '';
      },
      setOpenRouterApiMode: (openRouterApiMode) => set({ openRouterApiMode }),
      setSpeed: (speed) => set({ speed: Number.isFinite(speed) ? Math.max(0.5, Math.min(2.5, speed)) : 1 }),
      setPitch: (pitch) => set({ pitch }),
      setVolume: (volume) => set({ volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1 }),
      setGeminiModel: (geminiModel) => set({ geminiModel }),
      setOpenRouterModel: (openRouterModel) =>
        set((state) => {
          // При смене модели голос, неподходящий новой модели, сбрасывается на «по умолчанию»
          const cur = state.selectedVoiceIds.openrouter ?? '';
          const keep = isVoiceValidForModel(cur, openRouterModel, [], getCatalogModelInfo(state.openRouterBaseUrl, openRouterModel)?.voices);
          return {
            openRouterModel,
            selectedVoiceIds: keep ? state.selectedVoiceIds : { ...state.selectedVoiceIds, openrouter: '' },
          };
        }),
      setOpenRouterBaseUrl: (openRouterBaseUrl) => set({ openRouterBaseUrl }),
      setPdfRecognitionMode: (pdfRecognitionMode) => set({ pdfRecognitionMode }),
      setAlwaysAskPdfMode: (alwaysAskPdfMode) => set({ alwaysAskPdfMode }),
      setProxy: (proxy) => set({ proxy }),
      setApiKey: (provider, key) =>
        set((state) => ({
          apiKeys: { ...state.apiKeys, [provider]: key },
        })),
      addReplacementRule: (pattern, replacement, isRegex = false, bookId?: string) =>
        set((state) => ({
          replacementRules: [
            ...state.replacementRules,
            { id: Date.now().toString(), pattern, replacement, isRegex, enabled: true, bookId },
          ],
        })),
      removeReplacementRule: (id) =>
        set((state) => ({
          replacementRules: state.replacementRules.filter((r) => r.id !== id),
        })),
      toggleReplacementRule: (id) =>
        set((state) => ({
          replacementRules: state.replacementRules.map((r) =>
            r.id === id ? { ...r, enabled: !r.enabled } : r
          ),
        })),
    }),
    {
      name: 'ai-book-reader-settings',
      version: 4,
      migrate: (persisted: any, version: number) => {
        const state = { ...(persisted || {}) };
        if (version < 2) {
          // v1: единый selectedVoiceId → отдельный голос на провайдера
          const legacy: string = typeof state.selectedVoiceId === 'string' ? state.selectedVoiceId : '';
          const provider: TTSProviderType = state.activeProvider || 'webspeech';
          const ids: Record<string, string> = {};
          // Для агрегатора старый голос мог быть голосом другого движка — сбрасываем на «по умолчанию»
          if (legacy && provider !== 'openrouter') ids[provider] = legacy;
          state.selectedVoiceIds = ids;
          delete state.selectedVoiceId;
          if (!state.openRouterApiMode) state.openRouterApiMode = 'auto';
        }
        if (version < 4) {
          // v4: настройки перехода между главами (по умолчанию включены)
          if (typeof state.announceChapters !== 'boolean') state.announceChapters = true;
          if (typeof state.chapterChime !== 'boolean') state.chapterChime = true;
          if (typeof state.autoAdvanceChapter !== 'boolean') state.autoAdvanceChapter = true;
        }
        // gpt-4o-mini-audio-preview исчез из каталога OpenRouter — заменяем прежний дефолт
        if (state.openRouterModel === 'openai/gpt-4o-mini-audio-preview') state.openRouterModel = 'openai/gpt-audio-mini';
        if (state.selectedVoiceIds?.openrouter) {
          state.selectedVoiceIds.openrouter = normalizeAggregatorVoice(state.selectedVoiceIds.openrouter);
        }
        return state;
      },
    }
  )
);
