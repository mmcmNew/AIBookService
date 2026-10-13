import React, { useMemo } from 'react';
import { wordDiff } from '../../engine/cleanup';

/** «Было / Стало» с подсветкой различий. */
export const DiffView: React.FC<{ before: string; after: string }> = ({ before, after }) => {
  const parts = useMemo(() => wordDiff(before, after), [before, after]);
  return (
    <div className="grid gap-1.5 text-[13px] leading-relaxed">
      <div className="rounded-lg border border-rose-200/70 dark:border-rose-900/50 bg-rose-50/50 dark:bg-rose-950/20 px-2.5 py-1.5">
        <span className="block text-[10px] uppercase tracking-wide text-rose-700 dark:text-rose-400 font-semibold mb-0.5">Было</span>
        <p className="whitespace-pre-wrap break-words text-slate-800 dark:text-zinc-200">
          {parts
            .filter((p) => p.kind !== 'ins')
            .map((p, i) =>
              p.kind === 'del' ? (
                <del key={i} className="bg-rose-200/80 dark:bg-rose-900/60 text-rose-900 dark:text-rose-200 no-underline rounded-sm px-0.5">
                  {p.text}
                </del>
              ) : (
                <span key={i}>{p.text}</span>
              )
            )}
        </p>
      </div>
      <div className="rounded-lg border border-emerald-200/70 dark:border-emerald-900/50 bg-emerald-50/50 dark:bg-emerald-950/20 px-2.5 py-1.5">
        <span className="block text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-400 font-semibold mb-0.5">Стало</span>
        <p className="whitespace-pre-wrap break-words text-slate-800 dark:text-zinc-200">
          {after === '' ? (
            <em className="text-slate-500 dark:text-zinc-400">(абзац удаляется)</em>
          ) : (
            parts
              .filter((p) => p.kind !== 'del')
              .map((p, i) =>
                p.kind === 'ins' ? (
                  <ins key={i} className="bg-emerald-200/80 dark:bg-emerald-900/60 text-emerald-900 dark:text-emerald-200 no-underline rounded-sm px-0.5">
                    {p.text}
                  </ins>
                ) : (
                  <span key={i}>{p.text}</span>
                )
              )
          )}
        </p>
      </div>
    </div>
  );
};
