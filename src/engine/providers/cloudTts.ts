import { ITTSProvider, SynthesisOptions, VoiceOption } from '../../types/tts';

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

  async getVoices(): Promise<VoiceOption[]> {
    return CLOUD_VOICES;
  }

  async synthesize(text: string, options: SynthesisOptions): Promise<ArrayBuffer> {
    const serverUrl = options.serverUrl || 'http://localhost:4000';
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
