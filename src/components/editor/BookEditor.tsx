import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  FileText,
  ListChecks,
  Redo2,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Undo2,
  X,
  BookPlus,
  ArrowDownToLine,
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { useBookStore } from '../../store/bookStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useAudioStore } from '../../store/audioStore';
import { coordinator } from '../../engine/audio/coordinator';
import {
  applyCleanupToDraft,
  addParagraph,
  deleteChapter,
  deleteParagraph,
  mergeChapterWithNext,
  mergeParagraphWithNext,
  renameChapter,
  splitChapterAt,
  splitParagraph,
  updateParagraphText,
} from '../../engine/cleanup/draftOps';
import {
  chaptersToDraft,
  draftToChapters,
  isDraftDirty,
  paragraphProblems,
  type AppliedChapter,
  type CleanupOp,
  type DraftChapter,
  type DraftParagraph,
  type ParagraphProblem,
} from '../../engine/cleanup';
import { ParagraphRow } from './ParagraphRow';
import { CleanupPanel } from './CleanupPanel';
import { SearchPanel } from './SearchPanel';
import { QualityPanel } from './QualityPanel';
import { ChaptersPanel } from './ChaptersPanel';
import { PagedBookEditor } from './PagedBookEditor';

const MAX_UNDO = 50;
const PAGE_SIZE = 150;

interface History {
  past: DraftChapter[][];
  present: DraftChapter[];
  future: DraftChapter[][];
}

type Tab = 'quality' | 'cleanup' | 'chapters' | 'search';

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'quality', label: 'Качество', icon: <ShieldCheck className="w-4 h-4" aria-hidden="true" /> },
  { id: 'cleanup', label: 'Очистка', icon: <Sparkles className="w-4 h-4" aria-hidden="true" /> },
  { id: 'chapters', label: 'Главы', icon: <ListChecks className="w-4 h-4" aria-hidden="true" /> },
  { id: 'search', label: 'Поиск', icon: <Search className="w-4 h-4" aria-hidden="true" /> },
];

const headerBtn =
  'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors';

interface BookEditorProps {
  isOpen: boolean;
  onClose: () => void;
  /** Открыть сразу на нужной вкладке (например, «Главы») */
  initialTab?: Tab;
}

export const BookEditor: React.FC<BookEditorProps> = ({ isOpen, onClose, initialTab }) => {
  const hasBook = useBookStore((s) => s.currentBook !== null);
  const isPaged = useBookStore((s) => Boolean(s.currentBook?.metadata.paged));
  if (!isOpen || !hasBook) return null;
  if (isPaged) return <PagedBookEditor onClose={onClose} initialTab={initialTab} />;
  return <EditorInner onClose={onClose} initialTab={initialTab} />;
};

const EditorInner: React.FC<{ onClose: () => void; initialTab?: Tab }> = ({ onClose, initialTab }) => {
  const book = useBookStore((s) => s.currentBook)!;
  const startChapter = useBookStore((s) => s.currentChapterIndex);
  const replaceBookChapters = useBookStore((s) => s.replaceBookChapters);
  const toast = useToast();
  const titleId = useId();

  const [hist, setHist] = useState<History>(() => ({ past: [], present: chaptersToDraft(book.chapters), future: [] }));
  const draft = hist.present;
  const [ci, setCi] = useState(() => Math.min(startChapter, Math.max(0, book.chapters.length - 1)));
  const [editing, setEditing] = useState<string | null>(null); // key абзаца
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [tab, setTab] = useState<Tab>(initialTab ?? 'quality');
  const [mobileView, setMobileView] = useState<'text' | 'tools'>('text');
  const [suggestedOps, setSuggestedOps] = useState<CleanupOp[] | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<null | 'close' | 'deleteChapter'>(null);
  const [liveMessage, setLiveMessage] = useState('');
  const scrollTarget = useRef<string | null>(null);

  const isPdf = Boolean(book.rawPdfBuffer);
  const safeCi = Math.min(ci, draft.length - 1);
  const chapter = draft[safeCi];

  // ----------------------------------------------------------------- история
  const commit = useCallback((next: DraftChapter[], message?: string) => {
    setHist((h) => {
      if (next === h.present) return h;
      return { past: [...h.past.slice(-(MAX_UNDO - 1)), h.present], present: next, future: [] };
    });
    setEditing(null);
    if (message) setLiveMessage(message);
  }, []);

  const undo = useCallback(() => {
    setHist((h) => {
      if (h.past.length === 0) return h;
      return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
    });
    setEditing(null);
    setLiveMessage('Действие отменено');
  }, []);

  const redo = useCallback(() => {
    setHist((h) => {
      if (h.future.length === 0) return h;
      return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
    });
    setEditing(null);
    setLiveMessage('Действие повторено');
  }, []);

  const dirty = useMemo(() => isDraftDirty(draft, book.chapters), [draft, book.chapters]);

  // --------------------------------------------------- подозрительные абзацы
  const problemCache = useRef(new WeakMap<DraftParagraph, ParagraphProblem[]>());
  const problemsOf = useCallback((p: DraftParagraph): ParagraphProblem[] => {
    let v = problemCache.current.get(p);
    if (!v) {
      v = paragraphProblems(p.text);
      problemCache.current.set(p, v);
    }
    return v;
  }, []);

  const suspicious = useMemo(() => {
    const list: { ci: number; pi: number }[] = [];
    const perChapter: number[] = [];
    draft.forEach((c, i) => {
      let n = 0;
      c.paragraphs.forEach((p, pi) => {
        if (problemsOf(p).length > 0) {
          list.push({ ci: i, pi });
          n++;
        }
      });
      perChapter.push(n);
    });
    return { list, perChapter };
  }, [draft, problemsOf]);

  const jumpTo = useCallback(
    (targetCi: number, targetPi: number) => {
      const c = draft[targetCi];
      const p = c?.paragraphs[targetPi];
      if (!c || !p) return;
      setCi(targetCi);
      setLimit((l) => Math.max(l, targetPi + 30));
      setHighlight(p.key);
      scrollTarget.current = p.key;
      setMobileView('text');
      window.setTimeout(() => setHighlight((h) => (h === p.key ? null : h)), 2500);
    },
    [draft]
  );

  const goNextSuspicious = useCallback(() => {
    const list = suspicious.list;
    if (list.length === 0) {
      setLiveMessage('Подозрительных абзацев нет');
      return;
    }
    const after = list.find((x) => x.ci > safeCi || (x.ci === safeCi && x.pi > lastPi.current));
    const target = after ?? list[0];
    lastPi.current = target.pi;
    jumpTo(target.ci, target.pi);
  }, [suspicious, safeCi, jumpTo]);
  const lastPi = useRef(-1);

  // Прокрутка к целевому абзацу после рендера
  useEffect(() => {
    const key = scrollTarget.current;
    if (!key) return;
    const el = document.getElementById(`bp-${key}`);
    if (el) {
      scrollTarget.current = null;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.querySelector<HTMLElement>('[role="button"]')?.focus({ preventScroll: true });
    }
  });

  // ----------------------------------------------------------- сохранение
  const save = useCallback(async () => {
    if (saving || !dirty) return false;
    setSaving(true);
    try {
      const rules = useSettingsStore.getState().replacementRules;
      const result = draftToChapters(draft, { userRules: rules, lang: book.metadata.lang || 'ru' });
      if (result.chapters.length === 0) {
        toast.error('Нечего сохранять: в книге не осталось текста.');
        return false;
      }
      const audio = useAudioStore.getState();
      if (audio.isPlaying) coordinator.stop();
      await replaceBookChapters(result.chapters);
      const saved = useBookStore.getState().currentBook;
      setHist({ past: [], present: chaptersToDraft(saved?.chapters ?? result.chapters), future: [] });
      setEditing(null);
      const q = saved?.metadata.quality;
      toast.success(
        `Изменения сохранены.${q ? ` Качество текста: ${q.score}/100.` : ''}${
          result.droppedEmpty ? ` Пустых глав удалено: ${result.droppedEmpty}.` : ''
        }`
      );
      return true;
    } catch (e) {
      console.error('[BookEditor] Ошибка сохранения:', e);
      toast.error(`Не удалось сохранить: ${e instanceof Error && e.message ? e.message : 'неизвестная ошибка'}`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [saving, dirty, draft, book.metadata.lang, replaceBookChapters, toast]);

  const requestClose = useCallback(() => {
    if (dirty) setConfirm('close');
    else onClose();
  }, [dirty, onClose]);

  const onPanelKeyDown = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      e.stopPropagation();
      void save();
      return;
    }
    if (e.key === 'Escape' && !e.defaultPrevented && confirm === null) {
      e.preventDefault();
      e.stopPropagation();
      requestClose();
      return;
    }
    // Undo/redo работают вне текстовых полей (внутри них - собственная история браузера)
    const inField = e.target instanceof HTMLElement && ['TEXTAREA', 'INPUT'].includes(e.target.tagName);
    if (mod && !inField && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && !inField && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    } else if (e.key === 'F8') {
      e.preventDefault();
      goNextSuspicious();
    }
  };

  // Горячие клавиши работают на уровне документа: фокус может оказаться вне панели (например, после клика по кнопке)
  const keyHandlerRef = useRef(onPanelKeyDown);
  keyHandlerRef.current = onPanelKeyDown;
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyHandlerRef.current(e);
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);

  // Предупреждение при закрытии вкладки с несохранёнными правками
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // ----------------------------------------------- обработчики абзацев
  const handleCommit = useCallback((pi: number, text: string) => commit(updateParagraphText(draft, safeCi, pi, text)), [commit, draft, safeCi]);
  const handleDelete = useCallback((pi: number) => commit(deleteParagraph(draft, safeCi, pi), 'Абзац удалён'), [commit, draft, safeCi]);
  const handleMergeNext = useCallback(
    (pi: number, text: string) => commit(mergeParagraphWithNext(updateParagraphText(draft, safeCi, pi, text), safeCi, pi), 'Абзацы склеены'),
    [commit, draft, safeCi]
  );
  const handleMergePrev = useCallback(
    (pi: number, text: string) => commit(mergeParagraphWithNext(updateParagraphText(draft, safeCi, pi, text), safeCi, pi - 1), 'Абзацы склеены'),
    [commit, draft, safeCi]
  );
  const handleSplit = useCallback(
    (pi: number, text: string, offset: number) => {
      const next = splitParagraph(updateParagraphText(draft, safeCi, pi, text), safeCi, pi, offset);
      commit(next, next === draft ? undefined : 'Абзац разбит');
      if (next !== draft) setEditing(null);
    },
    [commit, draft, safeCi]
  );
  const handleAddAfter = useCallback(
    (pi: number, text: string) => {
      const base = updateParagraphText(draft, safeCi, pi, text);
      const next = addParagraph(base, safeCi, pi);
      commit(next, 'Добавлен абзац');
      const created = next[safeCi].paragraphs[pi + 1];
      if (created) setEditing(created.key);
    },
    [commit, draft, safeCi]
  );
  const handleNewChapter = useCallback(
    (pi: number, text: string) => {
      const base = updateParagraphText(draft, safeCi, pi, text);
      const next = splitChapterAt(base, safeCi, pi);
      commit(next, 'Создана новая глава');
      if (next !== base) setCi(safeCi + 1);
    },
    [commit, draft, safeCi]
  );
  const stopEdit = useCallback(() => setEditing(null), []);
  const startEdit = useCallback(
    (pi: number) => {
      const p = draft[safeCi]?.paragraphs[pi];
      if (p) setEditing(p.key);
    },
    [draft, safeCi]
  );

  const selectChapter = (i: number) => {
    setCi(i);
    setLimit(PAGE_SIZE);
    setEditing(null);
    lastPi.current = -1;
  };

  const applyCleanup = (applied: AppliedChapter[], label: string) => {
    commit(applyCleanupToDraft(draft, applied), `${label}: применено`);
    toast.success('Очистка применена. Не забудьте сохранить (Ctrl+S).');
  };

  const rescan = () => {
    if (dirty) {
      toast.info('Сначала сохраните или отмените правки, затем выберите другой режим распознавания.');
      return;
    }
    onClose();
    window.dispatchEvent(new CustomEvent('open-pdf-engine'));
  };

  const quality = useMemo(() => book.metadata.quality, [book.metadata.quality]);
  const shownParagraphs = chapter ? chapter.paragraphs.slice(0, limit) : [];

  return (
    <>
    <Modal
      isOpen
      onClose={requestClose}
      closeOnEsc={false}
      closeOnBackdrop={false}
      labelledBy={titleId}
      panelClassName="bg-white dark:bg-zinc-900 text-slate-900 dark:text-zinc-100 w-screen h-dvh sm:w-[min(98vw,1400px)] sm:h-[94vh] sm:rounded-2xl sm:border border-slate-200 dark:border-zinc-800 shadow-2xl overflow-hidden"
    >
      <div className="flex flex-col h-full">
        {/* Шапка */}
        <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 sm:px-4 py-2.5 border-b border-slate-200 dark:border-zinc-800">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-bold truncate">
              Редактор текста{dirty ? ' •' : ''}
            </h2>
            <p className="text-xs text-slate-500 dark:text-zinc-400 truncate">
              {book.metadata.title}
              {quality ? ` · качество ${quality.score}/100` : ''}
              {dirty ? ' · есть несохранённые изменения' : ''}
            </p>
          </div>
          <button type="button" className={headerBtn} onClick={undo} disabled={hist.past.length === 0} aria-label="Отменить" title="Отменить (Ctrl+Z)">
            <Undo2 className="w-4 h-4" aria-hidden="true" />
            <span className="hidden sm:inline">Отменить</span>
          </button>
          <button type="button" className={headerBtn} onClick={redo} disabled={hist.future.length === 0} aria-label="Повторить" title="Повторить (Ctrl+Shift+Z)">
            <Redo2 className="w-4 h-4" aria-hidden="true" />
            <span className="hidden sm:inline">Повторить</span>
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Сохранить (Ctrl+S)"
          >
            <Save className="w-4 h-4" aria-hidden="true" />
            {saving ? 'Сохранение…' : 'Сохранить'}
          </button>
          <button type="button" className={headerBtn} onClick={requestClose} aria-label="Закрыть редактор" title="Закрыть (Esc)">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {isPdf && (
          <p className="shrink-0 flex items-start gap-2 px-4 py-1.5 text-xs bg-sky-50 dark:bg-sky-950/30 text-sky-900 dark:text-sky-200 border-b border-sky-200/70 dark:border-sky-900/40">
            <FileText className="w-4 h-4 shrink-0 mt-px" aria-hidden="true" />
            <span>
              PDF: правки относятся к текстовому режиму («Текст книги»). Подсветка поверх страниц оригинала сохраняется только у неизменённых абзацев.
            </span>
          </p>
        )}

        {/* Переключатель на узких экранах */}
        <div className="lg:hidden shrink-0 flex border-b border-slate-200 dark:border-zinc-800" role="tablist" aria-label="Раздел редактора">
          {(['text', 'tools'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={mobileView === v}
              onClick={() => setMobileView(v)}
              className={`flex-1 py-2 text-sm font-medium ${mobileView === v ? 'text-amber-700 dark:text-amber-400 border-b-2 border-amber-600' : 'text-slate-600 dark:text-zinc-400'}`}
            >
              {v === 'text' ? 'Текст' : 'Инструменты'}
            </button>
          ))}
        </div>

        <div className="flex-1 min-h-0 flex">
          {/* Список глав */}
          <nav aria-label="Главы" className="hidden md:flex w-52 shrink-0 flex-col border-r border-slate-200 dark:border-zinc-800 min-h-0">
            <ul className="flex-1 overflow-y-auto p-2 flex flex-col gap-0.5">
              {draft.map((c, i) => (
                <li key={c.key}>
                  <button
                    type="button"
                    onClick={() => selectChapter(i)}
                    aria-current={i === safeCi ? 'true' : undefined}
                    className={`w-full text-left rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
                      i === safeCi
                        ? 'bg-amber-100 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 font-semibold'
                        : 'hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300'
                    }`}
                  >
                    <span className="block truncate">{c.title || 'Без названия'}</span>
                    <span className="block text-[11px] text-slate-500 dark:text-zinc-400">
                      {c.paragraphs.length} абз.
                      {suspicious.perChapter[i] > 0 && <span className="text-amber-700 dark:text-amber-400"> · проблем: {suspicious.perChapter[i]}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {/* Текст главы */}
          <section
            aria-label="Текст главы"
            className={`${mobileView === 'text' ? 'flex' : 'hidden'} lg:flex flex-1 min-w-0 flex-col min-h-0`}
          >
            {chapter && (
              <>
                <div className="shrink-0 px-3 sm:px-4 py-2 border-b border-slate-200 dark:border-zinc-800 flex flex-wrap items-end gap-2">
                  <div className="md:hidden w-full">
                    <label className="sr-only" htmlFor="ed-chapter-select">
                      Глава
                    </label>
                    <select
                      id="ed-chapter-select"
                      value={safeCi}
                      onChange={(e) => selectChapter(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1.5 text-sm"
                    >
                      {draft.map((c, i) => (
                        <option key={c.key} value={i}>
                          {i + 1}. {c.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex-1 min-w-[12rem]">
                    <label htmlFor="ed-chapter-title" className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400">
                      Название главы
                    </label>
                    <ChapterTitleInput key={chapter.key} value={chapter.title} onCommit={(t) => commit(renameChapter(draft, safeCi, t))} />
                  </div>
                  <button
                    type="button"
                    className={headerBtn}
                    onClick={() => commit(mergeChapterWithNext(draft, safeCi), 'Главы объединены')}
                    disabled={safeCi + 1 >= draft.length}
                    title="Добавить абзацы следующей главы в конец этой"
                  >
                    <ArrowDownToLine className="w-4 h-4" aria-hidden="true" />
                    <span className="hidden sm:inline">Склеить со следующей</span>
                  </button>
                  <button
                    type="button"
                    className={`${headerBtn} hover:!text-rose-600`}
                    onClick={() => setConfirm('deleteChapter')}
                    disabled={draft.length <= 1}
                    title="Удалить главу"
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                    <span className="hidden sm:inline">Удалить главу</span>
                  </button>
                  <button
                    type="button"
                    className={headerBtn}
                    onClick={goNextSuspicious}
                    disabled={suspicious.list.length === 0}
                    title="Перейти к следующему подозрительному абзацу (F8)"
                  >
                    <ChevronDown className="w-4 h-4" aria-hidden="true" />
                    Следующий подозрительный ({suspicious.list.length})
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto px-2 sm:px-4 py-3">
                  {chapter.paragraphs.length === 0 && (
                    <p className="text-sm text-slate-500 dark:text-zinc-400 px-2">В главе нет абзацев.</p>
                  )}
                  <div className="flex flex-col gap-1 max-w-4xl mx-auto">
                    {shownParagraphs.map((p, pi) => (
                      <ParagraphRow
                        key={p.key}
                        id={`bp-${p.key}`}
                        text={p.text}
                        index={pi}
                        total={chapter.paragraphs.length}
                        problems={problemsOf(p)}
                        editing={editing === p.key}
                        highlighted={highlight === p.key}
                        canMergePrev={pi > 0}
                        canMergeNext={pi + 1 < chapter.paragraphs.length}
                        canStartChapter={pi > 0}
                        onStartEdit={startEdit}
                        onStopEdit={stopEdit}
                        onCommit={handleCommit}
                        onDelete={handleDelete}
                        onMergePrev={handleMergePrev}
                        onMergeNext={handleMergeNext}
                        onSplit={handleSplit}
                        onAddAfter={handleAddAfter}
                        onNewChapter={handleNewChapter}
                      />
                    ))}
                    {chapter.paragraphs.length > limit && (
                      <button
                        type="button"
                        onClick={() => setLimit((l) => l + PAGE_SIZE)}
                        className="self-center mt-2 px-4 py-2 rounded-xl text-sm border border-slate-300 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800"
                      >
                        Показать ещё абзацы ({chapter.paragraphs.length - limit})
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => commit(addParagraph(draft, safeCi, chapter.paragraphs.length - 1), 'Добавлен абзац')}
                      className="self-start mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800"
                    >
                      <BookPlus className="w-4 h-4" aria-hidden="true" />
                      Добавить абзац в конец
                    </button>
                  </div>
                </div>
              </>
            )}
          </section>

          {/* Инструменты */}
          <aside
            aria-label="Инструменты"
            className={`${mobileView === 'tools' ? 'flex' : 'hidden'} lg:flex w-full lg:w-[22rem] shrink-0 flex-col min-h-0 lg:border-l border-slate-200 dark:border-zinc-800`}
          >
            <div role="tablist" aria-label="Инструменты редактора" className="shrink-0 flex border-b border-slate-200 dark:border-zinc-800">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`ed-tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls={`ed-panel-${t.id}`}
                  onClick={() => setTab(t.id)}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium transition-colors ${
                    tab === t.id
                      ? 'text-amber-700 dark:text-amber-400 border-b-2 border-amber-600'
                      : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100'
                  }`}
                >
                  {t.icon}
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
            <div role="tabpanel" id={`ed-panel-${tab}`} aria-labelledby={`ed-tab-${tab}`} className="flex-1 overflow-y-auto p-3 sm:p-4">
              {tab === 'quality' && (
                <QualityPanel
                  draft={draft}
                  lang={book.metadata.lang || 'ru'}
                  isPdf={isPdf}
                  pdfMode={book.metadata.pdfMode}
                  onFix={(ops) => {
                    setSuggestedOps(ops);
                    setTab('cleanup');
                  }}
                  onOpenChapters={() => setTab('chapters')}
                  onRescan={rescan}
                />
              )}
              {tab === 'cleanup' && <CleanupPanel draft={draft} chapterIndex={safeCi} suggestedOps={suggestedOps} onApply={applyCleanup} />}
              {tab === 'chapters' && (
                <ChaptersPanel
                  draft={draft}
                  chapterIndex={safeCi}
                  hint={draft.length <= 1}
                  onApply={(next, label) => {
                    commit(next, `${label}: применено`);
                    setCi(0);
                    toast.success('Главы обновлены. Не забудьте сохранить (Ctrl+S).');
                  }}
                />
              )}
              {tab === 'search' && (
                <SearchPanel
                  draft={draft}
                  chapterIndex={safeCi}
                  onJump={jumpTo}
                  onReplace={(next, n) => {
                    commit(next, `Заменено: ${n}`);
                    toast.success(`Заменено совпадений: ${n}`);
                  }}
                />
              )}
            </div>
          </aside>
        </div>

        <div className="sr-only" role="status" aria-live="polite">
          {liveMessage}
        </div>
      </div>
    </Modal>

      {/* Подтверждение закрытия с несохранёнными правками */}
      <Modal
        isOpen={confirm === 'close'}
        onClose={() => setConfirm(null)}
        role="alertdialog"
        ariaLabel="Несохранённые изменения"
        panelClassName="w-[calc(100vw-2rem)] max-w-sm bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl shadow-2xl p-5"
      >
        <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100">Закрыть без сохранения?</h3>
        <p className="mt-1 text-sm text-slate-600 dark:text-zinc-400">В тексте есть несохранённые изменения.</p>
        <div className="mt-5 flex flex-col sm:flex-row-reverse gap-2">
          <button
            type="button"
            data-autofocus
            className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700"
            onClick={async () => {
              setConfirm(null);
              if (await save()) onClose();
            }}
          >
            Сохранить и закрыть
          </button>
          <button
            type="button"
            className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-rose-600 hover:bg-rose-700"
            onClick={() => {
              setConfirm(null);
              onClose();
            }}
          >
            Не сохранять
          </button>
          <button
            type="button"
            className="px-4 py-2 rounded-xl text-sm font-medium text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800"
            onClick={() => setConfirm(null)}
          >
            Продолжить правку
          </button>
        </div>
      </Modal>

      {/* Подтверждение удаления главы */}
      <Modal
        isOpen={confirm === 'deleteChapter'}
        onClose={() => setConfirm(null)}
        role="alertdialog"
        ariaLabel="Удалить главу"
        panelClassName="w-[calc(100vw-2rem)] max-w-sm bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl shadow-2xl p-5"
      >
        <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100">Удалить главу?</h3>
        <p className="mt-1 text-sm text-slate-600 dark:text-zinc-400 break-words">
          Глава «{chapter?.title}» ({chapter?.paragraphs.length} абз.) будет удалена из черновика. Действие можно отменить кнопкой «Отменить».
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-autofocus
            className="px-4 py-2 rounded-xl text-sm font-medium text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800"
            onClick={() => setConfirm(null)}
          >
            Отмена
          </button>
          <button
            type="button"
            className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-rose-600 hover:bg-rose-700"
            onClick={() => {
              setConfirm(null);
              commit(deleteChapter(draft, safeCi), 'Глава удалена');
              setCi((i) => Math.max(0, Math.min(i, draft.length - 2)));
            }}
          >
            Удалить
          </button>
        </div>
      </Modal>
    </>
  );
};

/** Поле названия главы: фиксирует значение по Enter / потере фокуса, Esc возвращает прежнее. */
const ChapterTitleInput: React.FC<{ value: string; onCommit: (v: string) => void }> = ({ value, onCommit }) => {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      id="ed-chapter-title"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          e.preventDefault();
          setV(value);
        }
      }}
      className="w-full rounded-lg border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2.5 py-1.5 text-sm font-semibold text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-amber-500/60"
    />
  );
};
