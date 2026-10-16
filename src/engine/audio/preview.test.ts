import test from 'node:test';
import assert from 'node:assert/strict';
import { useAudioStore } from '../../store/audioStore';
import { useSettingsStore } from '../../store/settingsStore';
import { AudioManager, audioManager } from './audioManager';
import { htmlAudioPlayer } from '../../infra/audio/htmlAudioPlayer';
import { checkVoice, stopVoiceCheck } from '../settings';
import * as audioFetch from './audioFetch';

test('Оркестратор: playPreview ставит играющее чтение на паузу и не меняет токен', async () => {
  useAudioStore.getState().reset();
  const manager = new AudioManager();
  const { token } = manager.startPlayerRequest();
  manager.onPlayerStarted(token);

  assert.equal(useAudioStore.getState().status, 'playing');
  assert.equal(useAudioStore.getState().playToken, token);

  // Мокаем htmlAudioPlayer.playPreview
  let previewPlayed = false;
  const originalPlayPreview = htmlAudioPlayer.playPreview;
  htmlAudioPlayer.playPreview = async () => {
    previewPlayed = true;
  };

  try {
    const dummyBuffer = new ArrayBuffer(1024);
    await manager.playPreview(dummyBuffer, 0.8);

    assert.equal(previewPlayed, true);
    assert.equal(useAudioStore.getState().status, 'paused');
    assert.equal(useAudioStore.getState().playToken, token, 'Токен не должен меняться при паузе для пробы');
  } finally {
    htmlAudioPlayer.playPreview = originalPlayPreview;
  }
});

test('Оркестратор: stopPreview вызывает остановку канала превью в htmlAudioPlayer', () => {
  let stopPreviewCalled = false;
  const originalStopPreview = htmlAudioPlayer.stopPreview;
  htmlAudioPlayer.stopPreview = () => {
    stopPreviewCalled = true;
  };

  try {
    const manager = new AudioManager();
    manager.stopPreview();
    assert.equal(stopPreviewCalled, true);
  } finally {
    htmlAudioPlayer.stopPreview = originalStopPreview;
  }
});

import { PROVIDERS_MAP } from '../providers';

test('Настройки: checkVoice вызывает Поставщика один раз и Оркестратора один раз, возвращает bytes', async () => {
  useSettingsStore.setState({ activeProvider: 'edge-tts', volume: 0.9 });

  let synthesizeCalls = 0;
  let playPreviewCalls = 0;
  let playPreviewBytes = 0;

  const originalSynthesize = PROVIDERS_MAP['edge-tts'].synthesize;
  const originalPlayPreview = audioManager.playPreview;

  PROVIDERS_MAP['edge-tts'].synthesize = async () => {
    synthesizeCalls++;
    return new ArrayBuffer(2048);
  };

  audioManager.playPreview = async (buffer: ArrayBuffer) => {
    playPreviewCalls++;
    playPreviewBytes = buffer.byteLength;
  };

  try {
    const res = await checkVoice('Привет, мир!');
    assert.equal(synthesizeCalls, 1);
    assert.equal(playPreviewCalls, 1);
    assert.equal(playPreviewBytes, 2048);
    assert.deepEqual(res, { bytes: 2048 });
  } finally {
    PROVIDERS_MAP['edge-tts'].synthesize = originalSynthesize;
    audioManager.playPreview = originalPlayPreview;
  }
});

test('Настройки: ошибка синтеза в checkVoice доходит до вызывающего', async () => {
  useSettingsStore.setState({ activeProvider: 'edge-tts' });

  const originalSynthesize = PROVIDERS_MAP['edge-tts'].synthesize;
  PROVIDERS_MAP['edge-tts'].synthesize = async () => {
    throw new Error('API ключ недействителен');
  };

  try {
    await assert.rejects(
      () => checkVoice('Проверка ошибки'),
      /API ключ недействителен/
    );
  } finally {
    PROVIDERS_MAP['edge-tts'].synthesize = originalSynthesize;
  }
});

