import crypto from 'node:crypto';
import WebSocket from 'ws';
import { config } from '../../config.js';
import { ITtsConnector, SynthesisRequest, SynthesisResponse, TTSVoice } from './types.js';

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = '143';
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;

function generateSecMsGec(): string {
  const ticks = Math.floor(Date.now() / 1000) + 11644473600;
  const rounded = ticks - (ticks % 300);
  const windowsTicks = rounded * 10000000;
  const str = `${windowsTicks}${TRUSTED_TOKEN}`;
  return crypto.createHash('sha256').update(str, 'ascii').digest('hex').toUpperCase();
}

function generateMuid(): string {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

function dateToString(): string {
  const d = new Date();
  return d.toUTCString().replace('UTC', 'GMT') + ' (Coordinated Universal Time)';
}

export const POPULAR_EDGE_VOICES: TTSVoice[] = [
  { id: 'ru-RU-SvetlanaNeural', name: 'Светлана (ru-RU, естественный женский)', lang: 'ru-RU', gender: 'female', provider: 'edge-tts' },
  { id: 'ru-RU-DmitryNeural', name: 'Дмитрий (ru-RU, диктор мужской)', lang: 'ru-RU', gender: 'male', provider: 'edge-tts' },
  { id: 'en-US-JennyNeural', name: 'Jenny (en-US, Expressive)', lang: 'en-US', gender: 'female', provider: 'edge-tts' },
  { id: 'en-US-GuyNeural', name: 'Guy (en-US, Storyteller)', lang: 'en-US', gender: 'male', provider: 'edge-tts' },
  { id: 'en-US-AriaNeural', name: 'Aria (en-US, News / Clear)', lang: 'en-US', gender: 'female', provider: 'edge-tts' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia (en-GB, British)', lang: 'en-GB', gender: 'female', provider: 'edge-tts' },
];

export class EdgeTtsConnector implements ITtsConnector {
  readonly id = 'edge-tts' as const;
  readonly name = 'Microsoft Edge TTS';

  private cachedVoices: { list: TTSVoice[]; timestamp: number } | null = null;
  private readonly CACHE_TTL_MS = 60 * 60 * 1000; // 1 час

  isConfigured(): boolean {
    return config.edgeTtsEnabled();
  }

  async getVoices(): Promise<TTSVoice[]> {
    if (this.cachedVoices && Date.now() - this.cachedVoices.timestamp < this.CACHE_TTL_MS) {
      return this.cachedVoices.list;
    }

    try {
      const res = await fetch(
        `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_TOKEN}`,
        {
          headers: {
            'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/${CHROMIUM_MAJOR_VERSION}.0.0.0 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
          },
          signal: AbortSignal.timeout(10000),
        },
      );
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

          const voices: TTSVoice[] = sorted.map((v: any) => ({
            id: v.ShortName,
            name: `${v.FriendlyName || v.ShortName} (${v.Locale})`,
            lang: v.Locale,
            gender: v.Gender === 'Female' ? 'female' : 'male',
            provider: 'edge-tts' as const,
          }));

          this.cachedVoices = { list: voices, timestamp: Date.now() };
          return voices;
        }
      }
    } catch {
      // Игнорируем и возвращаем базовый список популярных голосов
    }

    return POPULAR_EDGE_VOICES;
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResponse> {
    const voice = req.voiceId || 'ru-RU-SvetlanaNeural';
    const ratePercent = req.speed && req.speed !== 1
      ? (req.speed >= 1 ? `+${Math.round((req.speed - 1) * 100)}%` : `-${Math.round((1 - req.speed) * 100)}%`)
      : '+0%';

    const pitchHz = req.pitch && req.pitch !== 0
      ? `${req.pitch >= 0 ? '+' : ''}${Math.round(req.pitch * 10)}Hz`
      : '+0Hz';

    const cleanText = req.text
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
      const secMsGec = generateSecMsGec();
      const connectionId = crypto.randomUUID().replace(/-/g, '');
      const url = `wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key=${TRUSTED_TOKEN}&ConnectionId=${connectionId}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

      let ws: WebSocket;
      try {
        ws = new WebSocket(url, {
          headers: {
            'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/${CHROMIUM_MAJOR_VERSION}.0.0.0 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'en-US,en;q=0.9',
            Pragma: 'no-cache',
            'Cache-Control': 'no-cache',
            Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
            'Sec-WebSocket-Version': '13',
            Cookie: `muid=${generateMuid()};`,
          },
        });
      } catch (e: any) {
        reject(new Error(`Не удалось подключиться к Edge TTS: ${e?.message || e}`));
        return;
      }

      const audioChunks: Buffer[] = [];
      let idleTimer: NodeJS.Timeout | null = null;
      let resolved = false;

      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        if (idleTimer) clearTimeout(idleTimer);
        try { ws.close(); } catch {}

        const merged = Buffer.concat(audioChunks);
        if (merged.length === 0) {
          reject(new Error('Edge TTS не вернул аудиоданных'));
          return;
        }
        resolve({
          audio: merged,
          contentType: 'audio/mpeg',
        });
      };

      const timeoutId = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        if (idleTimer) clearTimeout(idleTimer);
        try { ws.close(); } catch {}
        if (audioChunks.length > 0) {
          const merged = Buffer.concat(audioChunks);
          resolve({
            audio: merged,
            contentType: 'audio/mpeg',
          });
        } else {
          reject(new Error('Edge TTS: Превышен таймаут ответа сервера Microsoft'));
        }
      }, 15000);

      req.signal?.addEventListener('abort', () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        if (idleTimer) clearTimeout(idleTimer);
        try { ws.close(); } catch {}
        reject(new Error('Edge TTS: Запрос отменен'));
      });

      ws.on('open', () => {
        const timestamp = dateToString();
        const configMsg =
          `X-Timestamp:${timestamp}\r\n` +
          'Content-Type:application/json; charset=utf-8\r\n' +
          'Path:speech.config\r\n\r\n' +
          '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n';
        ws.send(configMsg);

        const requestId = crypto.randomUUID().replace(/-/g, '');
        const ssmlMsg =
          `X-RequestId:${requestId}\r\n` +
          'Content-Type:application/ssml+xml\r\n' +
          `X-Timestamp:${timestamp}Z\r\n` +
          'Path:ssml\r\n\r\n' +
          ssml;
        ws.send(ssmlMsg);
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
          if (buf.length >= 2) {
            const headerLength = buf.readUInt16BE(0);
            if (headerLength <= buf.length) {
              const headerText = buf.subarray(2, 2 + headerLength).toString('utf-8');
              if (headerText.includes('Path:audio')) {
                const audio = buf.subarray(2 + headerLength);
                if (audio.length > 0) {
                  audioChunks.push(audio);
                  if (idleTimer) clearTimeout(idleTimer);
                  idleTimer = setTimeout(finish, 700);
                }
              }
            }
          }
        } else {
          const text = data.toString();
          if (text.includes('Path:turn.end')) {
            finish();
          }
        }
      });

      ws.on('error', (err) => {
        if (resolved) return;
        clearTimeout(timeoutId);
        if (idleTimer) clearTimeout(idleTimer);
        reject(new Error(`Edge TTS: Ошибка соединения с сервером Microsoft (${err?.message || err})`));
      });

      ws.on('close', () => {
        if (!resolved && audioChunks.length > 0) {
          finish();
        }
      });
    });
  }
}
