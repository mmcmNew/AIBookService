import { ITTSProvider, SynthesisOptions, VoiceOption } from '../../types/tts';
import { useUserStore } from '../../store/userStore';

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
    const { authFetch, updateBalance } = useUserStore.getState();
    const voiceId = options.voiceId || 'Aoede';

    // authFetch добавляет Authorization и при 401 один раз перерегистрируется.
    const response = await authFetch('/api/tts/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        voiceId,
      }),
      signal: options.signal,
    });

    if (response.status === 402) {
      const data = await response.json().catch(() => null);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('open-topup-modal', { detail: data }));
      }
      throw new Error(`Недостаточно символов на балансе (нужно: ${text.length}). Пополните счет через ЮKassa.`);
    }

    if (!response.ok) {
      const err = await response.json().catch(() => null);
      throw new Error(err?.error || `Ошибка Cloud сервера (${response.status})`);
    }

    // Обновляем баланс из заголовков ответа
    const remainingBalance = response.headers.get('X-Remaining-Balance');
    if (remainingBalance) {
      updateBalance(parseInt(remainingBalance, 10)); // NaN игнорируется стором
    }

    return response.arrayBuffer();
  }
}

export const cloudTTSProvider = new CloudTTSProvider();
