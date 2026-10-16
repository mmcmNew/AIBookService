import * as pdfjsLib from 'pdfjs-dist';
import * as pdfWorkerModule from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Chapter, ParsedBook, PdfBoundingRect, SentenceItem } from '../../types/book';
import { ReplacementRule } from '../../types/settings';
import { tokenizeSentences } from '../tokenizer/sentenceTokenizer';
import { escapeHtml } from './htmlUtil';
import { classifyHeading, detectChapters, type DetectParagraph } from '../cleanup/chapters';
import { headerKey } from '../cleanup/textOps';

// Настройка воркера PDF.js через Vite asset URL
const pdfWorker = (pdfWorkerModule as { default?: string }).default ?? '';
if (pdfWorker) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
}

export class ScannedPdfError extends Error {
  pageCount: number;
  detectedChars: number;
  isScanned: boolean = true;
  isCorruptedLayer?: boolean;

  constructor(message: string, pageCount: number, detectedChars: number, isCorruptedLayer: boolean = false) {
    super(message);
    this.name = 'ScannedPdfError';
    this.pageCount = pageCount;
    this.detectedChars = detectedChars;
    this.isCorruptedLayer = isCorruptedLayer;
  }
}

/**
 * Детектор повреждённого текстового слоя / псевдокириллицы (старого битого OCR).
 * Проверяет характерные маркеры замены кириллицы на похожие ASCII символы (Mbl, 3HaeM, KaK, qTo, rrerKO, )J().
 */
export function checkCorruptedTextLayer(sampleText: string): { isCorrupted: boolean; reason?: string } {
  if (!sampleText || sampleText.length < 50) return { isCorrupted: false };

  const cyrillicMatches = sampleText.match(/[а-яА-ЯёЁ]/g) || [];
  const latinMatches = sampleText.match(/[a-zA-Z]/g) || [];
  const totalLetters = cyrillicMatches.length + latinMatches.length;

  if (totalLetters < 30) return { isCorrupted: false };

  const cyrillicRatio = cyrillicMatches.length / totalLetters;

  if (cyrillicRatio > 0.7) return { isCorrupted: false };

  const pseudoPatterns = [
    /\bMbl\b/,            // Мы
    /\b3Hae[a-zA-Z]*/,    // знаем, знаете
    /\b[Kk]a[Kk]\b/,      // как
    /\b[qQ][tT]o\b/,      // что
    /\brrer[Kk][Oo]\b/,   // легко
    /\b[cC][eE]\s+Mbl\b/, // все мы
    /\)[Jj]\(/,           // буква ж: )J(
    /\bCTOJIK/i,          // столк...
    /\b[Bb]eqep/i,        // вечер...
    /\b[Tt]pe[Bb][Oo]/i,  // трево...
    /[a-zA-Z]{2,};[a-zA-Z]{2,}/, // точка с запятой внутри псевдослова (rrosp;HlilM)
    /\blilC/i,            // исп...
    /\b3K3a/i,            // экза...
    /\b[Hh]a\s+ymu/i,     // на улице
  ];

  let matchesCount = 0;
  for (const pattern of pseudoPatterns) {
    if (pattern.test(sampleText)) matchesCount++;
  }

  if (matchesCount >= 2 && cyrillicRatio < 0.45) {
    return {
      isCorrupted: true,
      reason: 'Обнаружен повреждённый текстовый слой (псевдокириллица старого OCR: "ce Mbl 3HaeM...")'
    };
  }

  return { isCorrupted: false };
}

interface TextLine {
  pageNumber: number;
  y: number;
  x: number;
  width: number;
  height: number;
  fontSize: number;
  text: string;
}

interface ParagraphBlock {
  text: string;
  isHeading: boolean;
  headingText?: string;
  lines: TextLine[];
  pageNumber: number;
  /** Высота шрифта строки относительно медианной (для определения глав) */
  heightRatio?: number;
  /** Первая строка страницы */
  newPage?: boolean;
}

import { extractCover, loadOutline } from '../pdf/pdfjsDoc';
export { extractCover, loadOutline };

/**
 * Клиентский парсер PDF с сохранением точных координат предложений
 * для подсветки поверх оригинального Canvas.
 */
export async function parsePDF(
  fileBuffer: ArrayBuffer,
  fileName: string,
  userRules: ReplacementRule[] = []
): Promise<ParsedBook> {
  const startTime = performance.now();
  console.log(`[PDF Parser] 🚀 Старт парсинга: "${fileName}", размер: ${(fileBuffer.byteLength / 1024).toFixed(1)} KB`);

  // Делаем копию буфера для воркера, чтобы исходный буфер не отсоединился (detach)
  const workerData = new Uint8Array(fileBuffer.slice(0));
  const rawPdfBufferCopy = fileBuffer.slice(0);

  let pdfDoc: any;
  try {
    const loadingTask = pdfjsLib.getDocument({
      data: workerData,
      cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/cmaps/',
      cMapPacked: true,
      isEvalSupported: false, // совместимо со строгой CSP (без unsafe-eval)
    });
    pdfDoc = await loadingTask.promise;
  } catch (docErr: any) {
    console.error('[PDF Parser] ❌ Ошибка pdfjsLib.getDocument:', docErr);
    throw new Error(`Не удалось открыть PDF документ: ${docErr.message || docErr}`);
  }

  const numPages = pdfDoc.numPages;
  console.log(`[PDF Parser] 📄 Документ загружен. Всего страниц: ${numPages}`);

  if (numPages === 0) {
    throw new Error('PDF-документ не содержит страниц.');
  }

  // 1. Метаданные PDF
  let title = fileName.replace(/\.[^/.]+$/, '');
  let author = 'Не указан';
  let coverUrl: string | undefined = undefined;

  try {
    const meta = await pdfDoc.getMetadata();
    const info = meta?.info as any;
    if (info) {
      if (info.Title && typeof info.Title === 'string' && info.Title.trim().length > 1) {
        title = info.Title.trim();
      }
      if (info.Author && typeof info.Author === 'string' && info.Author.trim().length > 1) {
        author = info.Author.trim();
      }
    }
    console.log(`[PDF Parser] 🏷️ Метаданные: название="${title}", автор="${author}"`);
  } catch (e) {
    console.warn('[PDF Parser] ⚠️ Не удалось прочитать метаданные:', e);
  }

  // 2. Рендер обложки
  try {
    console.log('[PDF Parser] 🖼️ Рендеринг обложки из 1-й страницы...');
    const firstPage = await pdfDoc.getPage(1);
    coverUrl = await extractCover(firstPage);
    if (coverUrl) {
      console.log('[PDF Parser] ✅ Обложка успешно сформирована');
    }
  } catch (e) {
    console.warn('[PDF Parser] ⚠️ Ошибка рендера первой страницы:', e);
  }

  // 3. Постраничный сбор текста и геометрических координат
  const allLines: TextLine[] = [];
  let totalCharsCount = 0;

  console.log(`[PDF Parser] ⏳ Извлечение текстового слоя из ${numPages} страниц...`);

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.0 });
    const pageHeight = viewport.height;
    const pageWidth = viewport.width;

    const textContent = await page.getTextContent();
    const items = textContent.items as any[];

    // Отсекаем колонтитулы (верхние 6% и нижние 6% высоты страницы)
    const topMarginCutoff = pageHeight * 0.94;
    const bottomMarginCutoff = pageHeight * 0.06;

    const pageItems: Array<{
      pageNumber: number;
      x: number;
      y: number;
      width: number;
      height: number;
      str: string;
      fontSize: number;
    }> = [];

    let pageChars = 0;

    for (const item of items) {
      if (!item.str || !item.str.trim()) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      const fontSize = Math.abs(item.transform[0]) || 12;
      const width = item.width || item.str.length * fontSize * 0.55;
      const height = item.height || fontSize;

      const isMargin = y > topMarginCutoff || y < bottomMarginCutoff;
      const isLikelyPageNum = /^\d{1,4}$/.test(item.str.trim());
      const isShortHeader = item.str.trim().length < 40;

      if (isMargin && (isLikelyPageNum || isShortHeader)) {
        continue;
      }

      pageItems.push({
        pageNumber: pageNum,
        x,
        y,
        width,
        height,
        str: item.str,
        fontSize,
      });

      pageChars += item.str.trim().length;
      totalCharsCount += item.str.trim().length;
    }

    // Детекция колонок
    const midX = pageWidth / 2;
    const leftColItems = pageItems.filter(it => it.x + 20 < midX);
    const rightColItems = pageItems.filter(it => it.x >= midX);
    const isTwoColumn =
      leftColItems.length > 15 &&
      rightColItems.length > 15 &&
      Math.abs(leftColItems.length - rightColItems.length) < leftColItems.length * 0.7;

    let sortedItems: typeof pageItems;
    if (isTwoColumn) {
      leftColItems.sort((a, b) => b.y - a.y || a.x - b.x);
      rightColItems.sort((a, b) => b.y - a.y || a.x - b.x);
      sortedItems = [...leftColItems, ...rightColItems];
    } else {
      sortedItems = pageItems.sort((a, b) => {
        const yDiff = Math.abs(a.y - b.y);
        if (yDiff <= 4) return a.x - b.x;
        return b.y - a.y;
      });
    }

    // Группировка в строки
    let currentLine: TextLine | null = null;
    let pageLinesCount = 0;

    for (const item of sortedItems) {
      if (!currentLine) {
        currentLine = {
          pageNumber: pageNum,
          y: item.y,
          x: item.x,
          width: item.width,
          height: item.height,
          fontSize: item.fontSize,
          text: item.str,
        };
      } else if (Math.abs(currentLine.y - item.y) <= 4) {
        currentLine.text += (currentLine.text.endsWith(' ') ? '' : ' ') + item.str;
        const rightEdge = Math.max(currentLine.x + currentLine.width, item.x + item.width);
        currentLine.width = rightEdge - currentLine.x;
        currentLine.height = Math.max(currentLine.height, item.height);
      } else {
        allLines.push(currentLine);
        pageLinesCount++;
        currentLine = {
          pageNumber: pageNum,
          y: item.y,
          x: item.x,
          width: item.width,
          height: item.height,
          fontSize: item.fontSize,
          text: item.str,
        };
      }
    }
    if (currentLine) {
      allLines.push(currentLine);
      pageLinesCount++;
    }

    if (pageNum % 10 === 0 || pageNum === numPages) {
      console.log(`[PDF Parser] ⏳ Прогресс: стр. ${pageNum}/${numPages} (${pageChars} симв., ${pageLinesCount} строк)`);
    }
  }

  const avgCharsPerPage = totalCharsCount / numPages;
  console.log(`[PDF Parser] 📊 Всего символов: ${totalCharsCount}, среднее: ${avgCharsPerPage.toFixed(1)} на страницу`);

  // ПРОВЕРКА НА СКАН
  if (totalCharsCount < 80 || avgCharsPerPage < 40) {
    console.warn(`[PDF Parser] ⚠️ Документ определен как скан (${avgCharsPerPage.toFixed(1)} симв./стр.)`);
    throw new ScannedPdfError(
      `PDF-файл не содержит текстового слоя (в среднем ${Math.round(avgCharsPerPage)} симв./стр.). Скорее всего это скан. Рекомендуется распознавание через AI (Gemini OCR).`,
      numPages,
      totalCharsCount
    );
  }

  // ПРОВЕРКА НА ПОВРЕЖДЕННЫЙ ТЕКСТОВЫЙ СЛОЙ (ПСЕВДОКИРИЛЛИЦУ)
  const sampleText = allLines.slice(0, 150).map((l) => l.text).join(' ');
  const corruptedCheck = checkCorruptedTextLayer(sampleText);
  if (corruptedCheck.isCorrupted) {
    console.warn(`[PDF Parser] ⚠️ ${corruptedCheck.reason}`);
    throw new ScannedPdfError(
      'В этом PDF обнаружен повреждённый текстовый слой (псевдокириллица старого OCR: слова вида "ce Mbl 3HaeM, KaK rrerKO..."). Для качественного чтения необходимо оптическое распознавание через встроенный PyMuPDF (Tesseract OCR) или AI (Gemini OCR).',
      numPages,
      totalCharsCount,
      true
    );
  }

  // Медианный размер шрифта и повторяющиеся строки-колонтитулы (одинаковый короткий текст на 4+ страницах)
  const sizes = allLines.filter((l) => l.text.trim().length > 25).map((l) => l.fontSize).sort((a, b) => a - b);
  const medianFont = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  const pagesByKey = new Map<string, Set<number>>();
  for (const l of allLines) {
    const t = l.text.trim();
    if (t.length < 3 || t.length > 80 || /[.!?…»"]$/.test(t)) continue;
    const key = headerKey(t);
    const set = pagesByKey.get(key);
    if (set) set.add(l.pageNumber);
    else pagesByKey.set(key, new Set([l.pageNumber]));
  }
  const isRunningHeader = (t: string) =>
    !/^(глава|часть|раздел|chapter|part)\s/i.test(t) && (pagesByKey.get(headerKey(t))?.size ?? 0) >= 4;

  // 4. Сборка абзацев и дегифенация
  console.log('[PDF Parser] 🧩 Сборка строк в абзацы и устранение переносов слов...');
  const paragraphs: ParagraphBlock[] = [];
  let currentBlockLines: TextLine[] = [];
  let pendingText = '';

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    const trimmed = line.text.trim();
    if (!trimmed) continue;

    if (isRunningHeader(trimmed)) continue; // колонтитул, повторяющийся на страницах

    const heightRatio = medianFont > 0 ? line.fontSize / medianFont : undefined;
    const newPage = i === 0 || allLines[i - 1].pageNumber !== line.pageNumber;
    const headingInfo = classifyHeading({ text: trimmed, heightRatio, newPage });
    // Нумерованные пункты и «жирные строки» на уровне строки слишком шумные — их решает общий алгоритм по тексту
    const isHeading = headingInfo !== null && !['numbered', 'bold', 'weak'].includes(headingInfo.reason);

    if (isHeading) {
      if (pendingText.trim() && currentBlockLines.length > 0) {
        paragraphs.push({
          text: cleanText(pendingText),
          isHeading: false,
          lines: [...currentBlockLines],
          pageNumber: currentBlockLines[0].pageNumber,
        });
        currentBlockLines = [];
        pendingText = '';
      }
      paragraphs.push({
        text: trimmed,
        isHeading: true,
        headingText: trimmed,
        lines: [line],
        pageNumber: line.pageNumber,
        heightRatio,
        newPage,
      });
      continue;
    }

    if (pendingText.endsWith('-')) {
      pendingText = pendingText.slice(0, -1) + trimmed;
    } else if (pendingText.endsWith('–') || pendingText.endsWith('—')) {
      pendingText += ' ' + trimmed;
    } else if (pendingText) {
      pendingText += ' ' + trimmed;
    } else {
      pendingText = trimmed;
    }
    currentBlockLines.push(line);

    const isSentenceEnd = /[.!?…]["»]?$/.test(trimmed);
    const isNextIndented = i + 1 < allLines.length && (allLines[i + 1].x > line.x + 10);

    if (isSentenceEnd && isNextIndented) {
      paragraphs.push({
        text: cleanText(pendingText),
        isHeading: false,
        lines: [...currentBlockLines],
        pageNumber: currentBlockLines[0].pageNumber,
      });
      currentBlockLines = [];
      pendingText = '';
    }
  }

  if (pendingText.trim() && currentBlockLines.length > 0) {
    paragraphs.push({
      text: cleanText(pendingText),
      isHeading: false,
      lines: [...currentBlockLines],
      pageNumber: currentBlockLines[0].pageNumber,
    });
  }

  console.log(`[PDF Parser] 📝 Сформировано абзацев: ${paragraphs.length}. Токенизация предложений...`);

  // 5. Определение глав: оглавление PDF -> заголовки (шрифт, «Глава N», КАПС ...) -> разбиение по размеру
  const outline = await loadOutline(pdfDoc);
  const detectInput: DetectParagraph[] = paragraphs.map((para) => ({
    text: para.text,
    page: para.pageNumber,
    forced: para.isHeading,
    heightRatio: para.heightRatio,
    newPage: para.newPage,
  }));
  const detection = detectChapters(detectInput, { outline });
  console.log(
    `[PDF Parser] 📚 Определение глав: метод=${detection.method}, глав=${detection.chapters.length}, оглавление PDF: ${outline.length} пунктов`
  );
  const plan =
    detection.chapters.length > 0
      ? detection.chapters
      : [{ title: 'Начало', level: 1, headingIndex: null as number | null, items: paragraphs.map((_, i) => i) }];

  console.log(`[PDF Parser] 📝 Сформировано абзацев: ${paragraphs.length}. Токенизация предложений...`);

  const chapters: Chapter[] = [];
  let globalSentenceId = 0;

  for (const planned of plan) {
    const chapterSentences: SentenceItem[] = [];
    const chapterHtml: string[] = [];
    let pIndex = 0;

    for (const idx of planned.items) {
      const para = paragraphs[idx];
      if (!para.text) continue;

      chapterHtml.push(`<p class="my-3 leading-relaxed">${escapeHtml(para.text)}</p>`);
      const rawSentences = tokenizeSentences(para.text, globalSentenceId, pIndex++, userRules, 'ru');

      let searchStartChar = 0;
      for (const sentence of rawSentences) {
        const sentenceText = sentence.rawText;
        const charIndexInPara = para.text.indexOf(sentenceText, searchStartChar);
        const startIdx = charIndexInPara >= 0 ? charIndexInPara : searchStartChar;
        const endIdx = startIdx + sentenceText.length;
        searchStartChar = endIdx;

        const sentenceRects: PdfBoundingRect[] = [];
        let accumulatedChars = 0;

        for (const line of para.lines) {
          const lineLen = line.text.length + 1;
          const lineStart = accumulatedChars;
          const lineEnd = accumulatedChars + lineLen;
          accumulatedChars = lineEnd;

          const overlapStart = Math.max(startIdx, lineStart);
          const overlapEnd = Math.min(endIdx, lineEnd);

          if (overlapStart < overlapEnd && line.width > 0) {
            const ratioStart = Math.max(0, (overlapStart - lineStart) / lineLen);
            const ratioEnd = Math.min(1, (overlapEnd - lineStart) / lineLen);

            const subX = line.x + ratioStart * line.width;
            const subWidth = Math.max((ratioEnd - ratioStart) * line.width, 8);

            sentenceRects.push({
              pageNumber: line.pageNumber,
              x: Math.round(subX),
              y: Math.round(line.y),
              width: Math.round(subWidth),
              height: Math.round(line.height || 12),
            });
          }
        }

        sentence.pageNumber = sentenceRects[0]?.pageNumber || para.pageNumber;
        sentence.pdfRects = sentenceRects;
        chapterSentences.push(sentence);
        globalSentenceId++;
      }
    }

    if (chapterSentences.length === 0 && chapters.length > 0) continue;
    const firstPara = paragraphs[planned.headingIndex ?? planned.items[0]];
    chapters.push({
      id: `pdf_ch_${chapters.length}`,
      title: planned.title,
      level: planned.level,
      pageNumber: firstPara?.pageNumber,
      contentHtml: chapterHtml.join(String.fromCharCode(10)),
      sentences: chapterSentences,
    });
  }

  const bookId = `pdf_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const durationSec = ((performance.now() - startTime) / 1000).toFixed(2);

  console.log(
    `[PDF Parser] ✅ Успешно распарсено за ${durationSec}с! Глав: ${chapters.length}, Предложений: ${globalSentenceId}, ID: ${bookId}`
  );

  return {
    metadata: {
      id: bookId,
      title,
      author,
      lang: 'ru',
      coverUrl,
      fileName,
      addedAt: Date.now(),
    },
    chapters,
    notes: {},
    rawPdfBuffer: rawPdfBufferCopy,
  };
}

function cleanText(text: string): string {
  return text
    .replace(/\u00A0/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .replace(/\s+([.,!?:;])/g, '$1')
    .trim();
}
