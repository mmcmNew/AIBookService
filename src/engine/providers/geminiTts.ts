import { ITTSProvider, SynthesisOptions, VoiceOption } from '../../types/tts';

export const GEMINI_PREBUILT_VOICES: VoiceOption[] = [
  { id: 'Aoede', name: 'Aoede (Женский, выразительный / мягкий)', lang: 'ru-RU', gender: 'female', provider: 'gemini' },
  { id: 'Kore', name: 'Kore (Женский, спокойный / ровный)', lang: 'ru-RU', gender: 'female', provider: 'gemini' },
  { id: 'Leda', name: 'Leda (Женский, моложавый / свежий)', lang: 'ru-RU', gender: 'female', provider: 'gemini' },
  { id: 'Callirrhoe', name: 'Callirrhoe (Женский, дружелюбный)', lang: 'ru-RU', gender: 'female', provider: 'gemini' },
  { id: 'Autonoe', name: 'Autonoe (Женский, яркий / звонкий)', lang: 'ru-RU', gender: 'female', provider: 'gemini' },
  { id: 'Despina', name: 'Despina (Женский, бархатистый)', lang: 'ru-RU', gender: 'female', provider: 'gemini' },
  { id: 'Sulafat', name: 'Sulafat (Женский, теплый / уютный)', lang: 'ru-RU', gender: 'female', provider: 'gemini' },
  { id: 'Charon', name: 'Charon (Мужской, глубокий диктор)', lang: 'ru-RU', gender: 'male', provider: 'gemini' },
  { id: 'Fenrir', name: 'Fenrir (Мужской, харизматичный / энергичный)', lang: 'ru-RU', gender: 'male', provider: 'gemini' },
  { id: 'Puck', name: 'Puck (Мужской, живой / оптимистичный)', lang: 'ru-RU', gender: 'male', provider: 'gemini' },
  { id: 'Zephyr', name: 'Zephyr (Мужской, мягкий диктор)', lang: 'ru-RU', gender: 'male', provider: 'gemini' },
  { id: 'Orus', name: 'Orus (Мужской, уверенный / строгий)', lang: 'ru-RU', gender: 'male', provider: 'gemini' },
  { id: 'Iapetus', name: 'Iapetus (Мужской, четкий / ясный)', lang: 'ru-RU', gender: 'male', provider: 'gemini' },
  { id: 'Algieba', name: 'Algieba (Мужской, плавный)', lang: 'ru-RU', gender: 'male', provider: 'gemini' },
  { id: 'Umbriel', name: 'Umbriel (Мужской, спокойный)', lang: 'ru-RU', gender: 'male', provider: 'gemini' },
  { id: 'Erinome', name: 'Erinome (Женский, чёткий)', lang: 'ru-RU', gender: 'female', provider: 'gemini' },
  { id: 'Achernar', name: 'Achernar (Женский, мягкий)', lang: 'ru-RU', gender: 'female', provider: 'gemini' },
  { id: 'Gacrux', name: 'Gacrux (Женский, зрелый)', lang: 'ru-RU', gender: 'female', provider: 'gemini' },
  { id: 'Enceladus', name: 'Enceladus (Мужской, приглушенный)', lang: 'ru-RU', gender: 'male', provider: 'gemini' },
];

export const GEMINI_AVAILABLE_MODELS = [
  { id: 'gemini-3.8-flash-tts', name: 'Gemini 3.8 Flash TTS (Студийное качество озвучки, рекомендуется)' },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash (Интеллектуальная модель общего назначения)' },
  { id: 'gemini-3.1-flash-tts-preview', name: 'Gemini 3.1 Flash TTS (Preview)' },
  { id: 'gemini-3.8-flash-lite-tts', name: 'Gemini 3.8 Flash-Lite TTS (Быстрая и экономичная)' },
];

export class GeminiTTSProvider implements ITTSProvider {
  id = 'gemini' as const;
  name = 'Google Gemini Audio';
  description = 'Мультимодальный ИИ от Google. Глубокое понимание интонаций, эмоций и контекста книги.';
  requiresApiKey = true;
  supportsVoiceCloning = false;
  supportsOffline = false;

  async getVoices(apiKey?: string): Promise<VoiceOption[]> {
    if (!apiKey) {
      return GEMINI_PREBUILT_VOICES;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/voices', {
        headers: { 'x-goog-api-key': apiKey },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const data = await res.json();
        if (data.voices && Array.isArray(data.voices) && data.voices.length > 0) {
          return data.voices.map((v: any) => ({
            id: v.id || v.name,
            name: `${v.display_name || v.id} (${v.description || v.accent || 'Gemini Voice'})`,
            lang: v.language_code || 'ru-RU',
            gender: (v.gender === 'female' || v.gender === 'male') ? v.gender : 'neutral',
            provider: 'gemini' as const,
          }));
        }
      }
    } catch {
      // Игнорируем и возвращаем базовый список
    }

    return GEMINI_PREBUILT_VOICES;
  }

  async synthesize(text: string, options: SynthesisOptions): Promise<ArrayBuffer> {
    if (!options.apiKey) {
      throw new Error('Для использования Google Gemini требуется указать Gemini API Key в настройках.');
    }

    const voice = options.voiceId || 'Aoede';
    const model = options.model || 'gemini-3.8-flash-tts';
    const headers = {
      'Content-Type': 'application/json',
      'x-goog-api-key': options.apiKey, // ключ в заголовке, а не в URL (не попадает в логи/историю)
    };

    const requestBody = {
      contents: [{
        role: 'user',
        parts: [{ text }],
      }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice,
            },
          },
        },
      },
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { method: 'POST', headers, body: JSON.stringify(requestBody), signal: options.signal }
    );

    if (!response.ok) {
      const errJson = await response.json().catch(() => null);
      throw new Error(`Gemini API Error (${response.status}): ${errJson?.error?.message || response.statusText}`);
    }

    const data = await response.json().catch(() => null);
    if (data?.error) {
      throw new Error(`Gemini API Error: ${data.error.message || 'неизвестная ошибка'}`);
    }
    const parts: any[] = data?.candidates?.[0]?.content?.parts || [];
    const inlineData = parts.map((p) => p.inlineData || p.inline_data).find((d) => d && d.data);
    if (!inlineData) {
      const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
      throw new Error(`Gemini API не вернул аудиоданные${reason ? ` (причина: ${reason})` : ''}.`);
    }

    // Декодируем base64 в ArrayBuffer
    const binaryString = atob(inlineData.data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Сырой PCM (audio/L16;codec=pcm;rate=24000) → добавляем WAV-заголовок
    const mime: string = inlineData.mimeType || inlineData.mime_type || '';
    if (/pcm|raw|l16/i.test(mime)) {
      const rateMatch = /rate=(\d+)/i.exec(mime);
      return this.addWavHeader(bytes, rateMatch ? parseInt(rateMatch[1], 10) : 24000, 1, 16);
    }

    return bytes.buffer;
  }

  private addWavHeader(samples: Uint8Array, sampleRate: number, numChannels: number, bitsPerSample: number): ArrayBuffer {
    const dataSize = samples.length;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);

    // RIFF chunk descriptor
    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, totalSize - 8, true);
    this.writeString(view, 8, 'WAVE');

    // "fmt " sub-chunk
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true);  // AudioFormat (1 for PCM)
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true); // ByteRate
    view.setUint16(32, numChannels * (bitsPerSample / 8), true);             // BlockAlign
    view.setUint16(34, bitsPerSample, true);

    // "data" sub-chunk
    this.writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Copy audio PCM samples
    new Uint8Array(buffer, headerSize).set(samples);

    return buffer;
  }

  private writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
}

export const geminiTTSProvider = new GeminiTTSProvider();
