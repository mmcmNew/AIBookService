import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  List,
  Moon,
  Settings,
  Sun,
  ArrowLeft,
  Volume2,
  Sparkles,
  Plus,
  BookText,
  FileText,
  Palette,
  Pencil,
} from 'lucide-react';
import { useBookStore } from '../../store/bookStore';
import { loadBook, setPdfViewMode } from '../../engine/library';
import { useSettingsStore } from '../../store/settingsStore';
import { useUserStore } from '../../store/userStore';
import { PdfRecognitionModal } from '../reader/PdfRecognitionModal';
import { RerecognizeDialog } from '../reader/RerecognizeDialog';
import { PdfRecognitionMode, ReaderTheme } from '../../types/settings';
import { parseBookFile } from '../../engine/parsers';
import { useToast } from '../ui/Toast';

interface HeaderProps {
  onOpenSettings: () => void;
  onOpenTTS?: () => void;
  onToggleChapters: () => void;
  isChaptersOpen?: boolean;
  onOpenDictionary: () => void;
  onBackToLibrary: () => void;
  onOpenTopUp: () => void;
  /** Открыть редактор текста книги */
  onOpenEditor?: () => void;
}

const THEME_ORDER: ReaderTheme[] = ['light', 'sepia', 'dark', 'oled'];
const THEME_LABELS: Record<ReaderTheme, string> = {
  light: 'Светлая',
  sepia: 'Сепия',
  dark: 'Тёмная',
  oled: 'OLED',
};

/** Компактное отображение баланса символов: 850, 1.5k, 15k, 1.2M */
const formatBalance = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1000) return String(Math.floor(value));
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
};

const iconButton =
  'p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-300 transition-colors shrink-0';

interface PdfControlsProps {
  pdfViewMode: 'original' | 'reflow';
  onChangeMode: (mode: 'original' | 'reflow') => void;
  onOpenEngine: () => void;
  className?: string;
}

/** Переключатель вида PDF (Страницы / Текст) + кнопка смены движка распознавания. */
const PdfControls: React.FC<PdfControlsProps> = ({ pdfViewMode, onChangeMode, onOpenEngine, className }) => {
  const segment = (active: boolean) =>
    `flex items-center gap-1.5 px-2.5 py-1 rounded-md transition ${
      active
        ? 'bg-white dark:bg-zinc-700 text-slate-900 dark:text-zinc-100 shadow-sm font-semibold'
        : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-zinc-200'
    }`;

  return (
    <div className={className}>
      <div
        role="group"
        aria-label="Вид PDF"
        className="flex items-center bg-slate-100 dark:bg-zinc-800 rounded-lg p-0.5 text-xs font-medium border border-slate-200 dark:border-zinc-700/60 shadow-inner"
      >
        <button
          onClick={() => onChangeMode('original')}
          aria-pressed={pdfViewMode === 'original'}
          className={segment(pdfViewMode === 'original')}
          title="Оригинальные страницы PDF с сохранением вёрстки и подсветкой строк"
        >
          <FileText className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Страницы</span>
        </button>
        <button
          onClick={() => onChangeMode('reflow')}
          aria-pressed={pdfViewMode === 'reflow'}
          className={segment(pdfViewMode === 'reflow')}
          title="Адаптивный режим форматированного текста для комфортного чтения"
        >
          <BookText className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Текст книги</span>
        </button>
      </div>

      <button
        onClick={onOpenEngine}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-500/10 hover:bg-amber-500/20 text-amber-800 dark:text-amber-400 border border-amber-500/30 hover:border-amber-500/50 transition active:scale-[0.98]"
        title="Сменить движок распознавания PDF (PDF.js / PyMuPDF4LLM / Gemini OCR)"
      >
        <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
        <span>Движок PDF</span>
      </button>
    </div>
  );
};

export const Header: React.FC<HeaderProps> = ({
  onOpenSettings,
  onOpenTTS,
  onToggleChapters,
  isChaptersOpen,
  onOpenDictionary,
  onBackToLibrary,
  onOpenTopUp,
  onOpenEditor,
}) => {
  const currentBook = useBookStore((state) => state.currentBook);
  const currentChapterIndex = useBookStore((state) => state.currentChapterIndex);
  const pdfViewMode = useBookStore((state) => state.pdfViewMode);

  const {
    theme,
    setTheme,
    activeProvider,
    geminiModel,
    openRouterModel,
    replacementRules,
    pdfRecognitionMode,
    setPdfRecognitionMode,
    setAlwaysAskPdfMode,
  } = useSettingsStore();
  const balance = useUserStore((state) => state.balance);
  const toast = useToast();

  const [isPdfModalOpen, setIsPdfModalOpen] = useState(false);
  const [isReparsing, setIsReparsing] = useState(false);
  const [reparseStatus, setReparseStatus] = useState('Перераспознавание книги...');

  const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
  const toggleTheme = () => setTheme(nextTheme);

  const handleReparse = async (mode: PdfRecognitionMode, rememberDefault: boolean) => {
    if (!currentBook?.rawPdfBuffer || isReparsing) return;
    setIsReparsing(true);
    setReparseStatus(
      mode === 'pymupdf'
        ? 'Умный анализ вёрстки и структуры (PyMuPDF)...'
        : mode === 'gemini'
          ? 'Оптическое распознавание через Gemini Vision OCR...'
          : 'Извлечение текстового слоя PDF.js...'
    );

    try {
      if (rememberDefault) {
        setPdfRecognitionMode(mode);
        setAlwaysAskPdfMode(false);
      }
      const fileName = currentBook.metadata.fileName || `${currentBook.metadata.title}.pdf`;
      const file = new File([currentBook.rawPdfBuffer], fileName, { type: 'application/pdf' });
      const newBook = await parseBookFile(file, replacementRules, { pdfMode: mode });
      if (!newBook.rawPdfBuffer) {
        newBook.rawPdfBuffer = currentBook.rawPdfBuffer;
      }
      await loadBook(newBook);
      setIsPdfModalOpen(false);
      const q = useBookStore.getState().currentBook?.metadata.quality;
      toast.success(q ? `PDF перераспознан. Качество текста: ${q.score}/100` : 'PDF успешно перераспознан');
    } catch (err) {
      console.error('[Header] Ошибка повторного распознавания PDF:', err);
      const message = err instanceof Error && err.message ? err.message : 'неизвестная ошибка';
      toast.error(`Не удалось повторно распознать PDF: ${message}`);
    } finally {
      setIsReparsing(false);
      setReparseStatus('Перераспознавание книги...');
    }
  };

  const currentChapter = currentBook?.chapters[currentChapterIndex];
  const quality = currentBook?.metadata.quality;

  // Редактор может попросить пересканировать PDF другим режимом
  const hasPdfBook = Boolean(currentBook?.rawPdfBuffer);
  useEffect(() => {
    const open = () => {
      if (hasPdfBook) setIsPdfModalOpen(true);
    };
    window.addEventListener('open-pdf-engine', open);
    return () => window.removeEventListener('open-pdf-engine', open);
  }, [hasPdfBook]);

  const providerLabel =
    activeProvider === 'gemini'
      ? geminiModel.includes('flash-lite')
        ? 'Gemini 3.8 Lite'
        : 'Gemini 3.8 Flash'
      : activeProvider === 'openrouter'
        ? `OR: ${(openRouterModel || 'OpenRouter').split('/').pop()?.replace(/-preview|-audio/g, '')}`
        : activeProvider === 'edge-tts'
          ? 'Edge TTS'
          : activeProvider === 'webspeech'
            ? 'Web Speech'
            : activeProvider === 'openai'
              ? 'OpenAI'
              : activeProvider === 'elevenlabs'
                ? 'ElevenLabs'
                : String(activeProvider).toUpperCase();

  const hasPdf = Boolean(currentBook?.rawPdfBuffer);

  return (
    <>
      <header className="shrink-0 h-14 border-b border-slate-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md px-3 sm:px-4 flex items-center justify-between gap-2 transition-colors z-30 select-none">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
          {currentBook ? (
            <>
              <button
                onClick={onBackToLibrary}
                className={iconButton}
                aria-label="Назад в библиотеку"
                title="Назад в библиотеку"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div className="flex flex-col min-w-0">
                <span className="font-semibold text-sm truncate text-slate-800 dark:text-zinc-100" title={currentBook.metadata.title}>
                  {currentBook.metadata.title}
                </span>
                <span className="text-xs text-slate-600 dark:text-zinc-400 truncate">
                  {currentChapter ? currentChapter.title : currentBook.metadata.author}
                </span>
              </div>

              {hasPdf && (
                <PdfControls
                  pdfViewMode={pdfViewMode}
                  onChangeMode={setPdfViewMode}
                  onOpenEngine={() => setIsPdfModalOpen(true)}
                  className="hidden md:flex items-center gap-1.5 ml-2 shrink-0"
                />
              )}
            </>
          ) : (
            <div className="flex items-center gap-2 text-amber-700 dark:text-amber-500 font-bold text-lg">
              <BookOpen className="w-6 h-6" aria-hidden="true" />
              <span className="truncate">AIBookReader</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          {/* Баланс символов и кнопка пополнения через ЮKassa */}
          <button
            onClick={onOpenTopUp}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full bg-amber-500/10 hover:bg-amber-500/20 text-amber-800 dark:text-amber-400 border border-amber-500/30 transition-all font-medium"
            aria-label={`Баланс: ${Math.max(0, Math.floor(balance))} символов. Пополнить через ЮKassa`}
            title="Баланс символов. Нажмите для пополнения через ЮKassa"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-600" aria-hidden="true" />
            <span className="font-mono">{formatBalance(balance)}</span>
            <Plus className="w-3 h-3 text-amber-600" aria-hidden="true" />
          </button>

          {/* Словарь замен */}
          <button
            onClick={onOpenDictionary}
            className="flex items-center gap-1.5 p-2 sm:px-2.5 sm:py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 transition-colors"
            aria-label="Словарь замен и произношения"
            title="Словарь замен и произношения"
          >
            <BookText className="w-4 h-4 text-amber-600" aria-hidden="true" />
            <span className="hidden sm:inline">Словарь</span>
          </button>

          {/* Редактирование текста книги */}
          {currentBook && onOpenEditor && (
            <button
              onClick={onOpenEditor}
              className="relative flex items-center gap-1.5 p-2 sm:px-2.5 sm:py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 transition-colors"
              aria-label={`Редактировать текст${quality ? `. Качество распознавания: ${quality.score} из 100` : ''}`}
              title={`Редактировать текст${quality ? ` (качество: ${quality.score}/100)` : ''}`}
            >
              <Pencil className="w-4 h-4 text-amber-600" aria-hidden="true" />
              <span className="hidden sm:inline">Правка</span>
              {quality && quality.grade !== 'good' && (
                <span
                  aria-hidden="true"
                  className={`absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full border border-white dark:border-zinc-900 ${
                    quality.grade === 'poor' ? 'bg-rose-500' : 'bg-amber-500'
                  }`}
                />
              )}
            </button>
          )}

          {/* Оглавление */}
          {currentBook && (
            <button
              onClick={onToggleChapters}
              aria-expanded={Boolean(isChaptersOpen)}
              aria-label="Оглавление"
              className={`flex items-center gap-1.5 p-2 sm:px-2.5 sm:py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                isChaptersOpen
                  ? 'border-amber-600 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-400 font-bold'
                  : 'border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300'
              }`}
              title="Оглавление"
            >
              <List className="w-4 h-4" aria-hidden="true" />
              <span className="hidden sm:inline">Главы</span>
            </button>
          )}

          {/* Чип модели/провайдера для быстрого выбора */}
          <button
            onClick={onOpenTTS || onOpenSettings}
            className="hidden md:flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-slate-200 dark:border-zinc-700 hover:border-amber-500 hover:text-amber-800 dark:hover:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-all font-medium group"
            aria-label={`Озвучка: ${providerLabel}. Выбрать модель или диктора`}
            title="Нажмите для быстрого выбора модели озвучки или диктора"
          >
            <Volume2 className="w-3.5 h-3.5 text-amber-600 group-hover:scale-110 transition-transform" aria-hidden="true" />
            <span className="font-medium text-[11px] tracking-tight">{providerLabel}</span>
          </button>

          <button
            onClick={toggleTheme}
            className={iconButton}
            aria-label={`Тема: ${THEME_LABELS[theme]}. Переключить на «${THEME_LABELS[nextTheme]}»`}
            title={`Тема: ${THEME_LABELS[theme]} (далее: ${THEME_LABELS[nextTheme]})`}
          >
            {theme === 'light' ? (
              <Sun className="w-4 h-4 text-amber-600" />
            ) : theme === 'sepia' ? (
              <Palette className="w-4 h-4 text-amber-700" />
            ) : (
              <Moon className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
            )}
          </button>

          <button onClick={onOpenSettings} className={iconButton} aria-label="Настройки" title="Настройки">
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* На узких экранах управление PDF уходит на отдельную строку под шапкой */}
      {hasPdf && (
        <PdfControls
          pdfViewMode={pdfViewMode}
          onChangeMode={setPdfViewMode}
          onOpenEngine={() => setIsPdfModalOpen(true)}
          className="md:hidden shrink-0 flex items-center justify-between gap-2 px-3 py-1.5 border-b border-slate-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 select-none overflow-x-auto"
        />
      )}

      {currentBook?.metadata.paged && (
        <RerecognizeDialog
          isOpen={isPdfModalOpen}
          onClose={() => setIsPdfModalOpen(false)}
          initialFrom={1}
          initialTo={currentBook.metadata.paged.pageCount}
        />
      )}
      {currentBook?.rawPdfBuffer && !currentBook.metadata.paged && (
        <PdfRecognitionModal
          isOpen={isPdfModalOpen}
          onClose={() => setIsPdfModalOpen(false)}
          fileName={currentBook.metadata.fileName || currentBook.metadata.title}
          currentMode={pdfRecognitionMode}
          onSelectMode={handleReparse}
          isProcessing={isReparsing}
          statusText={reparseStatus}
          showRememberCheckbox={true}
          quality={quality}
          currentBookMode={currentBook.metadata.pdfMode}
          onOpenEditor={
            onOpenEditor
              ? () => {
                  setIsPdfModalOpen(false);
                  onOpenEditor();
                }
              : undefined
          }
        />
      )}
    </>
  );
};
