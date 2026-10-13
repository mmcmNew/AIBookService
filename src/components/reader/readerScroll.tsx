import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LocateFixed } from 'lucide-react';
import { useAudioStore } from '../../store/audioStore';
import { useSettingsStore } from '../../store/settingsStore';

export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const MANUAL_SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown']); // Пробел в приложении — пауза/пуск, не прокрутка

/** Озвучка реально идёт (или готовит следующую фразу): status ∈ {loading, playing}. На паузе/в idle/error — false. */
export function useIsReading(): boolean {
  return useAudioStore((s) => s.status === 'loading' || s.status === 'playing');
}

interface AutoscrollOptions {
  /** Элемент текущего читаемого предложения (для авто-возврата, когда он снова в зоне видимости) */
  getActive?: () => HTMLElement | null;
}

/**
 * Автопрокрутка следует за озвучкой ТОЛЬКО когда status ∈ {loading, playing}, settings.autoscroll
 * включена и пользователь не прокручивал текст вручную. В idle/paused/error автоскролла нет
 * (исключение — однократное позиционирование при открытии, смене главы, клике и стрелках; оно делается в самих видах).
 *
 * Ручную прокрутку определяем ТОЛЬКО по пользовательским событиям ввода (wheel, touchstart/move,
 * нажатие на полосу прокрутки, клавиши навигации) — события scroll для детекции не используются,
 * поэтому программный smooth-scroll никогда не принимается за ручной. Таймеров нет.
 * Подавление снимается: кнопкой «Вернуться к озвучке», кликом по предложению, сменой главы,
 * повторным включением автопрокрутки, новым запуском/возобновлением озвучки
 * или когда пользователь сам вернул читаемое предложение в зону видимости.
 */
export function useAutoscrollPause(
  container: React.RefObject<HTMLElement | null>,
  resetKey?: unknown,
  options: AutoscrollOptions = {}
) {
  const [paused, setPaused] = useState(false);
  const getActiveRef = useRef(options.getActive);
  getActiveRef.current = options.getActive;
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  const reading = useIsReading();
  const autoscroll = useSettingsStore((s) => s.autoscroll);

  useEffect(() => {
    const el = container.current;
    if (!el) return;

    const isReadingNow = () => {
      const st = useAudioStore.getState().status;
      return st === 'loading' || st === 'playing';
    };

    const manual = () => {
      // Если озвучка не идёт — подавлять нечего, пользователь свободно скроллит
      if (!isReadingNow()) return;
      // Прерываем идущий программный smooth-scroll, чтобы он не «дотягивал» страницу против пользователя
      if (!pausedRef.current) el.scrollTo({ top: el.scrollTop, left: el.scrollLeft, behavior: 'auto' });
      setPaused(true);
    };
    const onPointerDown = (e: PointerEvent) => {
      // Нажатие на полосу прокрутки (вне клиентской области контейнера)
      const rect = el.getBoundingClientRect();
      const onVBar = e.clientX >= rect.left + el.clientWidth && e.clientX <= rect.right;
      const onHBar = e.clientY >= rect.top + el.clientHeight && e.clientY <= rect.bottom;
      if (e.target === el && (onVBar || onHBar)) manual();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!MANUAL_SCROLL_KEYS.has(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName))) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      manual();
    };
    // Автовозврат: пользователь сам прокрутил так, что читаемое предложение снова в зоне видимости
    const onScroll = () => {
      if (!pausedRef.current || !isReadingNow() || !useSettingsStore.getState().autoscroll) return;
      const active = getActiveRef.current?.();
      if (active && isInComfortZone(el, active)) setPaused(false);
    };

    el.addEventListener('wheel', manual, { passive: true });
    el.addEventListener('touchstart', manual, { passive: true });
    el.addEventListener('touchmove', manual, { passive: true });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      el.removeEventListener('wheel', manual);
      el.removeEventListener('touchstart', manual);
      el.removeEventListener('touchmove', manual);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [container]);

  // Новая глава / книга — снова следуем за озвучкой
  useEffect(() => {
    setPaused(false);
  }, [resetKey]);

  // Включили автопрокрутку заново — следуем сразу
  useEffect(() => {
    if (autoscroll) setPaused(false);
  }, [autoscroll]);

  // Озвучка (пере)запущена после idle/паузы/ошибки — снова следуем; пока она идёт, флаг сохраняется
  useEffect(() => {
    if (reading) setPaused(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reading]);

  const resume = useCallback(() => setPaused(false), []);
  return { paused, resume };
}

/**
 * Однократное позиционирование к элементу, только если он вне видимой области
 * (клик/стрелки при остановленной озвучке). Ничего не делает, если элемент уже на виду.
 */
export function ensureVisible(container: HTMLElement, target: HTMLElement): void {
  const cr = container.getBoundingClientRect();
  const tr = target.getBoundingClientRect();
  const big = tr.height > container.clientHeight * 0.5;
  const visible = big
    ? tr.bottom > cr.top && tr.top < cr.top + container.clientHeight
    : tr.top >= cr.top && tr.bottom <= cr.top + container.clientHeight;
  if (!visible) scrollIntoComfortZone(container, target, { force: true });
}

function isInComfortZone(container: HTMLElement, target: HTMLElement): boolean {
  const cr = container.getBoundingClientRect();
  const tr = target.getBoundingClientRect();
  const height = container.clientHeight;
  const relTop = tr.top - cr.top;
  const relBottom = tr.bottom - cr.top;
  return relTop >= height * 0.12 && relBottom <= height * 0.72;
}

/**
 * Прокрутка к элементу только если он вышел из «комфортной зоны» (12%–72% высоты области).
 * Это убирает дёрганье: лёгкие смещения подсветки не вызывают скролл.
 */
export function scrollIntoComfortZone(
  container: HTMLElement,
  target: HTMLElement,
  options: { force?: boolean; instant?: boolean } = {}
): void {
  const cr = container.getBoundingClientRect();
  const tr = target.getBoundingClientRect();
  const height = container.clientHeight;
  const relTop = tr.top - cr.top;
  const relBottom = tr.bottom - cr.top;

  if (!options.force && relTop >= height * 0.12 && relBottom <= height * 0.72) return;

  const tall = tr.height > height * 0.5;
  const desiredTop = tall ? height * 0.12 : height * 0.35;
  const top = Math.max(0, container.scrollTop + relTop - desiredTop);
  container.scrollTo({
    top,
    behavior: options.instant || prefersReducedMotion() ? 'auto' : 'smooth',
  });
}

interface ResumeButtonProps {
  visible: boolean;
  onClick: () => void;
}

/** Плавающая кнопка «Вернуться к озвучке» после ручной прокрутки. */
export const ResumeAutoscrollButton: React.FC<ResumeButtonProps> = ({ visible, onClick }) => {
  if (!visible) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-4 inset-x-0 mx-auto w-fit z-30 flex items-center gap-2 px-4 py-2.5 rounded-full bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold shadow-lg shadow-black/20 animate-slide-up"
    >
      <LocateFixed className="w-4 h-4" aria-hidden="true" />
      <span>Вернуться к озвучке</span>
    </button>
  );
};
