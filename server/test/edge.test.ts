import test from 'node:test';
import assert from 'node:assert/strict';
import { EdgeTtsConnector } from '../src/services/tts/edge.js';

test('EdgeTtsConnector: синтез аудио через WebSocket', async () => {
  const edge = new EdgeTtsConnector();
  assert.equal(edge.isConfigured(), true);

  const res = await edge.synthesize({
    text: 'Привет! Это автоматический тест синтеза Edge TTS.',
    voiceId: 'ru-RU-SvetlanaNeural',
    speed: 1,
    pitch: 0,
  });

  assert.equal(res.contentType, 'audio/mpeg');
  assert.ok(Buffer.isBuffer(res.audio));
  assert.ok(res.audio.length > 3000, `Audio buffer length should be > 3000 bytes, got ${res.audio.length}`);
});
