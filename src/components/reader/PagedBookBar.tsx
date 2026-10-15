import React, { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, AlertCircle, Loader2, RefreshCw, SkipForward, Settings2, Pause, Play, Wand2 } from 'lucide-react';
import { useBookStore } from '../../store/bookStore';
import { goToPage } from '../../engine/library';
import { usePagedStore } from '../../store/pagedStore';
import { useAudioStore } from '../../store/audioStore';
import { RerecognizeDialog } from './RerecognizeDialog';
import { isSidecarAvailable } from '../../engine/parsers/pdfSidecar';
import type { PageState } from '../../types/pdf';

/** Событие для открытия диалога перераспознавания из других компонентов (текстовый вид, редактор). */
export const OPEN_RERECOGNIZE_EVENT = 'aibr:rerecognize';
export function openRerecognizeDialog(from?: number, to?: number): void {
  window.dispatchEvent(new CustomEvent(OPEN_RERECOGNIZE_EVENT, { detail: { from, to } }));
}

const SOURCE_LABEL: Record<string, string> = { text: 'текст', ocr: 'OCR', gemini: 'Gemini', manual: 'правка' };

const STATE_TEXT: Record<PageState, string> = {
  pending: 'ожидает',
  running: 'распознаётся…',
  done: 'готова',
  error: 'ошибка',
};

const STATE_STYLE: Record<PageState, string> = {
  pending: 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300',
  running: 'bg-amber-100 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300',
  done: 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300',
  error: 'bg-rose-100 dark:bg-rose-950/40 text-rose-800 dark:text-rose-300',
};

/**
 * Панель страниц постраничного PDF: номер страницы и переход, статус страницы (ожидает / распознаётся / готова / ошибка),
 * тонкая полоса прогресса распознавания, сообщение «Распознаём страницу N…» при ожидании озвучки и действия при ошибке.
 */
export const PagedBookBar: React.FC = () => {
  const currentPage = useBookStore((s) => s.currentPage);
  const pageCount = usePagedStore((s) => s.pageCount);
  const states = usePagedStore((s) => s.states);
  const errors = usePagedStore((s) => s.errors);
  const doneCount = usePagedStore((s) => s.doneCount);
  const errorCount = usePagedStore((s) => s.errorCount);
  const runningCount = usePagedStore((s) => s.runningCount);
  const controller = usePagedStore((s) => s.controller);
  const paused = usePagedStore((s) => s.paused);
  const bookEngine = usePagedStore((s) => s.engine);
  const waitingPage = useAudioStore((s) => s.waitingPage);

  const [draft, setDraft] = useState(String(currentPage));
  const [dialog, setDialog] = useState<{ open: boolean; from?: number; to?: number }>({ open: false });

  useEffect(() => setDraft(String(currentPage)), [currentPage]);

  useEffect(() => {
    const open = (e: Event) => {
      const d = (e as CustomEvent<{ from?: number; to?: number }>).detail;
      setDialog({ open: true, from: d?.from, to: d?.to });
    };
    window.addEventListener(OPEN_RERECOGNIZE_EVENT, open);
    return () => window.removeEventListener(OPEN_RERECOGNIZE_EVENT, open);
  }, []);

  const submitDraft = useCallback(() => {
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n) || n < 1) {
      setDraft(String(currentPage));
      return;
    }
    goToPage(Math.min(pageCount, n));
  }, [draft, goToPage, pageCount, currentPage]);

  if (pageCount === 0) return null;

  const state: PageState = states[currentPage - 1] ?? 'pending';
  const meta = state === 'done' ? controller?.getPageMeta(currentPage) : null;
  const percent = Math.round((doneCount / pageCount) * 100);

  // Какую страницу показываем в баннере: ту, которую ждёт озвучка, иначе текущую, если на ней ошибка
  const bannerPage = waitingPage ?? (state === 'error' ? currentPage : null);
  const bannerState: PageState | null = bannerPage ? states[bannerPage - 1] ?? 'pending' : null;

  const navBtn =
    'p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:pointer-events-none transition text-slate-700 dark:text-zinc-300';

  return (
    <div className="shrink-0 border-b border-slate-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 select-none">
      <div className="px-3 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-700 dark:text-zinc-300">
        <div className="flex items-center gap-1" role="group" aria-label="Навигация по страницам">
          <button className={navBtn} onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} aria-label="Предыдущая страница" title="Предыдущая страница">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              submitDraft();
            }}
          >
            <label htmlFor="page-input" className="sr-only">
              Номер страницы
            </label>
            <span aria-hidden="true">Стр.</span>
            <input
              id="page-input"
              type="number"
              inputMode="numeric"
              min={1}
              max={pageCount}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={submitDraft}
              className="w-16 px-1.5 py-0.5 text-center text-xs rounded-md bg-slate-100 dark:bg-zinc-800 border border-transparent focus:border-amber-500 text-slate-900 dark:text-zinc-100 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span aria-hidden="true">из {pageCount}</span>
          </form>
          <button className={navBtn} onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= pageCount} aria-label="Следующая страница" title="Следующая страница">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <span
          data-testid="page-status"
          className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${STATE_STYLE[state]}`}
          title={meta?.warnings.length ? `Предупреждения: ${meta.warnings.join(', ')}` : undefined}
        >
          {STATE_TEXT[state]}
          {meta?.source ? ` · ${SOURCE_LABEL[meta.source] ?? meta.source}` : ''}
          {meta?.edited ? ' · изменена' : ''}
        </span>

        <span className="text-slate-500 dark:text-zinc-400" data-testid="recognition-progress">
          Распознано {doneCount}/{pageCount}
          {errorCount > 0 && <span className="text-rose-600 dark:text-rose-400"> · ошибок: {errorCount}</span>}
          {runningCount > 0 && <Loader2 className="inline w-3 h-3 ml-1.5 animate-spin text-amber-500" aria-label="Идёт распознавание" />}
        </span>

        {(runningCount > 0 || paused || doneCount < pageCount) && (
          <button
            type="button"
            onClick={() => controller?.setPaused(!paused)}
            aria-pressed={paused}
            className="ml-auto flex items-center gap-1.5 px-2 py-1 rounded-lg border border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 transition"
            title={paused ? 'Продолжить распознавание' : 'Остановить распознавание (идущая страница дорабатывает, новые не запускаются)'}
          >
            {paused ? <Play className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" /> : <Pause className="w-3.5 h-3.5 text-rose-600" aria-hidden="true" />}
            <span className="hidden sm:inline">{paused ? 'Продолжить' : 'Остановить'}</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => setDialog({ open: true, from: currentPage, to: currentPage })}
          className={`${runningCount > 0 || paused || doneCount < pageCount ? '' : 'ml-auto '}flex items-center gap-1.5 px-2 py-1 rounded-lg border border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 transition`}
          title="Перераспознать страницу, диапазон или всю книгу другим движком"
        >
          <Settings2 className="w-3.5 h-3.5 text-amber-600" aria-hidden="true" />
          <span className="hidden sm:inline">Перераспознать</span>
        </button>
      </div>

      {/* Тонкая полоса прогресса распознавания */}
      <div
        role="progressbar"
        aria-label="Прогресс распознавания"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-0.5 w-full bg-slate-200 dark:bg-zinc-800"
      >
        <div className="h-full bg-amber-500 transition-[width] duration-300" style={{ width: `${percent}%` }} />
      </div>

      {bannerPage !== null && bannerState !== null && bannerState !== 'done' && (
        <div
          role={bannerState === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          className={`px-3 py-2 text-xs flex flex-wrap items-center gap-2 border-t ${
            bannerState === 'error'
              ? 'bg-rose-50 dark:bg-rose-950/20 border-rose-200 dark:border-rose-900/40 text-rose-800 dark:text-rose-300'
              : 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900/40 text-amber-900 dark:text-amber-300'
          }`}
        >
          {bannerState === 'error' ? (
            <>
              <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 break-words">
                Не удалось распознать страницу {bannerPage}: {errors[bannerPage] ?? 'ошибка распознавания'}
              </span>
              <button
                onClick={() => controller?.retryPage(bannerPage)}
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-semibold"
              >
                <RefreshCw className="w-3 h-3" aria-hidden="true" /> Повторить
              </button>
              <button
                onClick={() => void controller?.skipPage(bannerPage)}
                className="flex items-center gap-1 px-2 py-1 rounded-lg border border-rose-300 dark:border-rose-800 hover:bg-rose-100 dark:hover:bg-rose-950/40 font-semibold"
              >
                <SkipForward className="w-3 h-3" aria-hidden="true" /> Пропустить
              </button>
              {bookEngine !== 'auto' && isSidecarAvailable() && (
                <button
                  onClick={() => void controller?.switchEngine('auto', bannerPage)}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold"
                  title="Дальше распознавать автоматически: текст из слоя, OCR только где нужно. Уже готовые страницы не меняются."
                >
                  <Wand2 className="w-3 h-3" aria-hidden="true" /> Авто для остальных
                </button>
              )}
              <button
                onClick={() => setDialog({ open: true, from: bannerPage, to: bannerPage })}
                className="px-2 py-1 rounded-lg border border-rose-300 dark:border-rose-800 hover:bg-rose-100 dark:hover:bg-rose-950/40 font-semibold"
              >
                Другой режим…
              </button>
            </>
          ) : (
            <>
              <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
              <span data-testid="waiting-banner">Распознаём страницу {bannerPage}… Чтение продолжится автоматически.</span>
            </>
          )}
        </div>
      )}

      <RerecognizeDialog isOpen={dialog.open} initialFrom={dialog.from} initialTo={dialog.to} onClose={() => setDialog({ open: false })} />
    </div>
  );
};
