import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { ChevronLeft, ChevronRight, Bookmark, FileWarning } from 'lucide-react';
import { useBookStore } from '../../store/bookStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useAudioStore } from '../../store/audioStore';
import { SentenceItem } from '../../types/book';
import { clsx } from 'clsx';
import { ResumeAutoscrollButton, ensureVisible, scrollIntoComfortZone, useAutoscrollPause, useIsReading } from './readerScroll';

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

/* --------------------------- Текст всей главы -------------------------- */

const ChapterText = memo(({ sentences, onJump }: { sentences: SentenceItem[]; onJump: (id: number) => void }) => {
  const paragraphs = useMemo(() => {
    const map = new Map<number, SentenceItem[]>();
    for (const sentence of sentences) {
      const list = map.get(sentence.paragraphIndex);
      if (list) list.push(sentence);
      else map.set(sentence.paragraphIndex, [sentence]);
    }
    return Array.from(map.entries());
  }, [sentences]);

  return (
    <div className="space-y-5">
      {paragraphs.map(([pIndex, list]) => (
        <Paragraph key={pIndex} sentences={list} onJump={onJump} />
      ))}
    </div>
  );
});
ChapterText.displayName = 'ChapterText';

/* ------------------------------ Основной вид --------------------------- */

export const BookView: React.FC = () => {
  const currentBook = useBookStore((state) => state.currentBook);
  const currentChapterIndex = useBookStore((state) => state.currentChapterIndex);
  const setChapterIndex = useBookStore((state) => state.setChapterIndex);
  const currentSentenceId = useBookStore((state) => state.currentSentenceId);
  const jumpToSentence = useAudioStore((state) => state.jumpToSentence);

  const fontFamily = useSettingsStore((state) => state.fontFamily);
  const fontSize = useSettingsStore((state) => state.fontSize);
  const lineHeight = useSettingsStore((state) => state.lineHeight);
  const autoscroll = useSettingsStore((state) => state.autoscroll);

  const mainScrollRef = useRef<HTMLElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);

  const chapter = currentBook?.chapters[currentChapterIndex];
  const bookId = currentBook?.metadata.id;

  const findActiveElement = useCallback((): HTMLElement | null => {
    const id = useBookStore.getState().currentSentenceId;
    if (id === null || !textRef.current) return null;
    return textRef.current.querySelector<HTMLElement>(`[data-sentence-id="${id}"]`);
  }, []);

  const { paused, resume } = useAutoscrollPause(mainScrollRef, `${bookId}:${currentChapterIndex}`, {
    getActive: findActiveElement,
  });
  const reading = useIsReading();
  const readingRef = useRef(reading);
  readingRef.current = reading;

  // Клик по предложению — пользователь явно хочет читать отсюда: снимаем паузу автоскролла
  const handleJump = useCallback(
    (id: number) => {
      resume();
      void jumpToSentence(id);
    },
    [jumpToSentence, resume]
  );

  // Позиция при открытии книги / смене главы: сразу показываем сохранённое место (без анимации)
  useLayoutEffect(() => {
    const container = mainScrollRef.current;
    if (!container) return;
    const active = findActiveElement();
    const firstId = chapter?.sentences[0]?.id;
    const activeId = useBookStore.getState().currentSentenceId;
    if (active && activeId !== firstId) {
      scrollIntoComfortZone(container, active, { force: true, instant: true });
    } else {
      container.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, [bookId, currentChapterIndex, chapter, findActiveElement]);

  // Автоскролл к читаемому предложению: только пока status ∈ {loading, playing},
  // автопрокрутка включена и пользователь не прокручивал вручную.
  useEffect(() => {
    if (!reading || !autoscroll || paused) return;
    const container = mainScrollRef.current;
    const active = findActiveElement();
    if (container && active) scrollIntoComfortZone(container, active);
  }, [currentSentenceId, reading, autoscroll, paused, findActiveElement]);

  // Озвучка не идёт (idle/пауза/ошибка): смена предложения — это клик или стрелки пользователя,
  // позиционируем один раз и только если предложение вне экрана. Постоянного слежения нет.
  useEffect(() => {
    if (readingRef.current) return;
    const container = mainScrollRef.current;
    const active = findActiveElement();
    if (container && active) ensureVisible(container, active);
  }, [currentSentenceId, findActiveElement]);

  const handleResume = useCallback(() => {
    resume();
    const container = mainScrollRef.current;
    const active = findActiveElement();
    if (container && active) scrollIntoComfortZone(container, active, { force: true });
  }, [resume, findActiveElement]);

  if (!currentBook || !chapter) return null;

  const totalChapters = currentBook.chapters.length;
  const prevChapter = currentChapterIndex > 0 ? currentBook.chapters[currentChapterIndex - 1] : null;
  const nextChapter = currentChapterIndex < totalChapters - 1 ? currentBook.chapters[currentChapterIndex + 1] : null;

  const fontClass = fontFamily === 'serif' ? 'font-serif' : fontFamily === 'mono' ? 'font-mono' : 'font-sans';

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <main
        ref={mainScrollRef}
        tabIndex={0}
        aria-label="Текст книги"
        className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-8 md:py-12 flex flex-col items-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500"
      >
        <div
          className={clsx('w-full max-w-3xl min-w-0', fontClass)}
          style={{
            fontSize: `${fontSize}px`,
            lineHeight: lineHeight,
            overflowWrap: 'anywhere',
          }}
        >
          {/* Номер и заголовок текущей главы */}
          <div className="mb-8 border-b pb-4 border-slate-200 dark:border-zinc-800">
            <div className="text-xs uppercase tracking-wider font-semibold text-amber-700 dark:text-amber-500 mb-1 font-sans">
              Глава {currentChapterIndex + 1} из {totalChapters}
            </div>
            <h1 className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-zinc-100 font-sans tracking-tight">
              {chapter.title}
            </h1>
          </div>

          {/* Параграфы с караоке-предложениями */}
          <div ref={textRef}>
            {chapter.sentences.length > 0 ? (
              <ChapterText sentences={chapter.sentences} onJump={handleJump} />
            ) : (
              <div className="flex flex-col items-center text-center gap-2 py-12 text-slate-500 dark:text-zinc-400 font-sans text-sm">
                <FileWarning className="w-8 h-8" aria-hidden="true" />
                <p>В этой главе нет текста для чтения.</p>
              </div>
            )}
          </div>

          {/* Блок навигации между главами внизу текста */}
          <nav
            aria-label="Навигация по главам"
            className="mt-14 pt-8 border-t border-slate-200 dark:border-zinc-800 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 font-sans select-none pb-10"
          >
            {prevChapter ? (
              <button
                onClick={() => setChapterIndex(currentChapterIndex - 1)}
                className="min-w-0 w-full sm:w-auto sm:max-w-[48%] flex items-center gap-2 px-4 py-3 rounded-2xl border border-slate-200 dark:border-zinc-700 hover:border-amber-500 hover:bg-slate-50 dark:hover:bg-zinc-800/80 transition-all text-left text-xs md:text-sm group"
              >
                <ChevronLeft className="w-5 h-5 text-amber-600 dark:text-amber-500 group-hover:-translate-x-0.5 transition-transform shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <span className="block text-[10px] uppercase font-bold text-slate-500 dark:text-zinc-400">Предыдущая глава</span>
                  <span className="block font-semibold text-slate-800 dark:text-zinc-200 truncate">{prevChapter.title}</span>
                </div>
              </button>
            ) : (
              <div className="hidden sm:block" />
            )}

            {nextChapter ? (
              <button
                onClick={() => setChapterIndex(currentChapterIndex + 1)}
                className="min-w-0 w-full sm:w-auto sm:max-w-[48%] flex items-center justify-between sm:justify-end gap-2 px-4 py-3 rounded-2xl bg-amber-600 hover:bg-amber-700 text-white shadow-md shadow-amber-600/20 transition-all text-right text-xs md:text-sm group"
              >
                <div className="min-w-0 text-left sm:text-right">
                  <span className="block text-[10px] uppercase font-bold text-amber-100">Следующая глава</span>
                  <span className="block font-semibold truncate">{nextChapter.title}</span>
                </div>
                <ChevronRight className="w-5 h-5 group-hover:translate-x-0.5 transition-transform shrink-0" aria-hidden="true" />
              </button>
            ) : (
              <div className="flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/20 px-4 py-3 rounded-2xl border border-emerald-200 dark:border-emerald-800">
                <Bookmark className="w-4 h-4" aria-hidden="true" />
                <span>Вы дочитали книгу до конца!</span>
              </div>
            )}
          </nav>
        </div>
      </main>

      <ResumeAutoscrollButton visible={autoscroll && paused && reading && currentSentenceId !== null} onClick={handleResume} />
    </div>
  );
};
