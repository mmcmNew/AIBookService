import { ITTSProvider, SynthesisOptions, VoiceOption } from '../../types/tts';

export class WebSpeechProvider implements ITTSProvider {
  id = 'webspeech' as const;
  name = 'Web Speech (Системный)';
  description = 'Встроенный системный голос браузера/ОС. Работает оффлайн, бесплатно, без API-ключей.';
  requiresApiKey = false;
  supportsVoiceCloning = false;
  supportsOffline = true;

  async getVoices(): Promise<VoiceOption[]> {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return [];
    }

    return new Promise((resolve) => {
      let voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        resolve(this.mapVoices(voices));
        return;
      }

      window.speechSynthesis.onvoiceschanged = () => {
        voices = window.speechSynthesis.getVoices();
        resolve(this.mapVoices(voices));
      };

      // Таймаут на случай, если событие не выстрелит
      setTimeout(() => {
        resolve(this.mapVoices(window.speechSynthesis.getVoices()));
      }, 500);
    });
  }

  private mapVoices(voices: SpeechSynthesisVoice[]): VoiceOption[] {
    return voices
      .filter(v => v.lang.startsWith('ru') || v.lang.startsWith('en'))
      .map(v => ({
        id: v.name,
        name: `${v.name} (${v.lang})`,
        lang: v.lang,
        provider: 'webspeech',
      }));
  }

  /**
   * Для Web Speech синтез воспроизводится через SpeechSynthesisUtterance.
   * Для совместимости с аудио-очередью возвращаем пустой буфер с маркерным заголовком.
   */
  async synthesize(_text: string, _options: SynthesisOptions): Promise<ArrayBuffer> {
    // WebSpeech воспроизводится через нативный utterance в AudioEngine
    return new ArrayBuffer(0);
  }
}

export const webSpeechProvider = new WebSpeechProvider();
