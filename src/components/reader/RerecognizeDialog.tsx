import React, { useEffect, useId, useMemo, useState } from 'react';
import { X, RefreshCw, TriangleAlert } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { usePagedStore } from '../../store/pagedStore';
import { useSettingsStore } from '../../store/settingsStore';
import { availableEngines, ENGINE_LABELS } from '../../engine/pdf/engineChoice';
import { isSidecarAvailable } from '../../engine/parsers/pdfSidecar';
import type { PdfEngine } from '../../types/book';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  initialFrom?: number;
  initialTo?: number;
}

type Scope = 'rest' | 'page' | 'range' | 'all';

/** Перераспознать страницу / диапазон / всю книгу другим режимом. Ручные правки не затираются без подтверждения. */
export const RerecognizeDialog: React.FC<Props> = ({ isOpen, onClose, initialFrom, initialTo }) => {
  const titleId = useId();
  const toast = useToast();
  const pageCount = usePagedStore((s) => s.pageCount);
  const bookEngine = usePagedStore((s) => s.engine);
  const focusPage = usePagedStore((s) => s.focusPage);
  const controller = usePagedStore((s) => s.controller);
  const geminiKey = useSettingsStore((s) => s.apiKeys.gemini);

  const engines = useMemo(() => availableEngines({ sidecar: isSidecarAvailable(), geminiKey }), [geminiKey]);
  const [engine, setEngine] = useState<PdfEngine>(bookEngine);
  const [scope, setScope] = useState<Scope>('page');
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(1);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const f = initialFrom ?? focusPage;
    const t = initialTo ?? f;
    setFrom(f);
    setTo(t);
    setScope(f === 1 && t === pageCount && pageCount > 1 ? 'all' : f === t ? 'rest' : 'range');
    setEngine(engines.includes(bookEngine) ? bookEngine : engines[0]);
    setOverwrite(false);
  }, [isOpen, initialFrom, initialTo, focusPage, pageCount, bookEngine, engines]);

  const range = useMemo<[number, number]>(() => {
    if (scope === 'all') return [1, pageCount];
    if (scope === 'rest') return [from, pageCount];
    if (scope === 'page') return [from, from];
    return [Math.min(from, to), Math.max(from, to)];
  }, [scope, from, to, pageCount]);

  const editedCount = useMemo(() => {
    if (!controller) return 0;
    let n = 0;
    for (let p = range[0]; p <= range[1]; p++) if (controller.isEdited(p)) n++;
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, range, isOpen]);

  const noKey = engine === 'gemini' && !geminiKey?.trim();
  const pagesInRange = range[1] - range[0] + 1;

  const submit = async () => {
    if (!controller || busy || noKey) return;
    setBusy(true);
    try {
      if (scope === 'rest') {
        const n = await controller.switchEngine(engine, from);
        toast.success(`Дальше распознаём движком «${ENGINE_LABELS[engine]}». В очереди страниц: ${n}. Готовые страницы не изменены.`);
        onClose();
        return;
      }
      const res = await controller.rerecognize({ from: range[0], to: range[1], engine, overwriteEdited: overwrite });
      toast.success(
        res.queued > 0
          ? `Поставлено в очередь страниц: ${res.queued}${res.skippedEdited ? `. Пропущено страниц с вашими правками: ${res.skippedEdited}` : ''}`
          : `Нечего перераспознавать: все страницы диапазона правились вручную (${res.skippedEdited}).`,
      );
      onClose();
    } catch (e) {
      toast.error(`Не удалось запустить перераспознавание: ${e instanceof Error ? e.message : 'ошибка'}`);
    } finally {
      setBusy(false);
    }
  };

  const numInput =
    'w-20 px-2 py-1.5 text-sm rounded-lg bg-white dark:bg-zinc-900 border border-slate-300 dark:border-zinc-700 text-slate-800 dark:text-zinc-100';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      labelledBy={titleId}
      closeOnEsc={!busy}
      closeOnBackdrop={!busy}
      panelClassName="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-3xl w-[calc(100vw-2rem)] max-w-lg max-h-[92vh] overflow-y-auto p-5 sm:p-6 shadow-2xl"
    >
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-lg font-bold text-slate-900 dark:text-zinc-100 flex items-center gap-2">
              <RefreshCw className="w-5 h-5 text-amber-500" aria-hidden="true" />
              Перераспознать страницы
            </h2>
            <p className="text-xs text-slate-600 dark:text-zinc-400 mt-1">
              Выберите, что перераспознать и каким движком. Уже распознанный текст выбранных страниц будет заменён.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="p-1.5 rounded-xl text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800 dark:text-zinc-400"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <fieldset className="space-y-1.5">
          <legend className="text-xs font-semibold text-slate-700 dark:text-zinc-300 mb-1">Что перераспознать</legend>
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                ['rest', 'Эту и все следующие'],
                ['page', 'Только страницу'],
                ['range', 'Диапазон'],
                ['all', 'Всю книгу'],
              ] as Array<[Scope, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={scope === id}
                onClick={() => setScope(id)}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition ${
                  scope === id
                    ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300'
                    : 'border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {scope !== 'all' && (
            <div className="flex items-center gap-2 text-sm text-slate-700 dark:text-zinc-300 pt-1">
              <label className="flex items-center gap-1.5">
                {scope === 'page' ? 'Страница' : 'С'}
                <input
                  type="number"
                  min={1}
                  max={pageCount}
                  value={from}
                  onChange={(e) => setFrom(Math.min(pageCount, Math.max(1, Number(e.target.value) || 1)))}
                  className={numInput}
                />
              </label>
              {scope === 'range' && (
                <label className="flex items-center gap-1.5">
                  по
                  <input
                    type="number"
                    min={1}
                    max={pageCount}
                    value={to}
                    onChange={(e) => setTo(Math.min(pageCount, Math.max(1, Number(e.target.value) || 1)))}
                    className={numInput}
                  />
                </label>
              )}
              <span className="text-xs text-slate-500 dark:text-zinc-400">из {pageCount}</span>
            </div>
          )}
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="text-xs font-semibold text-slate-700 dark:text-zinc-300 mb-1">Движок</legend>
          {engines.map((e) => (
            <label
              key={e}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl border cursor-pointer text-sm ${
                engine === e
                  ? 'border-amber-500 bg-amber-50/60 dark:bg-amber-950/20'
                  : 'border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800/50'
              }`}
            >
              <input type="radio" name="engine" checked={engine === e} onChange={() => setEngine(e)} className="accent-amber-500" />
              <span className="text-slate-800 dark:text-zinc-200">{ENGINE_LABELS[e]}</span>
              {e === bookEngine && <span className="ml-auto text-[10px] text-slate-500 dark:text-zinc-400">сейчас</span>}
            </label>
          ))}
          {noKey && (
            <p className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
              <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
              Для Gemini нужен ключ API (Настройки → Ключи API). Страницы отправляются в Gemini по одной.
            </p>
          )}
          {engine === 'gemini' && !noKey && (
            <p className="text-xs text-slate-600 dark:text-zinc-400">
              Каждая страница — отдельный запрос к Gemini с вашим ключом ({pagesInRange} стр.). Фоновое распознавание вне ближайших страниц отключено.
            </p>
          )}
        </fieldset>

        {editedCount > 0 && (
          <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-zinc-300 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40 rounded-xl p-3 cursor-pointer">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} className="mt-0.5 accent-amber-500" />
            <span>
              В диапазоне страниц с вашими правками: <strong>{editedCount}</strong>. По умолчанию они пропускаются. Отметьте, чтобы
              перезаписать и их (правки будут потеряны).
            </span>
          </label>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || noKey}
            className="px-4 py-2 rounded-xl text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50"
          >
            {busy ? 'Запуск…' : scope === 'rest' ? 'Продолжить этим движком' : `Перераспознать (${pagesInRange} стр.)`}
          </button>
        </div>
      </div>
    </Modal>
  );
};
