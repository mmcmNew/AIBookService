/** Минимальное представление главы для очистки и оценки качества: только заголовок и абзацы. */
export interface TextChapter {
  id: string;
  title: string;
  paragraphs: string[];
}

/** Идентификаторы операций очистки. */
export type CleanupOp =
  | 'markdown'
  | 'shifted'
  | 'mixedScript'
  | 'control'
  | 'whitespace'
  | 'hyphenation'
  | 'joinLines'
  | 'quotes'
  | 'dashes'
  | 'headers'
  | 'pageNumbers'
  | 'mergeParagraphs'
  | 'ai';

export interface CleanupOpInfo {
  id: CleanupOp;
  label: string;
  description: string;
  /** Включена по умолчанию */
  defaultOn: boolean;
  /** Применяется ко всей книге/главе целиком (структурная операция), а не к отдельному абзацу */
  structural?: boolean;
}

export const CLEANUP_OPS: CleanupOpInfo[] = [
  { id: 'markdown', label: 'Убрать Markdown-разметку', description: '**жирный**, _курсив_, # заголовки, `код`, ссылки', defaultOn: true },
  { id: 'shifted', label: 'Исправить сдвинутую кириллицу', description: '«"@52>30» -> «Тревога» (код символа + 0x400)', defaultOn: true },
  { id: 'mixedScript', label: 'Латинские двойники в русских словах', description: '«рaзный» с латинской «a» -> кириллическая', defaultOn: true },
  { id: 'control', label: 'Удалить мусорные символы', description: 'U+FFFD (\uFFFD), управляющие и невидимые символы, мягкие переносы', defaultOn: true },
  { id: 'whitespace', label: 'Нормализовать пробелы', description: 'неразрывные и двойные пробелы, пробелы перед знаками', defaultOn: true },
  { id: 'hyphenation', label: 'Склеить переносы слов', description: '«пред- ложение» -> «предложение»', defaultOn: true },
  { id: 'joinLines', label: 'Склеить разорванные строки внутри абзаца', description: 'одиночные переводы строки -> пробел', defaultOn: true },
  { id: 'mergeParagraphs', label: 'Склеить абзацы, разорванные страницей', description: 'абзац без точки + следующий со строчной буквы', defaultOn: true, structural: true },
  { id: 'headers', label: 'Удалить повторяющиеся колонтитулы', description: 'короткие строки, повторяющиеся по всей книге', defaultOn: true, structural: true },
  { id: 'pageNumbers', label: 'Удалить одиночные номера страниц', description: 'абзацы вида «12», «— 12 —», «стр. 12»', defaultOn: true, structural: true },
  { id: 'quotes', label: 'Кавычки -> «ёлочки»', description: '"текст" и “текст” -> «текст»', defaultOn: false },
  { id: 'dashes', label: 'Дефис в тире', description: '« - » и «- » в начале реплики -> «—»', defaultOn: false },
];

export const DEFAULT_CLEANUP_OPS: CleanupOp[] = CLEANUP_OPS.filter((o) => o.defaultOn).map((o) => o.id);

export type QualitySeverity = 'info' | 'warn' | 'error';

export type QualityIssueCode =
  | 'EMPTY_BOOK'
  | 'TOO_LITTLE_TEXT'
  | 'REPLACEMENT_CHARS'
  | 'CONTROL_CHARS'
  | 'MARKDOWN'
  | 'SHIFTED_CYRILLIC'
  | 'MIXED_SCRIPT'
  | 'NON_LETTERS'
  | 'NO_VOWEL_WORDS'
  | 'SHORT_WORDS'
  | 'LANG_MISMATCH'
  | 'EMPTY_CHAPTERS'
  | 'BROKEN_PARAGRAPHS'
  | 'HYPHEN_LEFTOVERS'
  | 'REPEATED_HEADERS'
  | 'PAGE_NUMBERS'
  | 'SINGLE_CHAPTER';

export interface QualityIssue {
  code: QualityIssueCode;
  severity: QualitySeverity;
  /** Описание проблемы по-русски */
  message: string;
  /** Количество найденных случаев (слов, абзацев, символов - по смыслу проблемы) */
  count: number;
  /** Доля от общего числа (0..1) */
  ratio: number;
  /** Операции очистки, которые помогают */
  fixOps: CleanupOp[];
  /** Нужен отдельный инструмент редактора (вкладка «Главы») */
  tool?: 'chapters';
}

export interface QualityMetrics {
  chars: number;
  words: number;
  paragraphs: number;
  chapters: number;
  replacementCharRatio: number;
  controlCharRatio: number;
  markdownParagraphRatio: number;
  shiftedParagraphRatio: number;
  mixedScriptWordRatio: number;
  nonLetterRatio: number;
  noVowelWordRatio: number;
  shortWordRatio: number;
  cyrillicLetterRatio: number;
  latinLetterRatio: number;
  emptyChapterRatio: number;
  lowercaseStartRatio: number;
  hyphenLeftovers: number;
  repeatedHeaderParagraphs: number;
  pageNumberParagraphs: number;
}

export interface QualityReport {
  /** 0..100, чем больше, тем лучше */
  score: number;
  grade: 'good' | 'fair' | 'poor';
  issues: QualityIssue[];
  metrics: QualityMetrics;
  /** Короткая рекомендация (что делать) */
  recommendation?: string;
  /** Короткое резюме для заголовка */
  summary: string;
}

export interface QualityOptions {
  /** Книга получена из PDF (рекомендации про режимы распознавания) */
  isPdf?: boolean;
  /** Режим, которым книга распознана */
  pdfMode?: 'pdfjs' | 'pymupdf' | 'gemini';
}
