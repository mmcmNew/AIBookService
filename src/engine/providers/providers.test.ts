import test from 'node:test';
import assert from 'node:assert/strict';
import { getProvider, PROVIDERS_MAP, getAllVoices } from './index';
import { OpenAITTSProvider, OPENAI_VOICES } from './openaiTts';
import { GeminiTTSProvider, GEMINI_PREBUILT_VOICES } from './geminiTts';
import { ElevenLabsTTSProvider, DEFAULT_ELEVENLABS_VOICES } from './elevenLabsTts';
import { CloudTTSProvider, CLOUD_VOICES } from './cloudTts';
import { WebSpeechProvider } from './webSpeech';
import { EdgeTTSProvider, POPULAR_EDGE_VOICES } from './edgeTts';

// ---------------------------------------------------------------------------
// 1. Provider Map & Resolution
// ---------------------------------------------------------------------------

test('PROVIDERS_MAP содержит все заявленные типы провайдеров', () => {
  const expected = ['cloud', 'edge-tts', 'webspeech', 'gemini', 'openai', 'elevenlabs', 'openrouter'];
  for (const type of expected) {
    assert.ok(PROVIDERS_MAP[type as keyof typeof PROVIDERS_MAP], `Провайдер ${type} отсутствует`);
    assert.equal(PROVIDERS_MAP[type as keyof typeof PROVIDERS_MAP].id, type);
  }
});

test('getProvider возвращает целевой провайдер или fallback на edge-tts', () => {
  assert.equal(getProvider('openai').id, 'openai');
  assert.equal(getProvider('gemini').id, 'gemini');
  assert.equal(getProvider('webspeech').id, 'webspeech');
  assert.equal(getProvider('non-existent' as any).id, 'edge-tts');
});

test('getAllVoices собирает голоса со всех провайдеров', async () => {
  const voices = await getAllVoices({});
  assert.ok(voices.length > 0);
  assert.ok(voices.some((v) => v.provider === 'edge-tts'));
  assert.ok(voices.some((v) => v.provider === 'openai'));
  assert.ok(voices.some((v) => v.provider === 'gemini'));
  assert.ok(voices.some((v) => v.provider === 'cloud'));
});

// ---------------------------------------------------------------------------
// 2. OpenAI Provider
// ---------------------------------------------------------------------------

test('OpenAITTSProvider: getVoices возвращает список голосов', async () => {
  const p = new OpenAITTSProvider();
  const voices = await p.getVoices();
  assert.deepEqual(voices, OPENAI_VOICES);
});

test('OpenAITTSProvider: synthesize выбрасывает ошибку без apiKey', async () => {
  const p = new OpenAITTSProvider();
  await assert.rejects(
    () => p.synthesize('Тест', { speed: 1, pitch: 0 } as any),
    /указать OpenAI API Key/
  );
});

test('OpenAITTSProvider: synthesize отправляет корректный запрос и возвращает буфер', async () => {
  const p = new OpenAITTSProvider();
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestInit: any = null;

  globalThis.fetch = (async (url: any, init: any) => {
    requestedUrl = String(url);
    requestInit = init;
    return new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  }) as typeof fetch;

  try {
    const res = await p.synthesize('Привет мир', {
      apiKey: 'test-sk-123',
      voiceId: 'alloy',
      speed: 1,
      pitch: 0,
    } as any);

    assert.equal(requestedUrl, 'https://api.openai.com/v1/audio/speech');
    assert.equal(requestInit.method, 'POST');
    assert.equal(requestInit.headers['Authorization'], 'Bearer test-sk-123');
    const body = JSON.parse(requestInit.body);
    assert.equal(body.model, 'tts-1');
    assert.equal(body.input, 'Привет мир');
    assert.equal(body.voice, 'alloy');
    assert.equal(body.response_format, 'mp3');
    assert.equal(res.byteLength, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAITTSProvider: synthesize обрабатывает ошибку API', async () => {
  const p = new OpenAITTSProvider();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => p.synthesize('Тест', { apiKey: 'key', speed: 1, pitch: 0 } as any),
      /OpenAI API Error: Quota exceeded/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 3. Gemini Provider
// ---------------------------------------------------------------------------

test('GeminiTTSProvider: getVoices возвращает пресет при отсутствии ключа', async () => {
  const p = new GeminiTTSProvider();
  const voices = await p.getVoices();
  assert.deepEqual(voices, GEMINI_PREBUILT_VOICES);
});

test('GeminiTTSProvider: synthesize выбрасывает ошибку без apiKey', async () => {
  const p = new GeminiTTSProvider();
  await assert.rejects(
    () => p.synthesize('Тест', { speed: 1, pitch: 0 } as any),
    /указать Gemini API Key/
  );
});

test('GeminiTTSProvider: synthesize декодирует base64 и добавляет WAV заголовок для PCM', async () => {
  const p = new GeminiTTSProvider();
  const originalFetch = globalThis.fetch;
  let requestedHeaders: any = null;

  // Создаем 16 сэмплов тишины (32 байта для 16-bit)
  const rawPcm = new Uint8Array(32);
  const base64Audio = Buffer.from(rawPcm).toString('base64');

  globalThis.fetch = (async (_url: any, init: any) => {
    requestedHeaders = init.headers;
    const responsePayload = {
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/L16;codec=pcm;rate=24000',
                  data: base64Audio,
                },
              },
            ],
          },
        },
      ],
    };
    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const res = await p.synthesize('Текст для Gemini', {
      apiKey: 'gemini-key',
      voiceId: 'Aoede',
      speed: 1,
      pitch: 0,
    } as any);

    assert.equal(requestedHeaders['x-goog-api-key'], 'gemini-key');
    // Размер: 44 байта WAV-заголовок + 32 байта PCM = 76 байт
    assert.equal(res.byteLength, 76);
    const view = new DataView(res);
    // Проверяем RIFF сигнатуру
    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    assert.equal(riff, 'RIFF');
    assert.equal(wave, 'WAVE');
    assert.equal(view.getUint32(24, true), 24000); // sampleRate
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 4. ElevenLabs Provider
// ---------------------------------------------------------------------------

test('ElevenLabsTTSProvider: getVoices возвращает пресет при отсутствии ключа', async () => {
  const p = new ElevenLabsTTSProvider();
  const voices = await p.getVoices();
  assert.deepEqual(voices, DEFAULT_ELEVENLABS_VOICES);
});

test('ElevenLabsTTSProvider: synthesize выбрасывает ошибку без apiKey', async () => {
  const p = new ElevenLabsTTSProvider();
  await assert.rejects(
    () => p.synthesize('Тест', { speed: 1, pitch: 0 } as any),
    /указать ElevenLabs API Key/
  );
});

test('ElevenLabsTTSProvider: synthesize отправляет корректный запрос с xi-api-key', async () => {
  const p = new ElevenLabsTTSProvider();
  const originalFetch = globalThis.fetch;
  let requestedHeaders: any = null;

  globalThis.fetch = (async (_url: any, init: any) => {
    requestedHeaders = init.headers;
    return new Response(new Uint8Array([5, 6, 7]).buffer, {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  }) as typeof fetch;

  try {
    const res = await p.synthesize('Привет ElevenLabs', {
      apiKey: 'xi-secret',
      voiceId: '21m00Tcm4TlvDq8ikWAM',
      speed: 1,
      pitch: 0,
    } as any);

    assert.equal(requestedHeaders['xi-api-key'], 'xi-secret');
    assert.equal(res.byteLength, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 5. Cloud Provider
// ---------------------------------------------------------------------------

test('CloudTTSProvider: getVoices возвращает фиксированный список голосов', async () => {
  const p = new CloudTTSProvider();
  const voices = await p.getVoices();
  assert.deepEqual(voices, CLOUD_VOICES);
});

test('CloudTTSProvider: synthesize возвращает буфер и остаток баланса', async () => {
  const p = new CloudTTSProvider();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
    const headers = new Headers();
    headers.set('X-Remaining-Balance', '4950');
    return new Response(new Uint8Array([9, 8, 7]).buffer, {
      status: 200,
      headers,
    });
  }) as any;

  try {
    const res = await p.synthesize('Облачный текст', {
      voiceId: 'Aoede',
      speed: 1,
      pitch: 0,
      serverUrl: 'http://localhost:4000',
      token: 'test-token',
    } as any);

    assert.equal(res.byteLength, 3);
    assert.equal((res as any).remainingBalance, 4950);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CloudTTSProvider: synthesize выбрасывает ошибку при 402 Payment Required', async () => {
  const p = new CloudTTSProvider();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: 'Payment Required' }), {
      status: 402,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;

  try {
    await assert.rejects(
      () =>
        p.synthesize('Недостаточно средств', {
          voiceId: 'Aoede',
          speed: 1,
          pitch: 0,
          serverUrl: 'http://localhost:4000',
          token: 'test-token',
        } as any),
      /Недостаточно символов на балансе/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 6. WebSpeech Provider
// ---------------------------------------------------------------------------

test('WebSpeechProvider: getVoices возвращает пустой массив вне браузера', async () => {
  const p = new WebSpeechProvider();
  const voices = await p.getVoices();
  assert.deepEqual(voices, []);
});

test('WebSpeechProvider: synthesize возвращает пустой буфер для нативного utterance', async () => {
  const p = new WebSpeechProvider();
  const buf = await p.synthesize('Привет', { speed: 1, pitch: 0 } as any);
  assert.equal(buf.byteLength, 0);
});

// ---------------------------------------------------------------------------
// 7. Edge TTS Provider (SSML & WebSocket Protocol)
// ---------------------------------------------------------------------------

test('EdgeTTSProvider: getVoices возвращает POPULAR_EDGE_VOICES при сетевой ошибке', async () => {
  const p = new EdgeTTSProvider();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    throw new Error('Network error');
  }) as typeof fetch;

  try {
    const voices = await p.getVoices();
    assert.deepEqual(voices, POPULAR_EDGE_VOICES);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('EdgeTTSProvider: synthesize экранирует XML и собирает аудиочанки по WebSocket', async () => {
  const p = new EdgeTTSProvider();
  const originalWs = globalThis.WebSocket;

  class MockWebSocket {
    binaryType = 'arraybuffer';
    onopen: (() => void) | null = null;
    onmessage: ((event: any) => void) | null = null;
    onerror: (() => void) | null = null;
    sentMessages: string[] = [];

    constructor(_url: string) {
      setTimeout(() => {
        if (this.onopen) this.onopen();
        // Эмулируем ответ сервера: чанк с Path:audio и завершение Path:turn.end
        setTimeout(() => {
          // Создаем бинарное сообщение: 2 байта длины заголовка + заголовок + аудиобайты
          const header = 'Path:audio\r\nContent-Type:audio/mpeg\r\n\r\n';
          const headerBytes = Buffer.from(header, 'utf-8');
          const audioBytes = new Uint8Array([0xAA, 0xBB, 0xCC]);
          const totalBuffer = new ArrayBuffer(2 + headerBytes.length + audioBytes.length);
          const view = new DataView(totalBuffer);
          view.setInt16(0, headerBytes.length);
          new Uint8Array(totalBuffer, 2, headerBytes.length).set(headerBytes);
          new Uint8Array(totalBuffer, 2 + headerBytes.length).set(audioBytes);

          if (this.onmessage) {
            this.onmessage({ data: totalBuffer });
            this.onmessage({ data: 'Path:turn.end\r\n' });
          }
        }, 10);
      }, 5);
    }

    send(msg: string) {
      this.sentMessages.push(msg);
    }

    close() {}
  }

  (globalThis as any).WebSocket = MockWebSocket;

  try {
    const res = await p.synthesize('Кот & "Пёс" <тест>', {
      voiceId: 'ru-RU-SvetlanaNeural',
      speed: 1.2,
      pitch: 0,
    } as any);

    assert.equal(res.byteLength, 3);
    const uint = new Uint8Array(res);
    assert.equal(uint[0], 0xAA);
    assert.equal(uint[1], 0xBB);
    assert.equal(uint[2], 0xCC);
  } finally {
    globalThis.WebSocket = originalWs;
  }
});
