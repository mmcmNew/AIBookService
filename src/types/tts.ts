export type TTSProviderType = 
  | 'webspeech'
  | 'edge-tts'
  | 'cloud'
  | 'gemini'
  | 'openai'
  | 'elevenlabs'
  | 'openrouter';

/** Режим API агрегатора: auto — определить автоматически, chat — /chat/completions (audio), speech — /audio/speech */
export type AggregatorApiMode = 'auto' | 'chat' | 'speech';

/**
 * Тип модели с точки зрения озвучки:
 * - speech     — TTS-модель (architecture.output_modalities содержит "speech"), только POST /audio/speech
 * - chat-audio — чат-модель с аудио-выходом (output_modalities содержит "audio"), POST /chat/completions + modalities
 * - other      — всё остальное (текст, изображения, STT/transcription, embeddings...)
 */
export type AggregatorModelKind = 'speech' | 'chat-audio' | 'other';

export interface AggregatorModelInfo {
  id: string;
  name: string;
  description?: string;
  /** true для speech и chat-audio */
  isAudio: boolean;
  kind: AggregatorModelKind;
  /** Голоса из каталога (поле supported_voices), если есть */
  voices?: string[];
}

export interface VoiceOption {
  id: string;
  name: string;
  lang: string;
  gender?: 'male' | 'female' | 'neutral';
  provider: TTSProviderType;
  previewUrl?: string;
  isCloned?: boolean;
}

export interface SynthesisOptions {
  voiceId: string;
  speed: number;    // 0.5 - 2.5
  pitch?: number;   // -10 - 10
  volume?: number;  // 0.0 - 1.0
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Только для openrouter/агрегаторов */
  apiMode?: AggregatorApiMode;
  signal?: AbortSignal;
  serverUrl?: string;
  token?: string;
}

export interface ITTSProvider {
  id: TTSProviderType;
  name: string;
  description: string;
  requiresApiKey: boolean;
  supportsVoiceCloning: boolean;
  supportsOffline: boolean;
  getVoices(apiKey?: string, baseUrl?: string): Promise<VoiceOption[]>;
  synthesize(text: string, options: SynthesisOptions): Promise<ArrayBuffer>;
}
