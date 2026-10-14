import test from 'node:test';
import assert from 'node:assert/strict';
import { useAudioStore } from '../../store/audioStore';
import { AudioManager } from './audioManager';

/** Оркестратор с журналом событий Координатору: «хочу играть» и «остановлен» */
function setup() {
  useAudioStore.getState().reset();
  const manager = new AudioManager();
  const events: string[] = [];
  manager.setHandlers({
    onStarted: () => events.push('started'),
    onEnded: () => events.push('ended'),
    onFailed: () => events.push('failed'),
    onWantPlay: () => events.push('wantPlay'),
    onStopped: () => events.push('stopped'),
  });
  const status = () => useAudioStore.getState().status;
  const toPlaying = () => {
    const { token } = manager.startPlayerRequest();
    manager.onPlayerStarted(token);
  };
  return { manager, events, status, toPlaying };
}

test('Оркестратор: play на тишине — «хочу играть» Координатору, статус сам не меняет', () => {
  const { manager, events, status } = setup();
  manager.toggle();
  assert.deepEqual(events, ['wantPlay']);
  assert.equal(status(), 'idle');
});

test('Оркестратор: play после ошибки — тоже «хочу играть»', () => {
  const { manager, events, status } = setup();
  const { token } = manager.startPlayerRequest();
  manager.onPlayerFailed(token, 'сломалось');
  assert.equal(status(), 'error');
  manager.toggle();
  assert.deepEqual(events, ['wantPlay']);
});

test('Оркестратор: играет — просто пауза, Координатор не уведомляется', () => {
  const { manager, events, status, toPlaying } = setup();
  toPlaying();
  assert.equal(status(), 'playing');
  manager.toggle();
  assert.equal(status(), 'paused');
  assert.deepEqual(events, []);
});

test('Оркестратор: на паузе — продолжает без уведомлений', () => {
  const { manager, events, status, toPlaying } = setup();
  toPlaying();
  manager.toggle();
  manager.toggle();
  assert.equal(status(), 'playing');
  assert.deepEqual(events, []);
});

test('Оркестратор: пауза во время загрузки — остановка и событие «остановлен»', () => {
  const { manager, events, status } = setup();
  manager.startPlayerRequest();
  assert.equal(status(), 'loading');
  manager.toggle();
  assert.equal(status(), 'idle');
  assert.deepEqual(events, ['stopped']);
});

test('Оркестратор: стоп останавливает, снимает ожидание страницы и шлёт «остановлен»', () => {
  const { manager, events, status, toPlaying } = setup();
  toPlaying();
  manager.setWaitingPage(7);
  manager.requestStop();
  assert.equal(status(), 'idle');
  assert.equal(useAudioStore.getState().waitingPage, null);
  assert.equal(useAudioStore.getState().notice, null);
  assert.deepEqual(events, ['stopped']);
});

test('Оркестратор: остановка Координатором (конец книги) события «остановлен» не шлёт', () => {
  const { manager, events, status, toPlaying } = setup();
  toPlaying();
  manager.stopPlayer('Конец книги');
  assert.equal(status(), 'idle');
  assert.equal(useAudioStore.getState().notice, 'Конец книги');
  assert.deepEqual(events, []);
});
