import { stripMarkdown } from './markdown';
import { repairShiftedCyrillic } from './shiftedCyrillic';
import {
  findRepeatedHeaders,
  fixHyphenation,
  fixMixedScript,
  isPageNumber,
  isRepeatedHeader,
  joinLines,
  mergeTwoParagraphs,
  normalizeTypography,
  normalizeWhitespace,
  removeControlChars,
  shouldMergeParagraphs,
} from './textOps';
import type { CleanupOp, TextChapter } from './types';

/** Порядок важен: сдвинутую кириллицу чиним до удаления управляющих символов (коды 0x10–0x1F — это «А–П»). */
const PARAGRAPH_OPS_ORDER: CleanupOp[] = [
  'markdown',
  'shifted',
  'mixedScript',
  'control',
  'hyphenation',
  'joinLines',
  'whitespace',
  'quotes',
  'dashes',
];

/** Применяет к одному абзацу локальные операции очистки; возвращает результат и список реально сработавших. */
export function cleanParagraph(text: string, ops: CleanupOp[]): { text: string; applied: CleanupOp[] } {
  const enabled = new Set(ops);
  let current = text;
  const applied: CleanupOp[] = [];
  const run = (op: CleanupOp, fn: (s: string) => string) => {
    if (!enabled.has(op)) return;
    const next = fn(current);
    if (next !== current) {
      applied.push(op);
      current = next;
    }
  };

  for (const op of PARAGRAPH_OPS_ORDER) {
    switch (op) {
      case 'markdown':
        run(op, (s) => stripMarkdown(s));
        break;
      case 'shifted':
        run(op, (s) => repairShiftedCyrillic(s).text);
        break;
      case 'mixedScript':
        run(op, fixMixedScript);
        break;
      case 'control':
        run(op, removeControlChars);
        break;
      case 'hyphenation':
        run(op, fixHyphenation);
        break;
      case 'joinLines':
        run(op, joinLines);
        break;
      case 'whitespace':
        run(op, normalizeWhitespace);
        break;
      case 'quotes':
        run(op, (s) => normalizeTypography(s, { quotes: true, dashes: false }));
        break;
      case 'dashes':
        run(op, (s) => normalizeTypography(s, { quotes: false, dashes: true }));
        break;
    }
  }
  return { text: current, applied };
}

export type ChangeKind = 'edit' | 'delete' | 'merge';

export interface CleanupChange {
  /** Устойчивый идентификатор: `e:глава:абзац`, `d:...`, `m:...` */
  id: string;
  kind: ChangeKind;
  chapterIndex: number;
  /** Индекс абзаца в исходной главе */
  paragraphIndex: number;
  chapterTitle: string;
  before: string;
  after: string;
  ops: CleanupOp[];
}

export interface CleanupPlan {
  changes: CleanupChange[];
  /** Сколько абзацев затронуто по главам (для сводки) */
  summary: { edits: number; deletes: number; merges: number };
}

export interface PlanOptions {
  /** Индексы глав, к которым применять очистку (по умолчанию — все) */
  chapterIndexes?: number[];
}

const changeId = (kind: ChangeKind, ci: number, pi: number) => `${kind[0]}:${ci}:${pi}`;

/**
 * Строит план очистки (предпросмотр): ничего не изменяет, возвращает список изменений.
 * Колонтитулы определяются по всей книге, даже если очищается одна глава.
 */
export function planCleanup(chapters: TextChapter[], ops: CleanupOp[], options: PlanOptions = {}): CleanupPlan {
  const enabled = new Set(ops);
  const scope = options.chapterIndexes ? new Set(options.chapterIndexes) : null;
  const headers = enabled.has('headers') ? findRepeatedHeaders(chapters.map((c) => c.paragraphs)) : new Set<string>();
  const changes: CleanupChange[] = [];

  chapters.forEach((chapter, ci) => {
    if (scope && !scope.has(ci)) return;
    const original = chapter.paragraphs;
    const after: string[] = [];
    const appliedOps: CleanupOp[][] = [];
    original.forEach((p) => {
      const r = cleanParagraph(p, ops);
      after.push(r.text);
      appliedOps.push(r.applied);
    });

    const alive = original.map(() => true);
    const deleteChanges = new Map<number, CleanupChange>();

    // Фаза A: абзац после очистки стал пустым -> удаление
    original.forEach((p, pi) => {
      if (after[pi].trim() === '' && p.trim() !== '') {
        alive[pi] = false;
        deleteChanges.set(pi, {
          id: changeId('delete', ci, pi),
          kind: 'delete',
          chapterIndex: ci,
          paragraphIndex: pi,
          chapterTitle: chapter.title,
          before: p,
          after: '',
          ops: appliedOps[pi].length ? appliedOps[pi] : ['markdown'],
        });
      } else if (p.trim() === '' && enabled.has('whitespace')) {
        // Пустые абзацы тоже убираем
        alive[pi] = false;
        deleteChanges.set(pi, {
          id: changeId('delete', ci, pi),
          kind: 'delete',
          chapterIndex: ci,
          paragraphIndex: pi,
          chapterTitle: chapter.title,
          before: p,
          after: '',
          ops: ['whitespace'],
        });
      }
    });

    // Фаза B1: номера страниц и колонтитулы
    original.forEach((p, pi) => {
      if (!alive[pi]) return;
      const cur = after[pi];
      let op: CleanupOp | null = null;
      if (enabled.has('pageNumbers') && isPageNumber(cur)) op = 'pageNumbers';
      else if (enabled.has('headers') && isRepeatedHeader(cur, headers)) op = 'headers';
      if (op) {
        alive[pi] = false;
        deleteChanges.set(pi, {
          id: changeId('delete', ci, pi),
          kind: 'delete',
          chapterIndex: ci,
          paragraphIndex: pi,
          chapterTitle: chapter.title,
          before: p,
          after: '',
          ops: [op],
        });
      }
    });

    // Фаза B2: склейка разорванных абзацев (по оставшимся)
    const mergeChanges: CleanupChange[] = [];
    if (enabled.has('mergeParagraphs')) {
      let prevIdx = -1;
      let prevText = '';
      original.forEach((_, pi) => {
        if (!alive[pi]) return;
        const cur = after[pi];
        if (prevIdx >= 0 && shouldMergeParagraphs(prevText, cur)) {
          const merged = mergeTwoParagraphs(prevText, cur);
          mergeChanges.push({
            id: changeId('merge', ci, pi),
            kind: 'merge',
            chapterIndex: ci,
            paragraphIndex: pi,
            chapterTitle: chapter.title,
            before: `${prevText}\n↳ ${cur}`,
            after: merged,
            ops: ['mergeParagraphs'],
          });
          prevText = merged;
        } else {
          prevIdx = pi;
          prevText = cur;
        }
      });
    }

    // Правки текста (только для оставшихся и реально изменённых)
    original.forEach((p, pi) => {
      if (deleteChanges.has(pi)) return;
      if (after[pi] !== p) {
        changes.push({
          id: changeId('edit', ci, pi),
          kind: 'edit',
          chapterIndex: ci,
          paragraphIndex: pi,
          chapterTitle: chapter.title,
          before: p,
          after: after[pi],
          ops: appliedOps[pi],
        });
      }
    });
    changes.push(...deleteChanges.values(), ...mergeChanges);
  });

  changes.sort((a, b) => a.chapterIndex - b.chapterIndex || a.paragraphIndex - b.paragraphIndex);
  return {
    changes,
    summary: {
      edits: changes.filter((c) => c.kind === 'edit').length,
      deletes: changes.filter((c) => c.kind === 'delete').length,
      merges: changes.filter((c) => c.kind === 'merge').length,
    },
  };
}

export interface AppliedChapter {
  paragraphs: string[];
  /** Для каждого итогового абзаца: индекс исходного абзаца, если текст не изменился; иначе null */
  kept: (number | null)[];
  /** Для каждого итогового абзаца: индексы исходных абзацев, из которых он получен */
  origins: number[][];
}

/**
 * Применяет выбранные изменения плана. Возвращает новые абзацы глав (главы без изменений возвращаются как есть).
 */
export function applyCleanupPlan(
  chapters: TextChapter[],
  plan: CleanupPlan,
  selected?: Set<string>
): AppliedChapter[] {
  const byChapter = new Map<number, CleanupChange[]>();
  for (const c of plan.changes) {
    if (selected && !selected.has(c.id)) continue;
    const list = byChapter.get(c.chapterIndex);
    if (list) list.push(c);
    else byChapter.set(c.chapterIndex, [c]);
  }

  return chapters.map((chapter, ci) => {
    const list = byChapter.get(ci);
    if (!list) {
      return {
        paragraphs: chapter.paragraphs,
        kept: chapter.paragraphs.map((_, i) => i),
        origins: chapter.paragraphs.map((_, i) => [i]),
      };
    }
    const original = chapter.paragraphs;
    const text = original.slice();
    const removed = new Set<number>();
    const merges = new Set<number>();
    const edited = new Set<number>();
    for (const c of list) {
      if (c.kind === 'edit') {
        text[c.paragraphIndex] = c.after;
        edited.add(c.paragraphIndex);
      } else if (c.kind === 'delete') removed.add(c.paragraphIndex);
      else merges.add(c.paragraphIndex);
    }

    const out: string[] = [];
    const kept: (number | null)[] = [];
    const origins: number[][] = [];
    original.forEach((_, pi) => {
      if (removed.has(pi)) return;
      if (merges.has(pi) && out.length > 0) {
        out[out.length - 1] = mergeTwoParagraphs(out[out.length - 1], text[pi]);
        kept[kept.length - 1] = null;
        origins[origins.length - 1].push(pi);
        return;
      }
      out.push(text[pi]);
      kept.push(edited.has(pi) ? null : pi);
      origins.push([pi]);
    });
    return { paragraphs: out, kept, origins };
  });
}

/** Быстрый путь: применить все операции ко всем (или выбранным) главам без предпросмотра. */
export function cleanChapters(chapters: TextChapter[], ops: CleanupOp[], options: PlanOptions = {}): TextChapter[] {
  const plan = planCleanup(chapters, ops, options);
  const applied = applyCleanupPlan(chapters, plan);
  return chapters.map((c, i) => ({ ...c, paragraphs: applied[i].paragraphs }));
}
