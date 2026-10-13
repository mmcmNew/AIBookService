import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripMarkdown,
  detectShiftedCyrillic,
  repairShiftedCyrillic,
  fixHyphenation,
  joinLines,
  normalizeWhitespace,
  removeControlChars,
  normalizeTypography,
  fixMixedScript,
  isPageNumber,
  findRepeatedHeaders,
  isRepeatedHeader,
  shouldMergeParagraphs,
  mergeTwoParagraphs,
  assessTextQuality,
  planCleanup,
  applyCleanupPlan,
  cleanChapters,
  paragraphProblems,
  DEFAULT_CLEANUP_OPS,
} from '../index';

const NBSP = String.fromCharCode(0xa0);
const FFFD = String.fromCharCode(0xfffd);
const SHY = String.fromCharCode(0xad);

// ---------------------------------------------------------------- Markdown
test('stripMarkdown: жирный, курсив, заголовки из реального PDF', () => {
  assert.equal(stripMarkdown('**ДЭВИДА. КЛАРК,** _д-р философии_'), 'ДЭВИДА. КЛАРК, д-р философии');
  assert.equal(stripMarkdown('###### УДК 616.891.6'), 'УДК 616.891.6');
  assert.equal(stripMarkdown('## Глава 1 ##'), 'Глава 1');
  assert.equal(stripMarkdown('Это __важно__ и *очень* и ***совсем***.'), 'Это важно и очень и совсем.');
});

test('stripMarkdown: код, ссылки, списки, цитаты', () => {
  assert.equal(stripMarkdown('Вызови `foo()` сейчас'), 'Вызови foo() сейчас');
  assert.equal(stripMarkdown('См. [сайт](http://example.com) и ![рис](a.png) тут'), 'См. сайт и  тут');
  assert.equal(stripMarkdown('* пункт один\n+ пункт два'), 'пункт один\nпункт два');
  assert.equal(stripMarkdown('> цитата'), 'цитата');
  assert.equal(stripMarkdown('---'), '');
});

test('stripMarkdown не ломает обычный текст', () => {
  const plain = [
    'Файл snake_case_name и my_var_2 остаются',
    'Формула 2*3*4 = 24 и a * b * c',
    'Диалог: - Привет, - сказал он.',
    'Цена 5 * 3 = 15',
    'Подчёркивание_внутри_слова и *одинокая звёздочка',
    '— Реплика с тире',
    '>:>9AB2> не цитата',
  ];
  for (const p of plain) assert.equal(stripMarkdown(p), p, p);
});

test('stripMarkdown: _U_ -> U, маркеры в начале и конце', () => {
  assert.equal(stripMarkdown('_U_'), 'U');
  assert.equal(stripMarkdown('**"@52>30**'), '"@52>30');
});

// ------------------------------------------------------- Сдвинутая кириллица
test('repairShiftedCyrillic: примеры из реального PDF', () => {
  assert.equal(repairShiftedCyrillic('"@52>30').text, 'Тревога');
  assert.equal(repairShiftedCyrillic('>:>9AB2>').text, 'окойство');
  assert.equal(detectShiftedCyrillic('"@52>30').isShifted, true);
});

test('repairShiftedCyrillic: фраза целиком, пунктуация и короткие слова', () => {
  const shifted = '"@52>30 8 AB@5A A 8<5=5< AB@0E0.';
  // Т р е в о г а  и  с т р е с с ... проверяем только ключевые слова
  const r = repairShiftedCyrillic(shifted);
  assert.ok(r.isShifted);
  assert.match(r.text, /^Тревога /);
  assert.ok(r.text.endsWith('страха.'), r.text);
  assert.ok(r.text.includes(' с '), r.text); // 'A' -> «с»
});

test('repairShiftedCyrillic: нормальный текст не трогается', () => {
  const normal = [
    'Hello, world! This is a normal English sentence.',
    'Обычный русский текст без проблем.',
    'Meeting at 10:30, room A4, see http://example.com/page?id=5',
    'OK',
    'NATO and USA: 1999-2005',
    'ID: 4521; KOD=7?',
    '12.05.2020',
    '(c) 2020 <b>tag</b>',
    '100%',
    'a=b+c',
    '1, 2, 3...',
    '>>> print(1)',
  ];
  for (const t of normal) {
    const r = repairShiftedCyrillic(t);
    assert.equal(r.text, t, `изменён: ${t} -> ${r.text}`);
    assert.equal(r.changed, false);
  }
});

test('repairShiftedCyrillic: смешанный абзац — только сдвинутые слова', () => {
  const mixed = 'Раздел: "@52>30 и нормальный текст по-русски.';
  const r = repairShiftedCyrillic(mixed);
  assert.equal(r.text, 'Раздел: Тревога и нормальный текст по-русски.');
});

test('repairShiftedCyrillic: слова с дефисом и вопросительным знаком', () => {
  const r = repairShiftedCyrillic('B>-B> >:>9AB2> 2>?@>A?');
  assert.ok(r.isShifted);
  assert.ok(r.text.startsWith('то-то'), r.text);
});

test('repairShiftedCyrillic: режим предпросмотра не меняет вход', () => {
  const input = '"@52>30';
  const r = repairShiftedCyrillic(input);
  assert.equal(input, '"@52>30');
  assert.equal(r.changed, true);
  assert.ok(r.samples.length > 0 && r.samples[0].from === '"@52>30' && r.samples[0].to === 'Тревога');
});

// -------------------------------------------------------------- Текстовые операции
test('removeControlChars: U+FFFD, управляющие, мягкие переносы', () => {
  assert.equal(removeControlChars(`сло${FFFD}во\u0001\u0007 ещё${SHY}раз\n\tок`), 'слово ещёраз\n\tок');
});

test('normalizeWhitespace: nbsp, повторы, пробелы перед знаками', () => {
  assert.equal(normalizeWhitespace(`Привет${NBSP}${NBSP}мир  ,  как дела ?`), 'Привет мир, как дела?');
  assert.equal(normalizeWhitespace('  строка  \n   вторая  '), 'строка\nвторая');
  assert.equal(normalizeWhitespace('Слово ... и — тире'), 'Слово ... и — тире');
});

test('fixHyphenation: переносы строк и пробелов', () => {
  assert.equal(fixHyphenation('пред-\nложение'), 'предложение');
  assert.equal(fixHyphenation('пред- ложение разорвано'), 'предложение разорвано');
  assert.equal(fixHyphenation('Санкт-\nПетербург'), 'Санкт-Петербург');
  assert.equal(fixHyphenation('кто-то и что-нибудь'), 'кто-то и что-нибудь');
  assert.equal(fixHyphenation(`пере${SHY}нос`), 'перенос');
});

test('joinLines: склейка строк с переносом', () => {
  assert.equal(joinLines('Это длинное пред-\nложение, разбитое\nна строки.'), 'Это длинное предложение, разбитое на строки.');
});

test('normalizeTypography: кавычки и тире', () => {
  assert.equal(normalizeTypography('Он сказал "привет" и ушёл'), 'Он сказал «привет» и ушёл');
  assert.equal(normalizeTypography('“текст”'), '«текст»');
  assert.equal(normalizeTypography('- Привет, - сказал он.'), '— Привет, — сказал он.');
  assert.equal(normalizeTypography('кафе-бар и 5-10'), 'кафе-бар и 5-10');
});

test('fixMixedScript: латинские двойники в русских словах', () => {
  const lat = String.fromCharCode(0x61); // a
  assert.equal(fixMixedScript(`р${lat}зный`), 'разный');
  assert.equal(fixMixedScript('Привет hello'), 'Привет hello');
  assert.equal(fixMixedScript('сlass'), 'class'); // кириллическая «с» в латинском слове
});

test('isPageNumber', () => {
  for (const s of ['12', '— 12 —', '- 7 -', 'стр. 15', 'Page 3', '12 / 345', '5 из 300']) assert.ok(isPageNumber(s), s);
  for (const s of ['Глава 12', 'В 1999 году', '12 апреля', 'II', 'Это 12.']) assert.ok(!isPageNumber(s), s);
});

test('findRepeatedHeaders: повторяющиеся колонтитулы', () => {
  const chapter = ['Начало текста.', 'Тревога и страх 12', 'Много текста, который идёт далее.', 'Тревога и страх 13', 'Ещё немного.', 'Тревога и страх 14', 'И последний.', 'Тревога и страх 15'];
  const headers = findRepeatedHeaders([chapter]);
  assert.ok(isRepeatedHeader('Тревога и страх 99', headers));
  assert.ok(!isRepeatedHeader('Начало текста.', headers));
});

test('склейка разорванных абзацев', () => {
  const a = 'Это длинное предложение, которое оборвалось на границе страницы и не закончилось';
  assert.ok(shouldMergeParagraphs(a, 'продолжается здесь.'));
  assert.ok(!shouldMergeParagraphs(a + '.', 'продолжается здесь.'));
  assert.ok(!shouldMergeParagraphs(a, 'Новое предложение.'));
  assert.equal(mergeTwoParagraphs(a + ' пред-', 'ложением.'), a + ' предложением.');
});

// ------------------------------------------------------------------ Пайплайн
const dirty = [
  {
    id: 'c1',
    title: 'Глава 1',
    paragraphs: [
      '**"@52>30**',
      '###### УДК 616.891.6',
      'Тревога и страх 1',
      'Это длинное предложение, которое оборвалось на границе страницы и не закончилось',
      'продолжается на следующей странице.',
      '12',
      'Тревога и страх 2',
      `Обычный${NBSP}абзац  с пробелами${FFFD}.`,
      'Тревога и страх 3',
      'Тревога и страх 4',
    ],
  },
];

test('planCleanup/applyCleanupPlan: предпросмотр и применение', () => {
  const plan = planCleanup(dirty, DEFAULT_CLEANUP_OPS);
  assert.ok(plan.changes.length >= 6);
  const before = JSON.stringify(dirty);
  const result = applyCleanupPlan(dirty, plan);
  assert.equal(JSON.stringify(dirty), before, 'исходные данные не изменяются');
  const out = result[0].paragraphs;
  assert.equal(out[0], 'Тревога');
  assert.equal(out[1], 'УДК 616.891.6');
  assert.ok(out.includes('Это длинное предложение, которое оборвалось на границе страницы и не закончилось продолжается на следующей странице.'));
  assert.ok(!out.includes('12'));
  assert.ok(!out.some((p) => p.startsWith('Тревога и страх')));
  assert.ok(out.includes('Обычный абзац с пробелами.'));
});

test('applyCleanupPlan: выборочное применение', () => {
  const plan = planCleanup(dirty, DEFAULT_CLEANUP_OPS);
  const firstEdit = plan.changes.find((c) => c.kind === 'edit')!;
  const result = applyCleanupPlan(dirty, plan, new Set([firstEdit.id]));
  assert.equal(result[0].paragraphs.length, dirty[0].paragraphs.length);
  assert.equal(result[0].paragraphs[0], 'Тревога');
  assert.equal(result[0].paragraphs[1], '###### УДК 616.891.6');
});

test('cleanChapters ограничивается выбранными главами', () => {
  const two = [dirty[0], { id: 'c2', title: 'Глава 2', paragraphs: ['**жирный**'] }];
  const out = cleanChapters(two, ['markdown'], { chapterIndexes: [1] });
  assert.equal(out[1].paragraphs[0], 'жирный');
  assert.equal(out[0].paragraphs[0], dirty[0].paragraphs[0]);
});

test('paragraphProblems подсвечивает проблемные абзацы', () => {
  assert.ok(paragraphProblems('"@52>30').some((p) => p.code === 'shifted'));
  assert.ok(paragraphProblems('**жирный**').some((p) => p.code === 'markdown'));
  assert.deepEqual(paragraphProblems('Обычный текст.'), []);
});

// ------------------------------------------------------------ Оценка качества
const goodText = Array.from({ length: 30 }, (_, i) => `Это нормальный абзац номер ${i}, написанный по-русски, с запятыми и точкой в конце. Второе предложение тоже есть.`);

test('assessTextQuality: хороший текст', () => {
  const r = assessTextQuality([{ id: 'a', title: 'A', paragraphs: goodText }], 'ru');
  assert.ok(r.score >= 90, `score=${r.score}`);
  assert.equal(r.grade, 'good');
  assert.equal(r.issues.length, 0);
});

test('assessTextQuality: мусорный текст получает низкий балл и коды проблем', () => {
  const junk = [
    ...dirty[0].paragraphs,
    ...Array.from({ length: 20 }, () => '**"@52>30** ' + `текст${FFFD}${FFFD}`),
    ...Array.from({ length: 10 }, () => '>:>9AB2> A 8<5=5< AB@0E0.'),
  ];
  const r = assessTextQuality([{ id: 'a', title: 'A', paragraphs: junk }], 'ru', { isPdf: true, pdfMode: 'pdfjs' });
  assert.ok(r.score < 60, `score=${r.score}`);
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes('SHIFTED_CYRILLIC'), codes.join());
  assert.ok(codes.includes('REPLACEMENT_CHARS'), codes.join());
  assert.ok(codes.includes('MARKDOWN'), codes.join());
  assert.ok(r.recommendation && /Gemini/.test(r.recommendation));
  for (const i of r.issues) assert.ok(i.message.length > 0);
});

test('assessTextQuality: пустая книга и пустые главы', () => {
  assert.equal(assessTextQuality([], 'ru').score, 0);
  const r = assessTextQuality(
    [
      { id: '1', title: 'A', paragraphs: goodText },
      { id: '2', title: 'B', paragraphs: ['', '   '] },
      { id: '3', title: 'C', paragraphs: [] },
    ],
    'ru'
  );
  assert.ok(r.issues.some((i) => i.code === 'EMPTY_CHAPTERS'));
});

test('assessTextQuality: несоответствие языка и слова без гласных', () => {
  const english = Array.from({ length: 20 }, () => 'This is a perfectly normal English paragraph that should be long enough to analyse properly.');
  const r = assessTextQuality([{ id: 'e', title: 'E', paragraphs: english }], 'ru');
  assert.ok(r.issues.some((i) => i.code === 'LANG_MISMATCH'));

  const novowel = Array.from({ length: 20 }, () => 'ртвпкл мнгрд штрсщ кркмн втрпл блдрт хорошее слово тут');
  const r2 = assessTextQuality([{ id: 'n', title: 'N', paragraphs: novowel }], 'ru');
  assert.ok(r2.issues.some((i) => i.code === 'NO_VOWEL_WORDS'));
});

test('assessTextQuality принимает главы с предложениями', () => {
  const r = assessTextQuality(
    [
      {
        id: 'x',
        title: 'X',
        sentences: [
          { rawText: 'Первое предложение абзаца, достаточно длинное для проверки.', paragraphIndex: 0 },
          { rawText: 'Второе предложение того же абзаца.', paragraphIndex: 0 },
        ],
      },
    ],
    'ru'
  );
  assert.equal(r.metrics.paragraphs, 1);
});

test('сдвинутая кириллица внутри Markdown-маркеров обнаруживается', () => {
  assert.equal(detectShiftedCyrillic('**"@52>30**').isShifted, true);
  assert.equal(repairShiftedCyrillic('**"@52>30**').text, '**Тревога**');
  assert.equal(detectShiftedCyrillic('_U_').isShifted, false);
  assert.ok(paragraphProblems('**"@52>30**').some((p) => p.code === 'shifted'));
});
