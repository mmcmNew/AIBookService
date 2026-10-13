import { config } from '../config.js';

export interface TtsService {
  synthesize(text: string, voiceId?: string): Promise<Buffer>;
}

const VOICE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/** Разбор sample rate из mime вида 'audio/L16;codec=pcm;rate=24000'. */
export function parsePcmRate(mimeType: string | undefined, fallback = 24000): number {
  const m = /rate=(\d{4,6})/i.exec(mimeType || '');
  const rate = m ? parseInt(m[1], 10) : fallback;
  return rate >= 8000 && rate <= 192000 ? rate : fallback;
}

export function isRawPcm(mimeType: string | undefined): boolean {
  return /pcm|raw|l16/i.test(mimeType || '');
}

export function addWavHeader(samples: Buffer, sampleRate: number, numChannels = 1, bitsPerSample = 16): Buffer {
  const dataSize = samples.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, samples]);
}

export class ServerGeminiService implements TtsService {
  async synthesize(text: string, voiceId = 'Aoede'): Promise<Buffer> {
    const apiKey = config.geminiApiKey();
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY не установлен на сервере.');
    }
    const voice = VOICE_RE.test(voiceId) ? voiceId : 'Aoede';

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiTtsModel())}:generateContent`;
    const requestBody = {
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
        },
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini API Error (${response.status}): ${err.slice(0, 500)}`);
    }

    const data: any = await response.json();
    const inlineData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inlineData?.data) {
      throw new Error('Gemini API не вернул аудиоданные.');
    }

    const audioBuffer = Buffer.from(inlineData.data, 'base64');
    if (isRawPcm(inlineData.mimeType)) {
      return addWavHeader(audioBuffer, parsePcmRate(inlineData.mimeType), 1, 16);
    }
    return audioBuffer;
  }
}
