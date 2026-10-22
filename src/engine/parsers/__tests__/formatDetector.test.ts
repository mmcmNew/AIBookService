import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  isSupportedBookFile,
  detectFormatFromBuffer,
  normalizeBookFile,
  sanitizeBaseFileName,
} from '../formatDetector';

test('isSupportedBookFile: распознает все поддерживаемые расширения', () => {
  assert.equal(isSupportedBookFile('book.fb2'), true);
  assert.equal(isSupportedBookFile('book.fb2.zip'), true);
  assert.equal(isSupportedBookFile('book.fbz'), true);
  assert.equal(isSupportedBookFile('book.epub'), true);
  assert.equal(isSupportedBookFile('book.zip'), true);
  assert.equal(isSupportedBookFile('book.pdf'), true);
  assert.equal(isSupportedBookFile('book.mobi'), true);
  assert.equal(isSupportedBookFile('book.azw3'), true);
  assert.equal(isSupportedBookFile('book.txt'), true);

  assert.equal(isSupportedBookFile('book.exe'), false);
  assert.equal(isSupportedBookFile('document%3A12345'), false);
  assert.equal(isSupportedBookFile('unknown'), false);
});

test('sanitizeBaseFileName: очищает префиксы Android SAF и URL-кодирование', () => {
  assert.equal(sanitizeBaseFileName('document%3A1000000035'), '1000000035');
  assert.equal(sanitizeBaseFileName('primary%3ADownloads%2Fmy_book.bin'), 'my_book');
  assert.equal(sanitizeBaseFileName('msf:456'), '456');
  assert.equal(sanitizeBaseFileName('simple_book.epub'), 'simple_book');
});

test('detectFormatFromBuffer: определяет PDF по сигнатуре %PDF-', async () => {
  const pdfBytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj');
  const result = await detectFormatFromBuffer(pdfBytes);
  assert.ok(result);
  assert.equal(result.extension, 'pdf');
  assert.equal(result.mimeType, 'application/pdf');
});

test('detectFormatFromBuffer: определяет FB2 по XML-структуре FictionBook', async () => {
  const fb2Xml = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description>
    <title-info>
      <book-title>Тестовая книга</book-title>
    </title-info>
  </description>
  <body>
    <section>
      <title><p>Глава 1</p></title>
      <p>Текст первой главы книги.</p>
    </section>
  </body>
</FictionBook>`;
  const bytes = new TextEncoder().encode(fb2Xml);
  const result = await detectFormatFromBuffer(bytes);
  assert.ok(result);
  assert.equal(result.extension, 'fb2');
  assert.equal(result.mimeType, 'application/x-fictionbook+xml');
});

test('detectFormatFromBuffer: определяет FB2 с UTF-8 BOM', async () => {
  const fb2Xml = `<FictionBook><description><title-info><book-title>BOM Книга</book-title></title-info></description></FictionBook>`;
  const xmlBytes = new TextEncoder().encode(fb2Xml);
  const withBom = new Uint8Array(3 + xmlBytes.length);
  withBom[0] = 0xef;
  withBom[1] = 0xbb;
  withBom[2] = 0xbf;
  withBom.set(xmlBytes, 3);

  const result = await detectFormatFromBuffer(withBom);
  assert.ok(result);
  assert.equal(result.extension, 'fb2');
});

test('detectFormatFromBuffer: определяет FB2 внутри ZIP (fb2.zip)', async () => {
  const zip = new JSZip();
  zip.file(
    'book.fb2',
    `<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info><book-title>Архивная книга</book-title></title-info></description><body><p>Привет</p></body></FictionBook>`
  );
  const buffer = await zip.generateAsync({ type: 'arraybuffer' });
  const result = await detectFormatFromBuffer(buffer);
  assert.ok(result);
  assert.equal(result.extension, 'fb2.zip');
});

test('detectFormatFromBuffer: определяет EPUB по container.xml внутри ZIP', async () => {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
  );
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?><package></package>`);
  const buffer = await zip.generateAsync({ type: 'arraybuffer' });
  const result = await detectFormatFromBuffer(buffer);
  assert.ok(result);
  assert.equal(result.extension, 'epub');
  assert.equal(result.mimeType, 'application/epub+zip');
});

test('detectFormatFromBuffer: определяет MOBI по BOOKMOBI в заголовке', async () => {
  const mobiBytes = new Uint8Array(100);
  const magic = new TextEncoder().encode('BOOKMOBI');
  mobiBytes.set(magic, 60);

  const result = await detectFormatFromBuffer(mobiBytes);
  assert.ok(result);
  assert.equal(result.extension, 'mobi');
});

test('detectFormatFromBuffer: определяет TXT по читаемому тексту', async () => {
  const txtBytes = new TextEncoder().encode('Простой русский текст без XML тегов.');
  const result = await detectFormatFromBuffer(txtBytes);
  assert.ok(result);
  assert.equal(result.extension, 'txt');
});

test('normalizeBookFile: восстанавливает расширение для Android SAF document%3A...', async () => {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
  );
  const buffer = await zip.generateAsync({ type: 'arraybuffer' });

  // Файл из Android SAF без расширения
  const rawFile = new File([buffer], 'document%3A1000000035');
  const normalized = await normalizeBookFile(rawFile);

  assert.equal(normalized.name, '1000000035.epub');
  assert.equal(isSupportedBookFile(normalized.name), true);
});

test('normalizeBookFile: файл с generic .zip содержащий fb2 переименовывается в .fb2.zip', async () => {
  const zip = new JSZip();
  zip.file('story.fb2', `<?xml version="1.0"?><FictionBook><body><p>Текст</p></body></FictionBook>`);
  const buffer = await zip.generateAsync({ type: 'arraybuffer' });

  const rawFile = new File([buffer], 'tolstoy.zip');
  const normalized = await normalizeBookFile(rawFile);

  assert.equal(normalized.name, 'tolstoy.fb2.zip');
  assert.equal(isSupportedBookFile(normalized.name), true);
});

test('normalizeBookFile: файл с generic .zip содержащий EPUB переименовывается в .epub', async () => {
  const zip = new JSZip();
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?><container version="1.0"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`
  );
  const buffer = await zip.generateAsync({ type: 'arraybuffer' });

  const rawFile = new File([buffer], 'dune.zip');
  const normalized = await normalizeBookFile(rawFile);

  assert.equal(normalized.name, 'dune.epub');
  assert.equal(isSupportedBookFile(normalized.name), true);
});

test('normalizeBookFile: файл с уже правильным расширением не изменяется', async () => {
  const txtBytes = new TextEncoder().encode('Hello world');
  const rawFile = new File([txtBytes], 'notes.txt', { type: 'text/plain' });
  const normalized = await normalizeBookFile(rawFile);

  assert.equal(normalized, rawFile);
  assert.equal(normalized.name, 'notes.txt');
});
