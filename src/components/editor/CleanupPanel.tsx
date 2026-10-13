import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Bot, Eye, Check, TriangleAlert } from 'lucide-react';
import {
  AI_CLEANUP_MODEL,
  CLEANUP_OPS,
  DEFAULT_CLEANUP_OPS,
  aiCleanParagraphs,
  applyCleanupPlan,
  paragraphProblems,
  planCleanup,
  type AppliedChapter,
  type CleanupChange,
  type CleanupOp,
  type CleanupPlan,
  type DraftChapter,
  type TextChapter,
} from '../../engine/cleanup';
import { useSettingsStore } from '../../store/settingsStore';
import { DiffView } from './DiffView';

interface CleanupPanelProps {
  draft: DraftChapter[];
  chapterIndex: number;
  /** Операции, рекомендованные вкладкой «Качество» (подставляются при переходе) */
  suggestedOps: CleanupOp[] | null;
  onApply: (applied: AppliedChapter[], label: string) => void;
}

const OP_LABEL: Record<string, string> = Object.fromEntries(CLEANUP_OPS.map((o) => [o.id, o.label]));
OP_LABEL.ai = 'ИИ-очистка';

const KIND_LABEL: Record<CleanupChange['kind'], string> = { edit: 'Правка', delete: 'Удаление', merge: 'Склейка' };
const KIND_STYLE: Record<CleanupChange['kind'], string> = {
  edit: 'bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300',
  delete: 'bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300',
  merge: 'bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-300',
};

const PAGE = 60;
const AI_MAX_PARAGRAPHS = 120;

const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors';
const btnSecondary =
  'inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium border border-slate-300 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors';

export const CleanupPanel: React.FC<CleanupPanelProps> = ({ draft, chapterIndex, suggestedOps, onApply }) => {
  const [ops, setOps] = useState<Set<CleanupOp>>(() => new Set(DEFAULT_CLEANUP_OPS));
  const [scope, setScope] = useState<'book' | 'chapter'>('book');
  const [plan, setPlan] = useState<{ plan: CleanupPlan; source: DraftChapter[]; scopeLabel: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const scopeId = useId();

  // AI
  const geminiKey = useSettingsStore((s) => s.apiKeys.gemini);
  const [aiOnlyProblems, setAiOnlyProblems] = useState(true);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiProgress, setAiProgress] = useState<{ done: number; total: number } | null>(null);
  const [aiErrors, setAiErrors] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const textChapters = useMemo<TextChapter[]>(
    () => draft.map((c) => ({ id: c.id, title: c.title, paragraphs: c.paragraphs.map((p) => p.text) })),
    [draft]
  );

  // Рекомендации из вкладки «Качество»
  useEffect(() => {
    if (suggestedOps && suggestedOps.length > 0) {
      setOps(new Set(suggestedOps));
      setPlan(null);
    }
  }, [suggestedOps]);

  // План относится к конкретному состоянию черновика: после правок/undo он устарел
  useEffect(() => {
    if (plan && plan.source !== draft) setPlan(null);
  }, [draft, plan]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const toggleOp = (op: CleanupOp) => {
    setOps((prev) => {
      const next = new Set(prev);
      if (next.has(op)) next.delete(op);
      else next.add(op);
      return next;
    });
    setPlan(null);
  };

  const makePlan = () => {
    const chapterIndexes = scope === 'chapter' ? [chapterIndex] : undefined;
    const p = planCleanup(textChapters, Array.from(ops), { chapterIndexes });
    setPlan({ plan: p, source: draft, scopeLabel: scope === 'chapter' ? `глава «${draft[chapterIndex]?.title}»` : 'вся книга' });
    setSelected(new Set(p.changes.map((c) => c.id)));
    setShown(PAGE);
  };

  const apply = () => {
    if (!plan) return;
    const applied = applyCleanupPlan(textChapters, plan.plan, selected);
    onApply(applied, `Очистка (${selected.size})`);
    setPlan(null);
  };

  const runAi = async () => {
    const apiKey = useSettingsStore.getState().apiKeys.gemini;
    const chapter = draft[chapterIndex];
    if (!chapter || !apiKey) return;
    const candidates: number[] = [];
    chapter.paragraphs.forEach((p, i) => {
      if (!p.text.trim()) return;
      if (aiOnlyProblems && paragraphProblems(p.text).length === 0) return;
      if (candidates.length < AI_MAX_PARAGRAPHS) candidates.push(i);
    });
    if (candidates.length === 0) {
      setAiErrors(['В главе нет подходящих абзацев для ИИ-очистки (попробуйте отключить «Только подозрительные»).']);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setAiBusy(true);
    setAiErrors([]);
    setAiProgress({ done: 0, total: candidates.length });
    try {
      const result = await aiCleanParagraphs(
        candidates.map((i) => chapter.paragraphs[i].text),
        {
          apiKey,
          signal: controller.signal,
          onProgress: (done, total) => setAiProgress({ done, total }),
        }
      );
      const changes: CleanupChange[] = result.changed.map((k) => {
        const pi = candidates[k];
        return {
          id: `e:${chapterIndex}:${pi}`,
          kind: 'edit',
          chapterIndex,
          paragraphIndex: pi,
          chapterTitle: chapter.title,
          before: chapter.paragraphs[pi].text,
          after: result.results[k],
          ops: ['ai'],
        };
      });
      setAiErrors(result.errors);
      if (changes.length > 0) {
        setPlan({
          plan: { changes, summary: { edits: changes.length, deletes: 0, merges: 0 } },
          source: draft,
          scopeLabel: `ИИ, глава «${chapter.title}»`,
        });
        setSelected(new Set(changes.map((c) => c.id)));
        setShown(PAGE);
      } else if (result.errors.length === 0) {
        setAiErrors(['ИИ не нашёл, что исправлять в выбранных абзацах.']);
      }
    } finally {
      setAiBusy(false);
      setAiProgress(null);
      abortRef.current = null;
    }
  };

  const toggleChange = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const changes = plan?.plan.changes ?? [];

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="space-y-1.5">
        <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400 mb-1">Операции</legend>
        {CLEANUP_OPS.filter((o) => o.id !== 'ai').map((op) => (
          <label key={op.id} className="flex items-start gap-2 cursor-pointer rounded-lg px-1.5 py-1 hover:bg-slate-50 dark:hover:bg-zinc-800/60">
            <input
              type="checkbox"
              checked={ops.has(op.id)}
              onChange={() => toggleOp(op.id)}
              className="mt-0.5 accent-amber-600"
            />
            <span className="min-w-0">
              <span className="block text-sm text-slate-800 dark:text-zinc-100">{op.label}</span>
              <span className="block text-xs text-slate-500 dark:text-zinc-400">{op.description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div role="radiogroup" aria-labelledby={scopeId} className="flex items-center gap-4 text-sm">
        <span id={scopeId} className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
          Область
        </span>
        {(['book', 'chapter'] as const).map((s) => (
          <label key={s} className="inline-flex items-center gap-1.5 cursor-pointer text-slate-800 dark:text-zinc-100">
            <input
              type="radio"
              name={`scope-${scopeId}`}
              checked={scope === s}
              onChange={() => {
                setScope(s);
                setPlan(null);
              }}
              className="accent-amber-600"
            />
            {s === 'book' ? 'Вся книга' : 'Выбранная глава'}
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnSecondary} onClick={makePlan} disabled={ops.size === 0}>
          <Eye className="w-4 h-4" aria-hidden="true" />
          Предпросмотр
        </button>
      </div>

      {plan && (
        <section aria-label="Предпросмотр очистки" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-slate-700 dark:text-zinc-300" role="status">
              {changes.length === 0
                ? `Изменений не найдено (${plan.scopeLabel}).`
                : `Найдено изменений: ${changes.length} (${plan.scopeLabel}). Правок: ${plan.plan.summary.edits}, удалений: ${plan.plan.summary.deletes}, склеек: ${plan.plan.summary.merges}.`}
            </p>
            {changes.length > 0 && (
              <div className="flex gap-2 text-xs">
                <button type="button" className="underline text-amber-700 dark:text-amber-400" onClick={() => setSelected(new Set(changes.map((c) => c.id)))}>
                  Выбрать все
                </button>
                <button type="button" className="underline text-amber-700 dark:text-amber-400" onClick={() => setSelected(new Set())}>
                  Снять выбор
                </button>
              </div>
            )}
          </div>

          {changes.length > 0 && (
            <>
              <ul className="flex flex-col gap-2">
                {changes.slice(0, shown).map((c) => {
                  const checked = selected.has(c.id);
                  return (
                    <li
                      key={c.id}
                      className={`rounded-xl border p-2.5 ${
                        checked ? 'border-amber-400/70 bg-amber-50/30 dark:bg-amber-950/10' : 'border-slate-200 dark:border-zinc-800 opacity-70'
                      }`}
                    >
                      <label className="flex items-center gap-2 cursor-pointer mb-1.5">
                        <input type="checkbox" checked={checked} onChange={() => toggleChange(c.id)} className="accent-amber-600" />
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${KIND_STYLE[c.kind]}`}>{KIND_LABEL[c.kind]}</span>
                        <span className="text-xs text-slate-600 dark:text-zinc-400 truncate">
                          {c.chapterTitle || `Глава ${c.chapterIndex + 1}`} · абзац {c.paragraphIndex + 1}
                        </span>
                      </label>
                      <p className="text-[11px] text-slate-500 dark:text-zinc-400 mb-1.5">
                        {c.ops.map((o) => OP_LABEL[o] ?? o).join(', ')}
                      </p>
                      <DiffView before={c.before} after={c.after} />
                    </li>
                  );
                })}
              </ul>
              {shown < changes.length && (
                <button type="button" className={btnSecondary} onClick={() => setShown((n) => n + PAGE)}>
                  Показать ещё ({changes.length - shown})
                </button>
              )}
              <div className="sticky bottom-0 -mx-1 px-1 py-2 bg-white/95 dark:bg-zinc-900/95 backdrop-blur border-t border-slate-200 dark:border-zinc-800">
                <button type="button" className={`${btnPrimary} w-full`} onClick={apply} disabled={selected.size === 0}>
                  <Check className="w-4 h-4" aria-hidden="true" />
                  Применить выбранное ({selected.size})
                </button>
              </div>
            </>
          )}
        </section>
      )}

      <section aria-label="ИИ-очистка" className="rounded-2xl border border-slate-200 dark:border-zinc-800 p-3 flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-zinc-100">
          <Bot className="w-4 h-4 text-amber-600" aria-hidden="true" />
          ИИ-очистка выбранной главы (Gemini)
        </h3>
        <p className="text-xs text-slate-600 dark:text-zinc-400 leading-relaxed">
          Абзацы главы отправляются в Google Gemini ({AI_CLEANUP_MODEL}) с вашим ключом API; модель исправляет ошибки распознавания, не меняя смысл.
          Результат показывается как «было / стало» и применяется только после вашего подтверждения. За запросы может взиматься плата по вашему тарифу Google.
        </p>
        {!geminiKey && (
          <p role="alert" className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-300">
            <TriangleAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
            Ключ Gemini API не задан. Добавьте его в настройках (раздел «Ключи API»).
          </p>
        )}
        <label className="flex items-center gap-2 text-sm text-slate-800 dark:text-zinc-100 cursor-pointer">
          <input type="checkbox" checked={aiOnlyProblems} onChange={(e) => setAiOnlyProblems(e.target.checked)} className="accent-amber-600" />
          Только подозрительные абзацы (до {AI_MAX_PARAGRAPHS} за запуск)
        </label>
        <div className="flex gap-2">
          <button type="button" className={btnSecondary} onClick={runAi} disabled={aiBusy || !geminiKey || !draft[chapterIndex]}>
            {aiBusy ? 'Обработка…' : 'Исправить с помощью ИИ'}
          </button>
          {aiBusy && (
            <button type="button" className={btnSecondary} onClick={() => abortRef.current?.abort()}>
              Остановить
            </button>
          )}
        </div>
        {aiProgress && (
          <p role="status" className="text-xs text-slate-600 dark:text-zinc-400">
            Обработано {aiProgress.done} из {aiProgress.total} абзацев…
          </p>
        )}
        {aiErrors.length > 0 && (
          <ul role="alert" className="text-xs text-rose-700 dark:text-rose-400 list-disc pl-4 space-y-0.5">
            {aiErrors.slice(0, 6).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
            {aiErrors.length > 6 && <li>…и ещё {aiErrors.length - 6}</li>}
          </ul>
        )}
      </section>
    </div>
  );
};
