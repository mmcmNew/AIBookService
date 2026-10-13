import React, { useEffect, useMemo, useState } from 'react';
import { Replace } from 'lucide-react';
import { buildMatcher, findInDraft, replaceInDraft } from '../../engine/cleanup/draftOps';
import type { DraftChapter } from '../../engine/cleanup';

interface SearchPanelProps {
  draft: DraftChapter[];
  chapterIndex: number;
  onJump: (chapterIndex: number, paragraphIndex: number) => void;
  onReplace: (next: DraftChapter[], replaced: number) => void;
}

const inputCls =
  'w-full rounded-lg border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2.5 py-1.5 text-sm text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-amber-500/60';

export const SearchPanel: React.FC<SearchPanelProps> = ({ draft, chapterIndex, onJump, onReplace }) => {
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [scope, setScope] = useState<'book' | 'chapter'>('book');
  const [debounced, setDebounced] = useState({ find, regex, caseSensitive });

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced({ find, regex, caseSensitive }), 200);
    return () => window.clearTimeout(t);
  }, [find, regex, caseSensitive]);

  const built = useMemo(
    () => buildMatcher({ find: debounced.find, replace, regex: debounced.regex, caseSensitive: debounced.caseSensitive }),
    [debounced, replace]
  );
  const chapters = scope === 'chapter' ? [chapterIndex] : undefined;
  const found = useMemo(
    () => (built.matcher ? findInDraft(draft, built.matcher, chapters, 100) : null),
    [built, draft, chapterIndex, scope] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const doReplace = () => {
    if (!built.matcher) return;
    const r = replaceInDraft(draft, built.matcher, chapters);
    if (r.replaced > 0) onReplace(r.draft, r.replaced);
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <label htmlFor="se-find" className="block text-xs font-semibold text-slate-500 dark:text-zinc-400 mb-1">
          Найти
        </label>
        <input id="se-find" value={find} onChange={(e) => setFind(e.target.value)} className={inputCls} autoComplete="off" spellCheck={false} />
      </div>
      <div>
        <label htmlFor="se-replace" className="block text-xs font-semibold text-slate-500 dark:text-zinc-400 mb-1">
          Заменить на {regex && <span className="font-normal">($1, $&amp; — группы)</span>}
        </label>
        <input id="se-replace" value={replace} onChange={(e) => setReplace(e.target.value)} className={inputCls} autoComplete="off" spellCheck={false} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-800 dark:text-zinc-100">
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} className="accent-amber-600" />
          Регулярное выражение
        </label>
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} className="accent-amber-600" />
          Учитывать регистр
        </label>
      </div>
      <div role="radiogroup" aria-label="Область замены" className="flex gap-4 text-sm text-slate-800 dark:text-zinc-100">
        {(['book', 'chapter'] as const).map((s) => (
          <label key={s} className="inline-flex items-center gap-1.5 cursor-pointer">
            <input type="radio" name="search-scope" checked={scope === s} onChange={() => setScope(s)} className="accent-amber-600" />
            {s === 'book' ? 'Вся книга' : 'Выбранная глава'}
          </label>
        ))}
      </div>

      {find && built.error && (
        <p role="alert" className="text-xs text-rose-700 dark:text-rose-400">
          {built.error}
        </p>
      )}
      {found && (
        <p role="status" className="text-sm text-slate-700 dark:text-zinc-300">
          {found.total === 0 ? 'Совпадений нет.' : `Совпадений: ${found.total} в ${found.hits.length}${found.truncated ? '+' : ''} абзацах.`}
        </p>
      )}

      <button
        type="button"
        onClick={doReplace}
        disabled={!found || found.total === 0}
        className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        <Replace className="w-4 h-4" aria-hidden="true" />
        Заменить всё{found && found.total > 0 ? ` (${found.total})` : ''}
      </button>

      {found && found.hits.length > 0 && (
        <ul className="flex flex-col gap-1 max-h-[40vh] overflow-y-auto" aria-label="Найденные места">
          {found.hits.map((h) => (
            <li key={`${h.chapterIndex}:${h.paragraphIndex}`}>
              <button
                type="button"
                onClick={() => onJump(h.chapterIndex, h.paragraphIndex)}
                className="w-full text-left rounded-lg border border-slate-200 dark:border-zinc-800 px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-zinc-800/60"
              >
                <span className="block text-[11px] text-slate-500 dark:text-zinc-400 truncate">
                  {draft[h.chapterIndex]?.title} · абзац {h.paragraphIndex + 1}
                  {h.count > 1 ? ` · ${h.count} совп.` : ''}
                </span>
                <span className="block text-xs text-slate-800 dark:text-zinc-200 break-words">{h.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
