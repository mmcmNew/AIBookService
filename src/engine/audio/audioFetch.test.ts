import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS_MAP } from '../providers';
import type { ITTSProvider, SynthesisOptions } from '../../types/tts';
import type { SentenceItem } from '../../types/book';
import { useSettingsStore } from '../../store/settingsStore';
import { applyPronunciationDictionary } from '../tokenizer/dictionaryReplacer';
import { buildCacheKey, cancelPrepare, getOrFetchAudio, prepareAudio, synthesizeOnce } from './audioFetch';
import { AudioManager, type AudioEngineHandlers } from './audioManager';

/** Поддельный провайдер: считает вызовы, ждёт ручного «готово», уважает signal */
function installFakeProvider() {
  const fake = {
    calls: [] as { text: string; signal?: AbortSignal; resolve: () => void; reject: (e: Error) => void }[],
  };
  const provider = {
    id: 'openai',
    name: 'fake',
    synthesize: (text: string, options: SynthesisOptions) =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        const entry = { text, signal: options.signal, resolve: () => resolve(new ArrayBuffer(8)), reject };
        fake.calls.push(entry);
        options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
  };
  const original = PROVIDERS_MAP.openai;
  const warn = console.warn;
  console.warn = () => {}; // в Node нет IndexedDB: чтение кэша честно сообщает об этом, тесту это не важно
  PROVIDERS_MAP.openai = provider as unknown as ITTSProvider;
  return {
    fake,
    restore: () => {
      PROVIDERS_MAP.openai = original;
      console.warn = warn;
    },
  };
}

const sentence = (id: number, rawText: string): SentenceItem => ({ id, rawText } as SentenceItem);
const options: SynthesisOptions = { voiceId: 'alloy', speed: 1, pitch: 0, volume: 1, apiKey: 'test' };
const textOf = (s: SentenceItem, bookId: string) =>
  applyPronunciationDictionary(s.rawText, useSettingsStore.getState().replacementRules, bookId);
const tick = () => new Promise((r) => setTimeout(r, 0));

test('«приготовь»: подготовленное аудио берётся запросом «возьми аудио» без второго синтеза (ключ кэша совпадает)', async () => {
  const { fake, restore } = installFakeProvider();
  try {
    const s = sentence(11, 'Первая фраза.');
    prepareAudio('book-prepare', 'ch1', s, 'openai', options);
    await tick();
    assert.equal(fake.calls.length, 1, 'подготовка запросила синтез');

    const key = buildCacheKey('book-prepare', 'ch1', s.id, 'openai', options, textOf(s, 'book-prepare'));
    const taking = getOrFetchAudio(key, 'book-prepare', 'ch1', s.id, textOf(s, 'book-prepare'), 'openai', options);
    fake.calls[0].resolve();
    const buffer = await taking;
    assert.equal(buffer.byteLength, 8);
    assert.equal(fake.calls.length, 1, 'второго синтеза нет: запрос ждал подготовку');
  } finally {
    restore();
  }
});

test('«отмени»: подготовка прерывается сигналом, а запрос «возьми аудио» после неё синтезирует сам', async () => {
  const { fake, restore } = installFakeProvider();
  try {
    const s = sentence(21, 'Вторая фраза.');
    prepareAudio('book-cancel', 'ch1', s, 'openai', options);
    await tick();
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].signal?.aborted, false);

    cancelPrepare();
    assert.equal(fake.calls[0].signal?.aborted, true, 'подготовка отменена');
    await tick();

    const key = buildCacheKey('book-cancel', 'ch1', s.id, 'openai', options, textOf(s, 'book-cancel'));
    const taking = getOrFetchAudio(key, 'book-cancel', 'ch1', s.id, textOf(s, 'book-cancel'), 'openai', options);
    await tick();
    assert.equal(fake.calls.length, 2, 'после отмены аудио синтезируется заново');
    fake.calls[1].resolve();
    assert.equal((await taking).byteLength, 8);
  } finally {
    restore();
  }
});

test('«приготовь» новой фразы отменяет предыдущую подготовку', async () => {
  const { fake, restore } = installFakeProvider();
  try {
    prepareAudio('book-replace', 'ch1', sentence(31, 'Раз.'), 'openai', options);
    await tick();
    prepareAudio('book-replace', 'ch1', sentence(32, 'Два.'), 'openai', options);
    await tick();
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[0].signal?.aborted, true);
    assert.equal(fake.calls[1].signal?.aborted, false);
    cancelPrepare();
  } finally {
    restore();
  }
});

test('«приготовь» для системной озвучки (webspeech) ничего не делает', async () => {
  const { fake, restore } = installFakeProvider();
  try {
    prepareAudio('book-speech', 'ch1', sentence(41, 'Фраза.'), 'webspeech', options);
    await tick();
    assert.equal(fake.calls.length, 0);
  } finally {
    restore();
  }
});

test('«возьми аудио» с отменённым сигналом: AbortError (отмена), а не обычная ошибка', async () => {
  const { restore } = installFakeProvider();
  try {
    const controller = new AbortController();
    controller.abort();
    const s = sentence(51, 'Отменённая.');
    const text = textOf(s, 'book-abort');
    const key = buildCacheKey('book-abort', 'ch1', s.id, 'openai', options, text);
    await assert.rejects(
      getOrFetchAudio(key, 'book-abort', 'ch1', s.id, text, 'openai', options, controller.signal),
      (e: { name?: string }) => e.name === 'AbortError'
    );
  } finally {
    restore();
  }
});

test('«проверить озвучку» (synthesizeOnce): разовый синтез мимо кэша и очереди, ошибка уходит вызывающему', async () => {
  const { fake, restore } = installFakeProvider();
  try {
    const first = synthesizeOnce('openai', 'Проверка.', options);
    fake.calls[0].resolve();
    assert.equal((await first).byteLength, 8);
    const second = synthesizeOnce('openai', 'Проверка.', options);
    fake.calls[1].resolve();
    await second;
    assert.equal(fake.calls.length, 2, 'повторная проверка снова идёт к провайдеру: кэша нет');
    const failing = synthesizeOnce('openai', 'Проверка.', options);
    fake.calls[2].reject(new Error('Неверный ключ'));
    await assert.rejects(failing, /Неверный ключ/);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Оркестратор: отмена Координатора — тихий выход, ошибка синтеза — событие «не получилось»
// ---------------------------------------------------------------------------

function speakJob(bookId: string, id: number, token: number) {
  return {
    token,
    bookId,
    chapterId: 'ch1',
    sentence: sentence(id, 'Играй это.'),
    providerType: 'openai' as const,
    options,
  };
}

function makeManager() {
  const events: string[] = [];
  const manager = new AudioManager();
  const handlers: AudioEngineHandlers = {
    onStarted: (t) => events.push(`started:${t}`),
    onEnded: (t) => events.push(`ended:${t}`),
    onFailed: (t, m) => events.push(`failed:${t}:${m}`),
  };
  manager.setHandlers(handlers);
  return { manager, events };
}

test('Оркестратор: отмена Координатора (stop) во время ожидания аудио не даёт события «не получилось»', async () => {
  const { fake, restore } = installFakeProvider();
  try {
    const { manager, events } = makeManager();
    manager.speak(speakJob('book-orch-stop', 61, 1));
    await tick();
    assert.equal(fake.calls.length, 1, 'Оркестратор сам запросил аудио');
    manager.stop();
    await tick();
    await tick();
    assert.deepEqual(events, []);
  } finally {
    restore();
  }
});

test('Оркестратор: новая команда «играй это» молча отменяет прежнюю', async () => {
  const { fake, restore } = installFakeProvider();
  try {
    const { manager, events } = makeManager();
    manager.speak(speakJob('book-orch-replace', 71, 1));
    await tick();
    manager.speak(speakJob('book-orch-replace', 72, 2));
    await tick();
    assert.equal(fake.calls[0].signal?.aborted, true);
    assert.deepEqual(events, []);
    manager.stop();
  } finally {
    restore();
  }
});

test('Оркестратор: ошибка синтеза — ровно одно событие «не получилось»', async () => {
  const { fake, restore } = installFakeProvider();
  try {
    const { manager, events } = makeManager();
    manager.speak(speakJob('book-orch-fail', 81, 5));
    await tick();
    fake.calls[0].reject(new Error('Провайдер недоступен'));
    await tick();
    await tick();
    assert.deepEqual(events, ['failed:5:Провайдер недоступен']);
  } finally {
    restore();
  }
});
