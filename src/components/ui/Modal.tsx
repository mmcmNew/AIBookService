import React, { useEffect, useId, useRef } from 'react';
import { clsx } from 'clsx';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Стек открытых модалок: Esc и Tab обрабатывает только верхняя. */
const modalStack: string[] = [];

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Заголовок для скринридеров, если нет видимого заголовка с id=labelledBy */
  ariaLabel?: string;
  /** id видимого заголовка (aria-labelledby) */
  labelledBy?: string;
  describedBy?: string;
  /** Расположение панели: по центру или справа (drawer) */
  placement?: 'center' | 'right';
  closeOnBackdrop?: boolean;
  closeOnEsc?: boolean;
  role?: 'dialog' | 'alertdialog';
  panelClassName?: string;
  backdropClassName?: string;
  children: React.ReactNode;
}

const ModalInner: React.FC<Omit<ModalProps, 'isOpen'>> = ({
  onClose,
  ariaLabel,
  labelledBy,
  describedBy,
  placement = 'center',
  closeOnBackdrop = true,
  closeOnEsc = true,
  role = 'dialog',
  panelClassName,
  backdropClassName,
  children,
}) => {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeOnEscRef = useRef(closeOnEsc);
  closeOnEscRef.current = closeOnEsc;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    modalStack.push(id);

    // Фокус на первый интерактивный элемент (или на саму панель)
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      const autoFocusEl = panel.querySelector<HTMLElement>('[data-autofocus]');
      const first = autoFocusEl ?? panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus({ preventScroll: true });
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== id) return;

      if (e.key === 'Escape' && closeOnEscRef.current) {
        e.stopPropagation();
        e.preventDefault();
        onCloseRef.current();
        return;
      }

      if (e.key === 'Tab' && panelRef.current) {
        const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null || el === document.activeElement
        );
        if (items.length === 0) {
          e.preventDefault();
          panelRef.current.focus();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    // capture: чтобы перехватить Esc раньше глобальных обработчиков приложения
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const idx = modalStack.indexOf(id);
      if (idx >= 0) modalStack.splice(idx, 1);
      // Возврат фокуса на элемент, открывший окно
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [id]);

  return (
    <div
      className={clsx(
        'fixed inset-0 z-50 flex',
        placement === 'center' ? 'items-center justify-center p-4' : 'justify-end'
      )}
    >
      <div
        aria-hidden="true"
        onClick={closeOnBackdrop ? onClose : undefined}
        className={clsx('absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in', backdropClassName)}
      />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-label={labelledBy ? undefined : ariaLabel}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={clsx(
          'relative outline-none',
          placement === 'center' ? 'animate-pop-in' : 'h-full animate-slide-in-right',
          panelClassName
        )}
      >
        {children}
      </div>
    </div>
  );
};

/**
 * Доступная модалка: role="dialog", aria-modal, focus trap, закрытие по Esc/клику на фон,
 * возврат фокуса на элемент, открывший окно.
 */
export const Modal: React.FC<ModalProps> = ({ isOpen, ...rest }) => {
  if (!isOpen) return null;
  return <ModalInner {...rest} />;
};
