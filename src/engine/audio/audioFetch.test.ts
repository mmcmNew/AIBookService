import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS_MAP } from '../providers';
import type { ITTSProvider, SynthesisOptions } from '../../types/tts';
import type { SentenceItem } from '../../types/book';
import { useSettingsStore } from '../../store/settingsStore';
import { applyPronunciationDictionary } from '../tokenizer/dictionaryReplacer';
import { buildCacheKey } from './cacheKey';
import {
  cancelPrepare,
  getOrFetchAudio,
  getOrFetchChapterAudio,
  getSpeechText,
  prepareAudio,
  synthesizeOnce,
} from './audioFetch';
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

    const taking = getOrFetchAudio({
      bookId: 'book-prepare',
      chapterId: 'ch1',
      sentence: s,
      providerType: 'openai',
      options,
    });
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

    const taking = getOrFetchAudio({
      bookId: 'book-cancel',
      chapterId: 'ch1',
      sentence: s,
      providerType: 'openai',
      options,
    });
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
    await assert.rejects(
      getOrFetchAudio({
        bookId: 'book-abort',
        chapterId: 'ch1',
        sentence: s,
        providerType: 'openai',
        options,
        signal: controller.signal,
      }),
      (e: { name?: string }) => e.name === 'AbortError'
    );
  } finally {
    restore();
  }
});

test('getSpeechText: применяет правила словаря произношения из настроек', () => {
  const originalRules = useSettingsStore.getState().replacementRules;
  try {
    useSettingsStore.setState({
      replacementRules: [
        { id: '1', pattern: 'тест', replacement: 'проверка', isRegex: false, enabled: true },
      ],
    });
    const s = sentence(101, 'Это тест произношения.');
    const result = getSpeechText('any-book', s);
    assert.equal(result, 'Это проверка произношения.');
  } finally {
    useSettingsStore.setState({ replacementRules: originalRules });
  }
});

test('смена правил словаря произношения меняет генерируемый ключ кэша', () => {
  const originalRules = useSettingsStore.getState().replacementRules;
  try {
    const s = sentence(102, 'Слово');
    useSettingsStore.setState({ replacementRules: [] });
    const text1 = getSpeechText('b1', s);
    const key1 = buildCacheKey('b1', 'c1', s.id, 'openai', options, text1);

    useSettingsStore.setState({
      replacementRules: [
        { id: '2', pattern: 'Слово', replacement: 'Замена', isRegex: false, enabled: true },
      ],
    });
    const text2 = getSpeechText('b1', s);
    const key2 = buildCacheKey('b1', 'c1', s.id, 'openai', options, text2);

    assert.notEqual(key1, key2, 'ключи кэша должны отличаться при разном тексте после словаря');
  } finally {
    useSettingsStore.setState({ replacementRules: originalRules });
  }
});

test('getOrFetchChapterAudio: озвучивает заголовок главы с sentenceId = -1', async () => {
  const { fake, restore } = installFakeProvider();
  try {
    const taking = getOrFetchChapterAudio({
      bookId: 'book-ch',
      chapterId: 'ch1',
      title: 'Глава 1',
      providerType: 'openai',
      options,
    });
    await tick();
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].text, 'Глава 1');
    fake.calls[0].resolve();
    const buffer = await taking;
    assert.equal(buffer.byteLength, 8);
  } finally {
    restore();
  }
});

test('дефект B4: подготовка фразы N+1 не отменяется при вызове cancelPrepare с той же фразой (startPlayback)', async () => {
  const { fake, restore } = installFakeProvider();
  try {
    const s2 = sentence(202, 'Вторая фраза.');
    prepareAudio('b1', 'c1', s2, 'openai', options);
    await tick();
    assert.equal(fake.calls.length, 1, 'подготовка фразы N+1 запущена');
    assert.equal(fake.calls[0].signal?.aborted, false);

    // Имитируем startPlayback следующей фразы
    cancelPrepare({ bookId: 'b1', chapterId: 'c1', sentence: s2, providerType: 'openai', options });
    assert.equal(fake.calls[0].signal?.aborted, false, 'сигнал подготовки НЕ должен прерываться для той же фразы');

    // Оркестратор запрашивает ту же фразу
    const taking = getOrFetchAudio({ bookId: 'b1', chapterId: 'c1', sentence: s2, providerType: 'openai', options });
    assert.equal(fake.calls.length, 1, 'второго вызова synthesize нет: подключился к идущей подготовке');

    fake.calls[0].resolve();
    const buffer = await taking;
    assert.equal(buffer.byteLength, 8);
  } finally {
    restore();
  }
});

test('cancelPrepare: подготовка ДРУГОЙ фразы отменяется даже при передаче keep', async () => {
  const { fake, restore } = installFakeProvider();
  try {
    const s1 = sentence(301, 'Первая фраза.');
    const s2 = sentence(302, 'Вторая фраза.');
    prepareAudio('b1', 'c1', s1, 'openai', options);
    await tick();
    assert.equal(fake.calls.length, 1);

    // Передаём keep для s2, хотя готовилась s1
    cancelPrepare({ bookId: 'b1', chapterId: 'c1', sentence: s2, providerType: 'openai', options });
    assert.equal(fake.calls[0].signal?.aborted, true, 'подготовка чужой фразы s1 должна быть отменена');
  } finally {
    restore();
  }
});

test('cancelPrepare: подготовка с ДРУГИМИ параметрами синтеза отменяется', async () => {
  const { fake, restore } = installFakeProvider();
  try {
    const s = sentence(401, 'Фраза.');
    prepareAudio('b1', 'c1', s, 'openai', options);
    await tick();
    assert.equal(fake.calls.length, 1);

    const changedOptions: SynthesisOptions = { ...options, voiceId: 'echo' };
    cancelPrepare({ bookId: 'b1', chapterId: 'c1', sentence: s, providerType: 'openai', options: changedOptions });
    assert.equal(fake.calls[0].signal?.aborted, true, 'подготовка с другими опциями должна быть отменена');
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
