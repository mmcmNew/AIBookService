import React, { memo, useCallback } from 'react';
import { clsx } from 'clsx';
import { useBookStore } from '../../store/bookStore';
import { coordinator } from '../../engine/audio/coordinator';
import { SentenceItem } from '../../types/book';

/** Клик по предложению: снимаем паузу автоскролла и отдаём команду воспроизведению «играть отсюда». */
export function useSentenceJump(resume: () => void): (id: number) => void {
  const jumpToSentence = coordinator.jumpToSentence;
  return useCallback(
    (id: number) => {
      resume();
      void jumpToSentence(id);
    },
    [jumpToSentence, resume]
  );
}

/* ----------------------------- Предложение ----------------------------- */

interface SentenceProps {
  sentence: SentenceItem;
  isActive: boolean;
  onJump: (id: number) => void;
}

const Sentence = memo(({ sentence, isActive, onJump }: SentenceProps) => (
  <>
    <span
      data-sentence-id={sentence.id}
      onClick={() => onJump(sentence.id)}
      className={clsx('sentence-interactive', isActive && 'sentence-active')}
      title="Нажмите, чтобы начать воспроизведение с этого места"
    >
      {sentence.rawText}
    </span>{' '}
  </>
));
Sentence.displayName = 'Sentence';

/* ------------------------------- Параграф ------------------------------ */

interface ParagraphProps {
  sentences: SentenceItem[];
  onJump: (id: number) => void;
}

/**
 * Параграф сам подписывается на currentSentenceId, но возвращает значение только если
 * активное предложение принадлежит ему, поэтому при смене предложения перерисовываются
 * максимум два параграфа, а не вся глава.
 */
export const Paragraph = memo(({ sentences, onJump }: ParagraphProps) => {
  const activeId = useBookStore((state) => {
    const id = state.currentSentenceId;
    if (id === null) return null;
    return sentences.some((s) => s.id === id) ? id : null;
  });

  return (
    <p className="text-left md:text-justify hyphens-auto indent-6">
      {sentences.map((sentence) => (
        <Sentence key={sentence.id} sentence={sentence} isActive={sentence.id === activeId} onJump={onJump} />
      ))}
    </p>
  );
});
Paragraph.displayName = 'Paragraph';
