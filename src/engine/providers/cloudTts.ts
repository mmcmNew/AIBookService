import { ITTSProvider, SynthesisOptions, VoiceOption } from '../../types/tts';

function cleanServerUrl(rawUrl?: string): string {
  const url = (rawUrl || '').trim().replace(/\/+$/, '');
  if (!url || url === 'http://localhost:4000') {
    if (typeof window !== 'undefined' && window.location?.origin && window.location.protocol === 'https:') {
      return window.location.origin;
    }
  }
  return url || 'http://localhost:4000';
}

export class InsufficientFundsError extends Error {
  constructor(
    message = 'Недостаточно символов на балансе. Пожалуйста, пополните баланс в настройках или переключитесь на другой движок озвучки.'
  ) {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}

export class AuthExpiredError extends Error {
  constructor(message = 'Сессия пользователя истекла (401).') {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

export const CLOUD_VOICES: VoiceOption[] = [
  { id: 'Aoede', name: 'Премиум: Aoede (Женский рассказчик)', lang: 'ru-RU', gender: 'female', provider: 'cloud' },
  { id: 'Charon', name: 'Премиум: Charon (Мужской глубокий бас)', lang: 'ru-RU', gender: 'male', provider: 'cloud' },
  { id: 'Kore', name: 'Премиум: Kore (Женский мягкий голос)', lang: 'ru-RU', gender: 'female', provider: 'cloud' },
  { id: 'Fenrir', name: 'Премиум: Fenrir (Мужской харизматичный)', lang: 'ru-RU', gender: 'male', provider: 'cloud' },
  { id: 'Puck', name: 'Премиум: Puck (Мужской эмоциональный)', lang: 'ru-RU', gender: 'male', provider: 'cloud' },
];

export class CloudTTSProvider implements ITTSProvider {
  id = 'cloud' as const;
  name = 'AIBookReader Cloud (Премиум)';
  description = 'Озвучка без ввода личных ключей. Оплата символов через ЮKassa (СБП, карты РФ).';
  requiresApiKey = false;
  supportsVoiceCloning = true;
  supportsOffline = false;

  private cachedVoices: { list: VoiceOption[]; timestamp: number } | null = null;
  private readonly CACHE_TTL_MS = 10 * 60 * 1000;

  async getVoices(): Promise<VoiceOption[]> {
    if (this.cachedVoices && Date.now() - this.cachedVoices.timestamp < this.CACHE_TTL_MS) {
      return this.cachedVoices.list;
    }

    try {
      const serverUrl = cleanServerUrl();
      const res = await fetch(`${serverUrl}/api/tts/voices`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.voices) && data.voices.length > 0) {
          const list: VoiceOption[] = data.voices.map((v: any) => ({
            id: v.id,
            name: `${v.name}`,
            lang: v.lang || 'ru-RU',
            gender: v.gender || 'neutral',
            provider: 'cloud' as const,
          }));
          this.cachedVoices = { list, timestamp: Date.now() };
          return list;
        }
      }
    } catch {
      // Игнорируем и возвращаем базовый список популярных голосов
    }

    return CLOUD_VOICES;
  }

  async synthesize(text: string, options: SynthesisOptions): Promise<ArrayBuffer> {
    const serverUrl = cleanServerUrl(options.serverUrl);
    const voiceId = options.voiceId || 'Aoede';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (options.token) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }

    const response = await fetch(`${serverUrl}/api/tts/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text,
        voiceId,
        speed: options.speed,
        pitch: options.pitch,
      }),
      signal: options.signal,
    });

    if (response.status === 401) {
      throw new AuthExpiredError();
    }

    if (response.status === 402) {
      throw new InsufficientFundsError();
    }

    if (!response.ok) {
      const err = await response.json().catch(() => null);
      throw new Error(err?.error || `Ошибка Cloud сервера (${response.status})`);
    }

    const buffer = await response.arrayBuffer();
    const remainingBalance = response.headers.get('X-Remaining-Balance');
    if (remainingBalance !== null) {
      const parsed = parseInt(remainingBalance, 10);
      if (!Number.isNaN(parsed)) {
        (buffer as any).remainingBalance = parsed;
      }
    }

    return buffer;
  }
}

export const cloudTTSProvider = new CloudTTSProvider();
