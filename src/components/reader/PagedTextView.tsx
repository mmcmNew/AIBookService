import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader2, AlertCircle, RefreshCw, SkipForward, Hourglass } from 'lucide-react';
import { clsx } from 'clsx';
import { useBookStore } from '../../store/bookStore';
import { useSettingsStore } from '../../store/settingsStore';
import { coordinator } from '../../engine/audio/coordinator';
import { setFocusPage, setViewPage } from '../../engine/navigation';
import { usePagedStore } from '../../store/pagedStore';
import type { SentenceItem } from '../../types/book';
import type { ChapterSpec } from '../../engine/pdf/chapterPlan';
import type { ComposedPage } from '../../engine/pdf/pageCompose';
import type { PageState } from '../../engine/pdf/types';
import { paragraphIndexFor } from '../../engine/pdf/pageSentences';
import { sentencePage } from '../../engine/pdf/composer';
import { Paragraph } from './BookView';
import { openRerecognizeDialog } from './PagedBookBar';
import { ResumeAutoscrollButton, ensureVisible, scrollIntoComfortZone, useAutoscrollPause, useIsReading } from './readerScroll';

/**
 * Текстовый вид постраничной PDF-книги. Виртуализация по страницам: в DOM только окно страниц вокруг текущей
 * (по умолчанию -2…+6), окно расширяется по мере прокрутки и сдвигается вслед за озвучкой; остальные страницы
 * не рендерятся. Нераспознанные страницы показываются заглушками со статусом.
 */

const WINDOW_BEFORE = 2;
const WINDOW_AFTER = 6;
const MAX_WINDOW = 28;
const EXPAND_AFTER = 4;
const EXPAND_BEFORE = 3;

interface Win {
  start: number;
  end: number;
}

const aroundPage = (page: number, pageCount: number): Win => ({
  start: Math.max(1, page - WINDOW_BEFORE),
  end: Math.min(pageCount, page + WINDOW_AFTER),
});

/* --------------------------------- Заглушка ---------------------------------- */

const PagePlaceholder: React.FC<{ page: number; state: PageState; error?: string }> = ({ page, state, error }) => {
  const controller = usePagedStore((s) => s.controller);
  return (
    <div
      className="min-h-[45vh] flex flex-col items-center justify-center gap-2 text-center text-sm text-slate-500 dark:text-zinc-400 font-sans border border-dashed border-slate-200 dark:border-zinc-800 rounded-2xl px-4 py-8"
      data-page-state={state}
    >
      {state === 'running' && (
        <>
          <Loader2 className="w-6 h-6 animate-spin text-amber-500" aria-hidden="true" />
          <p>Распознаём страницу {page}…</p>
        </>
      )}
      {state === 'pending' && (
        <>
          <Hourglass className="w-6 h-6" aria-hidden="true" />
          <p>Страница {page} ждёт своей очереди на распознавание.</p>
          <button
            type="button"
            onClick={() => setFocusPage(page)}
            className="px-3 py-1.5 rounded-xl border border-slate-300 dark:border-zinc-700 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-zinc-800"
          >
            Распознать сейчас
          </button>
        </>
      )}
      {state === 'error' && (
        <>
          <AlertCircle className="w-6 h-6 text-rose-500" aria-hidden="true" />
          <p className="text-rose-700 dark:text-rose-400 max-w-md break-words">
            Не удалось распознать страницу {page}: {error ?? 'ошибка распознавания'}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => controller?.retryPage(page)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold"
            >
              <RefreshCw className="w-3 h-3" aria-hidden="true" /> Повторить
            </button>
            <button
              type="button"
              onClick={() => void controller?.skipPage(page)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-xl border border-slate-300 dark:border-zinc-700 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-zinc-800"
            >
              <SkipForward className="w-3 h-3" aria-hidden="true" /> Пропустить
            </button>
            <button
              type="button"
              onClick={() => openRerecognizeDialog(page, page)}
              className="px-3 py-1.5 rounded-xl border border-slate-300 dark:border-zinc-700 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-zinc-800"
            >
              Другой режим…
            </button>
          </div>
        </>
      )}
    </div>
  );
};

/* ---------------------------------- Страница ---------------------------------- */

interface SectionProps {
  page: number;
  state: PageState;
  error?: string;
  composedPage: ComposedPage | undefined;
  sentences: SentenceItem[] | undefined;
  specs: ChapterSpec[] | undefined;
  hidden: Set<string>;
  onJump: (id: number) => void;
}

const PageSection = memo(
  ({ page, state, error, composedPage, sentences, specs, hidden, onJump }: SectionProps) => {
    const items = useMemo(() => {
      const out: React.ReactNode[] = [];
      if (!composedPage || composedPage.state !== 'done') return out;
      const byPara = new Map<number, SentenceItem[]>();
      for (const s of sentences ?? []) {
        const list = byPara.get(s.paragraphIndex);
        if (list) list.push(s);
        else byPara.set(s.paragraphIndex, [s]);
      }
      const shown = (specs ?? []).filter((s) => s.source !== 'ranges');
      const emitted = new Set<string>();
      const emitHeadings = (beforeBlock: number) => {
        for (const sp of shown) {
          if (emitted.has(sp.id) || sp.startBlock > beforeBlock) continue;
          emitted.add(sp.id);
          out.push(
            <h2
              key={`ch_${sp.id}`}
              data-chapter-id={sp.id}
              className="mt-8 mb-5 text-2xl font-bold text-slate-900 dark:text-zinc-100 font-sans tracking-tight border-b border-slate-200 dark:border-zinc-800 pb-3"
            >
              {sp.title}
            </h2>,
          );
        }
      };
      for (const par of composedPage.paragraphs) {
        emitHeadings(par.block);
        if (hidden.has(`${par.page}:${par.block}`)) continue;
        const list = byPara.get(paragraphIndexFor(par.page, par.block));
        if (!list || list.length === 0) continue;
        if (par.type === 'heading') {
          out.push(
            <div key={`h_${par.block}`} className="font-semibold font-sans text-slate-900 dark:text-zinc-100 mt-2">
              <Paragraph sentences={list} onJump={onJump} />
            </div>,
          );
        } else {
          out.push(<Paragraph key={`p_${par.block}`} sentences={list} onJump={onJump} />);
        }
      }
      emitHeadings(Number.MAX_SAFE_INTEGER);
      return out;
    }, [composedPage, sentences, specs, hidden, onJump]);

    return (
      <section data-page={page} aria-label={`Страница ${page}`} className="mb-8">
        <div className="text-center text-[11px] text-slate-400 dark:text-zinc-600 select-none font-sans my-4" aria-hidden="true">
          — стр. {page} —
        </div>
        {state === 'done' ? (
          items.length > 0 ? (
            <div className="space-y-5">{items}</div>
          ) : (
            <p className="text-center text-xs text-slate-400 dark:text-zinc-500 font-sans italic py-6">
              {composedPage?.skipped ? 'Страница пропущена.' : 'На странице нет текста для чтения.'}
            </p>
          )
        ) : (
          <PagePlaceholder page={page} state={state} error={error} />
        )}
      </section>
    );
  },
  (a, b) =>
    a.page === b.page &&
    a.state === b.state &&
    a.error === b.error &&
    a.onJump === b.onJump &&
    a.hidden === b.hidden &&
    a.composedPage?.state === b.composedPage?.state &&
    sameList(a.sentences, b.sentences) &&
    sameSpecs(a.specs, b.specs) &&
    sameParas(a.composedPage, b.composedPage),
);
PageSection.displayName = 'PageSection';

function sameList(a?: SentenceItem[], b?: SentenceItem[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function sameSpecs(a?: ChapterSpec[], b?: ChapterSpec[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((s, i) => s.id === b[i].id && s.title === b[i].title && s.startBlock === b[i].startBlock);
}
function sameParas(a?: ComposedPage, b?: ComposedPage): boolean {
  if (a === b) return true;
  if (!a || !b || a.paragraphs.length !== b.paragraphs.length) return false;
  return a.paragraphs.every((p, i) => p.block === b.paragraphs[i].block && p.type === b.paragraphs[i].type && p.text === b.paragraphs[i].text);
}

/* ----------------------------------- Вид ------------------------------------ */

export const PagedTextView: React.FC = () => {
  const currentBook = useBookStore((s) => s.currentBook);
  const currentPage = useBookStore((s) => s.currentPage);
  const currentSentenceId = useBookStore((s) => s.currentSentenceId);
  const jumpToSentence = coordinator.jumpToSentence;
  const composed = usePagedStore((s) => s.composed);
  const states = usePagedStore((s) => s.states);
  const errors = usePagedStore((s) => s.errors);
  const navNonce = usePagedStore((s) => s.navNonce);
  const pageCount = usePagedStore((s) => s.pageCount);

  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const lineHeight = useSettingsStore((s) => s.lineHeight);
  const autoscroll = useSettingsStore((s) => s.autoscroll);

  const bookId = currentBook?.metadata.id;
  const mainRef = useRef<HTMLElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const topSentinel = useRef<HTMLDivElement | null>(null);
  const bottomSentinel = useRef<HTMLDivElement | null>(null);

  const [win, setWin] = useState<Win>(() => aroundPage(currentPage, pageCount));
  const winRef = useRef(win);
  winRef.current = win;
  /** Страница, к которой нужно прокрутить после следующей отрисовки (переход / открытие книги) */
  const scrollTarget = useRef<number | null>(currentPage);
  /** 'sentence' — открытие книги (к читаемому месту), 'page' — явный переход (к началу страницы) */
  const scrollMode = useRef<'sentence' | 'page'>('sentence');
  const reading = useIsReading();
  const readingRef = useRef(reading);
  readingRef.current = reading;
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;

  const findActiveElement = useCallback((): HTMLElement | null => {
    const id = useBookStore.getState().currentSentenceId;
    if (id === null || !textRef.current) return null;
    return textRef.current.querySelector<HTMLElement>(`[data-sentence-id="${id}"]`);
  }, []);

  const { paused, resume } = useAutoscrollPause(mainRef, bookId, { getActive: findActiveElement });

  const handleJump = useCallback(
    (id: number) => {
      resume();
      void jumpToSentence(id);
    },
    [jumpToSentence, resume],
  );

  // Явная навигация (номер страницы, глава, «Распознать сейчас»): окно вокруг страницы и прокрутка к ней
  const lastNav = useRef(navNonce);
  useEffect(() => {
    if (navNonce === lastNav.current) return;
    lastNav.current = navNonce;
    resume();
    scrollTarget.current = currentPageRef.current;
    scrollMode.current = 'page';
    setWin(aroundPage(currentPageRef.current, pageCount));
  }, [navNonce, pageCount, resume]);

  // Озвучка/клик увели позицию за пределы окна — двигаем окно вслед
  const sentencePageNow = useMemo(() => {
    if (!composed || currentSentenceId === null) return null;
    const idx = composed.indexById.get(currentSentenceId);
    return idx === undefined ? null : sentencePage(composed.order[idx]);
  }, [composed, currentSentenceId]);

  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  useEffect(() => {
    if (sentencePageNow === null) return;
    // Пользователь прокрутил в сторону во время озвучки — не перестраиваем окно под ним
    if (readingRef.current && pausedRef.current) return;
    setWin((w) => {
      if (sentencePageNow < w.start || sentencePageNow > w.end) {
        scrollTarget.current = scrollTarget.current ?? null;
        return aroundPage(sentencePageNow, pageCount);
      }
      if (sentencePageNow >= w.end - 1 && w.end < pageCount) {
        const end = Math.min(pageCount, sentencePageNow + WINDOW_AFTER);
        const start = Math.max(w.start, end - MAX_WINDOW);
        return { start, end };
      }
      return w;
    });
  }, [sentencePageNow, pageCount]);

  // Прокрутка к целевой странице/предложению после отрисовки окна
  useLayoutEffect(() => {
    const main = mainRef.current;
    const target = scrollTarget.current;
    if (!main || target === null) return;
    const active = findActiveElement();
    if (scrollMode.current === 'sentence' && active && sentencePageNow === target) {
      scrollIntoComfortZone(main, active, { force: true, instant: true });
      scrollTarget.current = null;
      return;
    }
    const section = main.querySelector<HTMLElement>(`[data-page="${target}"]`);
    if (section) {
      const top = section.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 12;
      main.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
      scrollTarget.current = null;
    }
  }, [win, composed, sentencePageNow, findActiveElement]);

  // Автоскролл к читаемому предложению
  useEffect(() => {
    if (!reading || !autoscroll || paused) return;
    const main = mainRef.current;
    const active = findActiveElement();
    if (main && active) scrollIntoComfortZone(main, active);
  }, [currentSentenceId, reading, autoscroll, paused, findActiveElement, win, composed]);

  // Озвучка не идёт: клик/стрелки — однократное позиционирование, если предложение вне экрана
  useEffect(() => {
    if (readingRef.current) return;
    const main = mainRef.current;
    const active = findActiveElement();
    if (main && active) ensureVisible(main, active);
  }, [currentSentenceId, findActiveElement]);

  // Расширение окна при прокрутке к краям (стражи на IntersectionObserver)
  useEffect(() => {
    const root = mainRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          if (e.target === bottomSentinel.current) {
            setWin((w) => {
              if (w.end >= pageCount) return w;
              const end = Math.min(pageCount, w.end + EXPAND_AFTER);
              // Слишком длинное окно обрезаем сверху (браузер сохраняет позицию прокрутки сам — overflow-anchor)
              const start = Math.max(w.start, end - MAX_WINDOW + 1);
              return { start, end };
            });
          } else if (e.target === topSentinel.current) {
            setWin((w) => {
              if (w.start <= 1) return w;
              const start = Math.max(1, w.start - EXPAND_BEFORE);
              const end = Math.min(w.end, start + MAX_WINDOW - 1);
              return { start, end };
            });
          }
        }
      },
      { root, rootMargin: '600px 0px' },
    );
    if (topSentinel.current) obs.observe(topSentinel.current);
    if (bottomSentinel.current) obs.observe(bottomSentinel.current);
    return () => obs.disconnect();
  }, [pageCount, win.start, win.end]);

  // Какую страницу сейчас смотрит пользователь (ручная прокрутка двигает окно распознавания)
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (readingRef.current) return; // во время озвучки позицию определяет читаемое предложение
        const cr = main.getBoundingClientRect();
        const probe = cr.top + cr.height * 0.3;
        let best: number | null = null;
        for (const el of Array.from(main.querySelectorAll<HTMLElement>('[data-page]'))) {
          const r = el.getBoundingClientRect();
          if (r.top <= probe && r.bottom >= probe) {
            best = Number(el.dataset.page);
            break;
          }
          if (r.top > probe) {
            best = best ?? Number(el.dataset.page);
            break;
          }
        }
        if (best !== null && best !== currentPageRef.current) setViewPage(best);
      }, 150);
    };
    main.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      main.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [setViewPage]);

  const handleResume = useCallback(() => {
    resume();
    const main = mainRef.current;
    const active = findActiveElement();
    if (main && active) scrollIntoComfortZone(main, active, { force: true });
  }, [resume, findActiveElement]);

  if (!currentBook || !composed) return null;

  const fontClass = fontFamily === 'serif' ? 'font-serif' : fontFamily === 'mono' ? 'font-mono' : 'font-sans';
  const pages: number[] = [];
  for (let p = win.start; p <= win.end && p <= pageCount; p++) pages.push(p);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <main
        ref={mainRef}
        tabIndex={0}
        aria-label="Текст книги"
        className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-6 md:py-8 flex flex-col items-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500"
      >
        <div
          className={clsx('w-full max-w-3xl min-w-0', fontClass)}
          style={{ fontSize: `${fontSize}px`, lineHeight, overflowWrap: 'anywhere' }}
        >
          <div ref={topSentinel} aria-hidden="true" className="h-px" />
          {win.start > 1 && (
            <p className="text-center text-xs text-slate-400 dark:text-zinc-500 font-sans py-2 select-none">
              Страницы 1–{win.start - 1} выше. Прокрутите вверх или перейдите к странице.
            </p>
          )}
          <div ref={textRef}>
            {pages.map((p) => (
              <PageSection
                key={p}
                page={p}
                state={states[p - 1] ?? 'pending'}
                error={errors[p]}
                composedPage={composed.pages[p - 1]}
                sentences={composed.sentencesByPage.get(p)}
                specs={composed.specsByPage.get(p)}
                hidden={composed.hidden}
                onJump={handleJump}
              />
            ))}
          </div>
          {win.end < pageCount && (
            <p className="text-center text-xs text-slate-400 dark:text-zinc-500 font-sans py-2 select-none">
              Далее — страницы {win.end + 1}–{pageCount}.
            </p>
          )}
          <div ref={bottomSentinel} aria-hidden="true" className="h-px mb-24" />
        </div>
      </main>

      <ResumeAutoscrollButton visible={autoscroll && paused && reading && currentSentenceId !== null} onClick={handleResume} />
    </div>
  );
};
