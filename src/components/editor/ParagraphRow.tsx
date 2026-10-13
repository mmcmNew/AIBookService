import React, { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpToLine, BookPlus, Pencil, Plus, Scissors, Trash2 } from 'lucide-react';
import type { ParagraphProblem } from '../../engine/cleanup';

export interface ParagraphRowProps {
  id: string;
  text: string;
  index: number;
  total: number;
  problems: ParagraphProblem[];
  editing: boolean;
  highlighted: boolean;
  canMergePrev: boolean;
  canMergeNext: boolean;
  canStartChapter: boolean;
  onStartEdit: (index: number) => void;
  onStopEdit: () => void;
  onCommit: (index: number, text: string) => void;
  onDelete: (index: number) => void;
  onMergePrev: (index: number, text: string) => void;
  onMergeNext: (index: number, text: string) => void;
  onSplit: (index: number, text: string, offset: number) => void;
  onAddAfter: (index: number, text: string) => void;
  onNewChapter: (index: number, text: string) => void;
}

const toolBtn =
  'p-1.5 rounded-lg text-slate-500 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-100 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors';

const ParagraphRowImpl: React.FC<ParagraphRowProps> = ({
  id,
  text,
  index,
  total,
  problems,
  editing,
  highlighted,
  canMergePrev,
  canMergeNext,
  canStartChapter,
  onStartEdit,
  onStopEdit,
  onCommit,
  onDelete,
  onMergePrev,
  onMergeNext,
  onSplit,
  onAddAfter,
  onNewChapter,
}) => {
  const [value, setValue] = useState(text);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const wasEditing = useRef(false);

  // При входе в режим правки берём актуальный текст и ставим курсор в конец
  useEffect(() => {
    if (editing) {
      setValue(text);
      const area = areaRef.current;
      if (area) {
        area.focus({ preventScroll: true });
        area.setSelectionRange(area.value.length, area.value.length);
      }
    } else if (wasEditing.current) {
      // Возвращаем фокус на строку, чтобы не потерять место при навигации с клавиатуры
      viewRef.current?.focus({ preventScroll: true });
    }
    wasEditing.current = editing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Автовысота поля ввода
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight + 2}px`;
  }, [value, editing]);

  const commitAndClose = () => {
    if (value !== text) onCommit(index, value);
    onStopEdit();
  };

  const cursor = () => areaRef.current?.selectionStart ?? value.length;
  const current = () => (editing ? value : text);
  // Кнопки не должны отнимать фокус у поля ввода (иначе blur закроет правку до клика)
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  const label = `Абзац ${index + 1} из ${total}`;

  return (
    <div
      id={id}
      className={`group relative rounded-xl border px-3 py-2 transition-colors ${
        highlighted
          ? 'border-amber-500 bg-amber-50/70 dark:bg-amber-950/30 ring-2 ring-amber-400/50'
          : problems.length > 0
            ? 'border-amber-300/70 dark:border-amber-800/60 bg-amber-50/30 dark:bg-amber-950/10'
            : 'border-transparent hover:border-slate-200 dark:hover:border-zinc-800'
      } ${editing ? 'bg-white dark:bg-zinc-900 border-amber-500/60 shadow-sm' : ''}`}
    >
      <div className="flex items-start gap-2">
        <span className="select-none shrink-0 w-8 pt-0.5 text-right text-[11px] font-mono text-slate-400 dark:text-zinc-500" aria-hidden="true">
          {index + 1}
        </span>

        <div className="flex-1 min-w-0">
          {editing ? (
            <textarea
              ref={areaRef}
              value={value}
              aria-label={`Правка. ${label}`}
              spellCheck
              rows={2}
              onChange={(e) => setValue(e.target.value)}
              onBlur={commitAndClose}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  // Отмена правки абзаца: закрываем только поле, не весь редактор
                  e.stopPropagation();
                  e.preventDefault();
                  setValue(text);
                  onStopEdit();
                } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  e.stopPropagation();
                  commitAndClose();
                }
              }}
              className="w-full resize-none rounded-lg border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2.5 py-2 text-[15px] leading-relaxed text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-amber-500/60"
            />
          ) : (
            <div
              ref={viewRef}
              role="button"
              tabIndex={0}
              aria-label={`${label}. Нажмите Enter, чтобы редактировать`}
              onClick={() => onStartEdit(index)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'F2') {
                  e.preventDefault();
                  onStartEdit(index);
                }
              }}
              className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-slate-800 dark:text-zinc-200 cursor-text rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 px-0.5"
            >
              {text || <span className="italic text-slate-400 dark:text-zinc-500">Пустой абзац</span>}
            </div>
          )}

          {problems.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap gap-1" aria-label="Найденные проблемы">
              {problems.map((p) => (
                <li
                  key={p.code}
                  className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-100 dark:bg-amber-950/50 text-amber-900 dark:text-amber-300 border border-amber-300/60 dark:border-amber-800/60"
                >
                  {p.label}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Панель действий: видна при наведении, фокусе или правке */}
        <div
          role="toolbar"
          aria-label={`Действия. ${label}`}
          className={`absolute -top-3.5 right-2 z-10 flex items-center gap-0.5 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-md px-0.5 transition-opacity ${
            editing
              ? 'opacity-100'
              : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto'
          }`}
        >
          {!editing && (
            <button type="button" className={toolBtn} aria-label="Редактировать абзац" title="Редактировать (Enter)" onClick={() => onStartEdit(index)}>
              <Pencil className="w-4 h-4" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className={toolBtn}
            aria-label="Разбить абзац по курсору"
            title={editing ? 'Разбить по курсору' : 'Сначала откройте абзац для правки и поставьте курсор'}
            disabled={!editing}
            onMouseDown={keepFocus}
            onClick={() => onSplit(index, value, cursor())}
          >
            <Scissors className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={toolBtn}
            aria-label="Склеить с предыдущим абзацем"
            title="Склеить с предыдущим"
            disabled={!canMergePrev}
            onMouseDown={keepFocus}
            onClick={() => onMergePrev(index, current())}
          >
            <ArrowUpToLine className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={toolBtn}
            aria-label="Склеить со следующим абзацем"
            title="Склеить со следующим"
            disabled={!canMergeNext}
            onMouseDown={keepFocus}
            onClick={() => onMergeNext(index, current())}
          >
            <ArrowDownToLine className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={toolBtn}
            aria-label="Добавить абзац ниже"
            title="Добавить абзац ниже"
            onMouseDown={keepFocus}
            onClick={() => onAddAfter(index, current())}
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={toolBtn}
            aria-label="Начать новую главу с этого абзаца"
            title="Начать новую главу отсюда"
            disabled={!canStartChapter}
            onMouseDown={keepFocus}
            onClick={() => onNewChapter(index, current())}
          >
            <BookPlus className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`${toolBtn} hover:!text-rose-600`}
            aria-label="Удалить абзац"
            title="Удалить абзац"
            onMouseDown={keepFocus}
            onClick={() => onDelete(index)}
          >
            <Trash2 className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
};

export const ParagraphRow = memo(ParagraphRowImpl);
