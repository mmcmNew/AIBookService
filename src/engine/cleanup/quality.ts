import { hasMarkdownMarkers } from './markdown';
import { detectShiftedCyrillic } from './shiftedCyrillic';
import { findRepeatedHeaders, isMixedScriptWord, isPageNumber, isRepeatedHeader } from './textOps';
import type {
  CleanupOp,
  QualityIssue,
  QualityMetrics,
  QualityOptions,
  QualityReport,
  QualitySeverity,
  TextChapter,
} from './types';

/** Что угодно, из чего можно получить абзацы: готовые абзацы или предложения книги. */
export interface ChapterLike {
  id?: string;
  title?: string;
  paragraphs?: string[];
  sentences?: Array<{ rawText: string; paragraphIndex: number }>;
}

/** Абзацы главы: готовые либо собранные из предложений по paragraphIndex. */
export function chapterParagraphs(chapter: ChapterLike): string[] {
  if (chapter.paragraphs) return chapter.paragraphs;
  const out: string[] = [];
  let lastIndex = Number.NaN;
  for (const s of chapter.sentences ?? []) {
    if (s.paragraphIndex === lastIndex && out.length > 0) {
      out[out.length - 1] += ' ' + s.rawText;
    } else {
      out.push(s.rawText);
      lastIndex = s.paragraphIndex;
    }
  }
  return out;
}

export function toTextChapters(chapters: ChapterLike[]): TextChapter[] {
  return chapters.map((c, i) => ({
    id: c.id ?? String(i),
    title: c.title ?? '',
    paragraphs: chapterParagraphs(c),
  }));
}

const WORD_RE = /\p{L}+(?:[-'’]\p{L}+)*/gu;
const VOWEL_RE = /[аеёиоуыэюяaeiouyAEIOUYАЕЁИОУЫЭЮЯ]/;
const KNOWN_PUNCT = /[\s\d.,;:!?…"'«»„“”‘’()[\]{}<>\-–—‒/\\%№&@#$€₽*+=_~^|°§¶•·©®™`]/;

/** Допустимые ASCII-символы текста: пробелы, цифры, обычная пунктуация. */
function isKnownAscii(code: number): boolean {
  if (code >= 48 && code <= 57) return true; // цифры
  return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}

function isCyrillicLang(lang: string): boolean {
  return /^(ru|uk|be|bg|sr|mk|kk)(-|$)/i.test(lang);
}

function isLatinLang(lang: string): boolean {
  return /^(en|de|fr|es|it|pt|nl|pl|cs|sv|da|no|fi|tr)(-|$)/i.test(lang);
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const pct = (r: number) => `${(r * 100).toFixed(r >= 0.1 ? 0 : 1).replace(/\.0$/, '')}%`;

/**
 * Оценивает качество распознанного текста книги. Чистая функция, работает за один проход по тексту.
 * @param chapters главы (с абзацами или предложениями)
 * @param lang ожидаемый язык книги (ru, en ...)
 */
export function assessTextQuality(chapters: ChapterLike[], lang = 'ru', options: QualityOptions = {}): QualityReport {
  const text = toTextChapters(chapters);
  const paragraphsAll = text.flatMap((c) => c.paragraphs);
  const paragraphCount = paragraphsAll.length;

  let chars = 0;
  let replacement = 0;
  let control = 0;
  let nonLetters = 0;
  let letters = 0;
  let cyr = 0;
  let lat = 0;
  let words = 0;
  let shortWords = 0;
  let noVowelWords = 0;
  let mixedWords = 0;
  let markdownParas = 0;
  let shiftedParas = 0;
  let lowercaseStarts = 0;
  let hyphenLeftovers = 0;
  let pageNumberParas = 0;
  let emptyChapters = 0;
  let nonEmptyParas = 0;

  const headers = findRepeatedHeaders(text.map((c) => c.paragraphs));
  let repeatedHeaderParas = 0;

  for (const ch of text) {
    const chText = ch.paragraphs.join('');
    if (!/[\p{L}\p{N}]/u.test(chText)) emptyChapters++;
    for (const p of ch.paragraphs) {
      if (!p.trim()) continue;
      nonEmptyParas++;
      chars += p.length;

      for (let i = 0; i < p.length; i++) {
        const code = p.charCodeAt(i);
        if (code === 0xfffd) replacement++;
        else if (code < 32 && code !== 9 && code !== 10 && code !== 13) control++;
        else if (code >= 0x7f && code <= 0x9f) control++;
      }

      if (hasMarkdownMarkers(p)) markdownParas++;
      if (detectShiftedCyrillic(p).isShifted) shiftedParas++;
      if (/^\p{Ll}/u.test(p.trim())) lowercaseStarts++;
      if (isPageNumber(p)) pageNumberParas++;
      else if (isRepeatedHeader(p, headers)) repeatedHeaderParas++;
      const hy = p.match(/\p{L}-\s+\p{Ll}|\p{L}-$/gu);
      if (hy) hyphenLeftovers += hy.length;

      for (const m of p.matchAll(WORD_RE)) {
        const w = m[0];
        words++;
        const lettersOnly = w.replace(/[-'’]/g, '');
        const len = lettersOnly.length;
        if (len <= 2) shortWords++;
        if (len >= 4 && !VOWEL_RE.test(lettersOnly)) noVowelWords++;
        if (isMixedScriptWord(lettersOnly)) mixedWords++;
      }

      for (let k = 0; k < p.length; k++) {
        const code = p.charCodeAt(k);
        if (code < 128) {
          if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
            lat++;
            letters++;
          } else if (!isKnownAscii(code)) {
            nonLetters++;
          }
        } else if (code >= 0x400 && code <= 0x52f) {
          cyr++;
          letters++;
        } else {
          const ch2 = p[k];
          if (/\p{L}/u.test(ch2)) letters++;
          else if (!KNOWN_PUNCT.test(ch2) && code !== 0xfffd) nonLetters++;
        }
      }
    }
  }

  const ratio = (n: number, d: number) => (d > 0 ? n / d : 0);
  const metrics: QualityMetrics = {
    chars,
    words,
    paragraphs: nonEmptyParas,
    chapters: text.length,
    replacementCharRatio: ratio(replacement, chars),
    controlCharRatio: ratio(control, chars),
    markdownParagraphRatio: ratio(markdownParas, nonEmptyParas),
    shiftedParagraphRatio: ratio(shiftedParas, nonEmptyParas),
    mixedScriptWordRatio: ratio(mixedWords, words),
    nonLetterRatio: ratio(nonLetters, chars),
    noVowelWordRatio: ratio(noVowelWords, words),
    shortWordRatio: ratio(shortWords, words),
    cyrillicLetterRatio: ratio(cyr, letters),
    latinLetterRatio: ratio(lat, letters),
    emptyChapterRatio: ratio(emptyChapters, text.length),
    lowercaseStartRatio: ratio(lowercaseStarts, nonEmptyParas),
    hyphenLeftovers,
    repeatedHeaderParagraphs: repeatedHeaderParas,
    pageNumberParagraphs: pageNumberParas,
  };

  const issues: QualityIssue[] = [];
  let penalty = 0;
  const add = (
    code: QualityIssue['code'],
    severity: QualitySeverity,
    message: string,
    count: number,
    r: number,
    pen: number,
    fixOps: CleanupOp[] = []
  ) => {
    issues.push({ code, severity, message, count, ratio: r, fixOps });
    penalty += pen;
  };

  if (text.length === 0 || nonEmptyParas === 0) {
    add('EMPTY_BOOK', 'error', 'В книге нет текста. Возможно, это скан без текстового слоя.', 0, 1, 100);
  } else {
    if (letters < 200) {
      add('TOO_LITTLE_TEXT', 'error', `Очень мало текста (${letters} букв). Возможно, файл — скан без текстового слоя.`, letters, 1, 40);
    }
    if (replacement > 0 && metrics.replacementCharRatio > 0.0002) {
      add(
        'REPLACEMENT_CHARS',
        metrics.replacementCharRatio > 0.005 ? 'error' : 'warn',
        `Символы-«ромбики» \uFFFD (нераспознанные знаки): ${replacement} шт. (${pct(metrics.replacementCharRatio)} текста).`,
        replacement,
        metrics.replacementCharRatio,
        Math.min(35, metrics.replacementCharRatio * 2500 + 3),
        ['control']
      );
    }
    if (control > 3) {
      add('CONTROL_CHARS', 'warn', `Управляющие/невидимые символы: ${control} шт.`, control, metrics.controlCharRatio, Math.min(10, 2 + metrics.controlCharRatio * 1000), ['control']);
    }
    if (shiftedParas > 0) {
      add(
        'SHIFTED_CYRILLIC',
        'error',
        `Сдвинутая кириллица (шрифт потерял старший байт, вместо «Тревога» — «"@52>30»): ${shiftedParas} абзац(ев).`,
        shiftedParas,
        metrics.shiftedParagraphRatio,
        Math.min(60, 8 + metrics.shiftedParagraphRatio * 160),
        ['shifted']
      );
    }
    if (markdownParas > 2 && metrics.markdownParagraphRatio > 0.01) {
      add(
        'MARKDOWN',
        'warn',
        `Остатки Markdown-разметки (**, _, #): ${markdownParas} абзац(ев).`,
        markdownParas,
        metrics.markdownParagraphRatio,
        Math.min(15, 3 + metrics.markdownParagraphRatio * 60),
        ['markdown']
      );
    }
    if (mixedWords > 2 && metrics.mixedScriptWordRatio > 0.003) {
      add(
        'MIXED_SCRIPT',
        'warn',
        `Слова со смешением кириллицы и латиницы (латинские двойники букв): ${mixedWords} шт.`,
        mixedWords,
        metrics.mixedScriptWordRatio,
        Math.min(20, 3 + metrics.mixedScriptWordRatio * 400),
        ['mixedScript']
      );
    }
    if (metrics.nonLetterRatio > 0.02 && nonLetters > 10) {
      add(
        'NON_LETTERS',
        metrics.nonLetterRatio > 0.06 ? 'error' : 'warn',
        `Много посторонних знаков (${pct(metrics.nonLetterRatio)} текста) — признак мусора распознавания.`,
        nonLetters,
        metrics.nonLetterRatio,
        Math.min(25, (metrics.nonLetterRatio - 0.01) * 400)
      );
    }
    if (words >= 50 && metrics.noVowelWordRatio > 0.03) {
      add(
        'NO_VOWEL_WORDS',
        metrics.noVowelWordRatio > 0.08 ? 'error' : 'warn',
        `«Слова» без гласных: ${noVowelWords} шт. (${pct(metrics.noVowelWordRatio)} слов).`,
        noVowelWords,
        metrics.noVowelWordRatio,
        Math.min(30, metrics.noVowelWordRatio * 250)
      );
    }
    if (words >= 200 && metrics.shortWordRatio > 0.4) {
      add(
        'SHORT_WORDS',
        metrics.shortWordRatio > 0.5 ? 'error' : 'warn',
        `Слишком много слов из 1–2 букв (${pct(metrics.shortWordRatio)}): слова разорваны пробелами.`,
        shortWords,
        metrics.shortWordRatio,
        Math.min(25, (metrics.shortWordRatio - 0.3) * 120)
      );
    }
    if (letters >= 100) {
      if (isCyrillicLang(lang) && metrics.cyrillicLetterRatio < 0.5) {
        const severe = metrics.cyrillicLetterRatio < 0.2;
        add(
          'LANG_MISMATCH',
          severe ? 'warn' : 'info',
          `Язык книги — «${lang}», но кириллицы в тексте всего ${pct(metrics.cyrillicLetterRatio)}. ` +
            'Это иностранная книга или повреждённый текстовый слой (псевдокириллица).',
          lat,
          1 - metrics.cyrillicLetterRatio,
          severe ? 15 : 8
        );
      } else if (isLatinLang(lang) && metrics.latinLetterRatio < 0.5) {
        add(
          'LANG_MISMATCH',
          'warn',
          `Язык книги — «${lang}», но латиницы в тексте всего ${pct(metrics.latinLetterRatio)}.`,
          cyr,
          1 - metrics.latinLetterRatio,
          12
        );
      }
    }
    if (emptyChapters > 0 && text.length > 1) {
      add(
        'EMPTY_CHAPTERS',
        metrics.emptyChapterRatio > 0.3 ? 'warn' : 'info',
        `Пустые главы: ${emptyChapters} из ${text.length}.`,
        emptyChapters,
        metrics.emptyChapterRatio,
        Math.min(20, metrics.emptyChapterRatio * 60)
      );
    }
    if (nonEmptyParas >= 10 && metrics.lowercaseStartRatio > 0.12) {
      add(
        'BROKEN_PARAGRAPHS',
        'warn',
        `Абзацы, начинающиеся со строчной буквы (${pct(metrics.lowercaseStartRatio)}): предложения разорваны страницами.`,
        lowercaseStarts,
        metrics.lowercaseStartRatio,
        Math.min(10, metrics.lowercaseStartRatio * 30),
        ['mergeParagraphs']
      );
    }
    if (hyphenLeftovers > 5) {
      add(
        'HYPHEN_LEFTOVERS',
        'info',
        `Неснятые переносы слов («пред- ложение»): ${hyphenLeftovers} шт.`,
        hyphenLeftovers,
        ratio(hyphenLeftovers, words),
        Math.min(8, hyphenLeftovers / 20),
        ['hyphenation']
      );
    }
    if (repeatedHeaderParas >= 3) {
      add(
        'REPEATED_HEADERS',
        'info',
        `Повторяющиеся колонтитулы: ${repeatedHeaderParas} строк.`,
        repeatedHeaderParas,
        ratio(repeatedHeaderParas, nonEmptyParas),
        Math.min(8, repeatedHeaderParas / 10),
        ['headers']
      );
    }
    if (nonEmptyParas >= 40 && (text.length <= 1 || chars / text.length > 150000) && chars > 30000) {
      const issue: QualityIssue = {
        code: 'SINGLE_CHAPTER',
        severity: 'warn',
        message:
          text.length <= 1
            ? 'Вся книга — одна глава: оглавление не определилось.'
            : `Главы слишком длинные (в среднем ${Math.round(chars / text.length / 1000)} тыс. символов): структура книги не определилась.`,
        count: text.length,
        ratio: 1,
        fixOps: [],
        tool: 'chapters',
      };
      issues.push(issue);
      penalty += 15;
    }
    if (pageNumberParas >= 3) {
      add(
        'PAGE_NUMBERS',
        'info',
        `Одиночные номера страниц в тексте: ${pageNumberParas} шт.`,
        pageNumberParas,
        ratio(pageNumberParas, nonEmptyParas),
        Math.min(6, pageNumberParas / 15),
        ['pageNumbers']
      );
    }
  }

  const score = Math.round(clamp(100 - penalty, 0, 100));
  const grade: QualityReport['grade'] = score >= 85 ? 'good' : score >= 60 ? 'fair' : 'poor';

  // Рекомендация
  const has = (code: QualityIssue['code']) => issues.some((i) => i.code === code);
  let recommendation: string | undefined;
  const hardOcr = has('EMPTY_BOOK') || has('TOO_LITTLE_TEXT') || has('NO_VOWEL_WORDS') || has('SHORT_WORDS') || has('NON_LETTERS');
  if (options.isPdf && (hardOcr || score < 60)) {
    if (options.pdfMode === 'gemini') {
      recommendation = 'Распознавание уже выполнено через Gemini OCR. Исправьте оставшиеся ошибки в редакторе или попробуйте режим PyMuPDF4LLM.';
    } else if (options.pdfMode === 'pymupdf') {
      recommendation = 'Попробуйте режим Gemini OCR (нейросетевое распознавание) — он лучше справляется с плохими сканами и битым шрифтом.';
    } else {
      recommendation = 'Попробуйте режим Gemini OCR или PyMuPDF4LLM: встроенный текстовый слой этого PDF распознан плохо.';
    }
  } else if (has('SINGLE_CHAPTER') && issues.length === 1) {
    recommendation = 'Откройте редактор -> вкладка «Главы» -> «Определить главы»: главы будут найдены по заголовкам и оглавлению PDF без повторного распознавания.';
  } else if (has('SHIFTED_CYRILLIC')) {
    recommendation = 'Откройте редактор -> «Очистка» и включите «Исправить сдвинутую кириллицу»: текст восстанавливается автоматически.';
  } else if (score < 85 && issues.length > 0) {
    recommendation = 'Откройте редактор -> «Очистка»: большинство найденных проблем исправляется автоматически.';
  }

  const summary =
    grade === 'good'
      ? `Качество текста хорошее (${score}/100)`
      : grade === 'fair'
        ? `Качество текста среднее (${score}/100)`
        : `Качество текста низкое (${score}/100)`;

  return { score, grade, issues, metrics, recommendation, summary };
}

/** Проблемы одного абзаца — для подсветки в редакторе. */
export interface ParagraphProblem {
  code: 'shifted' | 'markdown' | 'replacement' | 'control' | 'mixedScript' | 'noVowels' | 'pageNumber';
  label: string;
}

export function paragraphProblems(paragraph: string): ParagraphProblem[] {
  const out: ParagraphProblem[] = [];
  if (!paragraph) return out;
  if (detectShiftedCyrillic(paragraph).isShifted) out.push({ code: 'shifted', label: 'сдвинутая кириллица' });
  if (paragraph.includes('\uFFFD')) out.push({ code: 'replacement', label: 'символы \uFFFD' });
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(paragraph)) out.push({ code: 'control', label: 'управляющие символы' });
  if (hasMarkdownMarkers(paragraph)) out.push({ code: 'markdown', label: 'Markdown' });
  let mixed = 0;
  let noVowel = 0;
  for (const m of paragraph.matchAll(WORD_RE)) {
    const w = m[0].replace(/[-'’]/g, '');
    if (isMixedScriptWord(w)) mixed++;
    if (w.length >= 5 && !VOWEL_RE.test(w)) noVowel++;
  }
  if (mixed > 0) out.push({ code: 'mixedScript', label: 'латиница в русских словах' });
  if (noVowel >= 2) out.push({ code: 'noVowels', label: 'слова без гласных' });
  if (isPageNumber(paragraph)) out.push({ code: 'pageNumber', label: 'номер страницы' });
  return out;
}
