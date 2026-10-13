// Запуск: npx tsx --test src/engine/audio/playerState.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_PLAYER_STATE as S0,
  PlayerEvent,
  PlayerState,
  acceptEnded,
  isPausedStatus,
  isPlayingStatus,
  nextPosition,
  reducePlayer,
  shouldAnnounceChapter,
} from './playerState';

const run = (events: PlayerEvent[], from: PlayerState = S0) => events.reduce(reducePlayer, from);

test('idle -> loading -> playing -> paused -> playing -> idle', () => {
  let s = reducePlayer(S0, { type: 'request' });
  assert.equal(s.status, 'loading');
  assert.equal(s.token, 1);
  s = reducePlayer(s, { type: 'started', token: 1 });
  assert.equal(s.status, 'playing');
  s = reducePlayer(s, { type: 'pause' });
  assert.equal(s.status, 'paused');
  s = reducePlayer(s, { type: 'resume' });
  assert.equal(s.status, 'playing');
  s = reducePlayer(s, { type: 'stop' });
  assert.equal(s.status, 'idle');
});

test('производные флаги: isPlaying = loading|playing, isPaused = paused', () => {
  assert.deepEqual(['idle', 'loading', 'playing', 'paused', 'error'].map((x) => isPlayingStatus(x as never)), [false, true, true, false, false]);
  assert.deepEqual(['idle', 'loading', 'playing', 'paused', 'error'].map((x) => isPausedStatus(x as never)), [false, false, false, true, false]);
});

test('устаревшее started (после новой команды) игнорируется', () => {
  let s = reducePlayer(S0, { type: 'request' }); // token 1
  s = reducePlayer(s, { type: 'request' }); // token 2 (быстрый клик «следующая»)
  const after = reducePlayer(s, { type: 'started', token: 1 });
  assert.equal(after, s);
  assert.equal(reducePlayer(s, { type: 'started', token: 2 }).status, 'playing');
});

test('started после stop игнорируется (stop во время загрузки)', () => {
  const s = run([{ type: 'request' }, { type: 'stop' }]);
  assert.equal(s.status, 'idle');
  assert.equal(reducePlayer(s, { type: 'started', token: 1 }), s);
});

test('пауза во время загрузки = остановка и обесценивание токена', () => {
  const loading = reducePlayer(S0, { type: 'request' });
  const s = reducePlayer(loading, { type: 'pause' });
  assert.equal(s.status, 'idle');
  assert.ok(s.token > loading.token);
  assert.equal(reducePlayer(s, { type: 'started', token: loading.token }).status, 'idle');
});

test('pause/resume из «неправильных» статусов ничего не меняют', () => {
  assert.equal(reducePlayer(S0, { type: 'pause' }), S0);
  assert.equal(reducePlayer(S0, { type: 'resume' }), S0);
  const playing = run([{ type: 'request' }, { type: 'started', token: 1 }]);
  assert.equal(reducePlayer(playing, { type: 'resume' }), playing);
});

test('ошибка синтеза: loading -> error, сообщение сохраняется, повторный запуск очищает', () => {
  let s = reducePlayer(S0, { type: 'request' });
  s = reducePlayer(s, { type: 'failed', token: 1, message: 'Нет ключа' });
  assert.equal(s.status, 'error');
  assert.equal(s.error, 'Нет ключа');
  s = reducePlayer(s, { type: 'request' });
  assert.equal(s.status, 'loading');
  assert.equal(s.error, null);
});

test('устаревшая ошибка (от отменённого запроса) не портит состояние', () => {
  let s = run([{ type: 'request' }, { type: 'request' }]); // token 2
  s = reducePlayer(s, { type: 'failed', token: 1, message: 'boom' });
  assert.equal(s.status, 'loading');
  assert.equal(s.error, null);
});

test('ошибка в idle/paused игнорируется', () => {
  assert.equal(reducePlayer(S0, { type: 'failed', token: 0, message: 'x' }), S0);
  const paused = run([{ type: 'request' }, { type: 'started', token: 1 }, { type: 'pause' }]);
  assert.equal(reducePlayer(paused, { type: 'failed', token: 1, message: 'x' }), paused);
});

test('acceptEnded: только playing и свой токен (onend WebSpeech после cancel отсекается)', () => {
  const playing = run([{ type: 'request' }, { type: 'started', token: 1 }]);
  assert.equal(acceptEnded(playing, 1), true);
  assert.equal(acceptEnded(playing, 0), false);
  const paused = reducePlayer(playing, { type: 'pause' });
  assert.equal(acceptEnded(paused, 1), false);
  const stopped = reducePlayer(playing, { type: 'stop' });
  assert.equal(acceptEnded(stopped, 1), false); // событие от остановленной реплики
  const loading = reducePlayer(playing, { type: 'request' });
  assert.equal(acceptEnded(loading, 1), false); // уже идёт загрузка следующей
});

test('stop идемпотентен по статусу и всегда меняет токен', () => {
  const a = reducePlayer(S0, { type: 'stop' });
  assert.equal(a.status, 'idle');
  assert.ok(a.token > S0.token);
});

/* ------------------------ Объявление главы ------------------------ */

const base = { enabled: true, title: 'Глава 1', sentenceIndex: 0 } as const;

test('объявляем: старт с начала главы и переход на главу', () => {
  assert.equal(shouldAnnounceChapter({ ...base, trigger: 'start' }), true);
  assert.equal(shouldAnnounceChapter({ ...base, trigger: 'chapter' }), true);
});

test('не объявляем: выключено, нет названия, середина главы, навигация', () => {
  assert.equal(shouldAnnounceChapter({ ...base, enabled: false, trigger: 'start' }), false);
  assert.equal(shouldAnnounceChapter({ ...base, title: '', trigger: 'start' }), false);
  assert.equal(shouldAnnounceChapter({ ...base, title: '   ', trigger: 'start' }), false);
  assert.equal(shouldAnnounceChapter({ ...base, title: undefined, trigger: 'start' }), false);
  assert.equal(shouldAnnounceChapter({ ...base, sentenceIndex: 5, trigger: 'start' }), false);
  assert.equal(shouldAnnounceChapter({ ...base, trigger: 'navigate' }), false);
});

test('«Глава N» тоже объявляется', () => {
  assert.equal(shouldAnnounceChapter({ ...base, title: 'Глава 7', trigger: 'chapter' }), true);
});

/* ------------------------ Переход между главами ------------------------ */

test('nextPosition: следующее предложение в главе', () => {
  assert.deepEqual(nextPosition([3, 2], 0, 0, true), { kind: 'sentence', sentenceIndex: 1 });
});

test('nextPosition: конец главы -> следующая глава (авто-переход вкл)', () => {
  assert.deepEqual(nextPosition([3, 2], 0, 2, true), { kind: 'chapter', chapterIndex: 1 });
});

test('nextPosition: пустые главы пропускаются', () => {
  assert.deepEqual(nextPosition([3, 0, 0, 4], 0, 2, true), { kind: 'chapter', chapterIndex: 3 });
});

test('nextPosition: конец книги', () => {
  assert.deepEqual(nextPosition([3, 2], 1, 1, true), { kind: 'end-of-book' });
  assert.deepEqual(nextPosition([3, 0], 0, 2, true), { kind: 'end-of-book' });
});

test('nextPosition: авто-переход выкл — остановка в конце главы, но в конце книги — «конец книги»', () => {
  assert.deepEqual(nextPosition([3, 2], 0, 2, false), { kind: 'end-of-chapter' });
  assert.deepEqual(nextPosition([3, 2], 1, 1, false), { kind: 'end-of-book' });
  assert.deepEqual(nextPosition([3, 2], 0, 0, false), { kind: 'sentence', sentenceIndex: 1 });
});
