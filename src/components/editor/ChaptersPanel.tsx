import React, { useEffect, useMemo, useState } from 'react';
import { Check, ListChecks } from 'lucide-react';
import {
  applyDraftDetection,
  detectDraftChapters,
  type DraftChapter,
  type DraftDetection,
} from '../../engine/cleanup';

interface ChaptersPanelProps {
  draft: DraftChapter[];
  chapterIndex: number;
  /** Подсказка из вкладки «Качество»: книга состоит из одной главы */
  hint?: boolean;
  onApply: (next: DraftChapter[], label: string) => void;
}

const METHOD_LABEL: Record<string, string> = {
  outline: 'по оглавлению PDF',
  headings: 'по заголовкам в тексте',
  size: 'по размеру (заголовков не найдено)',
  none: 'главы не найдены',
};

const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors';
const btnSecondary =
  'inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium border border-slate-300 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-50 transition-colors';
const inputCls =
  'w-full rounded-lg border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-sm text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-amber-500/60';

export const ChaptersPanel: React.FC<ChaptersPanelProps> = ({ draft, chapterIndex, hint, onApply }) => {
  const [scope, setScope] = useState<'book' | 'chapter'>(draft.length === 1 ? 'book' : 'book');
  const [useTitles, setUseTitles] = useState(draft.length > 1);
  const [minChars, setMinChars] = useState(500);
  const [chunkK, setChunkK] = useState(20);
  const [bySize, setBySize] = useState(true);
  const [state, setState] = useState<{ detection: DraftDetection; source: DraftChapter[]; titles: string[] } | null>(null);

  // Предпросмотр относится к конкретному состоянию черновика
  useEffect(() => {
    if (state && state.source !== draft) setState(null);
  }, [draft, state]);

  const run = () => {
    const detection = detectDraftChapters(draft, {
      chapterIndex: scope === 'chapter' ? chapterIndex : undefined,
      useExistingTitles: useTitles,
      minChapterChars: minChars,
      fallbackChunkChars: chunkK * 1000,
      fallbackBySize: bySize,
    });
    setState({ detection, source: draft, titles: detection.result.chapters.map((c) => c.title) });
  };

  const result = state?.detection.result;
  const stats = useMemo(() => {
    if (!state) return [];
    const { flat, result: r } = state.detection;
    return r.chapters.map((c) => ({
      chars: c.items.reduce((a, i) => a + flat[i].text.length, 0),
      paragraphs: c.items.length,
      snippet: flat[c.items[0]]?.text.slice(0, 110) ?? '',
    }));
  }, [state]);

  const apply = () => {
    if (!state) return;
    onApply(applyDraftDetection(draft, state.detection, state.titles), `Главы (${state.detection.result.chapters.length})`);
    setState(null);
  };

  const unchanged =
    state && result
      ? result.chapters.length === (state.detection.range[1] - state.detection.range[0]) &&
        result.chapters.every((c, k) => c.title === draft[state.detection.range[0] + k]?.title)
      : false;

  return (
    <div className="flex flex-col gap-4">
      {hint && (
        <p role="status" className="text-sm rounded-xl border border-amber-300/70 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 px-3 py-2">
          В этой книге почти нет разделения на главы. Нажмите «Найти главы» — повторное распознавание не требуется.
        </p>
      )}
      <p className="text-sm text-slate-600 dark:text-zinc-400 leading-relaxed">
        Главы ищутся по заголовкам в тексте («Глава N», «Часть», «Введение», римские цифры, строки ЗАГЛАВНЫМИ, Markdown), а если их нет —
        книга делится на разделы «Часть N» по границам абзацев. Короткие главы склеиваются с соседними.
      </p>

      <div role="radiogroup" aria-label="Область поиска глав" className="flex flex-wrap items-center gap-4 text-sm">
        {(['book', 'chapter'] as const).map((s) => (
          <label key={s} className="inline-flex items-center gap-1.5 cursor-pointer text-slate-800 dark:text-zinc-100">
            <input
              type="radio"
              name="chapters-scope"
              checked={scope === s}
              onChange={() => {
                setScope(s);
                setState(null);
              }}
              className="accent-amber-600"
            />
            {s === 'book' ? 'Вся книга' : `Только выбранная глава`}
          </label>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <label className="flex flex-col gap-1 text-slate-700 dark:text-zinc-300">
          Мин. длина главы, симв.
          <input type="number" min={0} step={100} value={minChars} onChange={(e) => setMinChars(Math.max(0, Number(e.target.value) || 0))} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-slate-700 dark:text-zinc-300">
          Размер раздела, тыс. симв.
          <input type="number" min={3} max={200} value={chunkK} onChange={(e) => setChunkK(Math.min(200, Math.max(3, Number(e.target.value) || 20)))} className={inputCls} disabled={!bySize} />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-800 dark:text-zinc-100 cursor-pointer">
        <input type="checkbox" checked={bySize} onChange={(e) => setBySize(e.target.checked)} className="accent-amber-600" />
        Если заголовков нет — делить по размеру на «Часть N»
      </label>
      {draft.length > 1 && (
        <label className="flex items-center gap-2 text-sm text-slate-800 dark:text-zinc-100 cursor-pointer">
          <input type="checkbox" checked={useTitles} onChange={(e) => setUseTitles(e.target.checked)} className="accent-amber-600" />
          Учитывать названия существующих глав
        </label>
      )}

      <div>
        <button type="button" className={btnSecondary} onClick={run}>
          <ListChecks className="w-4 h-4" aria-hidden="true" />
          Найти главы
        </button>
      </div>

      {state && result && (
        <section aria-label="Найденные главы" className="flex flex-col gap-2">
          <p role="status" className="text-sm text-slate-700 dark:text-zinc-300">
            {result.chapters.length === 0
              ? 'Главы не найдены.'
              : `Найдено глав: ${result.chapters.length} (${METHOD_LABEL[result.method]}).${unchanged ? ' Структура не изменится.' : ''}`}
          </p>
          <ol className="flex flex-col gap-1.5 max-h-[45vh] overflow-y-auto pr-1">
            {result.chapters.map((c, k) => (
              <li key={k} className="rounded-xl border border-slate-200 dark:border-zinc-800 p-2">
                <label className="sr-only" htmlFor={`det-title-${k}`}>
                  Название главы {k + 1}
                </label>
                <input
                  id={`det-title-${k}`}
                  value={state.titles[k] ?? c.title}
                  onChange={(e) => {
                    const v = e.target.value;
                    setState((st) => (st ? { ...st, titles: st.titles.map((t, i) => (i === k ? v : t)) } : st));
                  }}
                  className={inputCls}
                />
                <p className="mt-1 text-[11px] text-slate-500 dark:text-zinc-400">
                  {stats[k]?.paragraphs} абз. · {stats[k]?.chars.toLocaleString('ru-RU')} симв.
                </p>
                {stats[k]?.snippet && <p className="text-xs text-slate-600 dark:text-zinc-400 truncate">{stats[k].snippet}</p>}
              </li>
            ))}
          </ol>
          <button type="button" className={btnPrimary} onClick={apply} disabled={result.chapters.length === 0 || Boolean(unchanged)}>
            <Check className="w-4 h-4" aria-hidden="true" />
            Применить ({result.chapters.length})
          </button>
        </section>
      )}
    </div>
  );
};
