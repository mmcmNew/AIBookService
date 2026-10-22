import { config } from '../../config.js';
import { ITtsConnector, SynthesisRequest, SynthesisResponse, TTSVoice } from './types.js';
import { addWavHeader, isRawPcm, parsePcmRate } from './wav.js';

const VOICE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export const GEMINI_VOICES: TTSVoice[] = [
  { id: 'Aoede', name: 'Aoede (Женский рассказчик)', lang: 'ru-RU', gender: 'female', provider: 'gemini' },
  { id: 'Charon', name: 'Charon (Мужской глубокий бас)', lang: 'ru-RU', gender: 'male', provider: 'gemini' },
  { id: 'Kore', name: 'Kore (Женский мягкий голос)', lang: 'ru-RU', gender: 'female', provider: 'gemini' },
  { id: 'Fenrir', name: 'Fenrir (Мужской харизматичный)', lang: 'ru-RU', gender: 'male', provider: 'gemini' },
  { id: 'Puck', name: 'Puck (Мужской эмоциональный)', lang: 'ru-RU', gender: 'male', provider: 'gemini' },
];

export class GeminiTtsConnector implements ITtsConnector {
  readonly id = 'gemini' as const;
  readonly name = 'Google Gemini Audio';

  isConfigured(): boolean {
    return Boolean(config.geminiApiKey());
  }

  async getVoices(): Promise<TTSVoice[]> {
    return GEMINI_VOICES;
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResponse> {
    const apiKey = config.geminiApiKey();
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY не установлен на сервере.');
    }
    const voice = req.voiceId && VOICE_RE.test(req.voiceId) ? req.voiceId : 'Aoede';

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      config.geminiTtsModel(),
    )}:generateContent`;

    const requestBody = {
      contents: [{ role: 'user', parts: [{ text: req.text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
        },
      },
    };

    const signal = req.signal ?? AbortSignal.timeout(60000);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(requestBody),
      signal,
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
      return {
        audio: addWavHeader(audioBuffer, parsePcmRate(inlineData.mimeType), 1, 16),
        contentType: 'audio/wav',
      };
    }

    return {
      audio: audioBuffer,
      contentType: inlineData.mimeType || 'audio/wav',
    };
  }
}
