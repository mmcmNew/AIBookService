import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listProviders,
  listVoices,
  voiceOptionsForModel,
  isVoiceValidForModel,
  normalizeVoiceForModel,
} from './audioCatalog';
import {
  loadCatalogVoices,
  getAggregatorVoiceOptions,
  isAggregatorVoiceValid,
} from '../settings';

test('audioCatalog: listProviders возвращает полную карту провайдеров с метаданными', () => {
  const providers = listProviders();
  assert.ok(providers['openrouter']);
  assert.ok(providers['edge-tts']);
  assert.ok(providers['gemini']);
  assert.ok(providers['openai']);
  assert.ok(providers['elevenlabs']);
  assert.ok(providers['cloud']);
  assert.ok(providers['webspeech']);

  assert.equal(providers.openrouter.requiresApiKey, true);
  assert.equal(providers['edge-tts'].requiresApiKey, false);
});

test('audioCatalog: voiceOptionsForModel добавляет вариант по умолчанию', () => {
  const options = voiceOptionsForModel('openai/gpt-4o-mini-tts');
  assert.ok(options.length > 1);
  assert.equal(options[0].id, '');
  assert.ok(options.some((o) => o.id === 'alloy'));
});

test('audioCatalog: isVoiceValidForModel валидирует голос для известной модели и каталога', () => {
  // Для gpt-4o-mini-tts alloy валиден, unknown-voice не валиден
  assert.equal(isVoiceValidForModel('alloy', 'openai/gpt-4o-mini-tts'), true);
  assert.equal(isVoiceValidForModel('non-existent-voice', 'openai/gpt-4o-mini-tts'), false);
  // Пустой голос (по умолчанию) валиден всегда
  assert.equal(isVoiceValidForModel('', 'openai/gpt-4o-mini-tts'), true);

  // С голосами из каталога
  assert.equal(isVoiceValidForModel('custom-voice', 'some/model', [], ['custom-voice', 'other']), true);
  assert.equal(isVoiceValidForModel('wrong-voice', 'some/model', [], ['custom-voice', 'other']), false);
});

test('audioCatalog: normalizeVoiceForModel сбрасывает неподходящий голос', () => {
  assert.equal(normalizeVoiceForModel('alloy', 'openai/gpt-4o-mini-tts'), 'alloy');
  assert.equal(normalizeVoiceForModel('invalid-voice', 'openai/gpt-4o-mini-tts'), '');
  assert.equal(normalizeVoiceForModel('custom', 'vendor/custom-tts', undefined), 'custom');
});

test('settings domain: проксирует запросы каталога в Поставщик озвучки', async () => {
  const voices = await loadCatalogVoices({});
  assert.ok(voices.length > 0);

  const opts = getAggregatorVoiceOptions('openai/gpt-4o-mini-tts');
  assert.equal(opts[0].id, '');

  assert.equal(isAggregatorVoiceValid('alloy', 'openai/gpt-4o-mini-tts'), true);
  assert.equal(isAggregatorVoiceValid('invalid', 'openai/gpt-4o-mini-tts'), false);
});
