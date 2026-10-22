import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { FontFamily, PdfRecognitionMode, ReaderTheme, ReplacementRule, UserSettings } from '../types/settings';
import { AggregatorApiMode, TTSProviderType } from '../types/tts';
import { normalizeAggregatorVoice } from '../types/voice';
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
  setPrefetchSentences: (count: number) => void;
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
  setAggregatorApiKey: (key: string, baseUrl?: string) => void;
  getAggregatorApiKey: (baseUrl?: string) => string;
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

export type KnownApiKeyProvider =
  | 'gemini'
  | 'openai'
  | 'elevenlabs'
  | 'openrouter'
  | 'routerai'
  | 'deepinfra'
  | 'groq'
  | 'together'
  | string;

export function getEnvApiKey(provider: KnownApiKeyProvider): string {
  try {
    // В сборке для продакшена import.meta.env.DEV заменяется на false,
    // и условие вместе со всеми VITE_* переменными вырезается минификатором.
    // Важно: не обращаться к import.meta.env как к объекту целиком.
    if (import.meta.env.DEV) {
      if (provider === 'openrouter') return (import.meta.env.VITE_OPENROUTER_API_KEY || '').trim();
      if (provider === 'routerai') return (import.meta.env.VITE_ROUTERAI_API_KEY || '').trim();
      if (provider === 'deepinfra') return (import.meta.env.VITE_DEEPINFRA_API_KEY || '').trim();
      if (provider === 'groq') return (import.meta.env.VITE_GROQ_API_KEY || '').trim();
      if (provider === 'together') return (import.meta.env.VITE_TOGETHER_API_KEY || '').trim();
      if (provider === 'gemini') return (import.meta.env.VITE_GEMINI_API_KEY || '').trim();
      if (provider === 'openai') return (import.meta.env.VITE_OPENAI_API_KEY || '').trim();
      if (provider === 'elevenlabs') return (import.meta.env.VITE_ELEVENLABS_API_KEY || '').trim();
    }
  } catch {
    // ignore
  }
  return '';
}

export function normalizeBaseUrl(url?: string): string {
  if (!url) return 'https://openrouter.ai/api/v1';
  return url.trim().replace(/\/+$/, '');
}

/**
 * Получить API-ключ для конкретного шлюза/подключения.
 * Учитывает сохранённый ключ для этого URL, .env переменные и дефолты.
 */
export function getAggregatorApiKey(baseUrl?: string, state?: UserSettings): string {
  const st = state ?? useSettingsStore.getState();
  const url = normalizeBaseUrl(baseUrl || st.openRouterBaseUrl);

  // 1. Сохранённый ключ для этого URL (если задан пользователем)
  if (st.aggregatorKeys && st.aggregatorKeys[url] !== undefined) {
    return st.aggregatorKeys[url];
  }

  // 2. OpenRouter по умолчанию
  if (url.includes('openrouter.ai')) {
    const directKey = st.apiKeys?.openrouter;
    if (directKey !== undefined && directKey.trim()) return directKey;
    return getEnvApiKey('openrouter');
  }

  // 3. Другие известные шлюзы
  if (url.includes('routerai.ru')) {
    return getEnvApiKey('routerai');
  }
  if (url.includes('deepinfra.com')) {
    return getEnvApiKey('deepinfra');
  }
  if (url.includes('groq.com')) {
    return getEnvApiKey('groq');
  }
  if (url.includes('together.xyz')) {
    return getEnvApiKey('together');
  }

  return '';
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
      prefetchSentences: 2,
      activeProvider: 'webspeech',
      selectedVoiceIds: {},
      speed: 1.0,
      pitch: 0,
      volume: 1.0,
      geminiModel: 'gemini-3.8-flash-tts',
      openRouterModel: 'openai/gpt-audio-mini',
      openRouterBaseUrl: 'https://openrouter.ai/api/v1',
      openRouterApiMode: 'auto',
      aggregatorKeys: {},
      aggregatorModels: {},
      // В десктопном приложении по умолчанию «Авто» (sidecar: текст или OCR по странице), в браузере — PDF.js
      pdfRecognitionMode:
        typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window) ? 'pymupdf' : 'pdfjs',
      alwaysAskPdfMode: true,
      proxy: { enabled: false, server: 'http://127.0.0.1:7890' },
      apiKeys: {
        gemini: getEnvApiKey('gemini'),
        openai: getEnvApiKey('openai'),
        elevenlabs: getEnvApiKey('elevenlabs'),
        openrouter: getEnvApiKey('openrouter'),
      },
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
      setPrefetchSentences: (prefetchSentences) =>
        set({ prefetchSentences: Math.max(1, Math.min(10, Math.round(prefetchSentences))) }),
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
          const clean = normalizeBaseUrl(state.openRouterBaseUrl);
          return {
            openRouterModel,
            aggregatorModels: {
              ...(state.aggregatorModels || {}),
              [clean]: openRouterModel,
            },
          };
        }),
      setOpenRouterBaseUrl: (openRouterBaseUrl) => {
        const clean = normalizeBaseUrl(openRouterBaseUrl);
        set((state) => {
          const savedModel = state.aggregatorModels?.[clean];
          return {
            openRouterBaseUrl: clean,
            ...(savedModel ? { openRouterModel: savedModel } : {}),
          };
        });
      },
      setPdfRecognitionMode: (pdfRecognitionMode) => set({ pdfRecognitionMode }),
      setAlwaysAskPdfMode: (alwaysAskPdfMode) => set({ alwaysAskPdfMode }),
      setProxy: (proxy) => set({ proxy }),
      setApiKey: (provider, key) =>
        set((state) => ({
          apiKeys: { ...state.apiKeys, [provider]: key },
        })),
      setAggregatorApiKey: (key: string, baseUrl?: string) => {
        const url = normalizeBaseUrl(baseUrl || get().openRouterBaseUrl);
        set((state) => {
          const nextAgg = { ...(state.aggregatorKeys || {}), [url]: key };
          const nextApiKeys = { ...state.apiKeys };
          if (url === 'https://openrouter.ai/api/v1') {
            nextApiKeys.openrouter = key;
          }
          return {
            aggregatorKeys: nextAgg,
            apiKeys: nextApiKeys,
          };
        });
      },
      getAggregatorApiKey: (baseUrl?: string) => {
        return getAggregatorApiKey(baseUrl, get());
      },
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
      version: 6,
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
        if (version < 5) {
          // v5: подтягиваем ключи из .env, если в сохранённых настройках они отсутствуют
          if (!state.apiKeys) state.apiKeys = {};
          const envOR = getEnvApiKey('openrouter');
          if (!state.apiKeys.openrouter && envOR) state.apiKeys.openrouter = envOR;
          const envGemini = getEnvApiKey('gemini');
          if (!state.apiKeys.gemini && envGemini) state.apiKeys.gemini = envGemini;
          const envOpenAI = getEnvApiKey('openai');
          if (!state.apiKeys.openai && envOpenAI) state.apiKeys.openai = envOpenAI;
          const envEleven = getEnvApiKey('elevenlabs');
          if (!state.apiKeys.elevenlabs && envEleven) state.apiKeys.elevenlabs = envEleven;
          if (typeof state.prefetchSentences !== 'number' || state.prefetchSentences < 1) {
            state.prefetchSentences = 2;
          }
        }
        if (version < 6) {
          // v6: раздельные ключи и модели на каждое подключение/шлюз
          if (!state.aggregatorKeys) state.aggregatorKeys = {};
          if (!state.aggregatorModels) state.aggregatorModels = {};
          const defaultORUrl = 'https://openrouter.ai/api/v1';
          if (state.apiKeys?.openrouter) {
            state.aggregatorKeys[defaultORUrl] = state.apiKeys.openrouter;
            const currentUrl = normalizeBaseUrl(state.openRouterBaseUrl);
            if (currentUrl && currentUrl !== defaultORUrl) {
              state.aggregatorKeys[currentUrl] = state.apiKeys.openrouter;
            }
          }
          if (state.openRouterModel) {
            const currentUrl = normalizeBaseUrl(state.openRouterBaseUrl);
            state.aggregatorModels[currentUrl] = state.openRouterModel;
          }
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
