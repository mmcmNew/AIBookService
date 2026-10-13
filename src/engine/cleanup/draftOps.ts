import { validateRegexPattern } from '../tokenizer/dictionaryReplacer';
import type { SentenceItem } from '../../types/book';
import type { AppliedChapter } from './pipeline';
import { mergeTwoParagraphs } from './textOps';
import { nextKey, type DraftChapter, type DraftParagraph } from './bookModel';

/** Чистые операции над черновиком книги (иммутабельные) — основа undo-стека редактора. */

const poolOf = (p: DraftParagraph): SentenceItem[] => p.pool ?? p.source?.sentences ?? [];

const withChapter = (draft: DraftChapter[], ci: number, fn: (c: DraftChapter) => DraftChapter): DraftChapter[] =>
  draft.map((c, i) => (i === ci ? fn(c) : c));

export function updateParagraphText(draft: DraftChapter[], ci: number, pi: number, text: string): DraftChapter[] {
  const p = draft[ci]?.paragraphs[pi];
  if (!p || p.text === text) return draft;
  return withChapter(draft, ci, (c) => ({
    ...c,
    paragraphs: c.paragraphs.map((x, i) => (i === pi ? { ...x, text, pool: poolOf(x) } : x)),
  }));
}

export function deleteParagraph(draft: DraftChapter[], ci: number, pi: number): DraftChapter[] {
  if (!draft[ci]?.paragraphs[pi]) return draft;
  return withChapter(draft, ci, (c) => ({ ...c, paragraphs: c.paragraphs.filter((_, i) => i !== pi) }));
}

/** Склеить абзац `pi` со следующим. */
export function mergeParagraphWithNext(draft: DraftChapter[], ci: number, pi: number): DraftChapter[] {
  const c = draft[ci];
  if (!c || pi < 0 || pi + 1 >= c.paragraphs.length) return draft;
  const a = c.paragraphs[pi];
  const b = c.paragraphs[pi + 1];
  const merged: DraftParagraph = {
    key: nextKey('p'),
    text: mergeTwoParagraphs(a.text, b.text),
    pool: [...poolOf(a), ...poolOf(b)],
  };
  return withChapter(draft, ci, (ch) => ({
    ...ch,
    paragraphs: [...ch.paragraphs.slice(0, pi), merged, ...ch.paragraphs.slice(pi + 2)],
  }));
}

/** Разбить абзац по позиции курсора (смещение в символах). */
export function splitParagraph(draft: DraftChapter[], ci: number, pi: number, offset: number): DraftChapter[] {
  const p = draft[ci]?.paragraphs[pi];
  if (!p) return draft;
  const left = p.text.slice(0, offset).trim();
  const right = p.text.slice(offset).trim();
  if (!left || !right) return draft;
  const pool = poolOf(p);
  const a: DraftParagraph = { key: nextKey('p'), text: left, pool };
  const b: DraftParagraph = { key: nextKey('p'), text: right, pool };
  return withChapter(draft, ci, (c) => ({
    ...c,
    paragraphs: [...c.paragraphs.slice(0, pi), a, b, ...c.paragraphs.slice(pi + 1)],
  }));
}

/** Добавить пустой абзац после `pi` (-1 — в начало главы). */
export function addParagraph(draft: DraftChapter[], ci: number, afterIndex: number, text = ''): DraftChapter[] {
  if (!draft[ci]) return draft;
  const fresh: DraftParagraph = { key: nextKey('p'), text };
  return withChapter(draft, ci, (c) => ({
    ...c,
    paragraphs: [...c.paragraphs.slice(0, afterIndex + 1), fresh, ...c.paragraphs.slice(afterIndex + 1)],
  }));
}

/** Начать новую главу с абзаца `pi`: абзацы с `pi` и до конца переходят в новую главу. */
export function splitChapterAt(draft: DraftChapter[], ci: number, pi: number, title = 'Новая глава'): DraftChapter[] {
  const c = draft[ci];
  if (!c || pi <= 0 || pi >= c.paragraphs.length) return draft;
  const tail: DraftChapter = {
    key: nextKey('c'),
    id: `ed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    title,
    level: c.level,
    paragraphs: c.paragraphs.slice(pi),
  };
  return [...draft.slice(0, ci), { ...c, paragraphs: c.paragraphs.slice(0, pi) }, tail, ...draft.slice(ci + 1)];
}

export function renameChapter(draft: DraftChapter[], ci: number, title: string): DraftChapter[] {
  if (!draft[ci] || draft[ci].title === title) return draft;
  return withChapter(draft, ci, (c) => ({ ...c, title }));
}

export function deleteChapter(draft: DraftChapter[], ci: number): DraftChapter[] {
  if (!draft[ci] || draft.length <= 1) return draft;
  return draft.filter((_, i) => i !== ci);
}

/** Склеить главу `ci` со следующей: абзацы следующей добавляются в конец. */
export function mergeChapterWithNext(draft: DraftChapter[], ci: number): DraftChapter[] {
  if (!draft[ci] || ci + 1 >= draft.length) return draft;
  const a = draft[ci];
  const b = draft[ci + 1];
  const merged: DraftChapter = { ...a, paragraphs: [...a.paragraphs, ...b.paragraphs] };
  return [...draft.slice(0, ci), merged, ...draft.slice(ci + 2)];
}

/** Результат очистки (applyCleanupPlan) -> черновик. Неизменённые абзацы сохраняют идентичность. */
export function applyCleanupToDraft(draft: DraftChapter[], applied: AppliedChapter[]): DraftChapter[] {
  return draft.map((chapter, ci) => {
    const res = applied[ci];
    if (!res) return chapter;
    const unchanged =
      res.paragraphs.length === chapter.paragraphs.length && res.kept.every((k, j) => k === j);
    if (unchanged) return chapter;
    const paragraphs = res.paragraphs.map((text, j): DraftParagraph => {
      const keptIdx = res.kept[j];
      if (keptIdx !== null && keptIdx !== undefined) return chapter.paragraphs[keptIdx];
      const pool = res.origins[j].flatMap((o) => poolOf(chapter.paragraphs[o]));
      return { key: nextKey('p'), text, pool };
    });
    return { ...chapter, paragraphs };
  });
}

/** Заменить тексты отдельных абзацев (например, результат ИИ-очистки). Ключ: `${ci}:${pi}`. */
export function applyParagraphReplacements(draft: DraftChapter[], replacements: Map<string, string>): DraftChapter[] {
  if (replacements.size === 0) return draft;
  return draft.map((chapter, ci) => {
    let touched = false;
    const paragraphs = chapter.paragraphs.map((p, pi) => {
      const t = replacements.get(`${ci}:${pi}`);
      if (t === undefined || t === p.text) return p;
      touched = true;
      return { ...p, text: t, pool: poolOf(p) };
    });
    return touched ? { ...chapter, paragraphs } : chapter;
  });
}

// ---------------------------------------------------------------------------
// Поиск и замена
// ---------------------------------------------------------------------------

export interface SearchSpec {
  find: string;
  replace: string;
  regex: boolean;
  caseSensitive: boolean;
}

export interface Matcher {
  re: RegExp;
  replacement: string;
}

export function buildMatcher(spec: SearchSpec): { matcher?: Matcher; error?: string } {
  if (!spec.find) return { error: 'Введите, что искать' };
  const flags = 'g' + (spec.caseSensitive ? '' : 'i') + 'u';
  try {
    if (spec.regex) {
      const v = validateRegexPattern(spec.find);
      if (!v.ok) return { error: v.reason ?? 'Недопустимое выражение' };
      if (new RegExp(spec.find, flags.replace('g', '')).test('')) {
        return { error: 'Выражение совпадает с пустой строкой — уточните шаблон' };
      }
      return { matcher: { re: new RegExp(spec.find, flags), replacement: spec.replace } };
    }
    const escaped = spec.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { matcher: { re: new RegExp(escaped, flags), replacement: spec.replace.replace(/\$/g, '$$$$') } };
  } catch (e) {
    return { error: `Некорректное выражение: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export interface SearchHit {
  chapterIndex: number;
  paragraphIndex: number;
  /** Число совпадений в абзаце */
  count: number;
  snippet: string;
}

const MAX_SEARCH_INPUT = 20000;

export function findInDraft(
  draft: DraftChapter[],
  matcher: Matcher,
  chapterIndexes?: number[],
  limit = 200
): { hits: SearchHit[]; total: number; truncated: boolean } {
  const hits: SearchHit[] = [];
  let total = 0;
  const scope = chapterIndexes ? new Set(chapterIndexes) : null;
  draft.forEach((chapter, ci) => {
    if (scope && !scope.has(ci)) return;
    chapter.paragraphs.forEach((p, pi) => {
      if (p.text.length > MAX_SEARCH_INPUT) return;
      matcher.re.lastIndex = 0;
      const m = p.text.match(matcher.re);
      if (!m) return;
      total += m.length;
      if (hits.length < limit) {
        matcher.re.lastIndex = 0;
        const first = matcher.re.exec(p.text);
        const at = first ? first.index : 0;
        const start = Math.max(0, at - 40);
        hits.push({
          chapterIndex: ci,
          paragraphIndex: pi,
          count: m.length,
          snippet: (start > 0 ? '…' : '') + p.text.slice(start, at + 80) + (at + 80 < p.text.length ? '…' : ''),
        });
      }
    });
  });
  matcher.re.lastIndex = 0;
  return { hits, total, truncated: hits.length >= limit };
}

export function replaceInDraft(
  draft: DraftChapter[],
  matcher: Matcher,
  chapterIndexes?: number[]
): { draft: DraftChapter[]; replaced: number } {
  let replaced = 0;
  const scope = chapterIndexes ? new Set(chapterIndexes) : null;
  const next = draft.map((chapter, ci) => {
    if (scope && !scope.has(ci)) return chapter;
    let touched = false;
    const paragraphs = chapter.paragraphs.map((p) => {
      if (p.text.length > MAX_SEARCH_INPUT) return p;
      matcher.re.lastIndex = 0;
      const text = p.text.replace(matcher.re, (...args: any[]) => {
        replaced++;
        // Подстановка $1, $&, $<name> выполняется стандартным механизмом: пересчитываем на совпавшем фрагменте
        return expand(matcher.replacement, args);
      });
      if (text === p.text) return p;
      touched = true;
      return { ...p, text, pool: poolOf(p) };
    });
    return touched ? { ...chapter, paragraphs } : chapter;
  });
  matcher.re.lastIndex = 0;
  return { draft: next, replaced };
}

/** Разворачивает шаблон замены ($1, $&, $$, $<имя>) для аргументов колбэка String.replace. */
function expand(template: string, args: any[]): string {
  const hasGroups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
  const groups = hasGroups ? (args[args.length - 1] as Record<string, string>) : undefined;
  const tail = hasGroups ? 3 : 2; // offset, string, [groups]
  const captures = args.slice(1, args.length - tail);
  return template.replace(/\$(\$|&|\d{1,2}|<([^>]+)>)/g, (full, token: string, name?: string) => {
    if (token === '$') return '$';
    if (token === '&') return args[0];
    if (name) return groups?.[name] ?? '';
    const n = Number(token);
    if (n >= 1 && n <= captures.length) return captures[n - 1] ?? '';
    return full;
  });
}
