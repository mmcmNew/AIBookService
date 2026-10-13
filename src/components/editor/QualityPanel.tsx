import React, { useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { assessTextQuality, type CleanupOp, type DraftChapter, type QualityIssue } from '../../engine/cleanup';

interface QualityPanelProps {
  draft: DraftChapter[];
  lang: string;
  isPdf: boolean;
  pdfMode?: 'pdfjs' | 'pymupdf' | 'gemini';
  onFix: (ops: CleanupOp[]) => void;
  onOpenChapters: () => void;
  onRescan: () => void;
}

const SEVERITY_STYLE: Record<QualityIssue['severity'], string> = {
  error: 'border-rose-300 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/20 text-rose-900 dark:text-rose-200',
  warn: 'border-amber-300 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/20 text-amber-900 dark:text-amber-200',
  info: 'border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/40 text-slate-800 dark:text-zinc-200',
};

export const QualityPanel: React.FC<QualityPanelProps> = ({ draft, lang, isPdf, pdfMode, onFix, onOpenChapters, onRescan }) => {
  const report = useMemo(
    () =>
      assessTextQuality(
        draft.map((c) => ({ id: c.id, title: c.title, paragraphs: c.paragraphs.map((p) => p.text) })),
        lang,
        { isPdf, pdfMode }
      ),
    [draft, lang, isPdf, pdfMode]
  );
  const color = report.grade === 'good' ? 'text-emerald-600 dark:text-emerald-400' : report.grade === 'fair' ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <span className={`text-4xl font-bold tabular-nums ${color}`} aria-label={`Оценка качества ${report.score} из 100`}>
          {report.score}
        </span>
        <span className="text-sm text-slate-600 dark:text-zinc-400">из 100 · {report.summary}</span>
      </div>
      <p className="text-xs text-slate-500 dark:text-zinc-400">
        {report.metrics.chapters} гл. · {report.metrics.paragraphs.toLocaleString('ru-RU')} абз. · {report.metrics.words.toLocaleString('ru-RU')} слов. Оценка
        пересчитывается по мере правок.
      </p>

      {report.recommendation && (
        <p role="status" className="text-sm rounded-xl border border-amber-300/70 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 px-3 py-2">
          {report.recommendation}
        </p>
      )}

      {report.issues.length === 0 ? (
        <p className="text-sm text-emerald-700 dark:text-emerald-400">Проблем не найдено.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {report.issues.map((issue) => (
            <li key={issue.code} className={`rounded-xl border px-3 py-2 text-sm ${SEVERITY_STYLE[issue.severity]}`}>
              <p className="leading-snug">{issue.message}</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {issue.fixOps.length > 0 && (
                  <button
                    type="button"
                    onClick={() => onFix(issue.fixOps)}
                    className="text-xs font-semibold px-2.5 py-1 rounded-lg bg-white/70 dark:bg-zinc-900/60 border border-current/30 hover:bg-white dark:hover:bg-zinc-900"
                  >
                    Исправить…
                  </button>
                )}
                {issue.tool === 'chapters' && (
                  <button
                    type="button"
                    onClick={onOpenChapters}
                    className="text-xs font-semibold px-2.5 py-1 rounded-lg bg-white/70 dark:bg-zinc-900/60 border border-current/30 hover:bg-white dark:hover:bg-zinc-900"
                  >
                    Определить главы…
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {isPdf && (
        <button
          type="button"
          onClick={onRescan}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium border border-slate-300 dark:border-zinc-700 text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800"
        >
          <RefreshCw className="w-4 h-4" aria-hidden="true" />
          Пересканировать другим режимом (PDF.js / PyMuPDF / Gemini)
        </button>
      )}
    </div>
  );
};
