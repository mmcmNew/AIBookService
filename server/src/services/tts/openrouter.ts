import { config } from '../../config.js';
import { ITtsConnector, SynthesisRequest, SynthesisResponse, TTSVoice } from './types.js';

export const DEFAULT_OPENROUTER_VOICES: TTSVoice[] = [
  { id: 'alloy', name: 'OpenRouter: Alloy', lang: 'ru-RU', gender: 'neutral', provider: 'openrouter' },
  { id: 'echo', name: 'OpenRouter: Echo', lang: 'ru-RU', gender: 'male', provider: 'openrouter' },
  { id: 'nova', name: 'OpenRouter: Nova', lang: 'ru-RU', gender: 'female', provider: 'openrouter' },
];

export class OpenRouterTtsConnector implements ITtsConnector {
  readonly id = 'openrouter' as const;
  readonly name = 'OpenRouter Audio';

  isConfigured(): boolean {
    return Boolean(config.openrouterApiKey());
  }

  async getVoices(): Promise<TTSVoice[]> {
    return DEFAULT_OPENROUTER_VOICES;
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResponse> {
    const apiKey = config.openrouterApiKey();
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY не установлен на сервере.');
    }

    const baseUrl = config.openrouterBaseUrl().replace(/\/+$/, '');
    const voice = req.voiceId || 'alloy';
    const model = 'openai/tts-1';
    const signal = req.signal ?? AbortSignal.timeout(60000);

    const response = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: req.text,
        voice,
        response_format: 'mp3',
      }),
      signal,
    });

    if (!response.ok) {
      const errJson: any = await response.json().catch(() => null);
      throw new Error(`OpenRouter Audio Error (${response.status}): ${errJson?.error?.message || response.statusText}`);
    }

    const arrayBuf = await response.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuf),
      contentType: 'audio/mpeg',
    };
  }
}
