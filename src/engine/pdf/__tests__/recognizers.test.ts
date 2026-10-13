import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { recognizePages, openAndInspect, toRanges, effectiveEngine, closeSidecarHandle, type RecognizerContext } from '../recognizers';
import { resolvePdfTarget, availableEngines } from '../engineChoice';
import { parseGeminiBlocks, explainGeminiHttp, GeminiPageError } from '../geminiPages';
import { layoutPage, type LayoutItem } from '../textLayout';
import { classifyHeading } from '../../cleanup/chapters';
import { finalizePageBlocks, cleanBlocks } from '../pageClean';
import { PDF_MAX_PAGES_PER_CALL, type PdfBlock } from '../../parsers/pdfSidecar';

/**
 * Контракт sidecar: мок Tauri invoke (window.__TAURI_INTERNALS__.invoke) проверяет, что
 *  - PDF передаётся ОДИН раз (pdf_open), дальше только handle и номера страниц;
 *  - диапазон > 20 страниц режется на вызовы;
 *  - при потере handle книга переоткрывается из сохранённого файла один раз;
 *  - режимы auto/text/ocr уходят в параметр mode.
 */

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}
let calls: Call[] = [];
let handleSeq = 0;
let liveHandles = new Set<string>();
let failNextPagesWith: string | null = null;

const pageResult = (page: number) => ({
  page,
  source: 'text',
  width: 600,
  height: 800,
  blocks: [{ type: 'paragraph', text: `Текст страницы ${page}.`, bbox: [50, 100, 500, 130] }],
  text: `Текст страницы ${page}.`,
  warnings: [],
});

beforeEach(() => {
  calls = [];
  handleSeq = 0;
  liveHandles = new Set();
  failNextPagesWith = null;
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'pdf_open') {
          const h = `h${++handleSeq}`;
          liveHandles.add(h);
          return h;
        }
        if (cmd === 'pdf_info') {
          return JSON.stringify({
            pageCount: 100,
            metadata: { title: 'T', author: 'A', fileName: 'x.pdf' },
            coverUrl: null,
            outline: [],
            pageSize: { width: 600, height: 800 },
            hasTextLayer: true,
            corruptedLayerSuspected: false,
            bodyFontSize: 11,
            recommendedMode: 'text',
          });
        }
        if (cmd === 'pdf_pages') {
          if (failNextPagesWith) {
            const m = failNextPagesWith;
            failNextPagesWith = null;
            throw m;
          }
          if (!liveHandles.has(String(args.handle))) throw 'Неизвестный или закрытый PDF-handle';
          const pages = [];
          for (let p = Number(args.from); p <= Number(args.to); p++) pages.push(pageResult(p));
          return JSON.stringify({ pages });
        }
        if (cmd === 'pdf_close') {
          liveHandles.delete(String(args.handle));
          return null;
        }
        throw new Error('unexpected ' + cmd);
      },
    },
  };
});

afterEach(async () => {
  await closeSidecarHandle('book1');
  delete (globalThis as unknown as { window?: unknown }).window;
});

const bytes = new Uint8Array([1, 2, 3]).buffer;
const ctx = (): RecognizerContext => ({
  bookId: 'book1',
  fileName: 'x.pdf',
  getBuffer: async () => bytes,
  bodyFontSize: 11,
  getGeminiKey: () => undefined,
});

test('sidecar: PDF открывается один раз, страницы запрашиваются по handle', async () => {
  const opened = await openAndInspect('book1', bytes, 'x.pdf', 'auto');
  assert.equal(opened.info.pageCount, 100);
  assert.equal(opened.engine, 'auto');
  const a = await recognizePages('auto', [3, 4], ctx());
  const b = await recognizePages('auto', [10], ctx());
  assert.deepEqual(a.map((p) => p.page), [3, 4]);
  assert.equal(b[0].source, 'text');
  assert.equal(calls.filter((c) => c.cmd === 'pdf_open').length, 1, 'файл отправляется в sidecar один раз');
  const pages = calls.filter((c) => c.cmd === 'pdf_pages');
  assert.equal(pages.length, 2);
  assert.equal(pages[0].args.handle, 'h1');
  assert.equal(pages[0].args.from, 3);
  assert.equal(pages[0].args.to, 4);
  assert.equal(pages[0].args.mode, 'auto');
  assert.equal(pages[0].args.bodySize, 11);
  assert.ok(pages.every((c) => c.args.fileBytes === undefined), 'байты PDF не уходят повторно');
});

test('sidecar: режимы ocr и text передаются в mode; несмежные страницы — отдельные вызовы', async () => {
  await recognizePages('ocr', [5, 6, 9], ctx());
  const pages = calls.filter((c) => c.cmd === 'pdf_pages');
  assert.deepEqual(pages.map((c) => [c.args.from, c.args.to, c.args.mode]), [
    [5, 6, 'ocr'],
    [9, 9, 'ocr'],
  ]);
  await recognizePages('text', [1], ctx());
  assert.equal(calls.filter((c) => c.cmd === 'pdf_pages').pop()?.args.mode, 'text');
});

test('sidecar: диапазон больше 20 страниц режется на вызовы', async () => {
  const list = Array.from({ length: 45 }, (_, i) => i + 1);
  const res = await recognizePages('auto', list, ctx());
  assert.equal(res.length, 45);
  const sizes = calls.filter((c) => c.cmd === 'pdf_pages').map((c) => Number(c.args.to) - Number(c.args.from) + 1);
  assert.ok(sizes.every((n) => n <= PDF_MAX_PAGES_PER_CALL));
  assert.equal(sizes.reduce((a, b) => a + b, 0), 45);
});

test('sidecar: потерянный handle — повторное открытие из сохранённого файла и повтор вызова', async () => {
  await openAndInspect('book1', bytes, 'x.pdf', 'auto');
  liveHandles.clear(); // как после перезапуска sidecar-состояния
  const res = await recognizePages('auto', [2], ctx());
  assert.equal(res[0].page, 2);
  assert.equal(calls.filter((c) => c.cmd === 'pdf_open').length, 2);
  assert.equal(calls.filter((c) => c.cmd === 'pdf_pages').pop()?.args.handle, 'h2');
});

test('sidecar: фатальная ошибка (нет Tesseract) помечается fatal', async () => {
  await openAndInspect('book1', bytes, 'x.pdf', 'ocr');
  failNextPagesWith = 'Tesseract не найден (AIBR_TESSERACT)';
  await assert.rejects(
    () => recognizePages('ocr', [1], ctx()),
    (e: Error & { fatal?: boolean }) => e.fatal === true && /Tesseract/.test(e.message),
  );
});

test('toRanges и effectiveEngine', () => {
  assert.deepEqual(toRanges([5, 3, 4, 9, 4]), [[3, 5], [9, 9]]);
  assert.equal(effectiveEngine('auto'), 'auto'); // в окружении с Tauri
  delete (globalThis as unknown as { window?: unknown }).window;
  assert.equal(effectiveEngine('auto'), 'pdfjs', 'без Tauri sidecar недоступен -> pdfjs');
  assert.equal(effectiveEngine('gemini'), 'gemini');
});

test('выбор способа обработки PDF по режиму и среде', () => {
  assert.deepEqual(resolvePdfTarget('pdfjs', { sidecar: false }), { kind: 'paged', engine: 'pdfjs' });
  assert.deepEqual(resolvePdfTarget(undefined, { sidecar: true }), { kind: 'paged', engine: 'pdfjs' });
  assert.deepEqual(resolvePdfTarget('pymupdf', { sidecar: true }), { kind: 'paged', engine: 'auto' });
  assert.deepEqual(resolvePdfTarget('pymupdf', { sidecar: false }), { kind: 'remote', mode: 'pymupdf' });
  assert.deepEqual(resolvePdfTarget('gemini', { sidecar: false, geminiKey: 'k' }), { kind: 'paged', engine: 'gemini' });
  assert.deepEqual(resolvePdfTarget('gemini', { sidecar: true }), { kind: 'remote', mode: 'gemini' });
  assert.deepEqual(resolvePdfTarget('ocr', { sidecar: true }), { kind: 'paged', engine: 'ocr' });
  assert.equal(resolvePdfTarget('ocr', { sidecar: false }).kind, 'unavailable');
  assert.deepEqual(availableEngines({ sidecar: false }), ['pdfjs', 'gemini']);
  assert.ok(availableEngines({ sidecar: true }).includes('ocr'));
});

test('Gemini: разбор ответа с обрамлением, неизвестные типы, пустые блоки', () => {
  const raw = '```json\n{"blocks":[{"type":"heading","text":"Глава 1","level":1},{"type":"weird","text":"Абзац."},{"type":"paragraph","text":"  "}]}\n```';
  const blocks = parseGeminiBlocks(raw);
  assert.deepEqual(blocks, [
    { type: 'heading', text: 'Глава 1', level: 1 },
    { type: 'paragraph', text: 'Абзац.' },
  ]);
  assert.deepEqual(parseGeminiBlocks('Вот результат: {"blocks":[{"type":"paragraph","text":"А."}]} готово'), [{ type: 'paragraph', text: 'А.' }]);
  assert.throws(() => parseGeminiBlocks('не json'), GeminiPageError);
  assert.equal(explainGeminiHttp(403, {}).fatal, true);
  assert.equal(explainGeminiHttp(429, {}).fatal, false);
  assert.equal(explainGeminiHttp(400, { error: { message: 'API key not valid' } }).fatal, true);
});

test('pdf.js-раскладка: колонтитулы, номер страницы, заголовок и абзацы со склейкой переносов', () => {
  const W = 600;
  const H = 800;
  const it = (str: string, x: number, y: number, w: number, fs = 11): LayoutItem => ({ str, x, y, w, fs });
  const items: LayoutItem[] = [
    it('Моя книга', 50, 30, 100, 9),
    it('ГЛАВА 1', 50, 120, 120, 22),
    it('Первая строка абзаца о пере-', 50, 160, 400),
    it('носе слов и так далее.', 50, 175, 300),
    it('Второй абзац начинается здесь', 70, 215, 400),
    it('и продолжается без точки', 50, 230, 380),
    it('17', 295, 770, 10, 9),
  ];
  const { blocks, text } = layoutPage(items, W, H, 11);
  assert.deepEqual(blocks.map((b) => b.type), ['header', 'heading', 'paragraph', 'paragraph', 'pagenum']);
  assert.equal(blocks[2].text, 'Первая строка абзаца о переносе слов и так далее.');
  assert.equal(blocks[3].endsWithOpenSentence, true);
  assert.ok(blocks[2].bbox && blocks[2].bbox[0] === 50);
  assert.ok(!text.includes('Моя книга') && !text.includes('17'));
});

test('flags склейки (finalizePageBlocks) и автоочистка Markdown', () => {
  const blocks: PdfBlock[] = [
    { type: 'paragraph', text: 'продолжение с маленькой' },
    { type: 'paragraph', text: 'обрыв на перено-' },
  ];
  finalizePageBlocks(blocks);
  assert.equal(blocks[0].continuesParagraph, true);
  assert.equal(blocks[1].endsWithHyphen, true);
  assert.equal(blocks[1].text, 'обрыв на перено');
  const cleaned = cleanBlocks([{ type: 'paragraph', text: '**Жирный** текст�  с  пробелами' }]);
  assert.equal(cleaned.blocks[0].text, 'Жирный текст с пробелами');
  assert.equal(cleaned.changed, 1);
});

test('строка абзаца, начинающаяся со слова «книга» со строчной, не становится заголовком', () => {
  const it = (str: string, x: number, y: number, w: number, fs = 11): LayoutItem => ({ str, x, y, w, fs });
  const items: LayoutItem[] = [
    it('Он долго читал и вспоминал, как лампа и', 72, 100, 400),
    it('книга встретили поле, а потом снег долго говорил про лес, огонь и', 72, 114, 420),
    it('необыкновенно длинное слово. Конец абзаца.', 72, 128, 300),
  ];
  const { blocks } = layoutPage(items, 600, 800, 11);
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph']);
  assert.equal(classifyHeading({ text: 'книга встретили поле, а потом снег долго говорил про лес' }), null);
  assert.ok(classifyHeading({ text: 'Книга вторая' }));
});
