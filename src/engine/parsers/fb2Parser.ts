import JSZip from 'jszip';
import { Chapter, Footnote, ParsedBook, SentenceItem } from '../../types/book';
import { ReplacementRule } from '../../types/settings';
import { tokenizeSentences } from '../tokenizer/sentenceTokenizer';
import { escapeHtml, safeImageDataUrl } from './htmlUtil';

export async function parseFB2(
  fileContent: string | ArrayBuffer,
  fileName: string,
  userRules: ReplacementRule[] = []
): Promise<ParsedBook> {
  let text = '';
  if (typeof fileContent === 'string') {
    text = fileContent;
  } else {
    // Проверка на ZIP-архив (.fb2.zip / .fbz / .zip)
    const sig = new Uint8Array(fileContent.slice(0, 4));
    if (sig.length >= 4 && sig[0] === 0x50 && sig[1] === 0x4b && sig[2] === 0x03 && sig[3] === 0x04) {
      try {
        const zip = await JSZip.loadAsync(fileContent);
        const fb2Entry =
          Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase().endsWith('.fb2')) ||
          Object.values(zip.files).find((f) => !f.dir && !f.name.startsWith('__MACOSX') && !f.name.startsWith('.'));
        if (fb2Entry) {
          fileContent = await fb2Entry.async('arraybuffer');
        }
      } catch (zipErr) {
        console.warn('[FB2Parser] Ошибка распаковки ZIP для FB2:', zipErr);
      }
    }

    const bytes = new Uint8Array(fileContent.slice(0, 500));
    const headerAscii = String.fromCharCode(...bytes);
    const match = headerAscii.match(/<\?xml[^>]+encoding=["']([^"']+)["']/i);
    const encoding = match ? match[1].toLowerCase() : 'utf-8';
    try {
      text = new TextDecoder(encoding).decode(fileContent);
    } catch {
      text = new TextDecoder('utf-8').decode(fileContent);
    }
  }

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(text, 'text/xml');

  const parserError = xmlDoc.querySelector('parsererror');
  if (parserError) {
    throw new Error('Ошибка парсинга FB2 XML: ' + parserError.textContent);
  }

  // 1. Извлечение двоичных данных (изображений)
  const images: Record<string, string> = {};
  const binaries = xmlDoc.querySelectorAll('binary');
  binaries.forEach((binary) => {
    const id = binary.getAttribute('id') || '';
    const contentType = binary.getAttribute('content-type') || 'image/jpeg';
    const base64Data = binary.textContent?.replace(/\s+/g, '') || '';
    if (id && base64Data) {
      const dataUrl = safeImageDataUrl(contentType, base64Data);
      if (dataUrl) images[id] = dataUrl;
    }
  });

  // 2. Извлечение метаданных книги
  const titleInfo = xmlDoc.querySelector('description > title-info');
  const bookTitle = titleInfo?.querySelector('book-title')?.textContent?.trim() || fileName.replace(/\.[^/.]+$/, '');

  let authorName = 'Неизвестный автор';
  const authorNode = titleInfo?.querySelector('author');
  if (authorNode) {
    const firstName = authorNode.querySelector('first-name')?.textContent?.trim() || '';
    const lastName = authorNode.querySelector('last-name')?.textContent?.trim() || '';
    const middleName = authorNode.querySelector('middle-name')?.textContent?.trim() || '';
    authorName = [firstName, middleName, lastName].filter(Boolean).join(' ') || 'Неизвестный автор';
  }

  let coverUrl: string | undefined = undefined;
  const coverImage = titleInfo?.querySelector('coverpage image');
  if (coverImage) {
    const href = coverImage.getAttribute('l:href') || coverImage.getAttribute('xlink:href') || '';
    const cleanId = href.replace(/^#/, '');
    if (images[cleanId]) {
      coverUrl = images[cleanId];
    }
  }

  // Аннотация: только безопасный текст абзацев, экранированный в простой HTML (<p>)
  const annotationNode = titleInfo?.querySelector('annotation');
  let annotationHtml: string | undefined;
  if (annotationNode) {
    const annParagraphs = Array.from(annotationNode.querySelectorAll('p'))
      .map((p) => p.textContent?.trim() || '')
      .filter(Boolean);
    const parts = annParagraphs.length > 0 ? annParagraphs : [annotationNode.textContent?.trim() || ''].filter(Boolean);
    annotationHtml = parts.length > 0 ? parts.map((t) => `<p>${escapeHtml(t)}</p>`).join('') : undefined;
  }
  const lang = titleInfo?.querySelector('lang')?.textContent?.trim() || 'ru';

  // 3. Извлечение сносок из вспомогательных body
  const notes: Record<string, Footnote> = {};
  const bodies = xmlDoc.querySelectorAll('FictionBook > body');
  
  bodies.forEach((body) => {
    const bodyName = body.getAttribute('name');
    if (bodyName === 'notes' || bodyName === 'comments') {
      const noteSections = body.querySelectorAll('section');
      noteSections.forEach((sec) => {
        const id = sec.getAttribute('id') || '';
        const title = sec.querySelector('title')?.textContent?.trim();
        const paragraphs = Array.from(sec.querySelectorAll('p')).map(p => p.textContent?.trim()).filter(Boolean);
        if (id) {
          notes[id] = {
            id,
            title,
            text: paragraphs.join('\n') || sec.textContent?.trim() || '',
          };
        }
      });
    }
  });

  // 4. Извлечение основных глав книги
  const chapters: Chapter[] = [];
  let globalSentenceId = 0;

  const mainBody = Array.from(bodies).find(b => !b.getAttribute('name')) || bodies[0];
  if (!mainBody) {
    throw new Error('В файле FB2 не найдено основное тело текста (body).');
  }

  // Если есть корневой заголовок книги/тома
  const bodyTitle = mainBody.querySelector(':scope > title')?.textContent?.trim();
  
  const sections = mainBody.querySelectorAll(':scope > section');

  function processSection(sec: Element, level = 1) {
    const titleNode = sec.querySelector(':scope > title');
    const chapterTitle = titleNode?.textContent?.trim() || `Глава ${chapters.length + 1}`;

    const paragraphs: string[] = [];
    const chapterSentences: SentenceItem[] = [];
    let pIndex = 0;

    // Проходим по элементам внутри секции
    Array.from(sec.children).forEach((child) => {
      const tag = child.tagName.toLowerCase();
      if (tag === 'title') return; // заголовок уже обработан

      if (tag === 'p' || tag === 'subtitle') {
        const pText = child.textContent?.trim() || '';
        if (pText) {
          paragraphs.push(`<p class="my-3 leading-relaxed">${escapeHtml(pText)}</p>`);
          const s = tokenizeSentences(pText, globalSentenceId, pIndex++, userRules, lang);
          chapterSentences.push(...s);
          globalSentenceId += s.length;
        }
      } else if (tag === 'empty-line') {
        paragraphs.push('<div class="h-4"></div>');
      } else if (tag === 'image') {
        const href = (child.getAttribute('l:href') || child.getAttribute('xlink:href') || '').replace(/^#/, '');
        if (images[href]) {
          paragraphs.push(`<div class="my-4 flex justify-center"><img src="${escapeHtml(images[href])}" class="max-h-96 rounded shadow-md object-contain" /></div>`);
        }
      }
    });

    if (paragraphs.length > 0) {
      chapters.push({
        id: `ch_${chapters.length}`,
        title: chapterTitle,
        level,
        contentHtml: paragraphs.join('\n'),
        sentences: chapterSentences,
      });
    }

    // Рекурсивный обход подсекций
    const subSections = sec.querySelectorAll(':scope > section');
    subSections.forEach((subSec) => processSection(subSec, level + 1));
  }

  if (sections.length > 0) {
    sections.forEach((sec) => processSection(sec, 1));
  } else {
    // Вся книга в одной секции без разделов
    processSection(mainBody, 1);
  }

  // Если главы не выделились, собираем все параграфы тела
  if (chapters.length === 0) {
    const pElements = mainBody.querySelectorAll('p');
    const paragraphs: string[] = [];
    const chapterSentences: SentenceItem[] = [];
    let pIndex = 0;

    pElements.forEach((p) => {
      const pText = p.textContent?.trim() || '';
      if (pText) {
        paragraphs.push(`<p class="my-3 leading-relaxed">${escapeHtml(pText)}</p>`);
        const s = tokenizeSentences(pText, globalSentenceId, pIndex++, userRules, lang);
        chapterSentences.push(...s);
        globalSentenceId += s.length;
      }
    });

    chapters.push({
      id: 'ch_0',
      title: bodyTitle || bookTitle,
      level: 1,
      contentHtml: paragraphs.join('\n'),
      sentences: chapterSentences,
    });
  }

  const bookId = `fb2_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  return {
    metadata: {
      id: bookId,
      title: bookTitle,
      author: authorName,
      lang,
      coverUrl,
      annotation: annotationHtml,
      fileName,
      addedAt: Date.now(),
    },
    chapters,
    notes,
  };
}
