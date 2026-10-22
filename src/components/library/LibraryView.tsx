import React, { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Upload,
  Trash2,
  Clock,
  FileText,
  Sparkles,
  AlertCircle,
  Search,
  X,
  Loader2,
  Library as LibraryIcon,
  FileUp,
} from 'lucide-react';
import { SavedBook, useBookStore } from '../../store/bookStore';
import { clearBookError as clearError, deleteBook, loadBookFromFile, selectSavedBook } from '../../engine/library';
import { rememberPdfRecognitionMode } from '../../engine/settings';
import { useSettingsStore } from '../../store/settingsStore';
import { PdfRecognitionModal } from '../reader/PdfRecognitionModal';
import { PdfRecognitionMode } from '../../types/settings';
import { isSupportedBookFile, normalizeBookFile, SUPPORTED_EXTENSIONS } from '../../engine/parsers/formatDetector';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';

// Расширения импортируются из formatDetector
const ACCEPT_ATTR = SUPPORTED_EXTENSIONS.join(',');

type SortKey = 'recent' | 'title' | 'author' | 'added' | 'progress';

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'recent', label: 'Недавно читал' },
  { value: 'added', label: 'Недавно добавлены' },
  { value: 'title', label: 'По названию' },
  { value: 'author', label: 'По автору' },
  { value: 'progress', label: 'По прогрессу' },
];

const SORT_STORAGE_KEY = 'aibr.library.sort';

const readStoredSort = (): SortKey => {
  try {
    const value = localStorage.getItem(SORT_STORAGE_KEY);
    if (value && SORT_OPTIONS.some((o) => o.value === value)) return value as SortKey;
  } catch {
    // localStorage может быть недоступен
  }
  return 'recent';
};

const isSupportedFile = (name: string): boolean => isSupportedBookFile(name);

const formatDate = (timestamp: number): string =>
  new Date(timestamp).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

const isScannedPdfError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const e = err as { isScanned?: boolean; name?: string; message?: string };
  return Boolean(
    e.isScanned ||
      e.name === 'ScannedPdfError' ||
      e.message?.includes('не содержит текстового слоя') ||
      e.message?.includes('повреждённый текстовый слой') ||
      e.message?.includes('псевдокириллица')
  );
};

const hasFiles = (e: React.DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');

const isMobileDevice = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
};

/* ------------------------------ Карточка книги ------------------------------ */

interface BookCardProps {
  book: SavedBook;
  isOpening: boolean;
  disabled: boolean;
  onOpen: (id: string) => void;
  onDelete: (book: SavedBook) => void;
}

const BookCard = memo(({ book, isOpening, disabled, onOpen, onDelete }: BookCardProps) => {
  const [coverFailed, setCoverFailed] = useState(false);
  const percent = Math.round(book.progress * 100);
  const started = percent > 0;

  return (
    <li className="group relative bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl shadow-sm hover:shadow-md hover:border-amber-400 dark:hover:border-amber-600 focus-within:border-amber-500 transition-all flex flex-col min-w-0">
      <button
        type="button"
        onClick={() => onOpen(book.id)}
        disabled={disabled}
        aria-label={`${started ? 'Продолжить чтение' : 'Читать'}: ${book.title}${book.author ? `, ${book.author}` : ''}`}
        className="text-left p-4 pb-3 rounded-t-2xl disabled:cursor-wait flex flex-col gap-3 min-w-0"
      >
        <div className="flex gap-3 min-w-0">
          {book.coverUrl && !coverFailed ? (
            <img
              src={book.coverUrl}
              alt=""
              loading="lazy"
              onError={() => setCoverFailed(true)}
              className="w-16 h-24 object-cover rounded-lg shadow-sm shrink-0 bg-slate-100 dark:bg-zinc-800"
            />
          ) : (
            <div
              className="w-16 h-24 bg-slate-100 dark:bg-zinc-800 rounded-lg flex items-center justify-center shrink-0 text-slate-500 dark:text-zinc-500"
              aria-hidden="true"
            >
              <FileText className="w-6 h-6" />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-sm text-slate-800 dark:text-zinc-100 line-clamp-3 break-words group-hover:text-amber-700 dark:group-hover:text-amber-400 transition-colors">
              {book.title}
            </h3>
            {book.author && (
              <p className="text-xs text-slate-600 dark:text-zinc-400 mt-1 truncate">{book.author}</p>
            )}
            <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-zinc-400 mt-2">
              <Clock className="w-3 h-3" aria-hidden="true" />
              <span>{formatDate(book.lastReadAt || book.addedAt)}</span>
            </div>
          </div>
        </div>

        {/* Прогресс чтения */}
        <div className="w-full">
          <div
            role="progressbar"
            aria-label="Прогресс чтения"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-zinc-800 overflow-hidden"
          >
            <div
              className="h-full rounded-full bg-amber-500 transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="mt-1 text-[11px] text-slate-600 dark:text-zinc-400">
            {started ? `Прочитано ${percent}%` : 'Не начата'}
          </div>
          {book.paged && (
            <div className="mt-2" data-testid="recognition-card">
              <div
                role="progressbar"
                aria-label="Прогресс распознавания"
                aria-valuemin={0}
                aria-valuemax={book.paged.pageCount}
                aria-valuenow={book.paged.pagesDone}
                className="h-1 w-full rounded-full bg-slate-200 dark:bg-zinc-800 overflow-hidden"
              >
                <div
                  className={`h-full rounded-full ${book.paged.pagesError > 0 ? 'bg-rose-400' : 'bg-emerald-500'}`}
                  style={{ width: `${Math.round((book.paged.pagesDone / Math.max(1, book.paged.pageCount)) * 100)}%` }}
                />
              </div>
              <div className="mt-1 text-[11px] text-slate-600 dark:text-zinc-400 flex flex-wrap gap-x-2">
                <span>
                  {book.paged.pagesDone >= book.paged.pageCount
                    ? `Распознана целиком (${book.paged.pageCount} стр.)`
                    : `Распознано ${book.paged.pagesDone}/${book.paged.pageCount}`}
                </span>
                {book.paged.pagesError > 0 && (
                  <span className="text-rose-600 dark:text-rose-400">ошибок: {book.paged.pagesError}</span>
                )}
                {book.paged.pagesDone < book.paged.pageCount && (
                  <span className="text-slate-500 dark:text-zinc-500">продолжится при открытии</span>
                )}
              </div>
            </div>
          )}
        </div>
      </button>

      <div className="px-4 pb-3 pt-2 border-t border-slate-100 dark:border-zinc-800 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-500" aria-hidden="true">
          {isOpening ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Открываем...</span>
            </>
          ) : (
            <span>{started ? 'Продолжить' : 'Читать'}</span>
          )}
        </span>

        <button
          type="button"
          onClick={() => onDelete(book)}
          className="p-1.5 rounded-lg text-slate-500 dark:text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors"
          aria-label={`Удалить книгу «${book.title}» из библиотеки`}
          title="Удалить из библиотеки"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </li>
  );
});
BookCard.displayName = 'BookCard';

/* --------------------------------- Библиотека -------------------------------- */

export const LibraryView: React.FC = () => {
  const toast = useToast();

  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const [pendingPdfFile, setPendingPdfFile] = useState<File | null>(null);
  const [isPdfModalOpen, setIsPdfModalOpen] = useState(false);
  const [pdfModalNotice, setPdfModalNotice] = useState<string | null>(null);

  const [statusText, setStatusText] = useState<string>('Чтение и подготовка книги...');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>(readStoredSort);
  const [bookToDelete, setBookToDelete] = useState<SavedBook | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const processingRef = useRef(false);
  const searchId = useId();
  const sortId = useId();

  const savedBooks = useBookStore((state) => state.savedBooks);
  const bookStoreError = useBookStore((state) => state.error);
  const isStoreLoading = useBookStore((state) => state.isLoading);

  const replacementRules = useSettingsStore((state) => state.replacementRules);
  const pdfRecognitionMode = useSettingsStore((state) => state.pdfRecognitionMode);
  const alwaysAskPdfMode = useSettingsStore((state) => state.alwaysAskPdfMode);

  // Ошибки стора вне загрузки файла (например, не удалось открыть сохранённую книгу) показываем тостом
  useEffect(() => {
    if (bookStoreError && !processingRef.current) {
      toast.error(bookStoreError);
      clearError();
      setOpeningId(null);
    }
  }, [bookStoreError, toast, clearError]);

  useEffect(() => {
    if (!isStoreLoading) setOpeningId(null);
  }, [isStoreLoading]);

  useEffect(() => {
    try {
      localStorage.setItem(SORT_STORAGE_KEY, sort);
    } catch {
      // ignore
    }
  }, [sort]);

  // Файл, брошенный мимо зоны загрузки, не должен «уводить» браузер на открытие файла
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  const handleFileUpload = async (file: File, options?: { pdfMode?: PdfRecognitionMode; pdfForce?: boolean }) => {
    if (processingRef.current) return;
    processingRef.current = true;
    setIsProcessing(true);
    setStatusText(
      file.name.toLowerCase().endsWith('.pdf')
        ? 'Открываем PDF: страницы, оглавление, обложка...'
        : 'Чтение и подготовка книги...'
    );
    setErrorMessage(null);
    setErrorDetail(null);

    try {
      await loadBookFromFile(file, replacementRules, options);

      // Успешно загружено — закрываем модальное окно и сбрасываем состояние
      setIsPdfModalOpen(false);
      setPendingPdfFile(null);
      setPdfModalNotice(null);
    } catch (err) {
      console.error('[LibraryView] Ошибка обработки книги:', err);
      clearError();
      if (isScannedPdfError(err)) {
        setPendingPdfFile(file);
        setPdfModalNotice(
          (err as Error).message ||
            'В этом PDF не обнаружен цифровой текстовый слой или он повреждён. Для чтения требуется режим распознавания.'
        );
        setIsPdfModalOpen(true);
      } else {
        const reason = err instanceof Error && err.message ? err.message : '';
        setErrorMessage(
          `Файл «${file.name}» не удалось открыть. Возможно, он повреждён или имеет неподдерживаемую структуру.`
        );
        setErrorDetail(reason ? reason.slice(0, 240) : null);
        setIsPdfModalOpen(false);
        setPendingPdfFile(null);
        setPdfModalNotice(null);
      }
    } finally {
      processingRef.current = false;
      setIsProcessing(false);
      setStatusText('Чтение и подготовка книги...');
    }
  };

  const onFileSelected = async (rawFile: File) => {
    if (processingRef.current) return;

    let file = rawFile;
    try {
      file = await normalizeBookFile(rawFile);
    } catch (e) {
      console.warn('[LibraryView] Ошибка нормализации книги:', e);
    }

    if (!isSupportedFile(file.name)) {
      const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '(без расширения)';
      setErrorDetail(null);
      setErrorMessage(
        `Формат ${ext} не поддерживается. Выберите файл FB2, EPUB, MOBI, AZW3, PDF или TXT.`
      );
      return;
    }
    if (file.size === 0) {
      setErrorDetail(null);
      setErrorMessage(`Файл «${file.name}» пустой.`);
      return;
    }
    setErrorMessage(null);

    if (file.name.toLowerCase().endsWith('.pdf')) {
      if (alwaysAskPdfMode) {
        setPendingPdfFile(file);
        setPdfModalNotice(null);
        setIsPdfModalOpen(true);
        return;
      }
      await handleFileUpload(file, { pdfMode: pdfRecognitionMode });
      return;
    }
    await handleFileUpload(file);
  };

  const handlePdfModeSelect = async (mode: PdfRecognitionMode, rememberDefault: boolean, force?: boolean) => {
    if (!pendingPdfFile || processingRef.current) return;
    if (rememberDefault) {
      rememberPdfRecognitionMode(mode);
    }
    // Оставляем модалку открытой: она сама отобразит спиннер и статус обработки
    await handleFileUpload(pendingPdfFile, { pdfMode: mode, pdfForce: force });
  };

  const handleOpenFileDialog = async () => {
    if (processingRef.current) return;
    const isMobile = isMobileDevice();
    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    // На мобильных устройствах плагин диалогов Tauri блокирует fb2 из-за MimeTypeMap и теряет имя файла.
    // Поэтому на мобильных сборках используем прямой системный выбор через HTML input.
    if (isTauri && !isMobile) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const { readFile } = await import('@tauri-apps/plugin-fs');
        const selected = await open({
          multiple: false,
          filters: [{ name: 'Электронные книги', extensions: ['fb2', 'zip', 'fbz', 'epub', 'mobi', 'azw', 'azw3', 'pdf', 'txt'] }],
        });
        if (selected) {
          const filePath = Array.isArray(selected) ? selected[0] : selected;
          const fileName = filePath.split(/[/\\]/).pop() || 'book';
          const bytes = await readFile(filePath);
          await onFileSelected(new File([bytes], fileName));
        }
      } catch (err) {
        console.warn('Tauri dialog fallback to input:', err);
        fileInputRef.current?.click();
      }
    } else {
      fileInputRef.current?.click();
    }
  };

  const onDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    if (!processingRef.current) setIsDragging(true);
  };

  const onDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = processingRef.current ? 'none' : 'copy';
  };

  const onDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  };

  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    if (processingRef.current) {
      toast.info('Дождитесь окончания обработки текущей книги.');
      return;
    }
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    if (files.length > 1) toast.info('Загружается только первая книга — добавляйте файлы по одному.');
    void onFileSelected(files[0]);
  };

  const handleOpenBook = useCallback(
    (id: string) => {
      setOpeningId(id);
      void selectSavedBook(id);
    },
    [selectSavedBook]
  );

  const confirmDelete = async () => {
    if (!bookToDelete) return;
    const target = bookToDelete;
    setIsDeleting(true);
    try {
      await deleteBook(target.id);
      toast.success(`Книга «${target.title}» удалена из библиотеки.`);
    } catch (err) {
      toast.error(`Не удалось удалить книгу: ${err instanceof Error ? err.message : 'ошибка базы данных'}`);
    } finally {
      setIsDeleting(false);
      setBookToDelete(null);
    }
  };

  const visibleBooks = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? savedBooks.filter((b) => b.title.toLowerCase().includes(q) || (b.author ?? '').toLowerCase().includes(q))
      : savedBooks.slice();

    const collator = new Intl.Collator('ru');
    filtered.sort((a, b) => {
      switch (sort) {
        case 'title':
          return collator.compare(a.title, b.title);
        case 'author':
          return collator.compare(a.author ?? '', b.author ?? '') || collator.compare(a.title, b.title);
        case 'added':
          return b.addedAt - a.addedAt;
        case 'progress':
          return b.progress - a.progress;
        case 'recent':
        default:
          return (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt);
      }
    });
    return filtered;
  }, [savedBooks, query, sort]);

  const dropZoneClass = isProcessing
    ? 'border-amber-500/40 bg-amber-50/30 dark:bg-amber-950/10 opacity-80 cursor-wait'
    : isDragging
      ? 'border-amber-500 bg-amber-50/60 dark:bg-amber-950/20 scale-[1.01] cursor-copy'
      : 'border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900/50 hover:border-amber-500 dark:hover:border-amber-600 cursor-pointer';

  return (
    <div
      className="min-h-full px-4 py-6 md:py-12 max-w-5xl mx-auto w-full"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Подсказка при перетаскивании файла над страницей */}
      {isDragging && (
        <div
          className="pointer-events-none fixed inset-3 z-40 rounded-3xl border-4 border-dashed border-amber-500 bg-amber-500/10 backdrop-blur-[1px] flex items-center justify-center"
          aria-hidden="true"
        >
          <div className="flex items-center gap-3 px-6 py-4 rounded-2xl bg-white dark:bg-zinc-900 shadow-xl text-amber-700 dark:text-amber-400 font-semibold">
            <FileUp className="w-6 h-6" />
            <span>Отпустите файл, чтобы добавить книгу</span>
          </div>
        </div>
      )}

      {/* Приветственный блок */}
      <div className="text-center mb-8 md:mb-10">
        <h1 className="text-2xl md:text-4xl font-extrabold tracking-tight text-slate-900 dark:text-zinc-100 flex items-center justify-center gap-3">
          <span>Ваша библиотека книг</span>
          <Sparkles className="w-6 h-6 text-amber-500 shrink-0" aria-hidden="true" />
        </h1>
        <p className="text-sm md:text-base text-slate-600 dark:text-zinc-400 mt-2 max-w-lg mx-auto">
          Загрузите электронную книгу для мгновенного чтения с живой нейросетевой озвучкой предложений.
        </p>
      </div>

      {/* Зона загрузки (клик, клавиатура, drag and drop) */}
      <div
        role="button"
        tabIndex={isProcessing ? -1 : 0}
        aria-disabled={isProcessing}
        aria-busy={isProcessing}
        aria-label={isProcessing ? statusText : 'Выбрать файл книги для загрузки'}
        onClick={isProcessing ? undefined : handleOpenFileDialog}
        onKeyDown={(e) => {
          if (!isProcessing && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            void handleOpenFileDialog();
          }
        }}
        className={`relative border-2 border-dashed rounded-3xl p-6 md:p-12 text-center transition-all duration-200 mb-8 md:mb-12 flex flex-col items-center justify-center ${dropZoneClass}`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={isMobileDevice() ? undefined : ACCEPT_ATTR}
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ''; // позволяет повторно выбрать тот же файл
            if (file) void onFileSelected(file);
          }}
        />

        <div className="w-16 h-16 rounded-2xl bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400 flex items-center justify-center mb-4 shadow-inner">
          {isProcessing ? (
            <div className="w-8 h-8 border-[3px] border-amber-500 border-t-transparent rounded-full animate-spin" />
          ) : (
            <Upload className="w-8 h-8" aria-hidden="true" />
          )}
        </div>

        <h2 className="font-semibold text-base md:text-lg text-slate-800 dark:text-zinc-200" aria-live="polite">
          {isProcessing ? statusText : 'Перетащите книгу сюда или нажмите для выбора'}
        </h2>
        <p className="text-xs text-slate-600 dark:text-zinc-400 mt-1.5">
          Поддерживаются: <strong>FB2</strong>, <strong>EPUB</strong>, <strong>MOBI</strong>, <strong>AZW3</strong>,{' '}
          <strong>PDF</strong>, <strong>TXT</strong>
        </p>
      </div>

      {/* Модальное окно выбора режима распознавания PDF */}
      <PdfRecognitionModal
        isOpen={isPdfModalOpen}
        onClose={() => {
          setIsPdfModalOpen(false);
          setPendingPdfFile(null);
          setPdfModalNotice(null);
        }}
        fileName={pendingPdfFile?.name}
        currentMode={pdfRecognitionMode}
        onSelectMode={handlePdfModeSelect}
        isProcessing={isProcessing}
        statusText={statusText}
        showRememberCheckbox={!pdfModalNotice}
        alertNotice={pdfModalNotice || undefined}
      />

      {/* Сообщение об ошибке загрузки */}
      {errorMessage && (
        <div
          role="alert"
          className="mb-8 p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 flex items-start gap-3 text-rose-800 dark:text-rose-300 text-sm"
        >
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <span className="font-semibold">Не удалось загрузить книгу</span>
            <span className="break-words">{errorMessage}</span>
            {errorDetail && (
              <span className="break-words text-xs opacity-80">Техническая причина: {errorDetail}</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="p-1 rounded-lg hover:bg-rose-100 dark:hover:bg-rose-900/40 shrink-0"
            aria-label="Скрыть сообщение об ошибке"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Список ранее сохранённых книг */}
      <section aria-labelledby="library-heading">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <h2 id="library-heading" className="text-lg font-bold text-slate-800 dark:text-zinc-200">
            Сохранённые книги ({savedBooks.length})
          </h2>

          {savedBooks.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full sm:w-auto">
                <label htmlFor={searchId} className="sr-only">
                  Поиск по библиотеке
                </label>
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden="true" />
                <input
                  id={searchId}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Поиск по книгам"
                  className="w-full sm:w-64 pl-9 pr-3 py-2 text-sm rounded-xl bg-white dark:bg-zinc-900 border border-slate-300 dark:border-zinc-700 focus:border-amber-500 text-slate-800 dark:text-zinc-100 placeholder:text-slate-500 dark:placeholder:text-zinc-500"
                />
              </div>
              <label htmlFor={sortId} className="sr-only">
                Сортировка
              </label>
              <select
                id={sortId}
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="w-full sm:w-auto py-2 pl-3 pr-8 text-sm rounded-xl bg-white dark:bg-zinc-900 border border-slate-300 dark:border-zinc-700 focus:border-amber-500 text-slate-800 dark:text-zinc-100"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {savedBooks.length === 0 ? (
          <div className="flex flex-col items-center text-center py-12 px-4 border rounded-2xl border-slate-200 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-900/20">
            <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 flex items-center justify-center mb-3">
              <LibraryIcon className="w-6 h-6" aria-hidden="true" />
            </div>
            <p className="font-semibold text-slate-800 dark:text-zinc-200">В библиотеке пока пусто</p>
            <p className="text-sm text-slate-600 dark:text-zinc-400 mt-1 max-w-sm">
              Добавьте первую книгу: перетащите файл в область выше или нажмите на неё. Книги хранятся только на этом
              устройстве.
            </p>
            <button
              type="button"
              onClick={() => void handleOpenFileDialog()}
              disabled={isProcessing}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold transition-colors disabled:opacity-60"
            >
              <Upload className="w-4 h-4" aria-hidden="true" />
              Выбрать файл
            </button>
          </div>
        ) : visibleBooks.length === 0 ? (
          <div className="text-center py-10 text-sm text-slate-600 dark:text-zinc-400 border rounded-2xl border-slate-200 dark:border-zinc-800">
            По запросу «{query}» ничего не найдено.{' '}
            <button type="button" className="text-amber-700 dark:text-amber-400 font-semibold underline" onClick={() => setQuery('')}>
              Сбросить поиск
            </button>
          </div>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {visibleBooks.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                isOpening={openingId === book.id}
                disabled={isStoreLoading}
                onOpen={handleOpenBook}
                onDelete={setBookToDelete}
              />
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        isOpen={bookToDelete !== null}
        danger
        isBusy={isDeleting}
        title="Удалить книгу?"
        message={
          bookToDelete
            ? `«${bookToDelete.title}» будет удалена из библиотеки вместе с прогрессом чтения и кэшем озвучки. Это действие нельзя отменить.`
            : undefined
        }
        confirmLabel="Удалить"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setBookToDelete(null)}
      />
    </div>
  );
};
