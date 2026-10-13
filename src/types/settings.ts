import { AggregatorApiMode, TTSProviderType } from './tts';

export type ReaderTheme = 'light' | 'dark' | 'sepia' | 'oled';
export type FontFamily = 'sans' | 'serif' | 'mono';

export interface ReplacementRule {
  id: string;
  pattern: string;
  replacement: string;
  isRegex?: boolean;
  enabled: boolean;
  bookId?: string; // Если задано — правило активно только для конкретной книги
}

export interface DesktopProxyConfig {
  enabled: boolean;
  server: string;
}

export type PdfRecognitionMode = 'pdfjs' | 'pymupdf' | 'gemini' | 'ocr';

export interface UserSettings {
  theme: ReaderTheme;
  fontFamily: FontFamily;
  fontSize: number;       // px (например, 18)
  lineHeight: number;     // множитель (например, 1.6)
  autoscroll: boolean;
  /** Озвучивать название главы перед её первым предложением */
  announceChapters: boolean;
  /** Короткий мелодичный сигнал перед объявлением главы */
  chapterChime: boolean;
  /** В конце главы автоматически продолжать чтение со следующей */
  autoAdvanceChapter: boolean;
  activeProvider: TTSProviderType;
  /** Выбранный голос отдельно для каждого провайдера ('' = по умолчанию) */
  selectedVoiceIds: Partial<Record<TTSProviderType, string>>;
  speed: number;
  pitch: number;
  volume: number;
  geminiModel: string;
  openRouterModel?: string;
  openRouterBaseUrl?: string;
  openRouterApiMode?: AggregatorApiMode;
  pdfRecognitionMode: PdfRecognitionMode;
  alwaysAskPdfMode: boolean;
  proxy: DesktopProxyConfig;
  apiKeys: {
    gemini?: string;
    openai?: string;
    elevenlabs?: string;
    openrouter?: string;
  };
  replacementRules: ReplacementRule[];
}
