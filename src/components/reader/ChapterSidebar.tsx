import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { X, BookOpen, Check, Search } from 'lucide-react';
import { useBookStore } from '../../store/bookStore';
import { selectChapter } from '../../engine/library';
import { Modal } from '../ui/Modal';
import { useMediaQuery } from '../ui/useMediaQuery';
import { clsx } from 'clsx';

interface ChapterSidebarProps {
  onClose: () => void;
}

interface PanelProps {
  titleId: string;
  onClose: () => void;
  /** Закрывать панель после выбора главы (мобильный drawer) */
  closeOnSelect: boolean;
}

/** Содержимое панели глав: заголовок, поиск, список. */
const ChapterPanel: React.FC<PanelProps> = ({ titleId, onClose, closeOnSelect }) => {
  const currentBook = useBookStore((state) => state.currentBook);
  const currentChapterIndex = useBookStore((state) => state.currentChapterIndex);
  const [search, setSearch] = useState('');
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const chapters = currentBook?.chapters;

  const filteredChapters = useMemo(() => {
    if (!chapters) return [];
    const q = search.trim().toLowerCase();
    return chapters
      .map((chapter, originalIndex) => ({ chapter, originalIndex }))
      .filter(({ chapter }) => !q || chapter.title.toLowerCase().includes(q));
  }, [chapters, search]);

  // При открытии показываем текущую главу в списке
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'center' });
  }, []);

  if (!currentBook) return null;

  return (
    <>
      <div className="p-3.5 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
        <h2 id={titleId} className="flex items-center gap-2 text-slate-800 dark:text-zinc-100 font-semibold text-sm">
          <BookOpen className="w-4 h-4 text-amber-600 dark:text-amber-500" aria-hidden="true" />
          <span>Оглавление ({currentBook.chapters.length})</span>
        </h2>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
          aria-label="Закрыть оглавление"
          title="Закрыть оглавление"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Поиск по главам (если глав больше 5) */}
      {currentBook.chapters.length > 5 && (
        <div className="px-3 pt-2.5 pb-1">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden="true" />
            <input
              type="search"
              placeholder="Поиск по главам..."
              aria-label="Поиск по главам"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-sm rounded-xl bg-slate-100 dark:bg-zinc-800 border border-transparent focus:border-amber-500 text-slate-800 dark:text-zinc-100 placeholder:text-slate-500 dark:placeholder:text-zinc-500"
            />
          </div>
        </div>
      )}

      {currentBook.metadata.paged && (
        <p className="px-3.5 pb-1 text-[11px] text-slate-500 dark:text-zinc-400">
          Содержание достраивается по мере распознавания страниц.
        </p>
      )}

      {/* Список глав */}
      <nav aria-labelledby={titleId} className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredChapters.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-slate-500 dark:text-zinc-400">Главы не найдены</p>
        )}
        {filteredChapters.map(({ chapter, originalIndex }) => {
          const isActive = originalIndex === currentChapterIndex;
          return (
            <button
              key={chapter.id}
              ref={isActive ? activeRef : null}
              aria-current={isActive ? 'true' : undefined}
              onClick={() => {
                selectChapter(originalIndex);
                if (closeOnSelect) onClose();
              }}
              className={clsx(
                'w-full text-left px-3 py-2 rounded-xl text-sm transition-colors flex items-center justify-between group',
                isActive
                  ? 'bg-amber-600 text-white font-medium shadow-sm'
                  : 'text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800'
              )}
              style={{ paddingLeft: `${Math.min(64, Math.max(12, (chapter.level || 1) * 14))}px` }}
              title={chapter.title}
            >
              <span className={clsx('truncate pr-2', chapter.stub && !isActive && 'italic text-slate-500 dark:text-zinc-400')}>{chapter.title}</span>
              {chapter.startPage !== undefined && (
                <span
                  className={clsx('ml-auto shrink-0 text-[10px] tabular-nums', isActive ? 'text-amber-100' : 'text-slate-400 dark:text-zinc-500')}
                  title={chapter.stub ? 'Страницы главы ещё не распознаны' : `Распознано страниц: ${chapter.pagesDone ?? 0} из ${chapter.pagesTotal ?? 0}`}
                >
                  {chapter.stub
                    ? 'ещё не распознана · '
                    : chapter.pagesTotal && (chapter.pagesDone ?? 0) < chapter.pagesTotal
                      ? `${chapter.pagesDone}/${chapter.pagesTotal} · `
                      : ''}
                  стр. {chapter.startPage}
                </span>
              )}
              {isActive && <Check className="w-3.5 h-3.5 shrink-0 ml-1" aria-hidden="true" />}
            </button>
          );
        })}
      </nav>
    </>
  );
};

/**
 * Оглавление: на широких экранах — закреплённая панель справа,
 * на узких (< md) — выезжающий drawer поверх текста с затемнением.
 */
export const ChapterSidebar: React.FC<ChapterSidebarProps> = ({ onClose }) => {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const titleId = useId();

  if (isDesktop) {
    return (
      <aside
        aria-labelledby={titleId}
        className="w-80 shrink-0 h-full border-l border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex flex-col z-20 select-none animate-slide-in-right"
      >
        <ChapterPanel titleId={titleId} onClose={onClose} closeOnSelect={false} />
      </aside>
    );
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      placement="right"
      labelledBy={titleId}
      backdropClassName="bg-black/40"
      panelClassName="w-[min(20rem,calc(100vw-3rem))] h-full bg-white dark:bg-zinc-900 border-l border-slate-200 dark:border-zinc-800 shadow-2xl flex flex-col select-none"
    >
      <ChapterPanel titleId={titleId} onClose={onClose} closeOnSelect />
    </Modal>
  );
};
