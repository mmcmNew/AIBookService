import type { ManualChapterStart, PagedOutlineItem } from '../../types/book';
import { detectChapters, type DetectParagraph } from '../cleanup/chapters';
import { stripMarkdown } from '../cleanup/markdown';
import type { ComposedPage } from './pageCompose';

/**
 * Построение глав постраничной книги. Источники по убыванию приоритета:
 *   manual   — границы, заданные пользователем («Определить главы» / правка);
 *   outline  — оглавление PDF (границы известны сразу, страницы могут быть ещё не распознаны);
 *   headings — заголовки из блоков heading и текстовые эвристики (cleanup/chapters.ts) по распознанным страницам;
 *   ranges   — «Страницы N–M».
 * Идентификаторы глав привязаны к позиции начала (страница + абзац), а не к порядковому номеру, поэтому при
 * достройке содержания существующие главы сохраняют id. Позиция чтения определяется по предложению, не по главе.
 */

export type ChapterSource = 'manual' | 'outline' | 'headings' | 'ranges';

export interface ChapterSpec {
  id: string;
  title: string;
  level: number;
  startPage: number;
  /** Первый абзац (индекс блока) страницы startPage, входящий в главу */
  startBlock: number;
  source: ChapterSource;
  /** Абзацы заголовка (page:block), которые не читаются как текст — название озвучивается отдельно */
  hide: Array<[number, number]>;
}

export const RANGE_CHUNK_PAGES = 20;

const norm = (s: string) => stripMarkdown(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function rangeTitle(from: number, to: number): string {
  return from === to ? `Страница ${from}` : `Страницы ${from}–${to}`;
}

function leadSpec(firstPage: number): ChapterSpec {
  return {
    id: 'r1',
    title: firstPage > 1 ? rangeTitle(1, firstPage - 1) : 'Начало',
    level: 1,
    startPage: 1,
    startBlock: 0,
    source: 'ranges',
    hide: [],
  };
}

function rangeSpecs(pageCount: number, chunk: number): ChapterSpec[] {
  const out: ChapterSpec[] = [];
  for (let s = 1; s <= pageCount; s += chunk) {
    const e = Math.min(pageCount, s + chunk - 1);
    out.push({ id: `r${s}`, title: rangeTitle(s, e), level: 1, startPage: s, startBlock: 0, source: 'ranges', hide: [] });
  }
  return out;
}

/** Главы по оглавлению PDF. Возвращает null, если оглавление непригодно (меньше двух пунктов). */
export function planFromOutline(outline: PagedOutlineItem[], pageCount: number, pages: ComposedPage[]): ChapterSpec[] | null {
  const valid = outline.filter((o) => o.title && o.page >= 1 && o.page <= pageCount);
  if (valid.length < 2) return null;
  const minLevel = Math.min(...valid.map((o) => o.level || 1));
  let usable = valid.filter((o) => (o.level || 1) <= minLevel + 1);
  if (usable.length < 2) usable = valid;
  // Порядок по странице; на одной странице остаётся первый пункт
  const sorted = usable.map((o, i) => ({ o, i })).sort((a, b) => a.o.page - b.o.page || a.i - b.i);
  const picked: Array<{ o: PagedOutlineItem; i: number }> = [];
  for (const e of sorted) {
    if (picked.length && picked[picked.length - 1].o.page === e.o.page) continue;
    picked.push(e);
  }
  if (picked.length < 2) return null;

  const specs: ChapterSpec[] = [];
  if (picked[0].o.page > 1) specs.push(leadSpec(picked[0].o.page));
  picked.forEach(({ o }, k) => {
    const title = stripMarkdown(o.title).replace(/\s+/g, ' ').trim();
    const t = norm(title);
    let startBlock = 0;
    const hide: Array<[number, number]> = [];
    const cp = pages[o.page - 1];
    if (cp && cp.state === 'done') {
      const cand = cp.paragraphs.slice(0, 4).find((p) => {
        const pt = norm(p.text);
        return pt.length > 0 && t.length > 0 && (pt === t || (pt.length <= t.length + 40 && (pt.startsWith(t) || (t.length > 6 && t.startsWith(pt) && pt.length > 3))));
      });
      if (cand) {
        startBlock = cand.block;
        hide.push([cand.page, cand.block]);
      }
    }
    specs.push({
      id: `o${k}`,
      title: title || `Раздел ${k + 1}`,
      level: Math.max(1, (o.level || 1) - minLevel + 1),
      startPage: o.page,
      startBlock,
      source: 'outline',
      hide,
    });
  });
  return specs;
}

/** Главы по заголовкам распознанных страниц. null — заголовков нет. */
export function planFromHeadings(pages: ComposedPage[]): ChapterSpec[] | null {
  const refs: Array<{ page: number; block: number }> = [];
  const detect: DetectParagraph[] = [];
  for (const cp of pages) {
    cp.paragraphs.forEach((p, i) => {
      refs.push({ page: p.page, block: p.block });
      detect.push({
        text: p.text,
        page: p.page,
        newPage: i === 0,
        forced: p.type === 'heading' && (p.level ?? 2) <= 2,
      });
    });
  }
  if (detect.length === 0) return null;
  const result = detectChapters(detect, { fallbackBySize: false });
  if (result.method !== 'headings') return null;
  const real = result.chapters.filter((c) => c.headingIndex !== null);
  if (real.length === 0) return null;

  const specs: ChapterSpec[] = [];
  const startsAt = real.map((c) => refs[c.headingIndex as number]);
  const first = startsAt[0];
  // Ведущая глава нужна, если до первого заголовка есть страницы или абзацы текста
  if (first.page > 1 || (real[0].headingIndex as number) > 0) specs.push(leadSpec(first.page));
  real.forEach((c, k) => {
    const h = c.headingIndex as number;
    const ref = refs[h];
    const spanEnd = k + 1 < real.length ? (real[k + 1].headingIndex as number) : detect.length;
    const items = new Set(c.items);
    const hide: Array<[number, number]> = [[ref.page, ref.block]];
    // Строки названия, поглощённые заголовком («ГЛАВА 1» + «Название»), идут сразу за ним и не входят в items
    for (let i = h + 1; i < spanEnd && !items.has(i); i++) hide.push([refs[i].page, refs[i].block]);
    specs.push({
      id: `h${ref.page}_${ref.block}`,
      title: c.title,
      level: c.level || 1,
      startPage: ref.page,
      startBlock: ref.block,
      source: 'headings',
      hide,
    });
  });
  return specs;
}

export function planFromManual(manual: ManualChapterStart[]): ChapterSpec[] | null {
  if (!manual || manual.length === 0) return null;
  const sorted = manual.slice().sort((a, b) => a.page - b.page || a.block - b.block);
  const specs: ChapterSpec[] = [];
  const first = sorted[0];
  if (first.page > 1) specs.push(leadSpec(first.page));
  for (const m of sorted) {
    const hide: Array<[number, number]> = (m.hideBlocks ?? []).map((b) => [m.page, b]);
    specs.push({
      id: `m${m.page}_${m.block}`,
      title: m.title,
      level: m.level || 1,
      startPage: m.page,
      startBlock: m.block,
      source: 'manual',
      hide,
    });
  }
  return specs;
}

export interface PlanInput {
  pageCount: number;
  outline: PagedOutlineItem[];
  pages: ComposedPage[];
  manual?: ManualChapterStart[];
  rangeChunk?: number;
}

/** Итоговый план глав (всегда непустой, отсортирован по позиции начала). */
export function planChapters(input: PlanInput): ChapterSpec[] {
  const specs =
    planFromManual(input.manual ?? []) ??
    planFromOutline(input.outline, input.pageCount, input.pages) ??
    planFromHeadings(input.pages) ??
    rangeSpecs(input.pageCount, input.rangeChunk ?? RANGE_CHUNK_PAGES);
  // Одинаковые id (редкие совпадения позиций) делаем уникальными
  const seen = new Set<string>();
  for (const s of specs) {
    let id = s.id;
    let n = 2;
    while (seen.has(id)) id = `${s.id}_${n++}`;
    seen.add(id);
    s.id = id;
  }
  return specs;
}
