import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHeading, detectChapters, assessTextQuality } from '../index';

const body = (n: number, tag = '') =>
  Array.from(
    { length: n },
    (_, i) => `Это длинный абзац основного текста номер ${i} ${tag}, достаточно подробный, чтобы набрать нужное количество символов в главе. Он содержит запятые и точку.`
  );

test('classifyHeading: ключевые слова, markdown, римские цифры, ЗАГЛАВНЫЕ', () => {
  const yes = ['Глава 1', 'ГЛАВА 12. Начало пути', 'Часть вторая', 'Chapter 3', 'Предисловие', 'Введение', 'Заключение', '## Тревога', '**Тревожные расстройства**', 'XII', 'ОБ АВТОРЕ', '2.1 Методы лечения', '# Название'];
  for (const t of yes) assert.ok(classifyHeading({ text: t }), t);
  const no = ['12', 'Обычный абзац текста, который заканчивается точкой.', 'В главе 3 мы говорили о другом.', 'я', 'Он сказал: «Глава закрыта».', '###### УДК 616.891.6'.repeat(1) + ' и ещё много слов подряд, чтобы не быть заголовком, да.'];
  for (const t of no) assert.equal(classifyHeading({ text: t }), null, t);
});

test('classifyHeading: размер шрифта и новая страница', () => {
  assert.ok(classifyHeading({ text: 'Тревога и страх', heightRatio: 1.6 }));
  assert.equal(classifyHeading({ text: 'Тревога и страх', heightRatio: 1.0 }), null);
  assert.equal(classifyHeading({ text: 'Тревога и страх', newPage: true }), null);
  assert.ok(classifyHeading({ text: 'Тревога и страх', heightRatio: 1.15, newPage: true }));
});

test('detectChapters: «Глава N» в Markdown-тексте одной главой', () => {
  const paras = ['Название книги', ...body(5), '## Глава 1', ...body(8, 'a'), '## Глава 2', ...body(8, 'b'), '**Глава 3. Финал**', ...body(8, 'c')];
  const r = detectChapters(paras);
  assert.equal(r.method, 'headings');
  assert.deepEqual(r.chapters.map((c) => c.title), ['Начало', 'Глава 1', 'Глава 2', 'Глава 3. Финал']);
  // заголовок не попадает в тело
  assert.ok(!r.chapters[1].items.includes(6));
});

test('detectChapters: «ГЛАВА 1» + название на следующей строке', () => {
  const paras = [...body(8), 'ГЛАВА 1', 'НАЧАЛО ПУТИ', ...body(8, 'a'), 'ГЛАВА 2', 'ПРОДОЛЖЕНИЕ', ...body(8, 'b')];
  const r = detectChapters(paras);
  assert.equal(r.chapters.length, 3);
  assert.equal(r.chapters[1].title, 'ГЛАВА 1. НАЧАЛО ПУТИ');
  assert.equal(r.chapters[1].items.length, 8);
});

test('detectChapters: колонтитулы ЗАГЛАВНЫМИ повторяются и не считаются главами', () => {
  const paras: string[] = [];
  for (let i = 0; i < 12; i++) paras.push('ТРЕВОГА И СТРАХ', ...body(3, String(i)));
  const r = detectChapters(paras, { fallbackBySize: false });
  assert.equal(r.method, 'none');
});

test('detectChapters: номера страниц игнорируются, короткие главы склеиваются', () => {
  const paras = ['Глава 1', ...body(8), '12', 'Глава 2', 'Всего одна короткая строка.', 'Глава 3', ...body(8, 'c')];
  const r = detectChapters(paras);
  assert.equal(r.chapters.length, 2, r.chapters.map((c) => c.title).join('|'));
  const all = r.chapters.flatMap((c) => c.items);
  assert.ok(all.includes(paras.indexOf('Глава 2')), 'заголовок короткой главы сохранён как абзац');
});

test('detectChapters: оглавление PDF по номерам страниц', () => {
  const paras = [
    ...body(6).map((text) => ({ text, page: 1 })),
    ...body(6, 'x').map((text) => ({ text, page: 5 })),
    ...body(6, 'y').map((text) => ({ text, page: 9 })),
  ];
  const r = detectChapters(paras, {
    outline: [
      { title: 'Тревожные расстройства', page: 1, level: 1 },
      { title: 'Лечение', page: 5, level: 1 },
      { title: 'Итоги', page: 9, level: 1 },
    ],
  });
  assert.equal(r.method, 'outline');
  assert.deepEqual(r.chapters.map((c) => c.title), ['Тревожные расстройства', 'Лечение', 'Итоги']);
  assert.equal(r.chapters[1].items[0], 6);
});

test('detectChapters: оглавление по тексту заголовка (без страниц)', () => {
  const paras = [...body(6), 'Лечение', ...body(6, 'x'), 'Итоги', ...body(6, 'y')];
  const r = detectChapters(paras, { outline: [{ title: 'Лечение' }, { title: 'Итоги' }] });
  assert.equal(r.method, 'outline');
  assert.equal(r.chapters.length, 3);
  assert.equal(r.chapters[1].title, 'Лечение');
});

test('detectChapters: нет заголовков — разбиение по размеру на «Часть N»', () => {
  const paras = body(600);
  const r = detectChapters(paras, { fallbackChunkChars: 20000 });
  assert.equal(r.method, 'size');
  assert.ok(r.chapters.length >= 3);
  assert.equal(r.chapters[0].title, 'Часть 1');
  assert.equal(r.chapters.flatMap((c) => c.items).length, 600);
  const small = detectChapters(body(10));
  assert.equal(small.method, 'none');
  assert.equal(small.chapters.length, 1);
});

test('detectChapters: оглавление книги (много подряд заголовков) не создаёт главы', () => {
  const toc = Array.from({ length: 8 }, (_, i) => `Глава ${i + 1}`);
  const paras = ['Содержание', ...toc, ...body(8), 'Глава 1', ...body(8, 'a'), 'Глава 2', ...body(8, 'b')];
  const r = detectChapters(paras);
  assert.deepEqual(r.chapters.map((c) => c.title).slice(-2), ['Глава 1', 'Глава 2']);
  assert.ok(!r.chapters.some((c) => c.title === 'Глава 5'));
});

test('качество: одна глава на всю книгу — проблема SINGLE_CHAPTER', () => {
  const r = assessTextQuality([{ id: 'a', title: 'Начало', paragraphs: body(500) }], 'ru');
  assert.ok(r.issues.some((i) => i.code === 'SINGLE_CHAPTER'));
  assert.ok(r.recommendation && /глав/i.test(r.recommendation));
  const ok = assessTextQuality(Array.from({ length: 5 }, (_, i) => ({ id: String(i), title: 'Г' + i, paragraphs: body(100) })), 'ru');
  assert.ok(!ok.issues.some((i) => i.code === 'SINGLE_CHAPTER'));
});

test('сохранённая книга с одной главой: главы находятся без повторного OCR', async () => {
  const { chaptersToDraft, draftToChapters, detectDraftChapters, applyDraftDetection } = await import('../index');
  const paras = [...body(8), '## Глава 1', ...body(8, 'a'), 'Глава 2', ...body(8, 'b'), 'ЗАКЛЮЧЕНИЕ', ...body(8, 'c')];
  const sentences = paras.map((t, i) => ({ id: i, rawText: t, speechText: t, paragraphIndex: i }));
  const book = [{ id: 'one', title: 'Начало', level: 1, contentHtml: '', sentences }];
  const draft = chaptersToDraft(book);
  const det = detectDraftChapters(draft);
  assert.deepEqual(det.result.chapters.map((c) => c.title), ['Начало', 'Глава 1', 'Глава 2', 'ЗАКЛЮЧЕНИЕ']);
  const next = applyDraftDetection(draft, det);
  assert.equal(next.length, 4);
  const rebuilt = draftToChapters(next);
  assert.equal(rebuilt.chapters.length, 4);
  // предложения неизменённых абзацев сохранили id (аудиокэш)
  assert.ok(rebuilt.chapters[1].sentences.every((s) => s.id < sentences.length));
  const total = rebuilt.chapters.reduce((a, c) => a + c.sentences.length, 0);
  assert.equal(total, sentences.length - 3, 'три заголовка стали названиями глав');
  // режим «только выбранная глава»
  const only = detectDraftChapters(next, { chapterIndex: 0 });
  assert.equal(only.range[1] - only.range[0], 1);
});
