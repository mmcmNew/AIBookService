import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfBlock } from '../../parsers/pdfSidecar';
import type { PdfPageRecord, PageState } from '../types';
import { composeBook, createComposeCache, firstSentenceOnPage, locateSentence, nextStep, prevSentenceOf, type ComposeInput } from '../composer';
import { composePages } from '../pageCompose';
import { computeRunningKeys } from '../runningHeaders';
import { pageOfSentenceId, sentenceIdFor, rectsForRange } from '../pageSentences';
import { planChapters, RANGE_CHUNK_PAGES } from '../chapterPlan';

const H = 800;
const NO_RULES: never[] = [];

function rec(page: number, blocks: PdfBlock[], extra: Partial<PdfPageRecord> = {}): PdfPageRecord {
  return { bookId: 'b', page, status: 'done', source: 'text', blocks, width: 600, height: H, warnings: [], editedByUser: false, updatedAt: 1, ...extra };
}
const par = (text: string, extra: Partial<PdfBlock> = {}): PdfBlock => ({ type: 'paragraph', text, bbox: [50, 100, 550, 160], fontSize: 12, ...extra });

function inputFor(records: PdfPageRecord[], pageCount: number, extra: Partial<ComposeInput> = {}): ComposeInput {
  const map = new Map(records.map((r) => [r.page, r]));
  return { pageCount, outline: [], getRecord: (p) => map.get(p), rules: NO_RULES, ...extra };
}

test('id предложений: page*1e6 + block*1000 + k, страница восстанавливается из id', () => {
  const id = sentenceIdFor(12, 3, 4);
  assert.equal(id, 12_003_004);
  assert.equal(pageOfSentenceId(id), 12);
});

test('header/footer/pagenum скрыты из текста, но остаются в данных', () => {
  const r = rec(1, [
    { type: 'header', text: 'Колонтитул книги', bbox: [50, 20, 500, 40] },
    par('Первый абзац страницы. Второе предложение.'),
    { type: 'pagenum', text: '17', bbox: [290, 770, 310, 790] },
    { type: 'footer', text: 'Сноска внизу', bbox: [50, 760, 500, 780] },
  ]);
  const book = composeBook(inputFor([r], 1), createComposeCache());
  assert.deepEqual(book.order.map((s) => s.rawText), ['Первый абзац страницы.', 'Второе предложение.']);
  assert.equal(r.blocks.length, 4, 'данные не удалены');
  assert.equal(book.pages[0].hidden, 3);
});

test('склейка границы страниц: продолжение абзаца приклеивается к предыдущей странице', () => {
  const r1 = rec(1, [par('Начало абзаца. Предложение, которое не', { endsWithOpenSentence: true })]);
  const r2 = rec(2, [par('закончилось на этой странице. Следующее предложение.', { continuesParagraph: true }), par('Новый абзац.')]);
  const book = composeBook(inputFor([r1, r2], 2), createComposeCache());
  const texts = book.order.map((s) => s.rawText);
  assert.deepEqual(texts, [
    'Начало абзаца.',
    'Предложение, которое не закончилось на этой странице.',
    'Следующее предложение.',
    'Новый абзац.',
  ]);
  // Предложения склеенного абзаца принадлежат странице 1, но подсветка охватывает обе страницы
  const joined = book.order[1];
  assert.equal(pageOfSentenceId(joined.id), 1);
  assert.deepEqual(new Set(joined.pdfRects?.map((r) => r.pageNumber)), new Set([1, 2]));
  assert.equal(pageOfSentenceId(book.order[3].id), 2);
});

test('дефисный перенос между страницами склеивается без пробела', () => {
  const r1 = rec(1, [par('Он любил переносить', { endsWithHyphen: true })]);
  // sidecar убирает дефис и ставит endsWithHyphen; следующий блок начинается со строчной
  r1.blocks[0].text = 'Он любил перено';
  const r2 = rec(2, [par('сить вещи.', { continuesParagraph: true })]);
  const book = composeBook(inputFor([r1, r2], 2), createComposeCache());
  assert.deepEqual(book.order.map((s) => s.rawText), ['Он любил переносить вещи.']);
});

test('склейка не выполняется, если предыдущая фраза закончена и следующий абзац с заглавной', () => {
  const r1 = rec(1, [par('Всё закончилось.')]);
  const r2 = rec(2, [par('Новая мысль.')]);
  const book = composeBook(inputFor([r1, r2], 2), createComposeCache());
  assert.equal(book.order.length, 2);
});

test('страница пришла позже: ids остальных предложений не меняются, перетокенизируется только граница', () => {
  const cache = createComposeCache();
  const r1 = rec(1, [par('Первая. Вторая. Третья не', { endsWithOpenSentence: true })]);
  const r3 = rec(3, [par('Страница три. Ещё предложение.')]);
  const before = composeBook(inputFor([r1, r3], 3), cache);
  const idsBefore = before.order.map((s) => s.id);
  const itemBefore = new Map(before.order.map((s) => [s.id, s]));

  const r2 = rec(2, [par('закончена. Четвёртая.', { continuesParagraph: true }), par('Пятая.')]);
  const after = composeBook(inputFor([r1, r2, r3], 3), cache);
  for (const id of idsBefore) {
    assert.ok(after.indexById.has(id), `id ${id} остался`);
  }
  // Предложения страницы 3 не изменились вообще (та же идентичность объектов)
  for (const s of before.order.filter((x) => pageOfSentenceId(x.id) === 3)) {
    assert.equal(after.order[after.indexById.get(s.id) as number], s);
  }
  // Перетокенизирован только граничный абзац страницы 1: id и тексты прежних предложений те же
  assert.equal(after.order[0].id, itemBefore.get(idsBefore[0])?.id);
  assert.equal(after.order[1].rawText, itemBefore.get(idsBefore[1])?.rawText);
  assert.equal(after.order[2].rawText, 'Третья не закончена.');
});

test('накопительная статистика колонтитулов: повторяющаяся строка в поле скрывается', () => {
  const records: PdfPageRecord[] = [];
  for (let p = 1; p <= 8; p++) {
    records.push(
      rec(p, [
        // sidecar не распознал колонтитул (тип paragraph), цифры меняются
        { type: 'paragraph', text: `Моя книга — глава ${p}`, bbox: [50, 20, 400, 40], fontSize: 9 },
        par(`Текст страницы номер ${p}. Он длинный и уникальный.`),
      ]),
    );
  }
  const keys = computeRunningKeys(records);
  assert.ok(keys.size >= 1);
  const book = composeBook(inputFor(records, 8), createComposeCache());
  assert.equal(book.order.length, 16);
  assert.ok(book.order.every((s) => !s.rawText.includes('Моя книга')));
  // Малые выборки не порождают ложных колонтитулов
  assert.equal(computeRunningKeys(records.slice(0, 2)).size, 0);
});

test('заголовки глав не считаются колонтитулами даже при повторе в верхнем поле', () => {
  const records: PdfPageRecord[] = [];
  for (let p = 1; p <= 6; p++) records.push(rec(p, [{ type: 'heading', level: 1, text: `Глава ${p}`, bbox: [50, 30, 300, 60], fontSize: 20 }, par('Текст. Ещё текст.')]));
  assert.equal(computeRunningKeys(records).size, 0);
});

test('главы из оглавления PDF: заглушки для нераспознанных страниц, стабильные id при достройке', () => {
  const outline = [
    { level: 1, title: 'Введение', page: 1 },
    { level: 1, title: 'Глава 1', page: 3 },
    { level: 1, title: 'Глава 2', page: 6 },
  ];
  const cache = createComposeCache();
  const r1 = rec(1, [par('Введение текст. Тут.')]);
  const first = composeBook(inputFor([r1], 8, { outline }), cache);
  assert.deepEqual(first.chapters.map((c) => c.title), ['Введение', 'Глава 1', 'Глава 2']);
  assert.deepEqual(first.chapters.map((c) => [c.startPage, c.endPage]), [[1, 2], [3, 5], [6, 8]]);
  assert.equal(first.chapters[1].stub, true);
  assert.equal(first.chapters[1].sentences.length, 0);
  assert.equal(first.chapters[0].pagesDone, 1);

  const ids = first.chapters.map((c) => c.id);
  const r3 = rec(3, [{ type: 'heading', level: 1, text: 'Глава 1', bbox: [50, 80, 300, 120], fontSize: 20 }, par('Текст первой главы. Ещё одно.')]);
  const second = composeBook(inputFor([r1, r3], 8, { outline }), cache);
  assert.deepEqual(second.chapters.map((c) => c.id), ids, 'ключи глав стабильны');
  assert.equal(second.chapters[1].stub, false);
  assert.deepEqual(second.chapters[1].sentences.map((s) => s.rawText), ['Текст первой главы.', 'Ещё одно.'], 'строка заголовка не читается как текст');
  assert.equal(second.chapters[0], first.chapters[0], 'глава без изменений — тот же объект');
});

test('главы из заголовков распознанных страниц + ведущая глава «Страницы 1–N»', () => {
  const records: PdfPageRecord[] = [];
  const longText = 'Это достаточно длинное предложение для того, чтобы глава набрала нужное количество символов. '.repeat(8);
  for (let p = 5; p <= 12; p++) {
    const blocks: PdfBlock[] = [];
    if (p === 5) blocks.push({ type: 'heading', level: 1, text: 'Глава 1', bbox: [50, 80, 300, 120], fontSize: 22 });
    if (p === 9) blocks.push({ type: 'heading', level: 1, text: 'Глава 2', bbox: [50, 80, 300, 120], fontSize: 22 });
    blocks.push(par(longText));
    records.push(rec(p, blocks));
  }
  const book = composeBook(inputFor(records, 20), createComposeCache());
  assert.equal(book.specs[0].title, 'Страницы 1–4');
  assert.equal(book.specs[0].startPage, 1);
  assert.deepEqual(book.specs.slice(1).map((s) => s.title), ['Глава 1', 'Глава 2']);
  assert.deepEqual(book.specs.slice(1).map((s) => s.id), ['h5_0', 'h9_0']);
  // Предложение принадлежит главе по позиции
  const s7 = firstSentenceOnPage(book, 7);
  assert.ok(s7);
  assert.equal(book.chapterOfSentence.get((s7 as { id: number }).id), 1);
  const s10 = firstSentenceOnPage(book, 10);
  assert.equal(book.chapterOfSentence.get((s10 as { id: number }).id), 2);
});

test('без оглавления и заголовков — главы «Страницы N–M»', () => {
  const specs = planChapters({ pageCount: 45, outline: [], pages: [] });
  assert.deepEqual(specs.map((s) => s.title), ['Страницы 1–20', 'Страницы 21–40', 'Страницы 41–45']);
  assert.equal(RANGE_CHUNK_PAGES, 20);
});

test('ручные границы глав имеют приоритет', () => {
  const book = composeBook(
    inputFor([rec(1, [par('Один.'), par('Два.'), par('Три.')])], 2, {
      manual: [{ page: 2, block: 0, title: 'Своя глава', level: 1 }],
    }),
    createComposeCache(),
  );
  assert.deepEqual(book.specs.map((s) => s.title), ['Страница 1', 'Своя глава']);
  assert.deepEqual(book.chapters[0].sentences.map((s) => s.rawText), ['Один.', 'Два.', 'Три.']);
});

test('nextStep: ждёт нераспознанную страницу, не перескакивая через неё', () => {
  const r1 = rec(1, [par('Конец страницы.')]);
  const r3 = rec(3, [par('Страница три.')]);
  const book = composeBook(inputFor([r1, r3], 4), createComposeCache());
  const states: Record<number, PageState> = { 1: 'done', 2: 'running', 3: 'done', 4: 'pending' };
  const step = nextStep(book, (p) => states[p], book.order[0].id);
  assert.deepEqual(step, { kind: 'wait', page: 2, state: 'running' });
  states[2] = 'done';
  const step2 = nextStep(book, (p) => states[p], book.order[0].id);
  assert.equal(step2.kind, 'sentence');
  // После страницы 3 ждём страницу 4, а не «конец книги»
  const last = nextStep(book, (p) => states[p], book.order[1].id);
  assert.deepEqual(last, { kind: 'wait', page: 4, state: 'pending' });
  states[4] = 'done';
  assert.deepEqual(nextStep(book, (p) => states[p], book.order[1].id), { kind: 'end' });
  states[2] = 'error';
  assert.deepEqual(nextStep(book, (p) => states[p], book.order[0].id), { kind: 'wait', page: 2, state: 'error' });
});

test('locateSentence: исчезнувший id заменяется ближайшим следующим; prevSentenceOf', () => {
  const book = composeBook(inputFor([rec(1, [par('А. Б.')]), rec(2, [par('В.')])], 2), createComposeCache());
  const gone = sentenceIdFor(1, 0, 500);
  assert.equal(book.order[locateSentence(book, gone)].rawText, 'В.');
  assert.equal(prevSentenceOf(book, book.order[0].id), null);
  assert.equal(prevSentenceOf(book, book.order[2].id)?.sentence.rawText, 'Б.');
});

test('bbox sidecar (начало сверху) переводится в координаты PDF (начало снизу)', () => {
  const rects = rectsForRange({ page: 1, bbox: [50, 100, 250, 124], fontSize: 12, pageHeight: 800, start: 0, end: 40 }, 0, 40);
  assert.equal(rects.length, 2); // 24pt / (12*1.2) -> 2 строки
  assert.equal(rects[0].x, 50);
  assert.equal(rects[0].width, 200);
  // верхняя строка выше нижней
  assert.ok(rects[0].y > rects[1].y);
  assert.equal(Math.round(rects[0].y + rects[0].height), 800 - 100);
});

test('composePages: страница в статусе error/pending не пропадает, а помечается missing', () => {
  const pages = composePages(3, (p) => (p === 2 ? undefined : rec(p, [par(`Страница ${p}.`)])));
  assert.deepEqual(pages.map((p) => p.state), ['done', 'missing', 'done']);
});

test('заголовок первым на странице 1 (после скрытого колонтитула) не порождает пустую ведущую главу', () => {
  const longText = 'Это достаточно длинное предложение для того, чтобы глава набрала нужное количество символов. '.repeat(8);
  const records = [1, 2, 3, 4].map((p) =>
    rec(p, [
      { type: 'header', text: 'Колонтитул', bbox: [50, 20, 200, 40] },
      ...(p === 1 ? [{ type: 'heading' as const, level: 1 as const, text: 'Глава 1', bbox: [50, 80, 300, 120] as [number, number, number, number], fontSize: 22 }] : []),
      ...(p === 3 ? [{ type: 'heading' as const, level: 1 as const, text: 'Глава 2', bbox: [50, 80, 300, 120] as [number, number, number, number], fontSize: 22 }] : []),
      par(longText),
    ]),
  );
  const book = composeBook(inputFor(records, 4), createComposeCache());
  assert.deepEqual(book.specs.map((s) => s.title), ['Глава 1', 'Глава 2']);
});
