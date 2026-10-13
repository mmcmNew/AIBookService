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
    const buf = await p.synthesize('Привет', { voiceId: '', speed: 1, apiKey: 'k', model: 'vendor/voiceless-tts', baseUrl: 'https://gw.example/api/v1', apiMode: 'speech' } as any);
    assert.ok(buf.byteLength > 0);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].voice, undefined);
    assert.ok(typeof bodies[1].voice === 'string' && bodies[1].voice.length > 0);
    // Запомнено: следующий запрос сразу с голосом
    await p.synthesize('Ещё', { voiceId: '', speed: 1, apiKey: 'k', model: 'vendor/voiceless-tts', baseUrl: 'https://gw.example/api/v1', apiMode: 'speech' } as any);
    assert.equal(bodies.length, 3);
    assert.ok(bodies[2].voice);
  } finally {
    globalThis.fetch = realFetch;
  }
});
