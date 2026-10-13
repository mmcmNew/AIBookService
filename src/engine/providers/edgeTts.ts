import { ITTSProvider, SynthesisOptions, VoiceOption } from '../../types/tts';

export const POPULAR_EDGE_VOICES: VoiceOption[] = [
  { id: 'ru-RU-SvetlanaNeural', name: 'Светлана (ru-RU, естественный женский)', lang: 'ru-RU', gender: 'female', provider: 'edge-tts' },
  { id: 'ru-RU-DmitryNeural', name: 'Дмитрий (ru-RU, диктор мужской)', lang: 'ru-RU', gender: 'male', provider: 'edge-tts' },
  { id: 'en-US-JennyNeural', name: 'Jenny (en-US, Expressive)', lang: 'en-US', gender: 'female', provider: 'edge-tts' },
  { id: 'en-US-GuyNeural', name: 'Guy (en-US, Storyteller)', lang: 'en-US', gender: 'male', provider: 'edge-tts' },
  { id: 'en-US-AriaNeural', name: 'Aria (en-US, News / Clear)', lang: 'en-US', gender: 'female', provider: 'edge-tts' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia (en-GB, British)', lang: 'en-GB', gender: 'female', provider: 'edge-tts' },
];

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

export class EdgeTTSProvider implements ITTSProvider {
  id = 'edge-tts' as const;
  name = 'Edge-TTS (Microsoft Neural)';
  description = 'Бесплатные нейросетевые голоса Microsoft высокого качества без ключа (требуется доступ к speech.platform.bing.com).';
  requiresApiKey = false;
  supportsVoiceCloning = false;
  supportsOffline = false;

  async getVoices(): Promise<VoiceOption[]> {
    try {
      const res = await fetch(`https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_TOKEN}`);
      if (res.ok) {
        const list = await res.json();
        if (Array.isArray(list) && list.length > 0) {
          const sorted = list
            .filter((v: any) => v.ShortName)
            .sort((a: any, b: any) => {
              const aRu = a.Locale?.startsWith('ru');
              const bRu = b.Locale?.startsWith('ru');
              if (aRu && !bRu) return -1;
              if (!aRu && bRu) return 1;
              return (a.FriendlyName || a.ShortName).localeCompare(b.FriendlyName || b.ShortName);
            });

          return sorted.map((v: any) => ({
            id: v.ShortName,
            name: `${v.FriendlyName || v.ShortName} (${v.Locale})`,
            lang: v.Locale,
            gender: v.Gender === 'Female' ? 'female' : 'male',
            provider: 'edge-tts' as const,
          }));
        }
      }
    } catch {
      // Игнорируем и возвращаем базовый список популярных голосов
    }

    return POPULAR_EDGE_VOICES;
  }

  async synthesize(text: string, options: SynthesisOptions): Promise<ArrayBuffer> {
    const voice = options.voiceId || 'ru-RU-SvetlanaNeural';
    const ratePercent = options.speed >= 1 
      ? `+${Math.round((options.speed - 1) * 100)}%` 
      : `-${Math.round((1 - options.speed) * 100)}%`;

    const pitchHz = options.pitch 
      ? `${options.pitch >= 0 ? '+' : ''}${Math.round(options.pitch * 10)}Hz` 
      : '+0Hz';

    const cleanText = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ru-RU'>
      <voice name='${voice}'>
        <prosody pitch='${pitchHz}' rate='${ratePercent}' volume='+0%'>
          ${cleanText}
        </prosody>
      </voice>
    </speak>`;

    return new Promise((resolve, reject) => {
      const connectionId = crypto.randomUUID().replace(/-/g, '');
      const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_TOKEN}&ConnectionId=${connectionId}`;

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e: any) {
        reject(new Error('Не удалось подключиться к серверам Edge TTS (сетевой сбой или блокировка). Переключитесь на Web Speech или Google Gemini в настройках.'));
        return;
      }

      const audioChunks: Uint8Array[] = [];
      ws.binaryType = 'arraybuffer';

      const timeoutId = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('Edge TTS: Превышен таймаут ответа сервера (сеть недоступна). Переключитесь на Web Speech или Google Gemini.'));
      }, 8000);

      options.signal?.addEventListener('abort', () => {
        clearTimeout(timeoutId);
        try { ws.close(); } catch {}
        reject(new Error('Edge-TTS: Запрос отменен'));
      });

      ws.onopen = () => {
        const configMsg = `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`;
        ws.send(configMsg);

        const requestId = crypto.randomUUID().replace(/-/g, '');
        const ssmlMsg = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`;
        ws.send(ssmlMsg);
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          const buffer = event.data;
          const view = new DataView(buffer);
          const headerLength = view.getInt16(0);
          const headerBytes = new Uint8Array(buffer, 2, headerLength);
          const headerText = new TextDecoder().decode(headerBytes);

          if (headerText.includes('Path:audio')) {
            const audioData = new Uint8Array(buffer, 2 + headerLength);
            if (audioData.length > 0) {
              audioChunks.push(audioData);
            }
          }
        } else if (typeof event.data === 'string') {
          if (event.data.includes('Path:turn.end')) {
            clearTimeout(timeoutId);
            try { ws.close(); } catch {}

            const totalLength = audioChunks.reduce((acc, c) => acc + c.length, 0);
            const merged = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of audioChunks) {
              merged.set(chunk, offset);
              offset += chunk.length;
            }

            resolve(merged.buffer);
          }
        }
      };

      ws.onerror = () => {
        clearTimeout(timeoutId);
        try { ws.close(); } catch {}
        reject(new Error('Не удалось подключиться к серверам Edge TTS (сеть или блокировка провайдером). Переключитесь на Web Speech (системный) или Google Gemini.'));
      };
    });
  }
}

export const edgeTTSProvider = new EdgeTTSProvider();
