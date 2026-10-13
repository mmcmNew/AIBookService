/**
 * Удаление Markdown-разметки, оставшейся после pymupdf4llm / OCR:
 * `**ДЭВИДА. КЛАРК,** _д-р философии_`, `###### УДК 616.891.6`.
 *
 * Принцип: разметка снимается только там, где она «настоящая» — маркеры стоят на границах слов.
 * Подчёркивания и звёздочки внутри слов (snake_case, 2*3, file_name_v2) не трогаем.
 */

const L = String.raw`\p{L}\p{N}`;

// ***текст*** / **текст** / __текст__
const BOLD_ITALIC = new RegExp(String.raw`(?<![${L}*])\*\*\*(?=\S)([^\n]*?\S)\*\*\*(?![${L}*])`, 'gu');
const BOLD_STAR = new RegExp(String.raw`(?<![${L}*\x5C])\*\*(?=\S)([^\n]*?\S)\*\*(?![${L}*])`, 'gu');
const BOLD_UNDER = new RegExp(String.raw`(?<![${L}_\x5C])__(?=\S)([^\n]*?\S)__(?![${L}_])`, 'gu');
// *текст* / _текст_ (одиночные)
const ITALIC_STAR = new RegExp(String.raw`(?<![${L}*\x5C])\*(?=[^\s*])([^\n*]*?[^\s*])\*(?![${L}*])`, 'gu');
const ITALIC_UNDER = new RegExp(String.raw`(?<![${L}_\x5C])_(?=[^\s_])([^\n_]*?[^\s_])_(?![${L}_])`, 'gu');
// ~~зачёркнутый~~
const STRIKE = /(?<![\p{L}\p{N}~])~~(?=\S)([^\n]*?\S)~~(?![\p{L}\p{N}~])/gu;
// `код`
const INLINE_CODE = /`([^`\n]+)`/g;
// ![alt](url) и [текст](url)
const IMAGE = /!\[([^\]\n]*)\]\([^)\n]*\)/g;
const LINK = /\[([^\]\n]+)\]\((?:[^)\n]*)\)/g;
const AUTOLINK = /<(https?:\/\/[^>\s]+)>/g;
// Экранирование \* \_ \# …
const ESCAPED = /\x5C([\x5C`*_{}\[\]()#+\-.!|~>])/g;

const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+/;
const HEADING_TRAILING = /[ \t]+#+[ \t]*$/;
const HR_LINE = /^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/;
const FENCE_LINE = /^[ \t]*(```|~~~).*$/;
const BLOCKQUOTE = /^[ \t]{0,3}>[ \t]+/;
const BULLET = /^[ \t]{0,6}[*+•▪●■◦][ \t]+/;
const TABLE_SEP = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/;
const TABLE_ROW = /^[ \t]*\|(.+)\|[ \t]*$/;
const HTML_BREAK = /<br\s*\/?>/gi;

export interface StripMarkdownOptions {
  /** Убирать маркеры маркированных списков (`* `, `+ `, `•`). Дефис не трогаем — это реплики диалога. */
  stripBullets?: boolean;
}

const BOLD_STAR_T = new RegExp(BOLD_STAR.source, 'u');
const BOLD_UNDER_T = new RegExp(BOLD_UNDER.source, 'u');
const ITALIC_UNDER_T = new RegExp(ITALIC_UNDER.source, 'u');
const ITALIC_STAR_T = new RegExp(ITALIC_STAR.source, 'u');
const HEADING_TEXT = /^[ \t]{0,3}#{1,6}[ \t]+\S/;
const LINK_OR_IMAGE_T = /!?\[[^\]\n]+\]\([^)\n]*\)/;
const CODE_T = /`[^`\n]+`/;
const FENCE_T = /^[ \t]*(```|~~~)/m;

/** Есть ли в тексте признаки Markdown-разметки (для оценки качества). */
export function hasMarkdownMarkers(text: string): boolean {
  if (!text) return false;
  // Быстрый отказ: ни одного служебного символа
  if (!/[*_#`\[~]/.test(text)) return false;
  if (HEADING_TEXT.test(text)) return true;
  return (
    BOLD_STAR_T.test(text) ||
    BOLD_UNDER_T.test(text) ||
    ITALIC_UNDER_T.test(text) ||
    ITALIC_STAR_T.test(text) ||
    LINK_OR_IMAGE_T.test(text) ||
    CODE_T.test(text) ||
    FENCE_T.test(text)
  );
}

function stripInline(line: string): string {
  let s = line;
  // Несколько проходов — на случай вложенной разметки (**_текст_**)
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s
      .replace(BOLD_ITALIC, '$1')
      .replace(BOLD_STAR, '$1')
      .replace(BOLD_UNDER, '$1')
      .replace(ITALIC_STAR, '$1')
      .replace(ITALIC_UNDER, '$1')
      .replace(STRIKE, '$1');
    if (s === before) break;
  }
  return s;
}

/**
 * Снимает Markdown-разметку. Обрабатывает построчно, переводы строк сохраняются
 * (разбор на абзацы — дело вызывающего кода).
 */
export function stripMarkdown(text: string, options: StripMarkdownOptions = {}): string {
  if (!text) return text;
  const stripBullets = options.stripBullets ?? true;
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;

  for (const rawLine of lines) {
    let line = rawLine;

    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue; // сами «заборы» ``` не нужны
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (HR_LINE.test(line) || (TABLE_SEP.test(line) && /^[ \t]*\|/.test(line))) {
      out.push('');
      continue;
    }

    line = line.replace(HTML_BREAK, ' ');
    if (HEADING.test(line)) {
      line = line.replace(HEADING, '').replace(HEADING_TRAILING, '');
    }
    line = line.replace(BLOCKQUOTE, '');
    if (stripBullets) line = line.replace(BULLET, '');

    const row = TABLE_ROW.exec(line);
    if (row) {
      line = row[1]
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)
        .join('; ');
    }

    line = line
      .replace(IMAGE, '')
      .replace(LINK, '$1')
      .replace(AUTOLINK, '$1')
      .replace(INLINE_CODE, '$1');
    line = stripInline(line);
    line = line.replace(ESCAPED, '$1');
    out.push(line);
  }

  return out.join('\n');
}
