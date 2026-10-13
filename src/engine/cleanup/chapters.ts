import { stripMarkdown } from './markdown';
import { headerKey, isPageNumber } from './textOps';

/**
 * Автоопределение глав над результатом любого распознавателя (pdfjs / pymupdf / gemini / TXT).
 *
 * Источники (по убыванию надёжности):
 *  1. оглавление (outline / TOC) PDF;
 *  2. заголовки в тексте: «Глава N», «Часть», «Введение», римские цифры, Markdown (#, **строка**),
 *     короткие строки ЗАГЛАВНЫМИ, нумерованные заголовки, крупный шрифт (pdfjs);
 *  3. если ничего не найдено — разбиение на разделы «Часть N» по границам абзацев.
 */

export interface DetectParagraph {
  /** Исходный текст абзаца (с Markdown, если он есть — заголовки ищем ДО очистки) */
  text: string;
  /** Высота шрифта относительно медианной (pdfjs) */
  heightRatio?: number;
  /** Абзац открывает новую страницу */
  newPage?: boolean;
  /** Номер страницы (1-based), если известен */
  page?: number;
  /** Абзац заведомо является заголовком главы (например, заголовок от внешнего распознавателя) */
  forced?: boolean;
}

export interface OutlineEntry {
  title: string;
  level?: number;
  /** 1-based номер страницы */
  page?: number;
}

export interface DetectOptions {
  outline?: OutlineEntry[];
  /** Главы короче этого числа символов склеиваются с соседней */
  minChapterChars?: number;
  /** Размер раздела при разбиении «по размеру» */
  fallbackChunkChars?: number;
  /** Разбивать на «Часть N», если глав не найдено */
  fallbackBySize?: boolean;
}

export type DetectMethod = 'outline' | 'headings' | 'size' | 'none';

export interface DetectedChapter {
  title: string;
  level: number;
  /** Индексы абзацев (в исходном плоском списке), входящих в главу, по порядку */
  items: number[];
  /** Индекс абзаца-заголовка в исходном списке (null — заголовок синтетический) */
  headingIndex: number | null;
}

export interface DetectResult {
  method: DetectMethod;
  chapters: DetectedChapter[];
  /** Сколько заголовков-кандидатов найдено до фильтрации коротких глав */
  candidates: number;
}

// ---------------------------------------------------------------------------
// Классификация заголовков
// ---------------------------------------------------------------------------

export type HeadingReason = 'markdown' | 'keyword' | 'special' | 'roman' | 'numbered' | 'bold' | 'caps' | 'size' | 'weak' | 'outline' | 'forced';

export interface HeadingInfo {
  score: number;
  reason: HeadingReason;
  level: number;
  /** Очищенный текст заголовка */
  title: string;
}

const KEYWORD =
  /^(глава|часть|раздел|книга|том|пролог|эпилог|chapter|part|section|book|volume)\b[\s.:№#-]*([\dIVXLCDMivxlcdm]+|[а-яёa-z-]{3,20})?(?:[\s.:—–-]|$)/i;
const KEYWORD_NUMBERED = /^(глава|часть|раздел|книга|том|chapter|part|section|book|volume)\s*[№#]?\s*([\dIVXLCDM]+|[а-яё]{3,20}|[a-z]{3,10})(?![\p{L}\p{N}])/iu;
const SPECIAL =
  /^(пролог|эпилог|предисловие|введение|заключение|послесловие|содержание|оглавление|приложение|приложения|вступление|от автора|от издателя|аннотация|благодарности|об авторе|примечания|комментарии|литература|библиография|список литературы|prologue|epilogue|preface|foreword|introduction|conclusion|afterword|contents|table of contents|appendix|acknowledg(?:e)?ments|bibliography|notes)(?![\p{L}\p{N}])/iu;
const ROMAN = /^(?=[IVXLCDM])M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})[.)]?$/;
const NUMBERED = /^(\d{1,2}(?:\.\d{1,2}){0,2})[.)]?\s+(\p{Lu}[^\n]{1,80})$/u;
const BOLD_LINE = /^(\*\*|__)(?=\S)(.{2,100}?)(\*\*|__)$/;
const TOC_ENTRY = /(\.{2,}|…|\s{2,}|\s)\d{1,4}$/;

function cleanTitle(raw: string): string {
  return stripMarkdown(raw)
    .replace(/\s+/g, ' ')
    .replace(/[\s.:]+$/g, '')
    .trim();
}

/** Оценивает, похож ли абзац на заголовок главы. null — не похож. */
export function classifyHeading(p: DetectParagraph): HeadingInfo | null {
  const raw = p.text.trim();
  if (!raw || raw.length > 140 || raw.includes('\n')) return null;
  if (isPageNumber(raw)) return null;

  const mdMatch = /^(#{1,6})[ \t]+(\S.*)$/.exec(raw);
  const boldMatch = BOLD_LINE.exec(raw);
  const core = cleanTitle(raw);
  if (core.length < 1 || core.length > 110) return null;
  if (!/[\p{L}\p{N}]/u.test(core)) return null;

  const endsLikeSentence = /[,;]$/.test(core) || (/[.!?…]$/.test(raw.replace(/\*+$/, '')) && core.split(' ').length > 8);
  let best: HeadingInfo | null = null;
  const offer = (score: number, reason: HeadingReason, level = 1) => {
    if (!best || score > best.score) best = { score, reason, level, title: core };
  };

  if (p.forced) offer(5, 'forced');

  if (mdMatch) {
    const lvl = mdMatch[1].length;
    if (lvl <= 3) offer(3, 'markdown', lvl <= 1 ? 1 : 2);
    else offer(1, 'markdown', 2);
  }

  // «книга встретили поле...»: служебное слово со строчной буквы в начале строки — продолжение предложения, не заголовок
  const startsLower = /^\p{Ll}/u.test(core) && !mdMatch && !boldMatch;
  if (!endsLikeSentence) {
    if (!startsLower && (KEYWORD_NUMBERED.test(core) || (KEYWORD.test(core) && core.length <= 80))) {
      const k = KEYWORD_NUMBERED.exec(core);
      if (k || /^(пролог|эпилог)/i.test(core)) {
        const lvl = /^(часть|part|книга|book|том|volume)/i.test(core) ? 1 : 2;
        offer(3, 'keyword', lvl);
      }
    }
    if (!startsLower && SPECIAL.test(core) && core.length <= 60) offer(3, 'special', 1);
    const plain = core.replace(/[.)]$/, '');
    if (ROMAN.test(plain) && plain.length <= 6) offer(2, 'roman', 2);
    const num = NUMBERED.exec(core);
    if (num && !TOC_ENTRY.test(core)) offer(2, 'numbered', Math.min(3, num[1].split('.').length + 1));
    if (boldMatch) offer(2, 'bold', 2);
    const letters = core.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 3 && core.length <= 70 && core === core.toUpperCase() && core !== core.toLowerCase()) {
      offer(2, 'caps', 2);
    }
  }

  if (p.heightRatio !== undefined && core.length < 100 && !endsLikeSentence) {
    if (p.heightRatio >= 1.25) offer(3, 'size', p.heightRatio >= 1.6 ? 1 : 2);
    else if (p.heightRatio >= 1.12) offer(1, 'size', 2);
  }
  if (best && p.newPage && core.length <= 60 && (best as HeadingInfo).score < 3) {
    (best as HeadingInfo).score += 1;
  }
  if (!best && p.newPage && p.heightRatio !== undefined && p.heightRatio >= 1.12 && core.length <= 60 && !endsLikeSentence) {
    offer(2, 'weak', 2);
  }

  const result = best as HeadingInfo | null;
  if (!result || result.score < 2) return null;
  // Строка оглавления: «Глава 1. Название .......... 15»
  if (result.reason !== 'forced' && TOC_ENTRY.test(raw) && /(\.{3,}|…)\s*\d{1,4}$/.test(raw)) return null;
  return result;
}

/** Короткий вспомогательный предикат для парсеров. */
export function isHeadingText(text: string, extra: Partial<DetectParagraph> = {}): boolean {
  return classifyHeading({ text, ...extra }) !== null;
}

// ---------------------------------------------------------------------------
// Основной алгоритм
// ---------------------------------------------------------------------------

const GENERIC_TITLES = /^(начало|основной текст|без названия|текст)$/i;

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function matchOutline(paragraphs: DetectParagraph[], outline: OutlineEntry[]): { index: number; title: string; level: number; synthetic: boolean }[] {
  const levels = outline.map((o) => o.level ?? 1);
  const minLevel = Math.min(...levels);
  let usable = outline.filter((o) => (o.level ?? 1) === minLevel);
  if (usable.length < 2) usable = outline.filter((o) => (o.level ?? 1) <= minLevel + 1);
  const hasPages = paragraphs.some((p) => p.page !== undefined);
  const found: { index: number; title: string; level: number; synthetic: boolean }[] = [];
  let from = 0;
  for (const entry of usable) {
    const t = norm(entry.title);
    if (!t) continue;
    let at = -1;
    const limit = paragraphs.length;
    for (let i = from; i < limit; i++) {
      const p = paragraphs[i];
      if (hasPages && entry.page !== undefined && p.page !== undefined && p.page < entry.page) continue;
      if (hasPages && entry.page !== undefined && p.page !== undefined && p.page > entry.page + 1) break;
      const pt = norm(cleanTitle(p.text));
      if (pt && pt.length <= t.length + 40 && (pt === t || pt.startsWith(t) || (t.length > 6 && t.startsWith(pt) && pt.length > 3))) {
        at = i;
        break;
      }
    }
    if (at >= 0) {
      found.push({ index: at, title: entry.title.trim(), level: entry.level ?? 1, synthetic: false });
      from = at + 1;
    } else if (hasPages && entry.page !== undefined) {
      const i = paragraphs.findIndex((p, k) => k >= from && p.page !== undefined && p.page >= (entry.page as number));
      if (i >= 0 && (found.length === 0 || i > found[found.length - 1].index)) {
        found.push({ index: i, title: entry.title.trim(), level: entry.level ?? 1, synthetic: true });
        from = i;
      }
    }
  }
  // Без дубликатов позиций
  return found.filter((f, k) => k === 0 || f.index > found[k - 1].index || f.synthetic === false);
}

/**
 * Определяет главы. Принимает плоский список абзацев всей книги.
 */
export function detectChapters(input: Array<DetectParagraph | string>, options: DetectOptions = {}): DetectResult {
  const paragraphs: DetectParagraph[] = input.map((p) => (typeof p === 'string' ? { text: p } : p));
  const minChars = options.minChapterChars ?? 500;
  const chunk = options.fallbackChunkChars ?? 20000;
  const n = paragraphs.length;
  const consumed = new Set<number>();

  type Start = { index: number; title: string; level: number; synthetic: boolean; score: number; reason: HeadingReason };
  let starts: Start[] = [];
  let method: DetectMethod = 'none';

  // 1. Оглавление PDF
  if (options.outline && options.outline.length >= 2) {
    const m = matchOutline(paragraphs, options.outline);
    if (m.length >= 2) {
      starts = m.map((x) => ({ ...x, score: 5, reason: 'outline' as HeadingReason }));
      method = 'outline';
    }
  }

  // 2. Эвристики
  let candidates = 0;
  if (starts.length === 0) {
    const found: Start[] = [];
    paragraphs.forEach((p, i) => {
      const h = classifyHeading(p);
      if (h) found.push({ index: i, title: h.title, level: h.level, synthetic: false, score: h.score, reason: h.reason });
    });

    // Повторяющиеся строки (колонтитулы), кроме явных «Глава N»
    const counts = new Map<string, number>();
    for (const f of found) {
      if (f.reason === 'keyword' || f.reason === 'forced' || f.reason === 'markdown') continue;
      const k = headerKey(f.title);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    let filtered = found.filter((f) => {
      if (f.reason === 'keyword' || f.reason === 'forced' || f.reason === 'markdown') return true;
      return (counts.get(headerKey(f.title)) ?? 0) < 4;
    });

    // Серии подряд идущих заголовков из 5+ строк — оглавление, а не главы
    const drop = new Set<number>();
    let run: Start[] = [];
    const flush = () => {
      if (run.length >= 5) run.forEach((r) => drop.add(r.index));
      run = [];
    };
    for (const f of filtered) {
      if (run.length && f.index - run[run.length - 1].index > 1) flush();
      run.push(f);
    }
    flush();
    filtered = filtered.filter((f) => !drop.has(f.index) || f.reason === 'forced');

    // «ГЛАВА 1» + следующая короткая строка-название
    const merged: Start[] = [];
    for (let k = 0; k < filtered.length; k++) {
      const f = filtered[k];
      const next = filtered[k + 1];
      if (
        next &&
        next.index === f.index + 1 &&
        ['keyword', 'roman', 'numbered'].includes(f.reason) &&
        f.title.length <= 24 &&
        !['keyword', 'roman', 'special'].includes(next.reason)
      ) {
        merged.push({ ...f, title: `${f.title}. ${next.title}` });
        consumed.add(next.index);
        k++;
      } else {
        merged.push(f);
      }
    }
    candidates = merged.length;
    starts = merged;
    if (starts.length > 0) method = 'headings';
  } else {
    candidates = starts.length;
  }

  // Сборка глав
  type Draft = { title: string; level: number; headingIndex: number | null; items: number[] };
  const drafts: Draft[] = [];
  const firstStart = starts.length ? starts[0].index : n;
  if (firstStart > 0 && n > 0) {
    drafts.push({ title: 'Начало', level: 1, headingIndex: null, items: range(0, firstStart) });
  }
  starts.forEach((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].index : n;
    const bodyStart = s.synthetic ? s.index : s.index + 1;
    const items = range(bodyStart, end).filter((i) => !consumed.has(i));
    drafts.push({ title: s.title, level: s.level, headingIndex: s.synthetic ? null : s.index, items });
  });

  // Слишком короткие главы склеиваем с соседней (заголовок остаётся абзацем)
  const chars = (d: Draft) => d.items.reduce((a, i) => a + paragraphs[i].text.length, 0);
  const total = drafts.reduce((a, d) => a + chars(d), 0);
  let result = drafts;
  if (drafts.length > 1 && total >= minChars * 3) {
    const out: Draft[] = [];
    for (let k = 0; k < drafts.length; k++) {
      const d = drafts[k];
      if (chars(d) >= minChars || (k === drafts.length - 1 && out.length === 0)) {
        out.push(d);
        continue;
      }
      const titleItems = d.headingIndex !== null ? [d.headingIndex] : [];
      if (out.length > 0) {
        const prev = out[out.length - 1];
        prev.items = [...prev.items, ...titleItems, ...d.items];
      } else {
        // Самая первая глава слишком короткая: присоединим к следующей
        const next = drafts[k + 1];
        next.items = [...titleItems, ...d.items, ...next.items];
      }
    }
    // Последняя глава тоже может оказаться короткой
    if (out.length > 1 && chars(out[out.length - 1]) < minChars) {
      const last = out.pop() as Draft;
      const prev = out[out.length - 1];
      prev.items = [...prev.items, ...(last.headingIndex !== null ? [last.headingIndex] : []), ...last.items];
    }
    result = out;
  }

  // 3. Разбиение по размеру
  if (result.length <= 1 && (options.fallbackBySize ?? true) && n > 0) {
    const all = result.length === 1 ? result[0].items : range(0, n);
    const pieces: Draft[] = [];
    let cur: number[] = [];
    let size = 0;
    const sum = all.reduce((a, i) => a + paragraphs[i].text.length, 0);
    if (sum >= chunk * 1.5) {
      const parts = Math.max(2, Math.round(sum / chunk));
      const target = sum / parts;
      for (const i of all) {
        cur.push(i);
        size += paragraphs[i].text.length;
        if (size >= target && pieces.length < parts - 1) {
          pieces.push({ title: `Часть ${pieces.length + 1}`, level: 1, headingIndex: null, items: cur });
          cur = [];
          size = 0;
        }
      }
      if (cur.length) pieces.push({ title: `Часть ${pieces.length + 1}`, level: 1, headingIndex: null, items: cur });
      if (pieces.length > 1) {
        const keepTitle = result.length === 1 && result[0].headingIndex !== null && !GENERIC_TITLES.test(result[0].title);
        if (keepTitle) pieces[0].title = `${result[0].title} (часть 1)`;
        return { method: 'size', chapters: pieces, candidates };
      }
    }
  }

  if (result.length === 0) return { method: 'none', chapters: [], candidates };
  // Если нашлась единственная «глава» и это просто «Начало» — глав нет
  const real = method === 'none' || (result.length === 1 && GENERIC_TITLES.test(result[0].title) && starts.length === 0);
  return { method: real ? 'none' : method, chapters: result, candidates };

  function range(a: number, b: number): number[] {
    const out: number[] = [];
    for (let i = a; i < b; i++) out.push(i);
    return out;
  }
}

/** Сколько символов текста приходится на главу (для предпросмотра). */
export function chapterChars(paragraphs: Array<DetectParagraph | string>, chapter: DetectedChapter): number {
  return chapter.items.reduce((a, i) => {
    const p = paragraphs[i];
    return a + (typeof p === 'string' ? p.length : p.text.length);
  }, 0);
}
