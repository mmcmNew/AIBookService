import { Chapter, ParsedBook, SentenceItem } from '../../types/book';
import { ReplacementRule } from '../../types/settings';
import { parseFB2 } from './fb2Parser';
import { parseEPUB } from './epubParser';
import { parseTXT } from './txtParser';
import { parsePDF, ScannedPdfError } from './pdfParser';
import { parseWithFoliate } from './foliateParser';
import { tokenizeSentences } from '../tokenizer/sentenceTokenizer';
import { escapeHtml } from './htmlUtil';
import { stripMarkdown } from '../cleanup/markdown';
import { detectShiftedCyrillic } from '../cleanup/shiftedCyrillic';
import { normalizeWhitespace, removeControlChars } from '../cleanup/textOps';
import { detectChapters, type DetectParagraph, type OutlineEntry } from '../cleanup/chapters';
import { createPagedPdfBook } from '../pdf/createPagedBook';
import { resolvePdfTarget } from '../pdf/engineChoice';
import { isSidecarAvailable } from './pdfSidecar';
import { useSettingsStore } from '../../store/settingsStore';
import { normalizeBookFile } from './formatDetector';

const DEFAULT_SERVER_URL: string =
  (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:4000';

export { ScannedPdfError };

/** Запоминает, каким режимом распознан PDF (нужно для рекомендаций по качеству текста). */
function withPdfMode(book: ParsedBook, mode: 'pdfjs' | 'pymupdf' | 'gemini'): ParsedBook {
  book.metadata.pdfMode = mode;
  return book;
}

export interface ParseOptions {
  pdfMode?: 'pdfjs' | 'pymupdf' | 'gemini' | 'ocr';
  /** Принудительно открыть PDF через pdfjs даже при подозрении на скан/битый слой */
  pdfForce?: boolean;
  /** true — старый режим «целиком» (pdfjs/PyMuPDF/Gemini за один проход) вместо постраничного */
  pdfLegacy?: boolean;
  serverUrl?: string;
  /** Необязательный токен; отправляется как Authorization: Bearer <token> на серверные эндпоинты. */
  authToken?: string;
}

/**
 * Главная точка входа для разбора любых форматов книг:
 * - EPUB, MOBI, AZW3, FB2, FB2.ZIP (через Foliate-js с fallback на нативные парсеры)
 * - PDF (клиентский pdfjs-dist с возможностью переключения на PyMuPDF4LLM или Gemini OCR)
 * - TXT (структурированный текстовый парсер)
 */
export async function parseBookFile(
  rawFile: File,
  userRules: ReplacementRule[] = [],
  options: ParseOptions = {}
): Promise<ParsedBook> {
  const file = await normalizeBookFile(rawFile);
  const fileNameLower = file.name.toLowerCase();

  // 1. PDF файлы
  if (fileNameLower.endsWith('.pdf')) {
    console.log(`[ParserHub] 📑 Выбран PDF файл: "${file.name}", режим: ${options.pdfMode || 'pdfjs'}${options.pdfLegacy ? ' (целиком)' : ' (постранично)'}`);
    if (!options.pdfLegacy) {
      const target = resolvePdfTarget(options.pdfMode, {
        sidecar: isSidecarAvailable(),
        geminiKey: useSettingsStore.getState().apiKeys.gemini,
      });
      if (target.kind === 'unavailable') throw new Error(target.reason);
      if (target.kind === 'paged') {
        try {
          return await createPagedPdfBook(file, target.engine, options.pdfForce);
        } catch (err) {
          // Запасной путь: sidecar недоступен (нет exe) — старый режим «целиком»
          const sidecarEngine = target.engine === 'auto' || target.engine === 'ocr' || target.engine === 'text';
          if (sidecarEngine && !(err as { isScanned?: boolean })?.isScanned) {
            console.warn('[ParserHub] Постраничный sidecar недоступен, запасной режим «целиком»:', err);
            return withPdfMode(await parsePdfPyMuPdf(file, userRules, options.serverUrl, options.authToken), 'pymupdf');
          }
          throw err;
        }
      }
      options = { ...options, pdfMode: target.mode };
    }
    if (options.pdfMode === 'pymupdf') {
      console.log('[ParserHub] 🐍 Запуск режима PyMuPDF4LLM (целиком)...');
      return withPdfMode(await parsePdfPyMuPdf(file, userRules, options.serverUrl, options.authToken), 'pymupdf');
    }
    if (options.pdfMode === 'gemini') {
      console.log('[ParserHub] ✨ Запуск серверного режима Gemini AI OCR (целиком)...');
      return withPdfMode(await parsePdfRemote(file, 'gemini', userRules, options.serverUrl, options.authToken), 'gemini');
    }
    // Запасной режим: клиентский парсер pdfjs-dist целиком
    console.log('[ParserHub] ⚡ Запуск клиентского парсера pdfjs-dist (целиком)...');
    const buffer = await file.arrayBuffer();
    return withPdfMode(await parsePDF(buffer, file.name, userRules), 'pdfjs');
  }

  // 2. Форматы Foliate-js (EPUB, FB2, MOBI, AZW3, CBZ)
  const isFoliateCandidate = 
    fileNameLower.endsWith('.epub') ||
    fileNameLower.endsWith('.fb2') ||
    fileNameLower.endsWith('.fb2.zip') ||
    fileNameLower.endsWith('.fbz') ||
    fileNameLower.endsWith('.mobi') ||
    fileNameLower.endsWith('.azw') ||
    fileNameLower.endsWith('.azw3') ||
    fileNameLower.endsWith('.cbz');

  if (isFoliateCandidate) {
    try {
      return await parseWithFoliate(file, userRules);
    } catch (foliateErr) {
      console.warn('Foliate-js парсинг завершился ошибкой, запуск fallback парсера:', foliateErr);

      // Fallback для FB2 / FB2.ZIP
      if (
        fileNameLower.endsWith('.fb2') ||
        fileNameLower.endsWith('.fb2.zip') ||
        fileNameLower.endsWith('.fbz')
      ) {
        const buffer = await file.arrayBuffer();
        return parseFB2(buffer, file.name, userRules);
      }

      // Fallback для EPUB
      if (fileNameLower.endsWith('.epub')) {
        const buffer = await file.arrayBuffer();
        return parseEPUB(buffer, file.name, userRules);
      }

      throw foliateErr;
    }
  }

  // 3. Простой текст (TXT)
  if (fileNameLower.endsWith('.txt')) {
    const text = await file.text();
    return parseTXT(text, file.name, userRules);
  }

  throw new Error(
    `Формат файла "${file.name}" пока не поддерживается.\nПоддерживаются: FB2, EPUB, MOBI, AZW3, PDF, TXT.`
  );
}

/**
 * Парсинг PDF через PyMuPDF4LLM:
 * В десктопном приложении (Tauri) запускает встроенный автономный бинарник pdf_processor (Sidecar)
 * без необходимости иметь установленный Python или Node.js сервер.
 * В браузерной версии автоматически выполняет fallback на локальный/удаленный HTTP-сервер.
 */
export async function parsePdfPyMuPdf(
  file: File,
  userRules: ReplacementRule[] = [],
  serverUrl: string = DEFAULT_SERVER_URL,
  authToken?: string
): Promise<ParsedBook> {
  const isTauri = typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
  const rawBuffer = await file.arrayBuffer();

  if (isTauri) {
    try {
      console.log('[ParserHub] 🚀 Запуск встроенного PyMuPDF4LLM через Tauri Sidecar (автономный exe)...');
      const { invoke } = await import('@tauri-apps/api/core');
      const jsonStr = await invoke<string>('parse_pdf_local', {
        fileBytes: Array.from(new Uint8Array(rawBuffer)),
        fileName: file.name,
      });

      const parsedData = JSON.parse(jsonStr);
      console.log('[ParserHub] ✅ Встроенный pdf_processor успешно обработал файл!');
      const parsedBook = convertRawChaptersToParsedBook(parsedData, file.name, userRules);
      parsedBook.rawPdfBuffer = rawBuffer;
      return parsedBook;
    } catch (err: any) {
      console.warn('[ParserHub] ⚠️ Ошибка встроенного Sidecar, пробуем серверный fallback:', err);
    }
  }

  // Fallback: обычный HTTP вызов на serverUrl /api/pdf/parse-python
  return parsePdfRemote(file, 'pymupdf', userRules, serverUrl, authToken);
}

/**
 * Серверный вызов PyMuPDF4LLM (Python) или Gemini OCR для PDF
 */
export async function parsePdfRemote(
  file: File,
  mode: 'pymupdf' | 'gemini',
  userRules: ReplacementRule[] = [],
  serverUrl: string = DEFAULT_SERVER_URL,
  authToken?: string
): Promise<ParsedBook> {
  const base64 = await fileToBase64(file);
  const rawBuffer = await file.arrayBuffer();
  const endpoint = mode === 'pymupdf' ? '/api/pdf/parse-python' : '/api/pdf/parse-gemini';

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const response = await fetch(`${serverUrl.replace(/\/+$/, '')}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      fileName: file.name,
      fileBase64: base64,
    }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(errData.error || `Ошибка сервера (${response.status}) при парсинге PDF.`);
  }

  const result = await response.json();
  if (!result.data) {
    throw new Error('Сервер не вернул данные книги.');
  }

  const parsedBook = convertRawChaptersToParsedBook(result.data, file.name, userRules);
  parsedBook.rawPdfBuffer = rawBuffer;
  return parsedBook;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Автоматическая безопасная очистка: Markdown (**, _, #), U+FFFD и управляющие символы, лишние пробелы. */
function safeClean(text: string): string {
  const md = stripMarkdown(text ?? '');
  // Управляющие символы 0x10–0x1F в «сдвинутой кириллице» — это заглавные А–П: не удаляем их до исправления
  return normalizeWhitespace(detectShiftedCyrillic(md).isShifted ? md : removeControlChars(md));
}

function convertRawChaptersToParsedBook(
  rawBook: {
    metadata?: any;
    chapters: Array<{ title: string; paragraphs: string[] }>;
    /** Оглавление PDF (PyMuPDF get_toc): [уровень, название, страница] */
    toc?: Array<[number, string, number] | { level?: number; title: string; page?: number }>;
  },
  fileName: string,
  userRules: ReplacementRule[] = []
): ParsedBook {
  // Плоский список абзацев ДО очистки: Markdown-заголовки (#, **Глава**) нужны для определения глав.
  // Заголовки глав от распознавателя считаем подсказкой, кроме служебных («Начало», «Страница N»).
  const flat: DetectParagraph[] = [];
  const GENERIC = /^(начало|основной текст|без названия|страница\s+\d+|page\s+\d+)$/i;
  for (const rawCh of rawBook.chapters || []) {
    const t = safeClean(rawCh.title || '');
    if (t && !GENERIC.test(t)) flat.push({ text: t, forced: true });
    for (const para of rawCh.paragraphs || []) {
      if (para && para.trim()) flat.push({ text: para });
    }
  }
  const outline: OutlineEntry[] = (rawBook.toc || []).map((e) =>
    Array.isArray(e) ? { level: e[0], title: String(e[1] ?? ''), page: e[2] } : { level: e.level, title: e.title, page: e.page }
  );
  const detection = detectChapters(flat, { outline });
  const plan =
    detection.chapters.length > 0
      ? detection.chapters
      : [{ title: 'Основной текст', level: 1, headingIndex: null as number | null, items: flat.map((_, i) => i) }];
  console.log(
    `[ParserHub] Главы: метод=${detection.method}, найдено=${plan.length}, пунктов оглавления=${outline.length}`
  );

  const chapters: Chapter[] = [];
  let globalSentenceId = 0;

  for (let cIdx = 0; cIdx < plan.length; cIdx++) {
    const planned = plan[cIdx];
    const chapterSentences: SentenceItem[] = [];
    const htmlParagraphs: string[] = [];
    let pIndex = 0;

    for (const idx of planned.items) {
      // Безопасная автоочистка результата внешних распознавателей: Markdown-разметка и мусорные символы
      const trimmed = safeClean(flat[idx].text);
      if (!trimmed) continue;

      htmlParagraphs.push(`<p class="my-3 leading-relaxed">${escapeHtml(trimmed)}</p>`);
      const s = tokenizeSentences(trimmed, globalSentenceId, pIndex++, userRules, 'ru');
      chapterSentences.push(...s);
      globalSentenceId += s.length;
    }

    if (chapterSentences.length > 0) {
      chapters.push({
        id: `pdf_rem_${cIdx}`,
        title: safeClean(planned.title) || `Раздел ${cIdx + 1}`,
        level: planned.level || 1,
        contentHtml: htmlParagraphs.join(String.fromCharCode(10)),
        sentences: chapterSentences,
      });
    }
  }

  const bookId = `pdf_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  return {
    metadata: {
      id: bookId,
      title: rawBook.metadata?.title || fileName.replace(/\.[^/.]+$/, ''),
      author: rawBook.metadata?.author || 'Не указан',
      coverUrl: rawBook.metadata?.coverUrl,
      fileName,
      lang: 'ru',
      addedAt: Date.now(),
    },
    chapters,
    notes: {},
  };
}
