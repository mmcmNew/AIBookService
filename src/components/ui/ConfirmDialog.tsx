import React, { useId } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Опасное действие (удаление): красная кнопка подтверждения */
  danger?: boolean;
  isBusy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  confirmLabel = 'Подтвердить',
  cancelLabel = 'Отмена',
  danger = false,
  isBusy = false,
  onConfirm,
  onCancel,
}) => {
  const titleId = useId();
  const descId = useId();

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      role="alertdialog"
      labelledBy={titleId}
      describedBy={message ? descId : undefined}
      panelClassName="w-[calc(100vw-2rem)] max-w-sm bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl shadow-2xl p-5"
    >
      <div className="flex items-start gap-3">
        <div
          className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
            danger
              ? 'bg-rose-100 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400'
              : 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400'
          }`}
        >
          <AlertTriangle className="w-5 h-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 id={titleId} className="text-base font-bold text-slate-900 dark:text-zinc-100">
            {title}
          </h2>
          {message && (
            <p id={descId} className="mt-1 text-sm text-slate-600 dark:text-zinc-400 break-words">
              {message}
            </p>
          )}
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          data-autofocus
          onClick={onCancel}
          disabled={isBusy}
          className="px-4 py-2 rounded-xl text-sm font-medium text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={isBusy}
          className={`px-4 py-2 rounded-xl text-sm font-semibold text-white transition-colors disabled:opacity-60 ${
            danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-amber-600 hover:bg-amber-700'
          }`}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
};
