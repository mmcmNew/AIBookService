import React, { useEffect, useId, useMemo, useState } from 'react';
import { X, FileText, ShieldCheck, ListChecks, Save, RotateCcw, Sparkles, TriangleAlert } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';
import { useBookStore } from '../../store/bookStore';
import { goToPage } from '../../engine/library';
import { usePagedStore } from '../../store/pagedStore';
import { assessBook } from '../../engine/cleanup/bookQuality';
import { planFromHeadings, planFromOutline, type ChapterSpec } from '../../engine/pdf/chapterPlan';
import { finalizePageBlocks } from '../../engine/pdf/pageClean';
import { normalizeBlockText } from '../../engine/pdf/pageCompose';
import type { PdfBlock } from '../../engine/parsers/pdfSidecar';
import type { ManualChapterStart } from '../../types/book';
import { openRerecognizeDialog } from '../reader/PagedBookBar';

type Tab = 'page' | 'quality' | 'chapters';

const HIDDEN = new Set(['header', 'footer', 'pagenum']);

/** Текст страницы для правки: читаемые блоки через пустую строку. */
export function blocksToEditText(blocks: PdfBlock[]): string {
  return blocks
    .filter((b) => !HIDDEN.has(b.type) && normalizeBlockText(b.text))
    .map((b) => normalizeBlockText(b.text))
    .join('\n\n');
}

/**
 * Применяет отредактированный текст к блокам страницы: совпавшие абзацы сохраняют тип/bbox (и подсветку по оригиналу),
 * при том же числе абзацев изменённый абзац сохраняет тип/bbox старого; колонтитулы остаются в данных.
 */
export function applyEditedText(blocks: PdfBlock[], text: string): PdfBlock[] {
  const texts = text
    .split(/\n{2,}/)
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const oldBody = blocks.filter((b) => !HIDDEN.has(b.type) && normalizeBlockText(b.text));
  const used = new Set<PdfBlock>();
  const next: PdfBlock[] = texts.map((t, i) => {
    const same = oldBody.find((b) => !used.has(b) && normalizeBlockText(b.text) === t);
    if (same) {
      used.add(same);
      return { ...same };
    }
    const byIndex = texts.length === oldBody.length ? oldBody[i] : undefined;
    if (byIndex && !used.has(byIndex)) {
      used.add(byIndex);
      return { ...byIndex, text: t };
    }
    return { type: 'paragraph', text: t };
  });
  for (const b of next) {
    delete b.continuesParagraph;
    delete b.endsWithHyphen;
    delete b.endsWithOpenSentence;
  }
  finalizePageBlocks(next);
  const head = blocks.filter((b) => b.type === 'header');
  const tail = blocks.filter((b) => b.type === 'footer' || b.type === 'pagenum');
  return [...head, ...next, ...tail];
}

function specsToManual(specs: ChapterSpec[]): ManualChapterStart[] {
  return specs
    .filter((s) => s.source !== 'ranges')
    .map((s) => ({
      page: s.startPage,
      block: s.startBlock,
      title: s.title,
      level: s.level,
      hideBlocks: s.hide.filter(([p]) => p === s.startPage).map(([, b]) => b),
    }));
}

export const PagedBookEditor: React.FC<{ onClose: () => void; initialTab?: 'quality' | 'chapters' | 'cleanup' | 'search' }> = ({
  onClose,
  initialTab,
}) => {
  const titleId = useId();
  const toast = useToast();
  const book = useBookStore((s) => s.currentBook)!;
  const currentPage = useBookStore((s) => s.currentPage);
  const controller = usePagedStore((s) => s.controller);
  const composed = usePagedStore((s) => s.composed);
  const states = usePagedStore((s) => s.states);
  const pageCount = usePagedStore((s) => s.pageCount);

  const [tab, setTab] = useState<Tab>(initialTab === 'chapters' ? 'chapters' : initialTab === 'quality' || initialTab === 'cleanup' ? 'quality' : 'page');
  const [page, setPage] = useState(currentPage);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<null | 'close' | 'revert' | 'shifted'>(null);
  const [autoClean, setAutoClean] = useState(book.metadata.paged?.autoClean ?? true);
  const [shiftedPages, setShiftedPages] = useState(0);
  const [bump, setBump] = useState(0);

  const state = states[page - 1] ?? 'pending';
  const meta = state === 'done' ? controller?.getPageMeta(page) : null;

  // Загрузка текста страницы в редактор (при смене страницы и после перераспознавания)
  useEffect(() => {
    const blocks = state === 'done' ? controller?.getPageBlocks(page) : null;
    setText(blocks ? blocksToEditText(blocks) : '');
    setDirty(false);
  }, [page, state, controller, bump, composed?.pages[page - 1]]);

  useEffect(() => {
    if (tab === 'quality') setShiftedPages(controller?.countShiftedPages() ?? 0);
  }, [tab, controller, composed]);

  const report = useMemo(() => {
    if (!composed) return null;
    const chapters = composed.chapters.filter((c) => c.sentences.length > 0);
    if (chapters.length === 0) return null;
    return assessBook({ metadata: book.metadata, chapters, rawPdfBuffer: undefined });
  }, [composed, book.metadata]);

  const requestClose = () => {
    if (dirty) setConfirm('close');
    else onClose();
  };

  const save = async () => {
    if (!controller || state !== 'done') return;
    setSaving(true);
    try {
      const blocks = controller.getPageBlocks(page) ?? [];
      await controller.savePageBlocks(page, applyEditedText(blocks, text));
      setDirty(false);
      toast.success(`Страница ${page} сохранена (помечена как изменённая вручную).`);
    } catch (e) {
      toast.error(`Не удалось сохранить страницу: ${e instanceof Error ? e.message : 'ошибка'}`);
    } finally {
      setSaving(false);
    }
  };

  const detect = async (source: 'headings' | 'outline') => {
    if (!composed || !controller) return;
    const specs =
      source === 'outline'
        ? planFromOutline(book.metadata.paged?.outline ?? [], pageCount, composed.pages)
        : planFromHeadings(composed.pages);
    if (!specs || specs.filter((s) => s.source !== 'ranges').length === 0) {
      toast.info(source === 'outline' ? 'В PDF нет пригодного оглавления.' : 'Заголовки глав в распознанном тексте не найдены. Распознайте больше страниц.');
      return;
    }
    await controller.setManualChapters(specsToManual(specs));
    toast.success(`Глав определено: ${specs.filter((s) => s.source !== 'ranges').length}. Содержание обновлено.`);
  };

  const tabBtn = (id: Tab, label: string, icon: React.ReactNode) => (
    <button
      key={id}
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition ${
        tab === id ? 'bg-amber-100 dark:bg-amber-950/40 text-amber-900 dark:text-amber-300' : 'text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800'
      }`}
    >
      {icon}
      {label}
    </button>
  );

  const btn =
    'inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium border border-slate-300 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-50';
  const primary = 'inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50';

  return (
    <>
      <Modal
        isOpen
        onClose={requestClose}
        labelledBy={titleId}
        panelClassName="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-3xl w-[calc(100vw-1.5rem)] max-w-3xl max-h-[92vh] flex flex-col shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 p-4 border-b border-slate-200 dark:border-zinc-800">
          <h2 id={titleId} className="font-bold text-slate-900 dark:text-zinc-100">
            Правка книги (постранично)
          </h2>
          <button onClick={requestClose} aria-label="Закрыть" className="p-1.5 rounded-xl text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div role="tablist" className="flex flex-wrap gap-1 px-3 pt-2">
          {tabBtn('page', 'Страница', <FileText className="w-4 h-4" aria-hidden="true" />)}
          {tabBtn('quality', 'Качество и очистка', <ShieldCheck className="w-4 h-4" aria-hidden="true" />)}
          {tabBtn('chapters', 'Главы', <ListChecks className="w-4 h-4" aria-hidden="true" />)}
        </div>

        <div className="p-4 overflow-y-auto flex-1 space-y-3">
          {tab === 'page' && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <button className={btn} onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
                  ←
                </button>
                <label className="flex items-center gap-1.5">
                  Страница
                  <input
                    type="number"
                    min={1}
                    max={pageCount}
                    value={page}
                    onChange={(e) => setPage(Math.min(pageCount, Math.max(1, Number(e.target.value) || 1)))}
                    className="w-20 px-2 py-1.5 rounded-lg bg-white dark:bg-zinc-900 border border-slate-300 dark:border-zinc-700"
                  />
                  <span className="text-slate-500 dark:text-zinc-400">из {pageCount}</span>
                </label>
                <button className={btn} onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount}>
                  →
                </button>
                <button className={btn} onClick={() => setPage(currentPage)} title="К текущей странице чтения">
                  Текущая ({currentPage})
                </button>
                <span className="text-xs text-slate-500 dark:text-zinc-400">
                  {state === 'done' ? `готова${meta?.edited ? ' · изменена вручную' : ''}` : state === 'running' ? 'распознаётся…' : state === 'error' ? 'ошибка' : 'ожидает'}
                </span>
              </div>

              {state !== 'done' ? (
                <div className="rounded-xl border border-dashed border-slate-300 dark:border-zinc-700 p-6 text-center text-sm text-slate-600 dark:text-zinc-400">
                  Страница ещё не распознана.
                  <div className="mt-3">
                    <button className={primary} onClick={() => goToPage(page)}>
                      Распознать сейчас
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <label htmlFor="page-edit" className="sr-only">
                    Текст страницы {page}
                  </label>
                  <textarea
                    id="page-edit"
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      setDirty(true);
                    }}
                    rows={16}
                    spellCheck={false}
                    className="w-full px-3 py-2 rounded-xl text-sm leading-relaxed bg-white dark:bg-zinc-950 border border-slate-300 dark:border-zinc-700 text-slate-900 dark:text-zinc-100 font-serif"
                  />
                  <p className="text-xs text-slate-500 dark:text-zinc-400">
                    Абзацы разделяются пустой строкой. Колонтитулы и номера страниц в текст не входят. После сохранения страница помечается
                    «изменена вручную» и не затирается перераспознаванием без подтверждения.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button className={primary} onClick={() => void save()} disabled={!dirty || saving}>
                      <Save className="w-4 h-4" aria-hidden="true" /> Сохранить страницу
                    </button>
                    <button className={btn} onClick={() => setBump((b) => b + 1)} disabled={!dirty}>
                      <RotateCcw className="w-4 h-4" aria-hidden="true" /> Отменить правки
                    </button>
                    <button className={btn} onClick={() => openRerecognizeDialog(page, page)}>
                      Перераспознать другим режимом…
                    </button>
                    {meta?.edited && (
                      <button className={btn} onClick={() => setConfirm('revert')}>
                        Вернуть распознанный текст
                      </button>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {tab === 'quality' && (
            <>
              {report ? (
                <div
                  className={`rounded-xl border p-3 text-sm ${
                    report.grade === 'good'
                      ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20 dark:border-emerald-900/50 text-emerald-900 dark:text-emerald-200'
                      : report.grade === 'fair'
                        ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900/50 text-amber-900 dark:text-amber-200'
                        : 'border-rose-300 bg-rose-50 dark:bg-rose-950/20 dark:border-rose-900/50 text-rose-900 dark:text-rose-200'
                  }`}
                >
                  <p className="font-semibold">
                    Качество по распознанным страницам: {report.score}/100
                  </p>
                  <p className="mt-0.5">{report.recommendation ?? report.summary}</p>
                  {report.issues.length > 0 && (
                    <ul className="mt-2 list-disc pl-5 space-y-0.5 text-xs">
                      {report.issues.map((i) => (
                        <li key={i.code}>{i.message}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-600 dark:text-zinc-400">Пока нет распознанного текста для оценки.</p>
              )}

              <label className="flex items-start gap-2 text-sm text-slate-800 dark:text-zinc-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoClean}
                  onChange={(e) => {
                    setAutoClean(e.target.checked);
                    controller?.setAutoClean(e.target.checked);
                  }}
                  className="mt-1 accent-amber-500"
                />
                <span>
                  Авто-очистка новых страниц
                  <span className="block text-xs text-slate-500 dark:text-zinc-400">Убирать Markdown-разметку, мусорные и невидимые символы, лишние пробелы сразу после распознавания.</span>
                </span>
              </label>

              <button
                className={btn}
                onClick={async () => {
                  const n = (await controller?.cleanRecognizedPages()) ?? 0;
                  toast.success(n > 0 ? `Очищено фрагментов текста: ${n}.` : 'Распознанные страницы уже чистые.');
                }}
              >
                <Sparkles className="w-4 h-4" aria-hidden="true" /> Очистить уже распознанные страницы
              </button>

              {shiftedPages > 0 && (
                <div className="rounded-xl border border-amber-300 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 p-3 text-sm text-amber-900 dark:text-amber-200 space-y-2">
                  <p className="flex items-start gap-2">
                    <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                    Обнаружена «сдвинутая кириллица» (текст из кракозябр) на страницах: {shiftedPages}. Автоматически она не исправляется — проверьте и примените.
                  </p>
                  <button className={primary} onClick={() => setConfirm('shifted')}>
                    Исправить на всех страницах…
                  </button>
                </div>
              )}
            </>
          )}

          {tab === 'chapters' && (
            <>
              <p className="text-sm text-slate-600 dark:text-zinc-400">
                Источник глав сейчас:{' '}
                <strong>
                  {composed?.specs[0]?.source === 'manual'
                    ? 'заданы вручную'
                    : composed?.specs[0]?.source === 'outline'
                      ? 'оглавление PDF'
                      : composed?.specs[0]?.source === 'headings'
                        ? 'заголовки в тексте'
                        : 'диапазоны страниц'}
                </strong>
                . Содержание достраивается по мере распознавания страниц.
              </p>
              <div className="flex flex-wrap gap-2">
                <button className={primary} onClick={() => void detect('headings')}>
                  Определить главы по тексту
                </button>
                {(book.metadata.paged?.outline.length ?? 0) > 1 && (
                  <button className={btn} onClick={() => void detect('outline')}>
                    По оглавлению PDF
                  </button>
                )}
                {book.metadata.paged?.chapterStarts && (
                  <button className={btn} onClick={() => void controller?.setManualChapters(undefined)}>
                    Сбросить на автоматические
                  </button>
                )}
              </div>
              <ol className="text-sm space-y-0.5 max-h-72 overflow-y-auto border border-slate-200 dark:border-zinc-800 rounded-xl p-2">
                {composed?.chapters.map((c, i) => (
                  <li key={c.id} className="flex justify-between gap-2 px-2 py-0.5">
                    <span className={`truncate ${c.stub ? 'italic text-slate-500' : ''}`}>
                      {i + 1}. {c.title}
                    </span>
                    <span className="shrink-0 text-xs text-slate-500">
                      стр. {c.startPage}
                      {c.stub ? ' · не распознана' : ''}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={confirm === 'close'}
        title="Закрыть без сохранения?"
        message={`Правки страницы ${page} не сохранены.`}
        confirmLabel="Закрыть"
        onConfirm={() => {
          setConfirm(null);
          onClose();
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        isOpen={confirm === 'revert'}
        title="Вернуть распознанный текст?"
        message={`Ваши правки страницы ${page} будут потеряны, страница распознаётся заново.`}
        confirmLabel="Перераспознать"
        danger
        onConfirm={() => {
          setConfirm(null);
          const engine = usePagedStore.getState().engine;
          void controller?.rerecognize({ from: page, to: page, engine, overwriteEdited: true });
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        isOpen={confirm === 'shifted'}
        title="Исправить сдвинутую кириллицу?"
        message="Текст на затронутых страницах будет преобразован (код символа + 0x400). Страницы с вашими правками не затрагиваются."
        confirmLabel="Исправить"
        onConfirm={async () => {
          setConfirm(null);
          const n = (await controller?.repairShiftedPages()) ?? 0;
          toast.success(n > 0 ? `Исправлено фрагментов: ${n}.` : 'Нечего исправлять.');
          setShiftedPages(controller?.countShiftedPages() ?? 0);
        }}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
};
