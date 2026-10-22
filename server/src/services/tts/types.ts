export type TTSProviderId = 'gemini' | 'openai' | 'elevenlabs' | 'edge-tts' | 'openrouter';

export interface TTSVoice {
  id: string;
  name: string;
  lang: string;
  gender?: 'male' | 'female' | 'neutral';
  provider: TTSProviderId;
  isCloned?: boolean;
}

export interface SynthesisRequest {
  text: string;
  voiceId?: string;
  speed?: number;
  pitch?: number;
  signal?: AbortSignal;
}

export interface SynthesisResponse {
  audio: Buffer;
  contentType: string; // 'audio/wav' | 'audio/mpeg'
}

export interface ITtsConnector {
  readonly id: TTSProviderId;
  readonly name: string;
  isConfigured(): boolean;
  getVoices(): Promise<TTSVoice[]>;
  synthesize(req: SynthesisRequest): Promise<SynthesisResponse>;
}
