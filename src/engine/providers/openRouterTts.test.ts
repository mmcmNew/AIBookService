import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyModel } from './openRouterTts';

const m = (id: string, modality: string, output_modalities: string[]) => ({
  id,
  architecture: { modality, input_modalities: modality.split('->')[0].split('+'), output_modalities },
});

test('TTS-модели OpenRouter (output speech) → speech', () => {
  for (const id of ['bytedance-seed/seed-audio-1-0', 'elevenlabs/eleven-v3', 'google/gemini-3.1-flash-tts-preview', 'deepgram/aura-2', 'minimax/speech-2.8-hd', 'fish-audio/s1', 'canopylabs/orpheus-3b-0.1-ft']) {
    assert.equal(classifyModel(m(id, 'text->speech', ['speech'])), 'speech', id);
  }
});

test('chat-модели с аудио-выходом → chat-audio', () => {
  assert.equal(classifyModel(m('openai/gpt-audio', 'text+audio->text+audio', ['text', 'audio'])), 'chat-audio');
  assert.equal(classifyModel(m('openai/gpt-audio-mini', 'text+audio->text+audio', ['text', 'audio'])), 'chat-audio');
});

test('генерация музыки (Lyria) и текстовые модели → other', () => {
  assert.equal(classifyModel(m('google/lyria-3-pro-preview', 'text+image->text+audio', ['text', 'audio'])), 'other');
  assert.equal(classifyModel(m('anthropic/claude-opus-5', 'text+image->text', ['text'])), 'other');
  assert.equal(classifyModel(m('openai/gpt-image-1', 'text->image', ['image'])), 'other');
});

test('только modality без массивов', () => {
  assert.equal(classifyModel({ id: 'x/y', architecture: { modality: 'text->speech' } }), 'speech');
  assert.equal(classifyModel({ id: 'x/y', architecture: { modality: 'text+audio->text+audio' } }), 'chat-audio');
});

test('нет architecture → эвристика по id', () => {
  assert.equal(classifyModel({ id: 'openai/tts-1-hd' }), 'speech');
  assert.equal(classifyModel({ id: 'openai/gpt-4o-mini-tts' }), 'speech');
  assert.equal(classifyModel({ id: 'openai/gpt-4o-audio-preview' }), 'chat-audio');
  assert.equal(classifyModel({ id: 'openai/whisper-1' }), 'other');
  assert.equal(classifyModel({ id: 'meta/llama-3' }), 'other');
});

import { OpenRouterTTSProvider } from './openRouterTts';

test('шлюз ответил «voice is missing» → повтор /audio/speech с голосом и запоминание', async () => {
  const bodies: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (!body.voice) {
      return new Response(JSON.stringify({ error: { message: 'voice is missing', code: 400 } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }) as typeof fetch;
  try {
    const p = new OpenRouterTTSProvider();
    const buf = await p.synthesize('Привет', { voiceId: '', speed: 1, apiKey: 'k', model: 'openai/tts-1', baseUrl: 'https://gw.example/api/v1', apiMode: 'speech' } as any);
    assert.ok(buf.byteLength > 0);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].voice, undefined);
    assert.equal(bodies[1].voice, 'alloy');
    // Запомнено: следующий запрос сразу с голосом
    await p.synthesize('Ещё', { voiceId: '', speed: 1, apiKey: 'k', model: 'openai/tts-1', baseUrl: 'https://gw.example/api/v1', apiMode: 'speech' } as any);
    assert.equal(bodies.length, 3);
    assert.equal(bodies[2].voice, 'alloy');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('для не-OpenAI модели (bytedance-seed/seed-audio-1-0) по умолчанию голос не отправляется в body.voice', async () => {
  const bodies: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  }) as typeof fetch;
  try {
    const p = new OpenRouterTTSProvider();
    const buf = await p.synthesize('Привет', {
      voiceId: '',
      speed: 1,
      apiKey: 'k',
      model: 'bytedance-seed/seed-audio-1-0',
      baseUrl: 'https://routerai.ru/api/v1',
      apiMode: 'speech',
    } as any);
    assert.ok(buf.byteLength > 0);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].voice, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('шлюз ответил «voice is missing» для не-OpenAI модели без каталога → понятная ошибка без отправки alloy', async () => {
  const bodies: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ error: { message: 'voice is required', code: 400 } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const p = new OpenRouterTTSProvider();
    await assert.rejects(
      async () => {
        await p.synthesize('Привет', {
          voiceId: '',
          speed: 1,
          apiKey: 'k',
          model: 'bytedance-seed/seed-audio-1-0',
          baseUrl: 'https://routerai.ru/api/v1',
          apiMode: 'speech',
        } as any);
      },
      (err: any) => {
        assert.ok(err.message.includes('требует указать ID голоса'));
        return true;
      }
    );
    // Должен быть сделан ровно 1 запрос без alloy, без автоповтора с чужим alloy
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].voice, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

import { resolveAggregatorVoiceOptions } from './openRouterTts';

test('resolveAggregatorVoiceOptions: динамический список в зависимости от модели', () => {
  // Для OpenAI-моделей: дефолт + голоса OpenAI
  const openaiVoices = resolveAggregatorVoiceOptions('openai/gpt-4o-mini-tts');
  assert.equal(openaiVoices[0].id, '');
  assert.ok(openaiVoices.some((v) => v.id === 'alloy'));

  // Для Kokoro: дефолт + голоса Kokoro
  const kokoroVoices = resolveAggregatorVoiceOptions('hexgrad/kokoro-82m');
  assert.equal(kokoroVoices[0].id, '');
  assert.ok(kokoroVoices.some((v) => v.id === 'af_heart'));
  assert.equal(kokoroVoices.some((v) => v.id === 'alloy'), false);

  // Для неизвестной модели (ByteDance Seed Audio): только дефолт, без навязывания чужих голосов
  const seedVoices = resolveAggregatorVoiceOptions('bytedance-seed/seed-audio-1-0');
  assert.equal(seedVoices.length, 1);
  assert.equal(seedVoices[0].id, '');

  // Если модель принесла свои голоса из каталога шлюза:
  const catalogCustom = resolveAggregatorVoiceOptions('some/model', [], ['custom_speaker_1', 'custom_speaker_2']);
  assert.equal(catalogCustom.length, 3);
  assert.equal(catalogCustom[0].id, '');
  assert.equal(catalogCustom[1].id, 'custom_speaker_1');
});

import { useSettingsStore, getAggregatorApiKey, normalizeBaseUrl } from '../../store/settingsStore';
import { buildSynthesisOptions, setOpenRouterModel, setAggregatorApiKey } from '../settings';

test('Раздельные API-ключи и модели для каждого подключения (OpenRouter vs RouterAI)', () => {
  const store = useSettingsStore.getState();

  // 1. Устанавливаем ключ для OpenRouter
  setAggregatorApiKey('sk-or-v1-openrouter-secret-key', 'https://openrouter.ai/api/v1');
  // 2. Устанавливаем ключ для RouterAI
  setAggregatorApiKey('routerai-secret-key-12345', 'https://routerai.ru/api/v1');

  // Проверяем, что ключи независимы и не перезаписывают друг друга
  assert.equal(getAggregatorApiKey('https://openrouter.ai/api/v1'), 'sk-or-v1-openrouter-secret-key');
  assert.equal(getAggregatorApiKey('https://routerai.ru/api/v1'), 'routerai-secret-key-12345');

  // 3. Проверяем, что buildSynthesisOptions подставляет ключ в зависимости от активного openRouterBaseUrl
  useSettingsStore.setState({
    activeProvider: 'openrouter',
    openRouterBaseUrl: 'https://openrouter.ai/api/v1',
  });
  const optsOR = buildSynthesisOptions();
  assert.equal(optsOR.apiKey, 'sk-or-v1-openrouter-secret-key');

  useSettingsStore.setState({
    activeProvider: 'openrouter',
    openRouterBaseUrl: 'https://routerai.ru/api/v1',
  });
  const optsRAI = buildSynthesisOptions();
  assert.equal(optsRAI.apiKey, 'routerai-secret-key-12345');

  // 4. Проверяем запоминание модели под каждое подключение
  useSettingsStore.setState({ openRouterBaseUrl: 'https://routerai.ru/api/v1' });
  setOpenRouterModel('bytedance-seed/seed-audio-1-0');
  assert.equal(useSettingsStore.getState().aggregatorModels?.['https://routerai.ru/api/v1'], 'bytedance-seed/seed-audio-1-0');

  useSettingsStore.setState({ openRouterBaseUrl: 'https://openrouter.ai/api/v1' });
  setOpenRouterModel('openai/gpt-audio-mini');
  assert.equal(useSettingsStore.getState().aggregatorModels?.['https://openrouter.ai/api/v1'], 'openai/gpt-audio-mini');

  // Переключение URL через setOpenRouterBaseUrl восстанавливает модель для этого URL
  useSettingsStore.getState().setOpenRouterBaseUrl('https://routerai.ru/api/v1');
  assert.equal(useSettingsStore.getState().openRouterModel, 'bytedance-seed/seed-audio-1-0');

  useSettingsStore.getState().setOpenRouterBaseUrl('https://openrouter.ai/api/v1');
  assert.equal(useSettingsStore.getState().openRouterModel, 'openai/gpt-audio-mini');
});

