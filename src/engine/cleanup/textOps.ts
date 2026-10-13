/**
 * Чистые текстовые операции очистки: пробелы, управляющие символы, переносы, колонтитулы, кавычки и тире.
 */

const SOFT_HYPHEN = /\u00AD/g;
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
// Все «странные» пробелы, кроме обычного пробела и перевода строки
const ODD_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\t\f\v]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Удаляет U+FFFD, управляющие символы (кроме \n и \t), нулевую ширину и мягкие переносы. */
export function removeControlChars(text: string): string {
  if (!text) return text;
  return text.replace(/\uFFFD/g, '').replace(CONTROL, '').replace(ZERO_WIDTH, '').replace(SOFT_HYPHEN, '');
}

/**
 * Нормализация пробелов: nbsp и экзотические пробелы -> обычный, сжатие повторов,
 * обрезка по краям строк, пробел перед знаками препинания убирается.
 */
export function normalizeWhitespace(text: string): string {
  if (!text) return text;
  let s = text.replace(/\r\n?/g, '\n').replace(ODD_SPACES, ' ');
  s = s.replace(/ {2,}/g, ' ');
  s = s.replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  // « ,» -> «,» (но не трогаем многоточие и тире)
  s = s.replace(/ +([,.;:!?])(?=\s|$|[»"”)])/g, '$1');
  return s.trim();
}

/**
 * Склейка слов, разорванных переносом: «пред-\nложение», «слу- чай».
 * Перенос перед строчной буквой удаляется. Перед заглавной дефис сохраняется («Санкт-\nПетербург»).
 */
export function fixHyphenation(text: string): string {
  if (!text) return text;
  let s = text.replace(SOFT_HYPHEN, '');
  // знак «¬» тоже используется как мягкий перенос
  s = s.replace(/(\p{L})¬[ \t]*\n?[ \t]*(\p{L})/gu, '$1$2');
  // перенос в конце строки
  s = s.replace(/(\p{L})[-‐‑][ \t]*\n[ \t]*(\p{Ll})/gu, '$1$2');
  s = s.replace(/(\p{L})[-‐‑][ \t]*\n[ \t]*(\p{Lu})/gu, '$1-$2');
  // перенос, уже склеенный в одну строку пробелом: «сло- во». Только строчные буквы и только один пробел.
  s = s.replace(/(\p{Ll}{2})- (\p{Ll}{2})/gu, (m, a: string, b: string) => `${a}${b}`);
  return s;
}

/** Склеивает строки внутри абзаца (одиночные переводы строки -> пробел), после обработки переносов. */
export function joinLines(text: string): string {
  if (!text) return text;
  return fixHyphenation(text).replace(/[ \t]*\n[ \t]*/g, ' ').replace(/ {2,}/g, ' ').trim();
}

export interface QuoteOptions {
  quotes?: boolean;
  dashes?: boolean;
}

/** Нормализация кавычек (-> «ёлочки») и тире (-> длинное тире). Для русского текста. */
export function normalizeTypography(text: string, options: QuoteOptions = { quotes: true, dashes: true }): string {
  if (!text) return text;
  let s = text;
  if (options.quotes !== false) {
    s = s.replace(/[“„]([^“”„"\n]*)[”“]/g, '«$1»');
    // Прямые кавычки: открывающая — в начале или после пробела/скобки/тире, закрывающая — иначе
    let open = false;
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch !== '"') {
        out += ch;
        continue;
      }
      const prev = i > 0 ? s[i - 1] : '';
      const opens = !open && (prev === '' || /[\s(\[—–\-«]/.test(prev));
      if (opens) {
        out += '«';
        open = true;
      } else if (open) {
        out += '»';
        open = false;
      } else {
        out += ch; // одиночная кавычка без пары — оставляем как есть
      }
    }
    s = out;
  }
  if (options.dashes !== false) {
    s = s
      .replace(/(^|\n)[-–][ \t]+(?=\S)/g, '$1— ')
      .replace(/ [-–] /g, ' — ')
      .replace(/ -- /g, ' — ')
      .replace(/(\p{L})--(\p{L})/gu, '$1—$2');
  }
  return s;
}

// ---------------------------------------------------------------------------
// Колонтитулы и номера страниц
// ---------------------------------------------------------------------------

const PAGE_NUMBER_PATTERNS: RegExp[] = [
  /^[\s\u00A0]*[-–—‒]?[\s\u00A0]*\d{1,4}[\s\u00A0]*[-–—‒]?[\s\u00A0]*$/, // 12, - 12 -, — 12 —
  /^[\s\u00A0]*(?:стр\.?|страница|с\.|page|p\.)[\s\u00A0]*\d{1,4}[\s\u00A0]*$/i,
  /^[\s\u00A0]*\d{1,4}[\s\u00A0]*(?:\/|из|of)[\s\u00A0]*\d{1,4}[\s\u00A0]*$/i, // 12 / 345, 12 из 345
];

/** Абзац состоит только из номера страницы. */
export function isPageNumber(paragraph: string): boolean {
  const t = paragraph.trim();
  if (!t || t.length > 24) return false;
  return PAGE_NUMBER_PATTERNS.some((re) => re.test(t));
}

/** Ключ для сравнения колонтитулов: без регистра, цифры заменены, пробелы сжаты. */
export function headerKey(paragraph: string): string {
  return paragraph
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[\s\u00A0]+/g, ' ')
    .trim();
}

export interface HeaderDetectOptions {
  /** Минимум повторов, чтобы считать абзац колонтитулом */
  minRepeats?: number;
  /** Максимальная длина колонтитула */
  maxLength?: number;
}

/**
 * Находит повторяющиеся короткие абзацы (колонтитулы): «Тревога и страх 12», «ГЛАВА 3. ...» на каждой странице.
 * Возвращает множество ключей (см. headerKey). Диалоги и абзацы, заканчивающиеся точкой, не считаются колонтитулами.
 */
export function findRepeatedHeaders(
  chapters: string[][],
  options: HeaderDetectOptions = {}
): Set<string> {
  const minRepeats = options.minRepeats ?? 3;
  const maxLength = options.maxLength ?? 100;
  const counts = new Map<string, number>();
  let totalParagraphs = 0;

  for (const paragraphs of chapters) {
    for (const p of paragraphs) {
      totalParagraphs++;
      const t = p.trim();
      if (t.length < 3 || t.length > maxLength) continue;
      if (!/\p{L}/u.test(t)) continue;
      if (/^[—–\-«"„]/.test(t)) continue; // реплики диалога
      if (/[.!?…»"”:;]$/.test(t)) continue; // законченные фразы
      const key = headerKey(t);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const result = new Set<string>();
  // Для небольших текстов требуем больше повторов, чтобы не удалять повторяющиеся подзаголовки
  const threshold = totalParagraphs < 30 ? Math.max(minRepeats, 4) : minRepeats;
  for (const [key, n] of counts) {
    if (n >= threshold) result.add(key);
  }
  return result;
}

/** Абзац — колонтитул из набора, найденного findRepeatedHeaders. */
export function isRepeatedHeader(paragraph: string, headers: Set<string>): boolean {
  const t = paragraph.trim();
  if (!t || t.length > 100) return false;
  return headers.has(headerKey(t));
}

// ---------------------------------------------------------------------------
// Склейка разорванных абзацев
// ---------------------------------------------------------------------------

/** Нужно ли склеить абзац `next` с предыдущим `prev` (разрыв предложения на границе страницы/колонки). */
export function shouldMergeParagraphs(prev: string, next: string): boolean {
  const a = prev.trimEnd();
  const b = next.trimStart();
  if (!a || !b) return false;
  if (/[.!?…»"”:;)\]]$/.test(a)) return false;
  if (a.length < 40) return false; // короткие строки — это скорее заголовки
  // Продолжение: следующий абзац начинается со строчной буквы
  return /^\p{Ll}/u.test(b);
}

/** Склейка двух абзацев с учётом переноса на стыке. */
export function mergeTwoParagraphs(prev: string, next: string): string {
  const a = prev.trimEnd();
  const b = next.trimStart();
  if (/\p{L}[-‐‑]$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b;
  return `${a} ${b}`;
}

// ---------------------------------------------------------------------------
// Латинские двойники внутри русских слов
// ---------------------------------------------------------------------------

const LAT_TO_CYR: Record<string, string> = {
  a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у',
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
};
const CYR_TO_LAT: Record<string, string> = {};
for (const [lat, cyr] of Object.entries(LAT_TO_CYR)) CYR_TO_LAT[cyr] = lat;

const MIXED_WORD = /[\p{L}]+/gu;
const CYR = /\p{Script=Cyrillic}/u;
const LAT = /\p{Script=Latin}/u;

/** Слово содержит буквы обоих алфавитов. */
export function isMixedScriptWord(word: string): boolean {
  return CYR.test(word) && LAT.test(word);
}

/**
 * Исправляет слова со смешением алфавитов («рaзный» с латинской «a»): буквы-двойники приводятся
 * к алфавиту большинства. Слово меняется, только если все «чужие» буквы имеют двойника.
 */
export function fixMixedScript(text: string): string {
  if (!text) return text;
  return text.replace(MIXED_WORD, (word) => {
    if (!isMixedScriptWord(word)) return word;
    let cyr = 0;
    let lat = 0;
    for (const ch of word) {
      if (CYR.test(ch)) cyr++;
      else if (LAT.test(ch)) lat++;
    }
    if (cyr >= lat) {
      let out = '';
      for (const ch of word) {
        if (LAT.test(ch)) {
          const m = LAT_TO_CYR[ch];
          if (!m) return word;
          out += m;
        } else out += ch;
      }
      return out;
    }
    let out = '';
    for (const ch of word) {
      if (CYR.test(ch)) {
        const m = CYR_TO_LAT[ch];
        if (!m) return word;
        out += m;
      } else out += ch;
    }
    return out;
  });
}
