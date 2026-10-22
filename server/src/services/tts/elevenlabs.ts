import { config } from '../../config.js';
import { ITtsConnector, SynthesisRequest, SynthesisResponse, TTSVoice } from './types.js';

export const DEFAULT_ELEVENLABS_VOICES: TTSVoice[] = [
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel (Спокойный, мягкий)', lang: 'ru-RU', gender: 'female', provider: 'elevenlabs' },
  { id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi (Эмоциональный, живой)', lang: 'ru-RU', gender: 'female', provider: 'elevenlabs' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella (Повествовательный, книга)', lang: 'ru-RU', gender: 'female', provider: 'elevenlabs' },
  { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni (Классический диктор)', lang: 'ru-RU', gender: 'male', provider: 'elevenlabs' },
  { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold (Низкий, авторитетный)', lang: 'ru-RU', gender: 'male', provider: 'elevenlabs' },
];

export class ElevenLabsTtsConnector implements ITtsConnector {
  readonly id = 'elevenlabs' as const;
  readonly name = 'ElevenLabs';

  private cachedVoices: { list: TTSVoice[]; timestamp: number } | null = null;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут

  isConfigured(): boolean {
    return Boolean(config.elevenlabsApiKey());
  }

  async getVoices(): Promise<TTSVoice[]> {
    const apiKey = config.elevenlabsApiKey();
    if (!apiKey) {
      return DEFAULT_ELEVENLABS_VOICES;
    }

    if (this.cachedVoices && Date.now() - this.cachedVoices.timestamp < this.CACHE_TTL_MS) {
      return this.cachedVoices.list;
    }

    try {
      const response = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': apiKey },
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        const data: any = await response.json();
        if (Array.isArray(data.voices)) {
          const list: TTSVoice[] = data.voices.map((v: any) => ({
            id: v.voice_id,
            name: v.category === 'cloned' ? `★ ${v.name} (Клон)` : v.name,
            lang: 'multilingual',
            gender: v.labels?.gender === 'female' ? 'female' : v.labels?.gender === 'male' ? 'male' : 'neutral',
            provider: 'elevenlabs' as const,
            isCloned: v.category === 'cloned',
          }));
          this.cachedVoices = { list, timestamp: Date.now() };
          return list;
        }
      }
    } catch (e) {
      console.warn('Не удалось загрузить кастомные голоса ElevenLabs с сервера:', e);
    }

    return DEFAULT_ELEVENLABS_VOICES;
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResponse> {
    const apiKey = config.elevenlabsApiKey();
    if (!apiKey) {
      throw new Error('ELEVENLABS_API_KEY не установлен на сервере.');
    }

    const voiceId = req.voiceId || '21m00Tcm4TlvDq8ikWAM';
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
    const signal = req.signal ?? AbortSignal.timeout(60000);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: req.text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
      signal,
    });

    if (!response.ok) {
      const errJson: any = await response.json().catch(() => null);
      throw new Error(`ElevenLabs API Error (${response.status}): ${errJson?.detail?.message || response.statusText}`);
    }

    const arrayBuf = await response.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuf),
      contentType: 'audio/mpeg',
    };
  }
}
