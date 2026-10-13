import { useEffect } from 'react';
import { useBookStore } from '../../store/bookStore';
import { useToast } from '../ui/Toast';

/**
 * Неблокирующее уведомление о низком качестве распознавания после импорта/перераспознавания книги.
 * Действие «Исправить» открывает редактор.
 */
export function QualityWatcher({ onOpenEditor }: { onOpenEditor: (tab?: 'quality' | 'chapters') => void }): null {
  const notice = useBookStore((s) => s.qualityNotice);
  const clear = useBookStore((s) => s.clearQualityNotice);
  const toast = useToast();

  useEffect(() => {
    if (!notice) return;
    const { quality } = notice;
    const single = quality.issueCodes.includes('SINGLE_CHAPTER');
    const message =
      `«${notice.title}»: ${quality.summary.toLowerCase()}. ` +
      (quality.recommendation ?? (single ? 'Главы не определились — откройте редактор.' : 'Откройте редактор, чтобы исправить текст.'));
    toast.info(message, { duration: 15000, actionLabel: 'Исправить', onAction: () => onOpenEditor(single && quality.issueCodes.length === 1 ? 'chapters' : 'quality') });
    clear();
  }, [notice, clear, toast, onOpenEditor]);

  return null;
}
