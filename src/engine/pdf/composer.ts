import type { Chapter, ManualChapterStart, PagedOutlineItem, SentenceItem } from '../../types/book';
import type { ReplacementRule } from '../../types/settings';
import { composePages, type ComposedPage, type ComposedParagraph } from './pageCompose';
import { planChapters, type ChapterSpec } from './chapterPlan';
import { buildParagraphSentences, pageOfSentenceId } from './pageSentences';
import { computeRunningKeys } from './runningHeaders';
import type { PageState, PdfPageRecord } from './types';

/**
 * Композитор постраничной книги: записи страниц -> абзацы (со склейкой границ) -> предложения -> главы.
 * Результат ComposedBook — единственный источник данных для плеера, текстового вида и оглавления.
 * Кэши по абзацам и по главам сохраняют идентичность объектов, поэтому React не перерисовывает неизменившееся.
 */

export interface ComposedBook {
  pageCount: number;
  pages: ComposedPage[];
  specs: ChapterSpec[];
  chapters: Chapter[];
  /** Все читаемые предложения в порядке чтения (id по возрастанию) */
  order: SentenceItem[];
  indexById: Map<number, number>;
  chapterOfSentence: Map<number, number>;
  /** Предложения по странице-владельцу */
  sentencesByPage: Map<number, SentenceItem[]>;
  /** Абзацы, не читаемые как текст (заголовок главы): ключ `${page}:${block}` */
  hidden: Set<string>;
  /** Главы, начинающиеся на странице */
  specsByPage: Map<number, ChapterSpec[]>;
  /** Число распознанных страниц и число страниц с текстом */
  doneCount: number;
}

export interface ComposeCache {
  sentences: Map<string, SentenceItem[]>;
  chapters: Map<string, Chapter>;
  hidden: Set<string> | null;
  rules: ReplacementRule[] | null;
  lang: string;
}

export function createComposeCache(): ComposeCache {
  return { sentences: new Map(), chapters: new Map(), hidden: null, rules: null, lang: 'ru' };
}

export interface ComposeInput {
  pageCount: number;
  outline: PagedOutlineItem[];
  getRecord: (page: number) => PdfPageRecord | undefined;
  rules: ReplacementRule[];
  manual?: ManualChapterStart[];
  lang?: string;
  /** Готовые ключи колонтитулов (если не заданы — считаются по записям) */
  runningKeys?: Set<string>;
}

const bboxSig = (p: ComposedParagraph) =>
  p.parts.map((x) => `${x.page}:${x.start}-${x.end}:${x.bbox ? x.bbox.join(',') : ''}:${x.pageHeight ?? ''}`).join('|');

function sentencesOf(par: ComposedParagraph, cache: ComposeCache): SentenceItem[] {
  const key = `${par.page}|${par.block}|${par.text}|${bboxSig(par)}`;
  let v = cache.sentences.get(key);
  if (!v) {
    v = buildParagraphSentences(par, cache.rules ?? [], cache.lang);
    cache.sentences.set(key, v);
  }
  return v;
}

function sameSentences(a: SentenceItem[], b: SentenceItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Позиция (страница, блок) строго раньше (страница2, блок2)? */
const before = (p: number, b: number, p2: number, b2: number) => p < p2 || (p === p2 && b < b2);

export function composeBook(input: ComposeInput, cache: ComposeCache): ComposedBook {
  const { pageCount } = input;
  const lang = input.lang ?? 'ru';
  if (cache.rules !== input.rules || cache.lang !== lang) {
    cache.sentences.clear();
    cache.rules = input.rules;
    cache.lang = lang;
  }

  const runningKeys =
    input.runningKeys ??
    computeRunningKeys(
      (function* () {
        for (let p = 1; p <= pageCount; p++) {
          const r = input.getRecord(p);
          if (r) yield r;
        }
      })(),
    );
  const pages = composePages(pageCount, input.getRecord, runningKeys);
  const specs = planChapters({ pageCount, outline: input.outline, pages, manual: input.manual });

  let hidden = new Set<string>();
  const specsByPage = new Map<number, ChapterSpec[]>();
  for (const s of specs) {
    for (const [p, b] of s.hide) hidden.add(`${p}:${b}`);
    const list = specsByPage.get(s.startPage);
    if (list) list.push(s);
    else specsByPage.set(s.startPage, [s]);
  }

  // Неизменившееся множество скрытых абзацев переиспользуем (стабильная ссылка для React.memo)
  if (cache.hidden && cache.hidden.size === hidden.size && [...hidden].every((k) => cache.hidden!.has(k))) hidden = cache.hidden;
  cache.hidden = hidden;

  // Предложения по порядку чтения + разметка по главам
  const order: SentenceItem[] = [];
  const sentencesByPage = new Map<number, SentenceItem[]>();
  const chapterOfSentence = new Map<number, number>();
  const perChapter: SentenceItem[][] = specs.map(() => []);
  let doneCount = 0;
  let specIdx = 0;
  const nextOf = (i: number) => specs[i + 1];

  for (const cp of pages) {
    if (cp.state === 'done') doneCount++;
    for (const par of cp.paragraphs) {
      while (specIdx + 1 < specs.length && !before(par.page, par.block, nextOf(specIdx).startPage, nextOf(specIdx).startBlock)) specIdx++;
      if (hidden.has(`${par.page}:${par.block}`)) continue;
      const sents = sentencesOf(par, cache);
      if (sents.length === 0) continue;
      for (const s of sents) {
        chapterOfSentence.set(s.id, specIdx);
        order.push(s);
      }
      perChapter[specIdx].push(...sents);
      const list = sentencesByPage.get(par.page);
      if (list) list.push(...sents);
      else sentencesByPage.set(par.page, sents.slice());
    }
  }

  const indexById = new Map<number, number>();
  order.forEach((s, i) => indexById.set(s.id, i));

  // Главы с сохранением идентичности неизменившихся объектов
  const nextChapters = new Map<string, Chapter>();
  const chapters: Chapter[] = specs.map((spec, i) => {
    const next = specs[i + 1];
    const endPage = next ? (next.startBlock > 0 ? next.startPage : next.startPage - 1) : pageCount;
    const lastPage = Math.max(spec.startPage, endPage);
    let done = 0;
    for (let p = spec.startPage; p <= lastPage; p++) if (pages[p - 1]?.state === 'done') done++;
    const total = lastPage - spec.startPage + 1;
    const sentences = perChapter[i];
    const prev = cache.chapters.get(spec.id);
    if (
      prev &&
      prev.title === spec.title &&
      prev.level === spec.level &&
      prev.startPage === spec.startPage &&
      prev.startBlock === spec.startBlock &&
      prev.endPage === lastPage &&
      prev.pagesDone === done &&
      sameSentences(prev.sentences, sentences)
    ) {
      nextChapters.set(spec.id, prev);
      return prev;
    }
    const chapter: Chapter = {
      id: spec.id,
      title: spec.title,
      level: spec.level,
      contentHtml: '',
      sentences,
      pageNumber: spec.startPage,
      startPage: spec.startPage,
      startBlock: spec.startBlock,
      endPage: lastPage,
      pagesTotal: total,
      pagesDone: done,
      stub: sentences.length === 0 && done < total,
    };
    nextChapters.set(spec.id, chapter);
    return chapter;
  });
  cache.chapters = nextChapters;
  // Не даём кэшу абзацев расти бесконечно при правках
  if (cache.sentences.size > 20000) cache.sentences.clear();

  return { pageCount, pages, specs, chapters, order, indexById, chapterOfSentence, sentencesByPage, hidden, specsByPage, doneCount };
}

// ---------------------------------------------------------------------------
// Навигация по прочитанному/непрочитанному тексту
// ---------------------------------------------------------------------------

/** Страница предложения для отображения (может отличаться от страницы-владельца у склеенного абзаца). */
export function sentencePage(s: SentenceItem): number {
  return s.pageNumber ?? pageOfSentenceId(s.id);
}

/** Индекс предложения в порядке чтения; если id исчез (перераспознавание) — ближайшее следующее. */
export function locateSentence(book: ComposedBook, id: number): number {
  const exact = book.indexById.get(id);
  if (exact !== undefined) return exact;
  let lo = 0;
  let hi = book.order.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (book.order[mid].id < id) lo = mid + 1;
    else hi = mid;
  }
  return lo < book.order.length ? lo : book.order.length - 1;
}

/** Первое предложение, показываемое на странице page или позже (null — читаемого текста нет). */
export function firstSentenceAtOrAfterPage(book: ComposedBook, page: number): SentenceItem | null {
  for (const s of book.order) if (sentencePage(s) >= page) return s;
  return null;
}

/** Первое предложение именно на странице page. */
export function firstSentenceOnPage(book: ComposedBook, page: number): SentenceItem | null {
  const own = book.sentencesByPage.get(page);
  if (own && own.length) return own[0];
  for (const s of book.order) {
    const sp = sentencePage(s);
    if (sp === page) return s;
    if (sp > page) break;
  }
  return null;
}

/** Индекс главы, содержащей страницу (по началу глав). */
export function chapterIndexForPage(book: ComposedBook, page: number): number {
  let idx = 0;
  for (let i = 0; i < book.specs.length; i++) {
    const s = book.specs[i];
    if (s.startPage <= page) idx = i;
    else break;
  }
  return idx;
}

export type NextStep =
  | { kind: 'sentence'; sentence: SentenceItem; chapterIndex: number }
  | { kind: 'wait'; page: number; state: PageState }
  | { kind: 'end' };

/**
 * Следующее предложение для озвучки. Если между текущим и следующим есть страница, которая ещё не распознана
 * (ожидает, идёт, ошибка) — возвращает wait: читать дальше нельзя, пропускать страницу нельзя.
 */
export function nextStep(book: ComposedBook, stateOf: (page: number) => PageState, currentId: number): NextStep {
  const idx = book.indexById.get(currentId);
  const cur = idx !== undefined ? book.order[idx] : null;
  const curPage = cur ? pageOfSentenceId(cur.id) : pageOfSentenceId(currentId);
  let nextIdx: number;
  if (idx !== undefined) nextIdx = idx + 1;
  else if (book.order.length === 0) nextIdx = 0;
  else {
    const li = locateSentence(book, currentId);
    nextIdx = book.order[li].id > currentId ? li : li + 1;
  }
  const next = nextIdx < book.order.length ? book.order[nextIdx] : null;
  const limit = next ? pageOfSentenceId(next.id) : book.pageCount + 1;
  // Страницы между текущей и следующей (для склеенного абзаца учитываем и страницу, на которую он заходит)
  const from = Math.max(curPage, cur ? sentencePage(cur) : curPage) + 1;
  for (let p = from; p < limit; p++) {
    const st = stateOf(p);
    if (st !== 'done') return { kind: 'wait', page: p, state: st };
  }
  if (!next) return { kind: 'end' };
  return { kind: 'sentence', sentence: next, chapterIndex: book.chapterOfSentence.get(next.id) ?? 0 };
}

export function prevSentenceOf(book: ComposedBook, currentId: number): { sentence: SentenceItem; chapterIndex: number } | null {
  const idx = book.indexById.get(currentId);
  if (idx === undefined || idx === 0) return null;
  const s = book.order[idx - 1];
  return { sentence: s, chapterIndex: book.chapterOfSentence.get(s.id) ?? 0 };
}
