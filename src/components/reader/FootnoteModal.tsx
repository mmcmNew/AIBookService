import React, { useId } from 'react';
import { X, Info } from 'lucide-react';
import { Footnote } from '../../types/book';
import { Modal } from '../ui/Modal';

interface FootnoteModalProps {
  footnote: Footnote | null;
  onClose: () => void;
}

export const FootnoteModal: React.FC<FootnoteModalProps> = ({ footnote, onClose }) => {
  const titleId = useId();

  return (
    <Modal
      isOpen={footnote !== null}
      onClose={onClose}
      labelledBy={titleId}
      panelClassName="w-[calc(100vw-2rem)] max-w-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl shadow-2xl p-6"
    >
      {footnote && (
        <>
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-1.5 rounded-lg text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="Закрыть сноску"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-2.5 text-amber-700 dark:text-amber-500 mb-3 pr-8">
            <Info className="w-5 h-5 shrink-0" aria-hidden="true" />
            <h2 id={titleId} className="font-semibold text-base">
              {footnote.title || 'Примечание / сноска'}
            </h2>
          </div>

          <div className="text-sm text-slate-700 dark:text-zinc-300 leading-relaxed whitespace-pre-line max-h-[60vh] overflow-y-auto pr-1">
            {footnote.text}
          </div>

          <div className="mt-5 flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-xl bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-200 transition-colors"
            >
              Закрыть
            </button>
          </div>
        </>
      )}
    </Modal>
  );
};
