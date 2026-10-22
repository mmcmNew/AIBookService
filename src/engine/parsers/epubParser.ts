import JSZip from 'jszip';
import { Chapter, ParsedBook, SentenceItem } from '../../types/book';
import { ReplacementRule } from '../../types/settings';
import { tokenizeSentences } from '../tokenizer/sentenceTokenizer';
import { escapeHtml } from './htmlUtil';

function findZipFile(zip: JSZip, targetPath: string): JSZip.JSZipObject | null {
  const direct = zip.file(targetPath);
  if (direct) return direct;

  const normalized = targetPath.replace(/^\//, '').toLowerCase();
  const found = Object.values(zip.files).find((f) => !f.dir && f.name.replace(/^\//, '').toLowerCase() === normalized);
  if (found) return found;

  // Поиск по окончанию пути
  const baseName = normalized.split('/').pop();
  if (baseName) {
    return Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase().endsWith(baseName)) || null;
  }
  return null;
}

export async function parseEPUB(
  fileContent: ArrayBuffer,
  fileName: string,
  userRules: ReplacementRule[] = []
): Promise<ParsedBook> {
  const zip = await JSZip.loadAsync(fileContent);

  // 1. Поиск container.xml для определения пути к .opf файлу
  const containerFile = findZipFile(zip, 'META-INF/container.xml');
  if (!containerFile) {
    throw new Error('Некорректный EPUB: отсутствует META-INF/container.xml');
  }

  const containerXml = await containerFile.async('text');
  const domParser = new DOMParser();
  const containerDoc = domParser.parseFromString(containerXml, 'text/xml');
  const rawRootfilePath = containerDoc.querySelector('rootfile')?.getAttribute('full-path');

  if (!rawRootfilePath) {
    throw new Error('Некорректный EPUB: не найден full-path в container.xml');
  }

  const rootfilePath = decodeURIComponent(rawRootfilePath).replace(/^\//, '');

  // 2. Чтение OPF файла (метаданные, манифест, спин)
  let opfFile = findZipFile(zip, rootfilePath);
  if (!opfFile) {
    // Резервный поиск любого .opf файла в архиве
    opfFile = Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase().endsWith('.opf')) || null;
  }
  if (!opfFile) {
    throw new Error(`Файл манифеста не найден: ${rootfilePath}`);
  }

  const opfDir = rootfilePath.includes('/') ? rootfilePath.substring(0, rootfilePath.lastIndexOf('/') + 1) : '';
  const opfXml = await opfFile.async('text');
  const opfDoc = domParser.parseFromString(opfXml, 'text/xml');

  // Метаданные
  const title =
    opfDoc.querySelector('metadata > title, metadata > dc\\:title')?.textContent?.trim() ||
    fileName.replace(/\.[^/.]+$/, '');
  const author =
    opfDoc.querySelector('metadata > creator, metadata > dc\\:creator')?.textContent?.trim() || 'Неизвестный автор';
  const lang = opfDoc.querySelector('metadata > language, metadata > dc\\:language')?.textContent?.trim() || 'ru';

  // Поиск обложки
  let coverUrl: string | undefined = undefined;
  const coverMeta = opfDoc.querySelector('metadata > meta[name="cover"]')?.getAttribute('content');
  const manifestItems: Record<string, { href: string; mediaType: string }> = {};

  opfDoc.querySelectorAll('manifest > item').forEach((item) => {
    const id = item.getAttribute('id') || '';
    const href = item.getAttribute('href') || '';
    const mediaType = item.getAttribute('media-type') || '';
    if (id && href) {
      manifestItems[id] = { href, mediaType };
    }
  });

  // Извлечение обложки
  const coverItemId = coverMeta || Object.keys(manifestItems).find((k) => k.toLowerCase().includes('cover'));
  if (coverItemId && manifestItems[coverItemId]) {
    const rawCoverHref = decodeURIComponent(manifestItems[coverItemId].href.split('#')[0].split('?')[0]);
    const coverPath = opfDir + rawCoverHref;
    const coverFile = findZipFile(zip, coverPath);
    if (coverFile) {
      const coverBlob = await coverFile.async('blob');
      coverUrl = URL.createObjectURL(coverBlob);
    }
  }

  // 3. Чтение глав по порядку из <spine>
  const chapters: Chapter[] = [];
  const spineItemRefs = opfDoc.querySelectorAll('spine > itemref');
  let globalSentenceId = 0;

  for (let i = 0; i < spineItemRefs.length; i++) {
    const idref = spineItemRefs[i].getAttribute('idref') || '';
    const item = manifestItems[idref];
    if (!item) continue;

    const rawHref = decodeURIComponent(item.href.split('#')[0].split('?')[0]);
    const chapterPath = opfDir + rawHref;
    const chapterFile = findZipFile(zip, chapterPath);
    if (!chapterFile) continue;

    const chapterHtml = await chapterFile.async('text');
    const chapterDoc = domParser.parseFromString(chapterHtml, 'text/html');

    // Название главы
    const heading =
      chapterDoc.querySelector('h1, h2, h3, title')?.textContent?.trim() || `Глава ${chapters.length + 1}`;

    const paragraphs: string[] = [];
    const chapterSentences: SentenceItem[] = [];
    let pIndex = 0;

    const pNodes = chapterDoc.querySelectorAll('p, div.paragraph, blockquote');
    if (pNodes.length > 0) {
      pNodes.forEach((node) => {
        const text = node.textContent?.trim();
        if (text && text.length > 2) {
          paragraphs.push(`<p class="my-3 leading-relaxed">${escapeHtml(text)}</p>`);
          const s = tokenizeSentences(text, globalSentenceId, pIndex++, userRules, lang);
          chapterSentences.push(...s);
          globalSentenceId += s.length;
        }
      });
    } else {
      // Если тегов <p> нет, берем body с разбивкой по строкам
      const bodyText = chapterDoc.body?.textContent?.trim() || '';
      const lines = bodyText
        .split(/\n\s*\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      lines.forEach((line) => {
        paragraphs.push(`<p class="my-3 leading-relaxed">${escapeHtml(line)}</p>`);
        const s = tokenizeSentences(line, globalSentenceId, pIndex++, userRules, lang);
        chapterSentences.push(...s);
        globalSentenceId += s.length;
      });
    }

    if (chapterSentences.length > 0) {
      chapters.push({
        id: `epub_ch_${chapters.length}`,
        title: heading,
        level: 1,
        contentHtml: paragraphs.join('\n'),
        sentences: chapterSentences,
      });
    }
  }

  const bookId = `epub_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  return {
    metadata: {
      id: bookId,
      title,
      author,
      lang,
      coverUrl,
      fileName,
      addedAt: Date.now(),
    },
    chapters,
    notes: {},
  };
}
