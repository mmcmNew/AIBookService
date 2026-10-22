import { config } from '../../config.js';
import { ITtsConnector, SynthesisRequest, SynthesisResponse, TTSVoice } from './types.js';

export const OPENAI_VOICES: TTSVoice[] = [
  { id: 'alloy', name: 'Alloy (Сбалансированный)', lang: 'ru-RU', gender: 'neutral', provider: 'openai' },
  { id: 'echo', name: 'Echo (Мужской, мягкий)', lang: 'ru-RU', gender: 'male', provider: 'openai' },
  { id: 'fable', name: 'Fable (Британский акцент, выразительный)', lang: 'ru-RU', gender: 'male', provider: 'openai' },
  { id: 'onyx', name: 'Onyx (Глубокий мужской бас)', lang: 'ru-RU', gender: 'male', provider: 'openai' },
  { id: 'nova', name: 'Nova (Женский, энергичный)', lang: 'ru-RU', gender: 'female', provider: 'openai' },
  { id: 'shimmer', name: 'Shimmer (Женский, чистый)', lang: 'ru-RU', gender: 'female', provider: 'openai' },
];

export class OpenAiTtsConnector implements ITtsConnector {
  readonly id = 'openai' as const;
  readonly name = 'OpenAI TTS';

  isConfigured(): boolean {
    return Boolean(config.openaiApiKey());
  }

  async getVoices(): Promise<TTSVoice[]> {
    return OPENAI_VOICES;
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResponse> {
    const apiKey = config.openaiApiKey();
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY не установлен на сервере.');
    }

    const voice = req.voiceId || 'alloy';
    const model = config.openaiTtsModel() || 'tts-1';
    const signal = req.signal ?? AbortSignal.timeout(60000);

    const response = await fetch('https://api.openai.com/v1/audio/speech', {
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
      throw new Error(`OpenAI API Error (${response.status}): ${errJson?.error?.message || response.statusText}`);
    }

    const arrayBuf = await response.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuf),
      contentType: 'audio/mpeg',
    };
  }
}
