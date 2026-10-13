import { ITTSProvider, SynthesisOptions, VoiceOption } from '../../types/tts';

export const DEFAULT_ELEVENLABS_VOICES: VoiceOption[] = [
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel (Спокойный, мягкий)', lang: 'ru-RU', gender: 'female', provider: 'elevenlabs' },
  { id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi (Эмоциональный, живой)', lang: 'ru-RU', gender: 'female', provider: 'elevenlabs' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella (Повествовательный, книга)', lang: 'ru-RU', gender: 'female', provider: 'elevenlabs' },
  { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni (Классический диктор)', lang: 'ru-RU', gender: 'male', provider: 'elevenlabs' },
  { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold (Низкий, авторитетный)', lang: 'ru-RU', gender: 'male', provider: 'elevenlabs' },
];

export class ElevenLabsTTSProvider implements ITTSProvider {
  id = 'elevenlabs' as const;
  name = 'ElevenLabs (Премиум кино-диктор)';
  description = 'Ультимативное качество аудиокниг, естественное дыхание и клонирование голосов персонажей.';
  requiresApiKey = true;
  supportsVoiceCloning = true;
  supportsOffline = false;

  async getVoices(apiKey?: string): Promise<VoiceOption[]> {
    if (!apiKey) {
      return DEFAULT_ELEVENLABS_VOICES;
    }

    try {
      const response = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': apiKey },
      });
      if (!response.ok) return DEFAULT_ELEVENLABS_VOICES;

      const data = await response.json();
      if (Array.isArray(data.voices)) {
        return data.voices.map((v: any) => ({
          id: v.voice_id,
          name: v.name,
          lang: 'multilingual',
          provider: 'elevenlabs',
          isCloned: v.category === 'cloned',
        }));
      }
    } catch {
      // Игнорируем ошибку сети и отдаем дефолтные
    }

    return DEFAULT_ELEVENLABS_VOICES;
  }

  async synthesize(text: string, options: SynthesisOptions): Promise<ArrayBuffer> {
    if (!options.apiKey) {
      throw new Error('Для использования ElevenLabs требуется указать ElevenLabs API Key в настройках.');
    }

    const voiceId = options.voiceId || '21m00Tcm4TlvDq8ikWAM';
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': options.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const errJson = await response.json().catch(() => null);
      throw new Error(`ElevenLabs API Error: ${errJson?.detail?.message || response.statusText}`);
    }

    return response.arrayBuffer();
  }
}

export const elevenLabsTTSProvider = new ElevenLabsTTSProvider();
