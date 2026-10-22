import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { Database } from '../src/db.js';
import { TtsManager, ITtsConnector, SynthesisRequest, SynthesisResponse, TTSVoice } from '../src/services/tts/index.js';

class MockConnector implements ITtsConnector {
  public synthesizedCount = 0;
  public lastRequest?: SynthesisRequest;

  constructor(
    public readonly id: any,
    public readonly name: string,
    private configured: boolean = true,
    private contentType: string = 'audio/mpeg',
  ) {}

  isConfigured(): boolean {
    return this.configured;
  }

  async getVoices(): Promise<TTSVoice[]> {
    return [
      { id: `${this.id}-voice-1`, name: `${this.name} Voice 1`, lang: 'ru-RU', gender: 'male', provider: this.id },
    ];
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResponse> {
    this.synthesizedCount++;
    this.lastRequest = req;
    if (req.text.includes('FAIL')) {
      throw new Error(`Mock error for ${this.id}`);
    }
    return {
      audio: Buffer.from(`AUDIO_DATA_FOR_${this.id}`),
      contentType: this.contentType,
    };
  }
}

let dir: string;
let server: Server;
let base: string;
let db: Database;
let ttsManager: TtsManager;
let mockOpenAi: MockConnector;
let mockEleven: MockConnector;
let mockGemini: MockConnector;
let mockEdge: MockConnector;

async function bootServer() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abr-tts-test-'));
  db = new Database(dir);

  mockOpenAi = new MockConnector('openai', 'Mock OpenAI', true, 'audio/mpeg');
  mockEleven = new MockConnector('elevenlabs', 'Mock ElevenLabs', true, 'audio/mpeg');
  mockGemini = new MockConnector('gemini', 'Mock Gemini', true, 'audio/wav');
  mockEdge = new MockConnector('edge-tts', 'Mock Edge', false, 'audio/mpeg'); // Не сконфигурирован для проверки

  ttsManager = new TtsManager({
    connectors: {
      openai: mockOpenAi,
      elevenlabs: mockEleven,
      gemini: mockGemini,
      'edge-tts': mockEdge,
      openrouter: new MockConnector('openrouter', 'Mock OpenRouter', false),
    },
  });

  const { app } = createApp({ db, tts: ttsManager });
  await new Promise<void>((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function registerUser() {
  const r = await fetch(`${base}/api/user/register`, { method: 'POST' });
  assert.equal(r.status, 201);
  return (await r.json()) as { userId: string; token: string; balance: number };
}

beforeEach(async () => {
  await bootServer();
});

afterEach(async () => {
  try {
    await new Promise((r) => server.close(r));
  } catch {}
  try {
    await db.flush();
  } catch {}
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

test('GET /api/tts/voices возвращает только голоса от настроенных провайдеров', async () => {
  const r = await fetch(`${base}/api/tts/voices`);
  assert.equal(r.status, 200);
  const data = (await r.json()) as { voices: TTSVoice[]; providers: any[] };

  assert.ok(Array.isArray(data.voices));
  assert.ok(Array.isArray(data.providers));

  // mockEdge configured: false, поэтому его голосов быть не должно
  const voiceProviders = data.voices.map((v) => v.provider);
  assert.ok(voiceProviders.includes('openai'));
  assert.ok(voiceProviders.includes('elevenlabs'));
  assert.ok(voiceProviders.includes('gemini'));
  assert.ok(!voiceProviders.includes('edge-tts'));

  // Проверяем список провайдеров
  const edgeProv = data.providers.find((p) => p.id === 'edge-tts');
  assert.equal(edgeProv?.configured, false);
  const openAiProv = data.providers.find((p) => p.id === 'openai');
  assert.equal(openAiProv?.configured, true);
});

test('POST /api/tts/stream корректно направляет запрос нужному провайдеру', async () => {
  const user = await registerUser();

  // Запрос в OpenAI
  const resOpenAI = await fetch(`${base}/api/tts/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.token}`,
    },
    body: JSON.stringify({
      text: 'Тест OpenAI озвучки',
      provider: 'openai',
      voiceId: 'alloy',
    }),
  });

  assert.equal(resOpenAI.status, 200);
  assert.equal(resOpenAI.headers.get('Content-Type'), 'audio/mpeg');
  assert.equal(mockOpenAi.synthesizedCount, 1);
  assert.equal(mockOpenAi.lastRequest?.voiceId, 'alloy');
  assert.equal(mockOpenAi.lastRequest?.text, 'Тест OpenAI озвучки');

  const audioData = await resOpenAI.text();
  assert.equal(audioData, 'AUDIO_DATA_FOR_openai');

  // Запрос в Gemini (отдает audio/wav)
  const resGemini = await fetch(`${base}/api/tts/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.token}`,
    },
    body: JSON.stringify({
      text: 'Тест Gemini',
      provider: 'gemini',
      voiceId: 'Aoede',
    }),
  });

  assert.equal(resGemini.status, 200);
  assert.equal(resGemini.headers.get('Content-Type'), 'audio/wav');
  assert.equal(mockGemini.synthesizedCount, 1);
});

test('POST /api/tts/stream возвращает 500 и делает возврат баланса при сбое провайдера', async () => {
  const user = await registerUser();
  const initialBalance = user.balance;
  const text = 'Слово FAIL вызовет сбой';

  const res = await fetch(`${base}/api/tts/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.token}`,
    },
    body: JSON.stringify({
      text,
      provider: 'openai',
    }),
  });

  assert.equal(res.status, 500);
  const errJson = (await res.json()) as any;
  assert.equal(errJson.refunded, text.length);

  // Проверяем, что баланс вернулся
  const userCheck = db.getUser(user.userId);
  assert.equal(userCheck?.balance, initialBalance);
});

test('POST /api/tts/stream отклоняет запрос к ненастроенному провайдеру с возвратом баланса', async () => {
  const user = await registerUser();
  const initialBalance = user.balance;
  const text = 'Проверка вызова неактивного Edge';

  const res = await fetch(`${base}/api/tts/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.token}`,
    },
    body: JSON.stringify({
      text,
      provider: 'edge-tts',
    }),
  });

  assert.equal(res.status, 500);
  const userCheck = db.getUser(user.userId);
  assert.equal(userCheck?.balance, initialBalance);
});
