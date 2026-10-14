import React, { useEffect } from 'react';
import { ControlBar, type ControlBarProps } from './ControlBar';
import { coordinator } from '../../engine/audio/coordinator';
import { useAudioStore } from '../../store/audioStore';
import { useBookStore } from '../../store/bookStore';

/** Элементы, у которых Space/Enter/стрелки имеют собственный смысл — горячие клавиши плеера их не перехватывают. */
const isInteractiveTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'SUMMARY'].includes(target.tagName)) return true;
  return Boolean(target.closest('[role="button"], [role="tab"], [role="slider"], [role="switch"], [role="menuitem"], [role="checkbox"]'));
};

/**
 * Панель плеера вместе с её горячими клавишами: Space — play/пауза, стрелки — предыдущая/следующая фраза.
 * Команды уходят Координатору, статус плеера читается здесь же; оболочка приложения горячих клавиш не знает.
 */
export const PlayerHotkeys: React.FC<ControlBarProps> = (props) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (isInteractiveTarget(e.target) && e.code === 'Space') return;
      if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      // Пока открыто модальное окно, горячие клавиши плеера отключены
      if (document.querySelector('[aria-modal="true"]')) return;
      if (!useBookStore.getState().currentBook) return;

      const audio = useAudioStore.getState();
      if (e.code === 'Space') {
        e.preventDefault();
        if (e.repeat) return;
        if (audio.isPlaying && !audio.isPaused) coordinator.pause();
        else if (audio.isPlaying && audio.isPaused) coordinator.resume();
        else void coordinator.play();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        void coordinator.playNextSentence();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        void coordinator.playPrevSentence();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return <ControlBar {...props} />;
};
