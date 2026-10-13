/**
 * Исправление «сдвинутой кириллицы».
 *
 * Некоторые PDF содержат шрифт, где кириллица потеряла старший байт: U+04xx превратился в U+00xx.
 * Тогда «о» (U+043E) выглядит как '>' (U+003E), «р» (U+0440) как '@', «е» (U+0435) как '5':
 *   `"@52>30`  ->  `Тревога`,   `>:>9AB2>`  ->  `окойство`.
 * Обратное преобразование — прибавить 0x400 к коду символа.
 *
 * Чтобы не испортить нормальный текст, замена выполняется только для «слов», которые целиком состоят
 * из символов, способных быть сдвинутой кириллицей, содержат «сильные» признаки (буквы A–O, знаки `>@"` и т.п.),
 * а результат похож на русское слово (гласные, частоты букв, допустимые сочетания).
 * Любое слово со строчной латиницей или настоящей кириллицей никогда не меняется.
 */

const SHIFT = 0x400;

const VOWELS = new Set('аеёиоуыэюя');
// Относительные частоты букв русского языка (НКРЯ), сумма ~1
const FREQ: Record<string, number> = {
  о: 0.109, е: 0.085, а: 0.08, и: 0.074, н: 0.067, т: 0.063, с: 0.055, р: 0.047, в: 0.045, л: 0.044,
  к: 0.035, м: 0.032, д: 0.03, п: 0.028, у: 0.026, я: 0.02, ы: 0.019, ь: 0.017, г: 0.017, з: 0.016,
  б: 0.016, ч: 0.014, й: 0.012, х: 0.009, ж: 0.008, ш: 0.007, ю: 0.006, ц: 0.005, щ: 0.004, э: 0.003,
  ф: 0.003, ъ: 0.0004, ё: 0.0004,
};

// Слово: необязательная заглавная (управляющие 0x01,0x10–0x1F = Ё,А–П; знаки 0x21–0x2F = С–Я),
// затем строчные (0x30–0x4F = а–я, 0x51 = ё)
const WORD_RE = /^[\x01\x10-\x1F!-/]?[0-9:;<=>?@A-OQ]+$/;
// Сильные признаки: буквы и знаки, которые почти не встречаются в обычном тексте вперемешку с цифрами
const STRONG = /[A-OQ<=>?@"#$&*+/\x01\x10-\x1F]/;

const LEADING_REAL = new Set(['(', '"', "'", '«', '“', '„', '[']);
const TRAILING_REAL = /[.,;:!?)\]»”"'…]+$/;

const SHORT_WORDS = new Set([
  'в', 'и', 'с', 'к', 'у', 'о', 'а', 'я', 'на', 'не', 'по', 'из', 'за', 'от', 'до', 'то', 'он', 'но', 'ли', 'же',
  'бы', 'мы', 'вы', 'ты', 'им', 'их', 'ни', 'ко', 'со', 'во', 'об', 'да', 'ей', 'ее', 'её', 'ой', 'ай', 'ах', 'эх',
  'ну', 'ох', 'ус',
]);

export interface ShiftedToken {
  from: string;
  to: string;
}

export interface ShiftedDetection {
  /** Текст содержит слова сдвинутой кириллицы, которые можно уверенно исправить */
  isShifted: boolean;
  /** 0..1: уверенность в исправлении */
  confidence: number;
  /** Сколько слов будет изменено */
  convertedTokens: number;
  /** Сколько слов всего (без пробелов) */
  totalTokens: number;
  /** Примеры замен (до 8) */
  samples: ShiftedToken[];
}

export interface ShiftedRepairResult extends ShiftedDetection {
  text: string;
  changed: boolean;
}

const EMPTY: ShiftedDetection = { isShifted: false, confidence: 0, convertedTokens: 0, totalTokens: 0, samples: [] };

function mapChars(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) + SHIFT);
  return out;
}

/** Похоже ли слово (в кириллице) на русское. */
function isPlausibleRussianWord(word: string): boolean {
  const w = word.toLowerCase();
  const n = w.length;
  if (n === 0) return false;
  // Заглавной может быть только первая буква
  if (n > 1 && word.slice(1) !== word.slice(1).toLowerCase()) return false;
  if (/^[ьъы]/.test(w)) return false;
  if (/(.)\1\1/.test(w)) return false;
  // «жы/шы», «чя/щю», «гы/кы/хы», двойные знаки, «ь/ъ» после гласной, «ъ» не перед е ё ю я и, «ъ» в конце
  if (/[жчшщ]ы|[жчшщ][юя]|[гкх]ы|[ьъ][ьъыйщшжчх]|[аеёиоуыэюя][ьъ]|ъ[^еёюяиа]|ъ$/.test(w)) return false;
  let vowels = 0;
  let run = 0;
  let maxRun = 0;
  for (const ch of w) {
    if (VOWELS.has(ch)) {
      vowels++;
      run = 0;
    } else {
      run++;
      if (run > maxRun) maxRun = run;
    }
  }
  if (maxRun > 4) return false;
  if (n >= 3 && vowels === 0) return false;
  if (n >= 3 && vowels / n > 0.75) return false;
  if (n >= 5 && vowels / n < 0.2) return false;
  return true;
}

interface Candidate {
  prefix: string;
  suffix: string;
  letters: string;
}

function buildCandidates(token: string): Candidate[] {
  const out: Candidate[] = [];
  const trailMatch = TRAILING_REAL.exec(token);
  const trail = trailMatch ? trailMatch[0] : '';
  const leadLen = token.length > 1 && LEADING_REAL.has(token[0]) ? 1 : 0;

  const push = (lead: number, trailLen: number) => {
    const core = token.slice(lead, token.length - trailLen);
    if (!core || !WORD_RE.test(core)) return;
    out.push({ prefix: token.slice(0, lead), suffix: token.slice(token.length - trailLen), letters: mapChars(core) });
  };

  // «?» на конце чаще настоящий вопросительный знак, чем буква «п»; «:» и «;» чаще буквы «к», «л»
  const preferTrim = trail.length > 0 && /^\?+$/.test(trail);
  if (preferTrim) {
    push(0, trail.length);
    push(0, 0);
  } else {
    push(0, 0);
    if (trail) push(0, trail.length);
  }
  if (leadLen) {
    push(leadLen, 0);
    if (trail) push(leadLen, trail.length);
  }
  return out;
}

interface TokenFix {
  original: string;
  replacement: string;
  letters: string;
  /** Сколько «сильных» символов в исходном слове */
  strong: number;
}

function countStrong(s: string): number {
  let n = 0;
  for (const ch of s) if (STRONG.test(ch)) n++;
  return n;
}

function analyzeSimpleToken(token: string): TokenFix | null {
  for (const c of buildCandidates(token)) {
    if (!isPlausibleRussianWord(c.letters)) continue;
    const core = token.slice(c.prefix.length, token.length - c.suffix.length);
    // Слова из 3+ букв требуют «сильного» признака; голые числа не трогаем
    if (c.letters.length >= 3 && (!STRONG.test(core) || /^[0-9]+$/.test(core))) continue;
    return { original: token, replacement: c.prefix + c.letters + c.suffix, letters: c.letters, strong: countStrong(core) };
  }
  return null;
}

function hasNonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return true;
  return false;
}

function analyzeCore(token: string): TokenFix | null {
  // Строчная латиница, настоящая кириллица, любые не-ASCII символы, P и R–Z — это не сдвинутая кириллица
  if (/[a-z]/.test(token) || hasNonAscii(token) || /[PR-Z]/.test(token)) return null;
  if (!/[0-9:;<=>?@A-OQ]/.test(token)) return null; // нет ни одного «строчного» символа

  const whole = analyzeSimpleToken(token);
  if (whole) return whole;

  // Слова с дефисом: `<>=8-B>` -> «мони-то» — разбираем по частям, все части должны исправляться
  if (/[^-]-[^-]/.test(token)) {
    const pieces = token.split('-');
    const fixes: TokenFix[] = [];
    for (const piece of pieces) {
      const f = piece ? analyzeSimpleToken(piece) : null;
      if (!f) return null;
      fixes.push(f);
    }
    return {
      original: token,
      replacement: fixes.map((f) => f.replacement).join('-'),
      letters: fixes.map((f) => f.letters).join(''),
      strong: fixes.reduce((a, f) => a + f.strong, 0),
    };
  }
  return null;
}

/** Слово может быть обёрнуто в Markdown-маркеры (`**текст**`, `_текст_`) - снимаем их на время анализа. */
function analyzeToken(token: string): TokenFix | null {
  const m = /^((?:\*\*|__|_)*)([^]*?)((?:\*\*|__|_)*)$/.exec(token);
  if (m && (m[1] || m[3]) && m[2]) {
    const inner = analyzeCore(m[2]);
    if (!inner) return null;
    return { ...inner, original: token, replacement: m[1] + inner.replacement + m[3] };
  }
  return analyzeCore(token);
}

function aggregatePlausible(allLetters: string): { ok: boolean; freqMean: number } {
  const s = allLetters.toLowerCase().replace(/[^а-яё]/g, '');
  if (s.length < 5) return { ok: false, freqMean: 0 };
  let vowels = 0;
  let freq = 0;
  for (const ch of s) {
    if (VOWELS.has(ch)) vowels++;
    freq += FREQ[ch] ?? 0;
  }
  const vowelRatio = vowels / s.length;
  const freqMean = freq / s.length;
  return { ok: vowelRatio >= 0.3 && vowelRatio <= 0.6 && freqMean >= 0.048, freqMean };
}

function analyze(text: string): { parts: string[]; replaced: (string | null)[]; detection: ShiftedDetection } {
  const parts = text.split(/(\s+)/);
  const replaced: (string | null)[] = parts.map(() => null);
  let totalTokens = 0;
  const found: { idx: number; fix: TokenFix }[] = [];

  parts.forEach((part, idx) => {
    if (!part || /^\s+$/.test(part)) return;
    totalTokens++;
    const fix = analyzeToken(part);
    if (fix) found.push({ idx, fix });
  });

  const none = { parts, replaced, detection: { ...EMPTY, totalTokens } };
  if (found.length === 0) return none;

  const agg = aggregatePlausible(found.map((f) => f.fix.letters).join(''));
  const longWords = found.filter((f) => f.fix.letters.length >= 4);
  const confident =
    longWords.length >= 2 ||
    (longWords.length === 1 && (found.length === totalTokens || (longWords[0].fix.letters.length >= 6 && longWords[0].fix.strong >= 2)));
  if (!agg.ok || !confident) return none;

  for (const { idx, fix } of found) {
    const len = fix.letters.length;
    if (len >= 3) {
      replaced[idx] = fix.replacement;
    } else if (!/^[0-9]+$/.test(fix.original) && SHORT_WORDS.has(fix.letters.toLowerCase().replace(/[^а-яё]/g, ''))) {
      // Короткие слова («на», «не», «по», «в») — только из белого списка; голые цифры не трогаем
      replaced[idx] = fix.replacement;
    }
  }

  // Цифры '2' = «в», '8' = «и', '0' = «а» — только между двумя исправленными словами
  parts.forEach((part, idx) => {
    if (replaced[idx] !== null || !/^[028]$/.test(part)) return;
    const prev = idx >= 2 ? replaced[idx - 2] : null;
    const next = idx + 2 < parts.length ? replaced[idx + 2] : null;
    if (prev && next) replaced[idx] = mapChars(part);
  });

  const converted = replaced.filter((r) => r !== null).length;
  if (converted === 0) return none;

  const samples: ShiftedToken[] = [];
  parts.forEach((part, idx) => {
    if (replaced[idx] !== null && samples.length < 8) samples.push({ from: part, to: replaced[idx] as string });
  });

  const coverage = converted / Math.max(1, totalTokens);
  const confidence = Math.min(
    1,
    0.45 + Math.min(0.3, converted * 0.06) + Math.min(0.15, agg.freqMean * 2) + Math.min(0.1, coverage * 0.2)
  );

  return { parts, replaced, detection: { isShifted: true, confidence, convertedTokens: converted, totalTokens, samples } };
}

/** Определяет, содержит ли текст сдвинутую кириллицу, которую можно уверенно исправить (+0x400). */
export function detectShiftedCyrillic(text: string): ShiftedDetection {
  if (!text) return { ...EMPTY };
  return analyze(text).detection;
}

/**
 * Предлагает исправление сдвинутой кириллицы. Функция чистая: результат нужно показать пользователю
 * (предпросмотр) и применить только после подтверждения.
 */
export function repairShiftedCyrillic(text: string): ShiftedRepairResult {
  if (!text) return { ...EMPTY, text, changed: false };
  const { parts, replaced, detection } = analyze(text);
  if (!detection.isShifted) return { ...detection, text, changed: false };
  const out = parts.map((p, i) => (replaced[i] !== null ? (replaced[i] as string) : p)).join('');
  return { ...detection, text: out, changed: out !== text };
}
