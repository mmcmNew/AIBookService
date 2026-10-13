import { ITTSProvider, SynthesisOptions, VoiceOption } from '../../types/tts';

export const OPENAI_VOICES: VoiceOption[] = [
  { id: 'alloy', name: 'Alloy (Сбалансированный)', lang: 'ru-RU', gender: 'neutral', provider: 'openai' },
  { id: 'echo', name: 'Echo (Мужской, мягкий)', lang: 'ru-RU', gender: 'male', provider: 'openai' },
  { id: 'fable', name: 'Fable (Британский акцент, выразительный)', lang: 'ru-RU', gender: 'male', provider: 'openai' },
  { id: 'onyx', name: 'Onyx (Глубокий мужской бас)', lang: 'ru-RU', gender: 'male', provider: 'openai' },
  { id: 'nova', name: 'Nova (Женский, энергичный)', lang: 'ru-RU', gender: 'female', provider: 'openai' },
  { id: 'shimmer', name: 'Shimmer (Женский, чистый)', lang: 'ru-RU', gender: 'female', provider: 'openai' },
];

export class OpenAITTSProvider implements ITTSProvider {
  id = 'openai' as const;
  name = 'OpenAI TTS (tts-1 / tts-1-hd)';
  description = 'Высококачественный синтез от OpenAI. Стабильное произношение и отличный русский язык.';
  requiresApiKey = true;
  supportsVoiceCloning = false;
  supportsOffline = false;

  async getVoices(): Promise<VoiceOption[]> {
    return OPENAI_VOICES;
  }

  async synthesize(text: string, options: SynthesisOptions): Promise<ArrayBuffer> {
    if (!options.apiKey) {
      throw new Error('Для использования OpenAI требуется указать OpenAI API Key в настройках.');
    }

    const voice = options.voiceId || 'alloy';
    // speed не передаём: скорость применяется плеером (playbackRate), иначе она применилась бы дважды

    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice,
        response_format: 'mp3',
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const errJson = await response.json().catch(() => null);
      throw new Error(`OpenAI API Error: ${errJson?.error?.message || response.statusText}`);
    }

    return response.arrayBuffer();
  }
}

export const openAITTSProvider = new OpenAITTSProvider();
