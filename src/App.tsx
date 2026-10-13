import React, { useState, useEffect, useCallback } from 'react';
import { Header } from './components/layout/Header';
import { LibraryView } from './components/library/LibraryView';
import { BookView } from './components/reader/BookView';
import { PdfBookView } from './components/reader/PdfBookView';
import { PagedTextView } from './components/reader/PagedTextView';
import { PagedBookBar } from './components/reader/PagedBookBar';
import { ControlBar } from './components/player/ControlBar';
import { ChapterSidebar } from './components/reader/ChapterSidebar';
import { FootnoteModal } from './components/reader/FootnoteModal';
import { DictionaryModal } from './components/dictionary/DictionaryModal';
import { SettingsModal } from './components/settings/SettingsModal';
import { TopUpModal } from './components/billing/TopUpModal';
import { ToastProvider } from './components/ui/Toast';
import { BookEditor } from './components/editor/BookEditor';
import { QualityWatcher } from './components/editor/QualityWatcher';
import { useBookStore } from './store/bookStore';
import { useAudioStore } from './store/audioStore';
import { useSettingsStore } from './store/settingsStore';
import { useUserStore } from './store/userStore';

type SettingsTab = 'tts' | 'keys' | 'dictionary' | 'view' | 'network';

/** Элементы, у которых Space/Enter/стрелки имеют собственный смысл — глобальные горячие клавиши их не перехватывают. */
const isInteractiveTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'SUMMARY'].includes(target.tagName)) return true;
  return Boolean(target.closest('[role="button"], [role="tab"], [role="slider"], [role="switch"], [role="menuitem"], [role="checkbox"]'));
};

const AppShell: React.FC = () => {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('tts');
  const [isChaptersOpen, setIsChaptersOpen] = useState(false);
  const [isDictionaryOpen, setIsDictionaryOpen] = useState(false);
  const [isTopUpOpen, setIsTopUpOpen] = useState(false);
  const [editorTab, setEditorTab] = useState<'quality' | 'chapters' | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const openEditor = useCallback((tab?: 'quality' | 'chapters') => {
    setEditorTab(tab ?? 'quality');
    setIsEditorOpen(true);
  }, []);

  const handleOpenSettings = useCallback((tab: SettingsTab = 'view') => {
    setSettingsTab(tab);
    setIsSettingsOpen(true);
  }, []);

  const handleOpenTTS = useCallback(() => handleOpenSettings('tts'), [handleOpenSettings]);
  const toggleChapters = useCallback(() => setIsChaptersOpen((open) => !open), []);

  const currentBook = useBookStore((state) => state.currentBook);
  const activeFootnote = useBookStore((state) => state.activeFootnote);
  const setActiveFootnote = useBookStore((state) => state.setActiveFootnote);
  const loadSavedBooksList = useBookStore((state) => state.loadSavedBooksList);
  const closeBook = useBookStore((state) => state.closeBook);
  const pdfViewMode = useBookStore((state) => state.pdfViewMode);
  const theme = useSettingsStore((state) => state.theme);
  const fetchBalance = useUserStore((state) => state.fetchBalance);

  const hasBook = currentBook !== null;
  const showPdfOriginal = Boolean(currentBook?.rawPdfBuffer) && pdfViewMode === 'original';

  // Применение темы оформления
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('dark', 'sepia', 'oled');
    if (theme === 'dark') root.classList.add('dark');
    if (theme === 'sepia') root.classList.add('sepia');
    if (theme === 'oled') root.classList.add('dark', 'oled');
  }, [theme]);

  // Начальная загрузка списка книг и баланса (один раз)
  useEffect(() => {
    void loadSavedBooksList();
    void fetchBalance();
  }, [loadSavedBooksList, fetchBalance]);

  useEffect(() => {
    const handleOpenTopup = () => setIsTopUpOpen(true);
    window.addEventListener('open-topup-modal', handleOpenTopup);
    return () => window.removeEventListener('open-topup-modal', handleOpenTopup);
  }, []);

  // Закрываем оглавление при выходе из книги
  useEffect(() => {
    if (!hasBook) {
      setIsChaptersOpen(false);
      setIsEditorOpen(false);
    }
  }, [hasBook]);

  // Глобальные горячие клавиши
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      if (e.key === 'Escape') {
        // Модалки на базе <Modal> закрываются сами (и останавливают событие); здесь — остальные панели
        setIsSettingsOpen(false);
        setIsChaptersOpen(false);
        setIsDictionaryOpen(false);
        setIsTopUpOpen(false);
        setActiveFootnote(null);
        return;
      }

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
        if (audio.isPlaying && !audio.isPaused) audio.pause();
        else if (audio.isPlaying && audio.isPaused) audio.resume();
        else audio.play();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        audio.playNextSentence();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        audio.playPrevSentence();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setActiveFootnote]);

  const handleBackToLibrary = useCallback(() => {
    useAudioStore.getState().stop();
    void closeBook();
  }, [closeBook]);

  return (
    <div className="h-dvh flex flex-col overflow-hidden select-text bg-white dark:bg-zinc-950 text-slate-900 dark:text-zinc-100">
      {/* Верхняя шапка */}
      <Header
        onOpenSettings={() => handleOpenSettings('view')}
        onOpenTTS={handleOpenTTS}
        onToggleChapters={toggleChapters}
        isChaptersOpen={isChaptersOpen}
        onOpenDictionary={() => setIsDictionaryOpen(true)}
        onOpenTopUp={() => setIsTopUpOpen(true)}
        onOpenEditor={() => openEditor()}
        onBackToLibrary={handleBackToLibrary}
      />

      {/* Основной контент */}
      {currentBook ? (
        <div className="flex-1 min-h-0 flex overflow-hidden relative">
          {/* Оригинальный PDF с подсветкой ИЛИ адаптивный текстовый режим (монтируем только активный вид) */}
          <div className="flex-1 min-w-0 h-full overflow-hidden flex flex-col">
            {currentBook.metadata.paged && <PagedBookBar />}
            {showPdfOriginal ? (
              <PdfBookView key={currentBook.metadata.id} />
            ) : currentBook.metadata.paged ? (
              <PagedTextView key={currentBook.metadata.id} />
            ) : (
              <BookView key={currentBook.metadata.id} />
            )}
          </div>

          {/* Панель глав: справа на десктопе, drawer на мобильных */}
          {isChaptersOpen && <ChapterSidebar onClose={() => setIsChaptersOpen(false)} />}
        </div>
      ) : (
        <main className="flex-1 overflow-y-auto">
          <LibraryView />
        </main>
      )}

      {/* Закреплённая снизу панель воспроизведения (ControlBar) */}
      {currentBook && (
        <ControlBar
          onToggleChapters={toggleChapters}
          isChaptersOpen={isChaptersOpen}
          onOpenDictionary={() => setIsDictionaryOpen(true)}
          onOpenTTS={handleOpenTTS}
        />
      )}

      {/* Модальное окно словаря замен и произношения */}
      <DictionaryModal isOpen={isDictionaryOpen} onClose={() => setIsDictionaryOpen(false)} />

      {/* Модальное окно сносок */}
      <FootnoteModal footnote={activeFootnote} onClose={() => setActiveFootnote(null)} />

      {/* Модальное окно настроек */}
      <SettingsModal isOpen={isSettingsOpen} initialTab={settingsTab} onClose={() => setIsSettingsOpen(false)} />

      {/* Редактор текста книги и уведомление о качестве распознавания */}
      <BookEditor isOpen={isEditorOpen} initialTab={editorTab ?? undefined} onClose={() => setIsEditorOpen(false)} />
      <QualityWatcher onOpenEditor={openEditor} />

      {/* Модальное окно пополнения баланса ЮKassa */}
      <TopUpModal isOpen={isTopUpOpen} onClose={() => setIsTopUpOpen(false)} />
    </div>
  );
};

export const App: React.FC = () => (
  <ToastProvider>
    <AppShell />
  </ToastProvider>
);

export default App;
