import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastOptions {
  /** Время показа, мс. 0 — не скрывать автоматически */
  duration?: number;
  /** Необязательная кнопка действия (например, «Отменить») */
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastItem extends ToastOptions {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface ToastApi {
  show: (message: string, kind?: ToastKind, options?: ToastOptions) => number;
  success: (message: string, options?: ToastOptions) => number;
  error: (message: string, options?: ToastOptions) => number;
  info: (message: string, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const noop = () => 0;
const fallbackApi: ToastApi = { show: noop, success: noop, error: noop, info: noop, dismiss: () => undefined };

const ToastContext = createContext<ToastApi>(fallbackApi);

/** Хук для показа уведомлений из любого компонента внутри <ToastProvider>. */
export const useToast = (): ToastApi => useContext(ToastContext);

const DEFAULT_DURATION: Record<ToastKind, number> = { success: 3500, info: 4500, error: 8000 };
const MAX_TOASTS = 4;

const kindStyles: Record<ToastKind, { box: string; icon: React.ReactNode }> = {
  success: {
    box: 'border-emerald-300 dark:border-emerald-800 text-emerald-900 dark:text-emerald-100',
    icon: <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden="true" />,
  },
  error: {
    box: 'border-rose-300 dark:border-rose-800 text-rose-900 dark:text-rose-100',
    icon: <AlertCircle className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0" aria-hidden="true" />,
  },
  info: {
    box: 'border-slate-300 dark:border-zinc-700 text-slate-900 dark:text-zinc-100',
    icon: <Info className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" aria-hidden="true" />,
  },
};

const ToastView: React.FC<{ item: ToastItem; onDismiss: (id: number) => void }> = ({ item, onDismiss }) => {
  const { id, kind, message, duration, actionLabel, onAction } = item;
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const ms = duration ?? DEFAULT_DURATION[kind];
    if (!ms || paused) return;
    const timer = window.setTimeout(() => onDismiss(id), ms);
    return () => window.clearTimeout(timer);
  }, [id, kind, duration, paused, onDismiss]);

  const style = kindStyles[kind];

  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={`pointer-events-auto flex items-start gap-3 w-full max-w-md rounded-2xl border bg-white dark:bg-zinc-900 shadow-xl px-4 py-3 text-sm animate-slide-up ${style.box}`}
    >
      {style.icon}
      <div className="flex-1 min-w-0 break-words leading-snug pt-0.5">{message}</div>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={() => {
            onAction();
            onDismiss(id);
          }}
          className="shrink-0 px-2 py-0.5 rounded-lg text-xs font-semibold text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-950/40"
        >
          {actionLabel}
        </button>
      )}
      <button
        type="button"
        onClick={() => onDismiss(id)}
        aria-label="Закрыть уведомление"
        className="shrink-0 p-0.5 rounded-lg text-slate-500 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-100 hover:bg-slate-100 dark:hover:bg-zinc-800"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((message: string, kind: ToastKind = 'info', options?: ToastOptions) => {
    const id = ++counter.current;
    setToasts((list) => [...list, { id, kind, message, ...options }].slice(-MAX_TOASTS));
    return id;
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      success: (m, o) => show(m, 'success', o),
      error: (m, o) => show(m, 'error', o),
      info: (m, o) => show(m, 'info', o),
    }),
    [show, dismiss]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* z-[60]: выше модалок (z-50), чтобы ошибки были видны поверх окон */}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <ToastView key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
};
