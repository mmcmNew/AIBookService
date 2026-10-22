import React, { useId, useState } from 'react';
import {
  X,
  Zap,
  Layers,
  Sparkles,
  AlertCircle,
  Target,
  TriangleAlert,
  ExternalLink,
  Info,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { PdfRecognitionMode } from '../../types/settings';
import type { BookQuality } from '../../types/book';

interface PdfRecognitionModalProps {
  isOpen: boolean;
  onClose: () => void;
  fileName?: string;
  currentMode?: PdfRecognitionMode;
  onSelectMode: (mode: PdfRecognitionMode, rememberDefault: boolean, force?: boolean) => void;
  isProcessing?: boolean;
  statusText?: string;
  showRememberCheckbox?: boolean;
  alertNotice?: string;
  /** Оценка качества текущего распознавания (если книга уже открыта) */
  quality?: BookQuality | null;
  /** Режим, которым книга распознана сейчас */
  currentBookMode?: PdfRecognitionMode;
  /** Открыть редактор текста (кнопка в карточке оценки) */
  onOpenEditor?: () => void;
}

const ONLINE_CONVERTERS = [
  {
    name: 'Convertio (PDF → FB2)',
    url: 'https://convertio.co/ru/pdf-fb2/',
    desc: 'Автоматически выполняет OCR сканированных страниц и сохраняет в FB2 с главами.',
    badge: 'Рекомендуется',
    actionText: 'Открыть Convertio',
  },
  {
    name: 'PDF24 Tools (Бесплатный OCR)',
    url: 'https://tools.pdf24.org/ru/ocr-pdf',
    desc: 'Бесплатный онлайн-инструмент: добавляет качественный текстовый слой прямо в PDF.',
    badge: 'Бесплатно',
    actionText: 'Открыть PDF24',
  },
  {
    name: 'CloudConvert (PDF → EPUB)',
    url: 'https://cloudconvert.com/pdf-to-epub',
    desc: 'Преобразует PDF в популярный книжный формат EPUB с чистым форматированием.',
    badge: 'EPUB',
    actionText: 'Открыть CloudConvert',
  },
];

export const PdfRecognitionModal: React.FC<PdfRecognitionModalProps> = ({
  isOpen,
  onClose,
  fileName,
  currentMode = 'pdfjs',
  onSelectMode,
  isProcessing = false,
  statusText = 'Обработка PDF файла...',
  showRememberCheckbox = true,
  alertNotice,
  quality,
  currentBookMode,
  onOpenEditor,
}) => {
  const [rememberDefault, setRememberDefault] = useState(false);
  const [showAdvancedModes, setShowAdvancedModes] = useState(false);
  const titleId = useId();

  // Режимы, которые стоит попробовать при плохой оценке: все, кроме использованного (Gemini - в первую очередь)
  const poor = Boolean(quality && quality.grade !== 'good');
  const suggested = (id: PdfRecognitionMode): boolean =>
    poor && Boolean(currentBookMode) && id !== currentBookMode && (id === 'gemini' || currentBookMode === 'pdfjs');

  const isTauriEnv = typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

  const modes: {
    id: PdfRecognitionMode;
    title: string;
    badge: string;
    badgeColor: string;
    icon: React.ReactNode;
    description: string;
    bestFor: string;
    note?: string;
  }[] = [
    {
      id: 'pdfjs',
      title: 'Быстрый встроенный слой (PDF.js)',
      badge: isTauriEnv ? 'Автономный • Постранично' : 'Автономный • Рекомендуется',
      badgeColor: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
      icon: <Zap className="w-5 h-5 text-amber-500" />,
      description:
        'Книга открывается мгновенно, текст страниц извлекается из цифрового слоя по мере чтения и в фоне. Сохраняет координаты предложений для подсветки поверх страниц оригинального PDF.',
      bestFor: 'Для большинства электронных PDF-книг с нормальным текстом.',
    },
    {
      id: 'pymupdf',
      title: isTauriEnv ? 'Встроенный анализатор (PyMuPDF), авто' : 'Умный структурный парсер (PyMuPDF4LLM)',
      badge: isTauriEnv ? 'Рекомендуется • Постранично' : 'Две колонки • Python',
      badgeColor: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20',
      icon: <Layers className="w-5 h-5 text-indigo-500" />,
      description:
        isTauriEnv
          ? 'Книга открывается за секунды; каждая страница разбирается по требованию и в фоне: текст берётся из цифрового слоя, а для сканов и битого слоя автоматически включается OCR. Распутывает две колонки, скрывает колонтитулы, склеивает переносы между страницами.'
          : 'Глубокий анализ верстки через PyMuPDF. Автоматически распутывает двухколоночный текст, удаляет колонтитулы, сноски, формулы и склеивает переносы слов.',
      bestFor: 'Для сложных книг, журналов, научных статей в 2 колонки.',
      note: isTauriEnv ? undefined : 'Для работы в браузере требуется сервер (start_server.bat).',
    },
    ...(isTauriEnv
      ? [
          {
            id: 'ocr' as PdfRecognitionMode,
            title: 'Принудительный OCR (Tesseract)',
            badge: 'Сканы • Медленнее',
            badgeColor: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
            icon: <Target className="w-5 h-5 text-rose-500" />,
            description:
              'Каждая страница распознаётся оптически, даже если у PDF есть текстовый слой. Постранично, в фоне.',
            bestFor: 'Для сканов и PDF с испорченным текстовым слоем.',
            note: undefined as string | undefined,
          },
        ]
      : []),
    {
      id: 'gemini',
      title: 'Нейросетевой AI OCR (Google Gemini)',
      badge: 'Vision OCR • Сканы и фото',
      badgeColor: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20',
      icon: <Sparkles className="w-5 h-5 text-purple-500" />,
      description:
        'Оптическое распознавание страниц с помощью мультимодальной нейросети. Оцифровывает отсканированные страницы и книги, где текст сохранен как картинка.',
      bestFor: 'Для сканированных книг, фотокопий и документов без текста.',
      note: 'Нужен ключ Gemini API (Настройки → Ключи API): страницы отправляются по одной. Без ключа — серверный режим целиком.',
    },
  ];

  const hasAlert = Boolean(alertNotice);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      labelledBy={titleId}
      closeOnEsc={!isProcessing}
      closeOnBackdrop={!isProcessing}
      panelClassName="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-3xl w-[calc(100vw-2rem)] max-w-2xl max-h-[92vh] overflow-y-auto p-5 sm:p-7 shadow-2xl"
    >
      <div className="space-y-5">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 border ${
              hasAlert
                ? 'bg-amber-500/10 border-amber-500/20 text-amber-500'
                : 'bg-amber-500/10 border-amber-500/20 text-amber-500'
            }`}>
              {hasAlert ? <AlertCircle className="w-5 h-5" /> : <Sparkles className="w-5 h-5" />}
            </div>
            <div>
              <h2 id={titleId} className="text-lg font-bold text-slate-900 dark:text-zinc-100 leading-tight">
                {hasAlert ? 'Низкое качество текста в PDF' : 'Способ распознавания PDF'}
              </h2>
              {fileName && (
                <p className="text-xs font-mono text-slate-500 dark:text-zinc-400 truncate max-w-[14rem] sm:max-w-md">
                  {fileName}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isProcessing}
            aria-label="Закрыть"
            className="p-1.5 rounded-xl text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {isProcessing ? (
          <div className="py-12 flex flex-col items-center justify-center space-y-4" role="status" aria-live="polite">
            <div className="w-12 h-12 rounded-full border-4 border-amber-500/20 border-t-amber-500 animate-spin" />
            <p className="text-sm font-medium text-slate-700 dark:text-zinc-300 animate-pulse">
              {statusText}
            </p>
          </div>
        ) : (
          <>
            {/* Блок при обнаружении скана / плохого текстового слоя */}
            {hasAlert && (
              <div className="space-y-4">
                <div role="alert" className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/40 rounded-2xl p-4 text-xs text-slate-800 dark:text-zinc-200">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
                    <div className="space-y-1">
                      <p className="font-semibold text-slate-900 dark:text-zinc-100">
                        {alertNotice}
                      </p>
                      <p className="text-slate-600 dark:text-zinc-400 leading-relaxed">
                        Для живой озвучки предложений и караоке-подсветки читалке необходим текстовый слой. В сканах текст сохранён как картинка, а в испорченных PDF буквы заменены нечитаемыми символами.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Рекомендация онлайн-конвертеров */}
                <div className="bg-slate-50 dark:bg-zinc-800/50 border border-slate-200 dark:border-zinc-700/70 rounded-2xl p-4">
                  <div className="flex items-center gap-2 mb-1.5 text-xs font-bold text-slate-900 dark:text-zinc-100 uppercase tracking-wide">
                    <Sparkles className="w-4 h-4 text-amber-500" />
                    <span>Рекомендуемое решение: онлайн-конвертация в FB2 или EPUB</span>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-zinc-300 leading-relaxed mb-3">
                    Сконвертируйте ваш файл через бесплатный онлайн-сервис с оптическим распознаванием (OCR) и вернитесь сюда:
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mb-3">
                    {ONLINE_CONVERTERS.map((conv) => (
                      <a
                        key={conv.name}
                        href={conv.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group flex flex-col justify-between p-3 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 hover:border-amber-500 hover:shadow-md transition-all text-left"
                      >
                        <div>
                          <div className="flex items-center justify-between gap-1 mb-1">
                            <span className="font-bold text-xs text-slate-900 dark:text-zinc-100 group-hover:text-amber-600 dark:group-hover:text-amber-400">
                              {conv.name}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium">
                              {conv.badge}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-500 dark:text-zinc-400 leading-snug">
                            {conv.desc}
                          </p>
                        </div>
                        <div className="mt-2.5 flex items-center gap-1 text-[11px] font-semibold text-amber-600 dark:text-amber-400 group-hover:translate-x-0.5 transition-transform">
                          <span>{conv.actionText}</span>
                          <ExternalLink className="w-3 h-3" />
                        </div>
                      </a>
                    ))}
                  </div>

                  <div className="text-[11px] text-slate-600 dark:text-zinc-400 bg-white/70 dark:bg-zinc-900/60 rounded-xl p-2.5 border border-slate-200/60 dark:border-zinc-800 flex items-start gap-2">
                    <Info className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                    <span>
                      <strong>Как это работает:</strong> Откройте любой из сервисов выше → загрузите ваш PDF → выберите <strong>FB2</strong> или <strong>EPUB</strong> (с включённым OCR) → скачайте и перетащите в читалку. Книга сразу откроется с идеальным звуком!
                    </span>
                  </div>
                </div>

                {/* Опция "Всё равно открыть как есть" */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-3.5 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60">
                  <div className="text-xs">
                    <p className="font-semibold text-slate-900 dark:text-zinc-100">
                      Открыть как есть без конвертации
                    </p>
                    <p className="text-[11px] text-slate-500 dark:text-zinc-400">
                      Попытаться извлечь встроенный текстовый слой через PDF.js (возможны ошибки или пропуски)
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onSelectMode('pdfjs', false, true)}
                    className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-800 dark:text-zinc-200 transition shrink-0 self-start sm:self-auto"
                  >
                    Всё равно открыть
                  </button>
                </div>
              </div>
            )}

            {quality && !hasAlert && (
              <div
                role="status"
                className={`rounded-2xl border p-3.5 text-xs leading-relaxed ${
                  quality.grade === 'good'
                    ? 'border-emerald-300/60 bg-emerald-50 dark:bg-emerald-950/20 dark:border-emerald-900/50 text-emerald-900 dark:text-emerald-200'
                    : quality.grade === 'fair'
                      ? 'border-amber-300/70 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900/50 text-amber-900 dark:text-amber-200'
                      : 'border-rose-300/70 bg-rose-50 dark:bg-rose-950/20 dark:border-rose-900/50 text-rose-900 dark:text-rose-200'
                }`}
              >
                <p className="font-semibold">
                  Оценка текущего распознавания{currentBookMode ? ` (${currentBookMode})` : ''}: {quality.score}/100
                </p>
                <p className="mt-0.5">{quality.recommendation ?? quality.summary}</p>
                {onOpenEditor && (
                  <button type="button" onClick={onOpenEditor} className="mt-1.5 underline font-semibold">
                    Исправить текст в редакторе
                  </button>
                )}
              </div>
            )}

            {/* Аккордеон / выбор режимов */}
            {hasAlert ? (
              <div className="pt-2 border-t border-slate-100 dark:border-zinc-800">
                <button
                  type="button"
                  onClick={() => setShowAdvancedModes(!showAdvancedModes)}
                  className="flex items-center justify-between w-full text-xs font-semibold text-slate-500 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200 py-1 transition-colors"
                >
                  <span>Продвинутые встроенные режимы (Gemini AI, Tesseract, PyMuPDF)</span>
                  {showAdvancedModes ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>

                {showAdvancedModes && (
                  <div className="mt-3 space-y-3">
                    {modes.map((mode) => {
                      const isSelected = currentMode === mode.id;
                      return (
                        <button
                          type="button"
                          key={mode.id}
                          onClick={() => onSelectMode(mode.id, rememberDefault)}
                          aria-pressed={isSelected}
                          className={`block w-full text-left p-3.5 rounded-2xl border cursor-pointer transition-all ${
                            isSelected
                              ? 'border-amber-500 bg-amber-50/40 dark:bg-amber-950/20 shadow-sm ring-1 ring-amber-500/30'
                              : 'border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:hover:border-zinc-700 hover:bg-slate-50/50 dark:hover:bg-zinc-800/40'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2 mb-1">
                            <div className="flex items-center gap-2">
                              {mode.icon}
                              <span className="font-bold text-xs text-slate-900 dark:text-zinc-100">
                                {mode.title}
                              </span>
                            </div>
                            <span className={`text-[10px] px-2 py-0.5 rounded-md font-medium border ${mode.badgeColor} shrink-0`}>
                              {suggested(mode.id) ? 'Попробуйте этот режим' : mode.badge}
                            </span>
                          </div>

                          <p className="text-[11px] text-slate-600 dark:text-zinc-300 leading-relaxed mb-1">
                            {mode.description}
                          </p>

                          <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] pt-1 border-t border-slate-100 dark:border-zinc-800/60">
                            <span className="text-slate-600 dark:text-zinc-400">
                              <Target className="inline w-3 h-3 mr-1 -mt-0.5" aria-hidden="true" />
                              <strong>Назначение:</strong> {mode.bestFor}
                            </span>
                            {mode.note && (
                              <span className="text-amber-700 dark:text-amber-400 font-medium">
                                <TriangleAlert className="inline w-3 h-3 mr-1 -mt-0.5" aria-hidden="true" />
                                {mode.note}
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <>
                <p className="text-sm text-slate-600 dark:text-zinc-400 leading-relaxed">
                  Выберите механизм обработки документа в зависимости от его типа и качества верстки:
                </p>

                <div className="space-y-3">
                  {modes.map((mode) => {
                    const isSelected = currentMode === mode.id;
                    return (
                      <button
                        type="button"
                        key={mode.id}
                        onClick={() => onSelectMode(mode.id, rememberDefault)}
                        aria-pressed={isSelected}
                        className={`block w-full text-left p-4 rounded-2xl border cursor-pointer transition-all ${
                          isSelected
                            ? 'border-amber-500 bg-amber-50/40 dark:bg-amber-950/20 shadow-sm ring-1 ring-amber-500/30'
                            : 'border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:hover:border-zinc-700 hover:bg-slate-50/50 dark:hover:bg-zinc-800/40'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2 mb-1.5">
                          <div className="flex items-center gap-2">
                            {mode.icon}
                            <span className="font-bold text-sm text-slate-900 dark:text-zinc-100">
                              {mode.title}
                            </span>
                          </div>
                          <span className={`text-[10px] px-2 py-0.5 rounded-md font-medium border ${mode.badgeColor} shrink-0`}>
                            {suggested(mode.id) ? 'Попробуйте этот режим' : mode.badge}
                          </span>
                        </div>

                        <p className="text-xs text-slate-600 dark:text-zinc-300 leading-relaxed mb-1.5">
                          {mode.description}
                        </p>

                        <div className="flex flex-wrap items-center justify-between gap-1 text-[11px] pt-1 border-t border-slate-100 dark:border-zinc-800/60">
                          <span className="text-slate-600 dark:text-zinc-400">
                            <Target className="inline w-3.5 h-3.5 mr-1 -mt-0.5" aria-hidden="true" />
                            <strong>Назначение:</strong> {mode.bestFor}
                          </span>
                          {mode.note && (
                            <span className="text-amber-700 dark:text-amber-400 font-medium">
                              <TriangleAlert className="inline w-3.5 h-3.5 mr-1 -mt-0.5" aria-hidden="true" />
                              {mode.note}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {showRememberCheckbox && (
                  <label className="flex items-center gap-2 pt-1 text-xs text-slate-600 dark:text-zinc-400 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={rememberDefault}
                      onChange={(e) => setRememberDefault(e.target.checked)}
                      className="rounded text-amber-500 accent-amber-500"
                    />
                    <span>Запомнить мой выбор и не спрашивать при открытии других PDF</span>
                  </label>
                )}
              </>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition"
              >
                Закрыть
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};
