import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, PageViewport, RenderTask } from 'pdfjs-dist';
import { useBookStore } from '../../store/bookStore';
import { coordinator } from '../../engine/audio/coordinator';
import { useSettingsStore } from '../../store/settingsStore';
import { usePagedStore } from '../../store/pagedStore';
import { loadPdfjsDocument, getPdfBuffer } from '../../engine/pdf/pdfjsDoc';
import { SentenceItem } from '../../types/book';
import { ZoomIn, ZoomOut, RotateCcw, AlertCircle, RefreshCw, BookText } from 'lucide-react';
import { ResumeAutoscrollButton, ensureVisible, scrollIntoComfortZone, useAutoscrollPause, useIsReading } from './readerScroll';

const PAGE_GAP = 32; // mb-8
const DEFAULT_SCALE = 1.25;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;

interface PageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface SentenceLayout {
  id: number;
  text: string;
  boxes: PageBox[];
}

/* ------------------- Слой кликабельных зон (статичный) ------------------ */

const PageClickLayer = memo(
  ({ layout, onSentenceClick }: { layout: SentenceLayout[]; onSentenceClick: (id: number) => void }) => (
    <>
      {layout.map((sentence) =>
        sentence.boxes.map((box, idx) => (
          <div
            key={`${sentence.id}_${idx}`}
            onClick={() => onSentenceClick(sentence.id)}
            className="absolute cursor-pointer rounded-sm hover:bg-amber-400/20 transition-colors z-10"
            style={box}
            title={sentence.text}
          />
        ))
      )}
    </>
  )
);
PageClickLayer.displayName = 'PageClickLayer';

/* ------------------------------ Страница PDF ----------------------------- */

interface PdfPageProps {
  pageNum: number;
  pdfDoc: PDFDocumentProxy;
  scale: number;
  placeholder: { width: number; height: number };
  pageSentences: SentenceItem[];
  /** id читаемого предложения, если оно находится на этой странице; иначе null (страница не перерисовывается) */
  activeSentenceId: number | null;
  onSentenceClick: (sentenceId: number) => void;
  /** Следовать за озвучкой: автопрокрутка включена и status ∈ {loading, playing} */
  autoscroll: boolean;
  autoscrollPaused: boolean;
  /** Озвучка не идёт: смена предложения = действие пользователя, позиционируем один раз */
  idleNav: boolean;
  scrollRootRef: React.RefObject<HTMLElement | null>;
}

const PdfPageItem = memo(
  ({
    pageNum,
    pdfDoc,
    scale,
    placeholder,
    pageSentences,
    activeSentenceId,
    onSentenceClick,
    autoscroll,
    autoscrollPaused,
    idleNav,
    scrollRootRef,
  }: PdfPageProps) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const activeRectRef = useRef<HTMLDivElement | null>(null);

    const [viewport, setViewport] = useState<PageViewport | null>(null);
    const [isRendered, setIsRendered] = useState(false);
    const [isNear, setIsNear] = useState(false);

    const hasActive = activeSentenceId !== null;

    // Ленивый рендер: канвас рисуем только для страниц около видимой области
    useEffect(() => {
      const el = containerRef.current;
      if (!el || typeof IntersectionObserver === 'undefined') {
        setIsNear(true);
        return;
      }
      const observer = new IntersectionObserver(([entry]) => setIsNear(entry.isIntersecting), {
        root: scrollRootRef.current,
        rootMargin: '1500px 0px',
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, [scrollRootRef]);

    // Рендер страницы PDF на Canvas
    useEffect(() => {
      const canvas = canvasRef.current;

      if (!isNear && !hasActive) {
        // Страница далеко от экрана: освобождаем память канваса, размеры контейнера сохраняются
        if (canvas && canvas.width > 0) {
          canvas.width = 0;
          canvas.height = 0;
        }
        setIsRendered(false);
        return;
      }

      let isCancelled = false;
      let renderTask: RenderTask | null = null;

      const renderPage = async () => {
        try {
          const page = await pdfDoc.getPage(pageNum);
          if (isCancelled) return;

          const dpr = window.devicePixelRatio || 1;
          const vp = page.getViewport({ scale });
          setViewport(vp);

          if (!canvas) return;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;

          canvas.width = Math.floor(vp.width * dpr);
          canvas.height = Math.floor(vp.height * dpr);
          canvas.style.width = `${Math.floor(vp.width)}px`;
          canvas.style.height = `${Math.floor(vp.height)}px`;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

          setIsRendered(false);
          renderTask = page.render({ canvasContext: ctx, viewport: vp });
          await renderTask.promise;
          if (!isCancelled) setIsRendered(true);
        } catch (err) {
          if ((err as { name?: string })?.name !== 'RenderingCancelledException') {
            console.warn(`[PdfBookView] Ошибка рендера страницы ${pageNum}:`, err);
          }
        }
      };

      void renderPage();

      return () => {
        isCancelled = true;
        try {
          renderTask?.cancel();
        } catch {
          // ignore
        }
      };
    }, [pdfDoc, pageNum, scale, isNear, hasActive]);

    const viewportValid = viewport !== null && viewport.scale === scale;

    // Геометрия предложений на странице считается один раз на (viewport, предложения)
    const layout = useMemo<SentenceLayout[]>(() => {
      if (!viewport || viewport.scale !== scale) return [];
      const result: SentenceLayout[] = [];
      for (const sentence of pageSentences) {
        const boxes: PageBox[] = [];
        for (const rect of sentence.pdfRects ?? []) {
          if (rect.pageNumber !== pageNum) continue;
          const [vx1, vy1, vx2, vy2] = viewport.convertToViewportRectangle([
            rect.x,
            rect.y,
            rect.x + rect.width,
            rect.y + rect.height,
          ]);
          boxes.push({
            left: Math.min(vx1, vx2),
            top: Math.min(vy1, vy2),
            width: Math.max(Math.abs(vx1 - vx2), 6),
            height: Math.max(Math.abs(vy1 - vy2), 12),
          });
        }
        if (boxes.length > 0) result.push({ id: sentence.id, text: sentence.rawText, boxes });
      }
      return result;
    }, [viewport, scale, pageSentences, pageNum]);

    const activeBoxes = useMemo(
      () => (activeSentenceId === null ? [] : layout.find((s) => s.id === activeSentenceId)?.boxes ?? []),
      [layout, activeSentenceId]
    );

    // Автоскролл к активному предложению (если страница ещё не отрисована — к самой странице)
    useEffect(() => {
      if (!hasActive || !autoscroll || autoscrollPaused) return;
      const root = scrollRootRef.current;
      const target = activeRectRef.current ?? containerRef.current;
      if (root && target) scrollIntoComfortZone(root, target);
    }, [activeSentenceId, hasActive, autoscroll, autoscrollPaused, isRendered, viewport, scrollRootRef]);

    // Озвучка не идёт: однократное позиционирование на клик/стрелки (только если вне экрана)
    const idleNavRef = useRef(idleNav);
    idleNavRef.current = idleNav;
    const lastNavRef = useRef<string | null>(null);
    useEffect(() => {
      if (!hasActive) {
        lastNavRef.current = null;
        return;
      }
      if (!idleNavRef.current) return;
      const root = scrollRootRef.current;
      const target = activeRectRef.current ?? containerRef.current;
      if (!root || !target) return;
      const mark = `${activeSentenceId}:${activeRectRef.current ? 'rect' : 'page'}`;
      if (lastNavRef.current === mark) return;
      lastNavRef.current = mark;
      ensureVisible(root, target);
    }, [activeSentenceId, hasActive, isRendered, viewport, scrollRootRef]);

    const width = viewportValid ? Math.floor(viewport.width) : Math.floor(placeholder.width * scale);
    const height = viewportValid ? Math.floor(viewport.height) : Math.floor(placeholder.height * scale);

    return (
      <div
        ref={containerRef}
        data-pdf-page={pageNum}
        className="relative mx-auto mb-8 bg-white dark:bg-zinc-950 shadow-xl rounded-lg overflow-hidden border border-slate-200 dark:border-zinc-800 select-none shrink-0"
        style={{ width, height }}
      >
        {/* 1. Оригинальный визуальный холст страницы */}
        <canvas ref={canvasRef} className="block" aria-label={`Страница ${pageNum}`} />

        {!isRendered && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-500 dark:text-zinc-500 pointer-events-none">
            <div className="w-5 h-5 mr-2 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            Страница {pageNum}
          </div>
        )}

        {/* 2. Прозрачный интерактивный слой поверх холста */}
        {isRendered && viewportValid && (
          <div className="absolute inset-0">
            <PageClickLayer layout={layout} onSentenceClick={onSentenceClick} />

            {/* Активная караоке-подсветка */}
            {activeBoxes.map((box, idx) => (
              <div
                key={`active_${idx}`}
                ref={idx === 0 ? activeRectRef : null}
                data-pdf-active={idx === 0 ? 'true' : undefined}
                className="absolute bg-amber-400/35 border-b-2 border-amber-500 rounded-sm pointer-events-none z-20 transition-[top,left,width,height] duration-200"
                style={box}
              />
            ))}
          </div>
        )}

        {/* Номер страницы в нижнем углу */}
        <div className="absolute bottom-2 right-3 text-[10px] text-slate-600 dark:text-zinc-400 bg-white/80 dark:bg-black/70 px-1.5 py-0.5 rounded backdrop-blur-sm pointer-events-none z-30">
          Стр. {pageNum}
        </div>
      </div>
    );
  }
);
PdfPageItem.displayName = 'PdfPageItem';

/* ------------------------------ Основной вид ----------------------------- */

const EMPTY_SENTENCES: SentenceItem[] = [];

export const PdfBookView: React.FC = () => {
  const currentBook = useBookStore((state) => state.currentBook);
  const currentSentenceId = useBookStore((state) => state.currentSentenceId);
  const setPdfViewMode = useBookStore((state) => state.setPdfViewMode);
  const jumpToSentence = coordinator.jumpToSentence;
  const autoscroll = useSettingsStore((state) => state.autoscroll);

  const bookId = currentBook?.metadata.id;
  const isPagedBook = Boolean(currentBook?.metadata.paged);
  const currentPageNo = useBookStore((state) => state.currentPage);
  const setViewPage = useBookStore((state) => state.setViewPage);
  const navNonce = usePagedStore((state) => state.navNonce);
  const readingNow = useIsReading();
  const readingRef = useRef(readingNow);
  readingRef.current = readingNow;
  const currentPageRef = useRef(currentPageNo);
  currentPageRef.current = currentPageNo;

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [scale, setScale] = useState<number>(DEFAULT_SCALE);
  const [defaultScale, setDefaultScale] = useState<number>(DEFAULT_SCALE);
  const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(null);
  const [isLoadingPdf, setIsLoadingPdf] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const mainRef = useRef<HTMLElement | null>(null);
  const initialScrollDone = useRef<string | null>(null);

  const getActiveEl = useCallback(
    () => mainRef.current?.querySelector<HTMLElement>('[data-pdf-active="true"]') ?? null,
    []
  );
  const { paused, resume } = useAutoscrollPause(mainRef, bookId, { getActive: getActiveEl });
  const reading = useIsReading();

  // Загрузка документа PDF (общий кэш с распознаванием страниц: файл держится в памяти один раз)
  useEffect(() => {
    let isCancelled = false;
    if (!bookId) {
      setIsLoadingPdf(false);
      return;
    }
    setIsLoadingPdf(true);
    setErrorMsg(null);
    setPdfDoc(null);
    const getBuffer = async () => {
      const inMemory = useBookStore.getState().currentBook?.rawPdfBuffer;
      if (inMemory && inMemory.byteLength > 0) return inMemory;
      const restored = await getPdfBuffer(bookId);
      if (restored) {
        useBookStore.setState((state) =>
          state.currentBook && state.currentBook.metadata.id === bookId
            ? { currentBook: { ...state.currentBook, rawPdfBuffer: restored } }
            : {}
        );
      }
      return restored;
    };
    loadPdfjsDocument(bookId, getBuffer)
      .then((doc) => {
        if (isCancelled) return;
        setPdfDoc(doc);
        setIsLoadingPdf(false);
      })
      .catch((err) => {
        if (isCancelled) return;
        console.error('[PdfBookView] Ошибка загрузки PDF:', err);
        setErrorMsg(err instanceof Error && err.message ? err.message : 'Ошибка открытия оригинального PDF');
        setIsLoadingPdf(false);
      });
    return () => {
      isCancelled = true;
    };
  }, [bookId, reloadKey]);

  // Размер первой страницы — для плейсхолдеров и подбора масштаба под ширину экрана
  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;
    pdfDoc
      .getPage(1)
      .then((page) => {
        if (cancelled) return;
        const vp = page.getViewport({ scale: 1 });
        setBaseSize({ width: vp.width, height: vp.height });
        const available = (mainRef.current?.clientWidth ?? window.innerWidth) - 32;
        const fit = Math.max(MIN_SCALE, Math.min(DEFAULT_SCALE, available / vp.width));
        const rounded = Math.round(fit * 100) / 100;
        setDefaultScale(rounded);
        setScale((current) => (initialScrollDone.current === bookId ? current : rounded));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, bookId]);

  // Группируем предложения книги по страницам PDF (+ обратный индекс «предложение -> страницы»)
  const { sentencesByPage, pagesBySentence } = useMemo(() => {
    const byPage = new Map<number, SentenceItem[]>();
    const bySentence = new Map<number, number[]>();
    if (!currentBook) return { sentencesByPage: byPage, pagesBySentence: bySentence };

    for (const chapter of currentBook.chapters) {
      for (const sentence of chapter.sentences) {
        const pages =
          sentence.pdfRects && sentence.pdfRects.length > 0
            ? Array.from(new Set(sentence.pdfRects.map((r) => r.pageNumber)))
            : sentence.pageNumber
              ? [sentence.pageNumber]
              : [];
        if (pages.length === 0) continue;
        bySentence.set(sentence.id, pages);
        for (const p of pages) {
          const list = byPage.get(p);
          if (list) list.push(sentence);
          else byPage.set(p, [sentence]);
        }
      }
    }
    return { sentencesByPage: byPage, pagesBySentence: bySentence };
  }, [currentBook?.chapters]);

  const activePages = currentSentenceId !== null ? pagesBySentence.get(currentSentenceId) : undefined;

  // Восстановление позиции при открытии: прокручиваем к странице с сохранённым предложением
  useLayoutEffect(() => {
    if (!pdfDoc || !baseSize || !bookId || initialScrollDone.current === bookId) return;
    const main = mainRef.current;
    if (!main) return;
    initialScrollDone.current = bookId;
    const page = activePages?.[0] ?? (isPagedBook ? currentPageNo : undefined);
    if (page && page > 1) {
      main.scrollTo({ top: (page - 1) * (baseSize.height * scale + PAGE_GAP), behavior: 'auto' });
    }
  }, [pdfDoc, baseSize, bookId, activePages, scale]);

  // Явный переход к странице (номер страницы, оглавление): прокручиваем к ней
  const lastNav = useRef(navNonce);
  useEffect(() => {
    if (!isPagedBook || navNonce === lastNav.current) return;
    lastNav.current = navNonce;
    resume();
    const main = mainRef.current;
    if (!main) return;
    const el = main.querySelector<HTMLElement>(`[data-pdf-page="${currentPageRef.current}"]`);
    if (el) {
      const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 12;
      main.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    } else if (baseSize) {
      main.scrollTo({ top: (currentPageRef.current - 1) * (baseSize.height * scale + PAGE_GAP), behavior: 'auto' });
    }
  }, [navNonce, isPagedBook, resume, baseSize, scale]);

  // Ручная прокрутка двигает окно распознавания (во время озвучки позицию определяет читаемое предложение)
  useEffect(() => {
    const main = mainRef.current;
    if (!main || !isPagedBook) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (readingRef.current) return;
        const cr = main.getBoundingClientRect();
        const probe = cr.top + cr.height * 0.35;
        for (const el of Array.from(main.querySelectorAll<HTMLElement>('[data-pdf-page]'))) {
          const r = el.getBoundingClientRect();
          if (r.bottom >= probe) {
            const p = Number(el.dataset.pdfPage);
            if (p !== currentPageRef.current) setViewPage(p);
            break;
          }
        }
      }, 150);
    };
    main.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      main.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [isPagedBook, setViewPage, pdfDoc]);

  const handleResume = useCallback(() => {
    resume();
    const root = mainRef.current;
    const active = getActiveEl();
    if (root && active) scrollIntoComfortZone(root, active, { force: true });
  }, [resume, getActiveEl]);

  const handleSentenceClick = useCallback(
    (id: number) => {
      resume();
      void jumpToSentence(id);
    },
    [jumpToSentence, resume]
  );

  const pageCount = pdfDoc?.numPages ?? 0;
  const pagesArray = useMemo(() => Array.from({ length: pageCount }, (_, i) => i + 1), [pageCount]);
  const placeholder = baseSize ?? { width: 595, height: 842 };

  if (!currentBook) {
    return null;
  }

  // Состояние ошибки загрузки оригинала
  if (errorMsg) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center max-w-md mx-auto" role="alert">
        <div className="w-12 h-12 rounded-2xl bg-rose-100 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 flex items-center justify-center mb-4">
          <AlertCircle className="w-6 h-6" aria-hidden="true" />
        </div>
        <h3 className="text-base font-bold text-slate-800 dark:text-zinc-200 mb-2">
          Не удалось отобразить оригинал PDF
        </h3>
        <p className="text-sm text-slate-600 dark:text-zinc-400 mb-6 leading-relaxed">{errorMsg}</p>
        <div className="flex flex-col sm:flex-row gap-3 w-full">
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="flex-1 py-2.5 px-4 rounded-xl border border-slate-300 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 font-medium text-sm flex items-center justify-center gap-2 transition"
          >
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
            Повторить
          </button>
          <button
            onClick={() => setPdfViewMode('reflow')}
            className="flex-1 py-2.5 px-4 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-medium text-sm flex items-center justify-center gap-2 transition"
          >
            <BookText className="w-4 h-4" aria-hidden="true" />
            Читать в текстовом режиме
          </button>
        </div>
      </div>
    );
  }

  if (isLoadingPdf || !pdfDoc) {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center text-slate-500 dark:text-zinc-400 gap-3"
        role="status"
      >
        <div className="w-8 h-8 border-[3px] border-amber-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-sm">Загрузка оригинала PDF...</span>
      </div>
    );
  }

  const zoomBtn =
    'p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800 transition disabled:opacity-40 disabled:pointer-events-none';

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <main
        ref={mainRef}
        tabIndex={0}
        aria-label="Страницы PDF"
        className="flex-1 overflow-auto px-4 py-8 flex flex-col pb-24 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500"
      >
        {/* Плавающая панель масштабирования */}
        <div
          role="toolbar"
          aria-label="Масштаб страницы"
          className="sticky top-2 z-40 mb-6 self-center flex items-center gap-1 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md px-2.5 py-1 rounded-2xl shadow-lg border border-slate-200 dark:border-zinc-800 text-slate-700 dark:text-zinc-300"
        >
          <button
            onClick={() => setScale((s) => Math.max(MIN_SCALE, Math.round((s - 0.15) * 100) / 100))}
            disabled={scale <= MIN_SCALE}
            className={zoomBtn}
            aria-label="Уменьшить масштаб"
            title="Уменьшить масштаб"
          >
            <ZoomOut className="w-4 h-4" />
          </button>

          <span className="text-xs font-semibold px-2 min-w-[50px] text-center" aria-live="polite">
            {Math.round(scale * 100)}%
          </span>

          <button
            onClick={() => setScale((s) => Math.min(MAX_SCALE, Math.round((s + 0.15) * 100) / 100))}
            disabled={scale >= MAX_SCALE}
            className={zoomBtn}
            aria-label="Увеличить масштаб"
            title="Увеличить масштаб"
          >
            <ZoomIn className="w-4 h-4" />
          </button>

          <div className="w-px h-4 bg-slate-300 dark:bg-zinc-700 mx-1" aria-hidden="true" />

          <button
            onClick={() => setScale(defaultScale)}
            className={zoomBtn}
            aria-label={`Сбросить масштаб (${Math.round(defaultScale * 100)}%)`}
            title={`Сбросить масштаб (${Math.round(defaultScale * 100)}%)`}
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Вертикальный стек страниц с подсветкой */}
        <div className="flex flex-col">
          {pagesArray.map((pageNum) => (
            <PdfPageItem
              key={`page_${pageNum}`}
              pageNum={pageNum}
              pdfDoc={pdfDoc}
              scale={scale}
              placeholder={placeholder}
              pageSentences={sentencesByPage.get(pageNum) ?? EMPTY_SENTENCES}
              activeSentenceId={activePages?.includes(pageNum) ? currentSentenceId : null}
              onSentenceClick={handleSentenceClick}
              autoscroll={autoscroll && reading}
              autoscrollPaused={paused}
              idleNav={!reading}
              scrollRootRef={mainRef}
            />
          ))}
        </div>
      </main>

      <ResumeAutoscrollButton visible={autoscroll && paused && reading && currentSentenceId !== null} onClick={handleResume} />
    </div>
  );
};
