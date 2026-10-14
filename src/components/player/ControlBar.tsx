import React, { useState, useRef, useEffect } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Loader2,
  Gauge,
  Sparkles,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  List,
  BookText,
  ScrollText,
  Bell,
  Square,
} from 'lucide-react';
import { useAudioStore } from '../../store/audioStore';
import { coordinator } from '../../engine/audio/coordinator';
import { setChapterIndex } from '../../engine/navigation';
import { useBookStore } from '../../store/bookStore';
import { useSettingsStore } from '../../store/settingsStore';
import { setSpeed, setVolume, setAutoscroll, setAnnounceChapters, setChapterChime, setAutoAdvanceChapter } from '../../engine/settings';

const SPEED_PRESETS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5];

/** Общие классы для «тихих» кнопок панели (контрастные в светлой, тёмной и sepia-темах) */
const ICON_BTN =
  'p-2 rounded-lg text-slate-600 dark:text-zinc-300 sepia:text-[#4a3920] hover:bg-slate-100 dark:hover:bg-zinc-800 sepia:hover:bg-[#e2cf9f] transition-colors';
const CHIP_IDLE =
  'border-slate-200 dark:border-zinc-700 sepia:border-[#b59a62] text-slate-600 dark:text-zinc-300 sepia:text-[#4a3920] hover:bg-slate-100 dark:hover:bg-zinc-800 sepia:hover:bg-[#e2cf9f]';
const CHIP_ACTIVE =
  'bg-amber-50 dark:bg-amber-950/40 sepia:bg-[#e8c877] border-amber-300 dark:border-amber-700/60 sepia:border-[#a8823a] text-amber-700 dark:text-amber-400 sepia:text-[#5a3205]';
const POPOVER =
  'absolute right-0 bottom-full mb-2 bg-white dark:bg-zinc-900 sepia:bg-[#f6ecd2] sepia:border-[#b59a62] border border-slate-200 dark:border-zinc-800 rounded-2xl shadow-xl z-50';

interface ControlBarProps {
  onToggleChapters?: () => void;
  isChaptersOpen?: boolean;
  onOpenDictionary?: () => void;
  onOpenTTS?: () => void;
}

/** Закрытие всплывающего меню по клику вне и по Escape */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, close]);
}

export const ControlBar: React.FC<ControlBarProps> = ({
  onToggleChapters,
  isChaptersOpen,
  onOpenDictionary,
  onOpenTTS,
}) => {
  const status = useAudioStore((s) => s.status);
  const error = useAudioStore((s) => s.error);
  const notice = useAudioStore((s) => s.notice);
  const { clearError, play, pause, stop, playNextSentence, playPrevSentence } = coordinator;

  const currentBook = useBookStore((state) => state.currentBook);
  const currentChapter = useBookStore((state) => state.getCurrentChapter());
  const currentChapterIndex = useBookStore((state) => state.currentChapterIndex);
  const currentSentenceIndex = useBookStore((state) => state.getCurrentSentenceIndex());

  const {
    speed, volume, activeProvider, geminiModel, openRouterModel, autoscroll, announceChapters, chapterChime, autoAdvanceChapter } = useSettingsStore();

  const [isSpeedMenuOpen, setIsSpeedMenuOpen] = useState(false);
  const speedMenuRef = useRef<HTMLDivElement | null>(null);
  const [isChapterMenuOpen, setIsChapterMenuOpen] = useState(false);
  const chapterMenuRef = useRef<HTMLDivElement | null>(null);

  useDismiss(isSpeedMenuOpen, speedMenuRef, () => setIsSpeedMenuOpen(false));
  useDismiss(isChapterMenuOpen, chapterMenuRef, () => setIsChapterMenuOpen(false));

  if (!currentBook || !currentChapter) return null;

  const totalSentences = currentChapter.sentences.length;
  const totalChapters = currentBook.chapters.length;

  // Кнопка отражает ТОЛЬКО status: loading → остановить, playing → пауза, остальное → воспроизвести
  const handlePlayToggle = () => {
    if (status === 'loading') stop();
    else if (status === 'playing') pause();
    else void play();
  };
  const playLabel =
    status === 'loading' ? 'Загрузка… Нажмите, чтобы остановить' : status === 'playing' ? 'Пауза' : 'Воспроизвести';

  const chapterToggles = [
    { label: 'Озвучивать название главы', value: announceChapters, set: setAnnounceChapters },
    { label: 'Звук перехода', value: chapterChime, set: setChapterChime },
    { label: 'Авто-переход к следующей главе', value: autoAdvanceChapter, set: setAutoAdvanceChapter },
  ];

  return (
    <div className="w-full shrink-0 bg-white/95 dark:bg-zinc-900/95 sepia:bg-[#ead9ad] sepia:text-[#3b2d1a] border-t border-slate-200 dark:border-zinc-800 sepia:border-[#b59a62] backdrop-blur-md px-4 py-2.5 shadow-lg transition-colors z-30 select-none">
      <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">

        {/* Левая часть: Провайдер, глава и номер фразы */}
        <div className="flex items-center gap-2.5 w-full sm:w-auto justify-between sm:justify-start">
          <button
            onClick={onOpenTTS}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-100 dark:bg-zinc-800 sepia:bg-[#dcc890] sepia:border-[#b59a62] hover:bg-amber-50 dark:hover:bg-amber-950/40 sepia:hover:bg-[#e8d7aa] border border-slate-200 dark:border-zinc-700 hover:border-amber-500/40 text-xs text-slate-700 dark:text-zinc-300 sepia:text-[#3b2d1a] hover:text-amber-600 dark:hover:text-amber-400 font-medium transition-all group"
            title="Нажмите для смены модели озвучки или диктора"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-500 sepia:text-[#b45309] group-hover:rotate-12 transition-transform" />
            <span className="font-medium text-[11px]">
              {activeProvider === 'gemini'
                ? (geminiModel.includes('flash-lite') ? 'Gemini 3.8 Lite' : 'Gemini 3.8 Flash')
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
                          : (activeProvider as string).toUpperCase()
              }
            </span>
          </button>

          {/* Быстрое переключение глав в плеере */}
          <div className="flex items-center gap-1 text-xs text-slate-500 dark:text-zinc-400 sepia:text-[#4a3920]">
            <button
              onClick={() => currentChapterIndex > 0 && setChapterIndex(currentChapterIndex - 1)}
              disabled={currentChapterIndex === 0}
              className="p-1 rounded hover:bg-slate-100 dark:hover:bg-zinc-800 sepia:hover:bg-[#e2cf9f] disabled:opacity-30 disabled:pointer-events-none transition-colors"
              title="Предыдущая глава"
              aria-label="Предыдущая глава"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onToggleChapters}
              className="font-medium hover:text-amber-500 underline decoration-dotted transition-colors"
              title="Открыть список глав"
            >
              Гл. {currentChapterIndex + 1}/{totalChapters}
            </button>
            <button
              onClick={() => currentChapterIndex < totalChapters - 1 && setChapterIndex(currentChapterIndex + 1)}
              disabled={currentChapterIndex >= totalChapters - 1}
              className="p-1 rounded hover:bg-slate-100 dark:hover:bg-zinc-800 sepia:hover:bg-[#e2cf9f] disabled:opacity-30 disabled:pointer-events-none transition-colors"
              title="Следующая глава"
              aria-label="Следующая глава"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="text-xs text-slate-500 dark:text-zinc-400 sepia:text-[#4a3920] font-mono hidden md:inline">
            {totalSentences > 0 ? (
              <span>
                Фраза <strong className="text-slate-800 dark:text-zinc-200 sepia:text-[#2b2114]">{currentSentenceIndex + 1}</strong> из {totalSentences}
              </span>
            ) : (
              'Нет фраз'
            )}
          </div>
        </div>

        {/* Центральные кнопки управления плеером */}
        <div className="flex items-center gap-3">
          <button
            onClick={playPrevSentence}
            disabled={currentSentenceIndex === 0}
            className={`${ICON_BTN} rounded-full disabled:opacity-30 disabled:pointer-events-none`}
            title="Предыдущее предложение (←)"
            aria-label="Предыдущее предложение"
          >
            <SkipBack className="w-5 h-5" />
          </button>

          <button
            onClick={handlePlayToggle}
            data-status={status}
            aria-label={playLabel}
            title={
              status === 'playing'
                ? 'Пауза (Пробел)'
                : status === 'loading'
                  ? 'Загрузка… Нажмите, чтобы остановить (Пробел)'
                  : 'Воспроизвести (Пробел)'
            }
            className="relative p-3.5 rounded-full bg-amber-500 hover:bg-amber-600 sepia:bg-[#b45309] sepia:hover:bg-[#92400e] active:scale-95 text-white shadow-md hover:shadow-amber-500/25 transition-all flex items-center justify-center"
          >
            {status === 'loading' ? (
              <>
                <Loader2 className="w-6 h-6 animate-spin" aria-hidden="true" />
                <Square className="absolute w-2.5 h-2.5 fill-current" aria-hidden="true" />
              </>
            ) : status === 'playing' ? (
              <Pause className="w-6 h-6" aria-hidden="true" />
            ) : (
              <Play className="w-6 h-6 ml-0.5" aria-hidden="true" />
            )}
          </button>

          <button
            onClick={playNextSentence}
            disabled={currentSentenceIndex >= totalSentences - 1 && currentChapterIndex >= totalChapters - 1}
            className={`${ICON_BTN} rounded-full disabled:opacity-30 disabled:pointer-events-none`}
            title="Следующее предложение (→)"
            aria-label="Следующее предложение"
          >
            <SkipForward className="w-5 h-5" />
          </button>
        </div>

        {/* Правые контролы */}
        <div className="flex items-center gap-2.5 w-full sm:w-auto justify-end relative">

          {/* Быстрый переключатель автопрокрутки */}
          <button
            type="button"
            onClick={() => setAutoscroll(!autoscroll)}
            aria-pressed={autoscroll}
            aria-label="Автопрокрутка"
            title={`Автопрокрутка за озвучкой: ${autoscroll ? 'включена' : 'выключена'}`}
            className={`flex items-center gap-1.5 p-2 sm:px-2.5 sm:py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              autoscroll ? CHIP_ACTIVE : CHIP_IDLE
            }`}
          >
            <ScrollText className="w-4 h-4" aria-hidden="true" />
            <span className="hidden sm:inline whitespace-nowrap">Автопрокрутка</span>
          </button>

          {/* Переход между главами: озвучка названия, звук, авто-переход */}
          <div className="relative" ref={chapterMenuRef}>
            <button
              type="button"
              onClick={() => setIsChapterMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={isChapterMenuOpen}
              aria-label="Переход между главами"
              title="Переход между главами: название, звук, авто-переход"
              className={`flex items-center gap-1.5 p-2 sm:px-2.5 sm:py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                isChapterMenuOpen ? CHIP_ACTIVE : CHIP_IDLE
              }`}
            >
              <Bell className="w-4 h-4" aria-hidden="true" />
              <span className="hidden sm:inline whitespace-nowrap">Главы</span>
            </button>
            {isChapterMenuOpen && (
              <div role="menu" className={`${POPOVER} w-64 p-2`}>
                {chapterToggles.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={item.value}
                    onClick={() => item.set(!item.value)}
                    className="w-full flex items-center justify-between gap-3 px-2.5 py-2 rounded-xl text-left text-xs font-medium text-slate-700 dark:text-zinc-200 sepia:text-[#3b2d1a] hover:bg-slate-100 dark:hover:bg-zinc-800 sepia:hover:bg-[#e8d7aa] transition-colors"
                  >
                    <span>{item.label}</span>
                    <span
                      aria-hidden="true"
                      className={`shrink-0 w-8 h-[18px] rounded-full p-0.5 transition-colors ${
                        item.value ? 'bg-amber-500 sepia:bg-[#b45309]' : 'bg-slate-300 dark:bg-zinc-600 sepia:bg-[#c9b88e]'
                      }`}
                    >
                      <span
                        className={`block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${
                          item.value ? 'translate-x-3.5' : ''
                        }`}
                      />
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Быстрый словарь замен */}
          {onOpenDictionary && (
            <button onClick={onOpenDictionary} className={ICON_BTN} title="Словарь замен и произношения" aria-label="Словарь замен и произношения">
              <BookText className="w-4 h-4 text-amber-500 sepia:text-[#b45309]" />
            </button>
          )}

          {/* Быстрое открытие оглавления */}
          {onToggleChapters && (
            <button
              onClick={onToggleChapters}
              className={`p-2 rounded-lg transition-colors ${
                isChaptersOpen
                  ? 'bg-amber-50 dark:bg-amber-950/40 sepia:bg-[#e8c877] text-amber-600 dark:text-amber-400 sepia:text-[#5a3205]'
                  : 'text-slate-600 dark:text-zinc-300 sepia:text-[#4a3920] hover:bg-slate-100 dark:hover:bg-zinc-800 sepia:hover:bg-[#e2cf9f]'
              }`}
              title="Оглавление книги"
              aria-label="Оглавление книги"
            >
              <List className="w-4 h-4" />
            </button>
          )}

          {/* ВЫПАДАЮЩЕЕ МЕНЮ СКОРОСТИ */}
          <div className="relative" ref={speedMenuRef}>
            <button
              onClick={() => setIsSpeedMenuOpen(!isSpeedMenuOpen)}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-xl border text-xs font-semibold transition-colors ${CHIP_IDLE}`}
              title="Настройка скорости воспроизведения"
            >
              <Gauge className="w-3.5 h-3.5 text-amber-500 sepia:text-[#b45309]" />
              <span>{speed.toFixed(speed % 1 === 0 ? 0 : 2)}x</span>
              <ChevronUp className={`w-3 h-3 text-slate-400 sepia:text-[#7a6338] transition-transform ${isSpeedMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            {isSpeedMenuOpen && (
              <div className={`${POPOVER} w-56 p-3 animate-in fade-in slide-in-from-bottom-2 duration-150`}>
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-zinc-500 sepia:text-[#6b5530] mb-2">
                  Скорость речи: {speed.toFixed(2)}x
                </div>

                {/* Сетка пресетов скорости */}
                <div className="grid grid-cols-4 gap-1.5 mb-3">
                  {SPEED_PRESETS.map((p) => (
                    <button
                      key={p}
                      onClick={() => {
                        setSpeed(p);
                        setIsSpeedMenuOpen(false);
                      }}
                      className={`py-1 text-xs rounded-lg font-medium transition-all ${
                        speed === p
                          ? 'bg-amber-500 sepia:bg-[#b45309] text-white font-bold shadow-sm'
                          : 'bg-slate-100 dark:bg-zinc-800 sepia:bg-[#e2cf9f] text-slate-700 dark:text-zinc-300 sepia:text-[#3b2d1a] hover:bg-slate-200 dark:hover:bg-zinc-700 sepia:hover:bg-[#d6bf84]'
                      }`}
                    >
                      {p}x
                    </button>
                  ))}
                </div>

                {/* Плавный ползунок для точной подстройки */}
                <div className="pt-1 border-t border-slate-100 dark:border-zinc-800 sepia:border-[#cdb88c]">
                  <input
                    type="range"
                    min="0.5"
                    max="2.5"
                    step="0.05"
                    value={speed}
                    onChange={(e) => setSpeed(parseFloat(e.target.value) || 1)}
                    className="w-full accent-amber-500 sepia:accent-[#b45309] cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-slate-400 sepia:text-[#6b5530] mt-0.5">
                    <span>0.5x</span>
                    <span>1.0x</span>
                    <span>2.5x</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Громкость */}
          <div className="flex items-center gap-1.5 text-slate-600 dark:text-zinc-400 sepia:text-[#4a3920]">
            <button
              onClick={() => setVolume(volume > 0 ? 0 : 1)}
              className="p-1 hover:text-slate-900 dark:hover:text-zinc-100"
              title={volume === 0 ? 'Включить звук' : 'Выключить звук'}
              aria-label={volume === 0 ? 'Включить звук' : 'Выключить звук'}
            >
              {volume === 0 ? <VolumeX className="w-4 h-4 text-rose-500" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value) || 0)}
              className="w-16 h-1.5 bg-slate-200 dark:bg-zinc-700 sepia:bg-[#c9b27a] rounded-lg appearance-none cursor-pointer accent-amber-500 sepia:accent-[#b45309]"
              title={`Громкость: ${Math.round(volume * 100)}%`}
              aria-label="Громкость"
            />
          </div>
        </div>
      </div>

      {/* Информация об остановке: конец книги / главы */}
      {notice && !error && status === 'idle' && (
        <div
          role="status"
          className="max-w-4xl mx-auto mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-400 sepia:text-[#3f5a1a] bg-emerald-50 dark:bg-emerald-950/20 sepia:bg-[#dfe6bb] py-1.5 px-3 rounded-lg border border-emerald-200 dark:border-emerald-900/40 sepia:border-[#a9b66b]"
        >
          {notice}
        </div>
      )}

      {/* Оповещение об ошибке (неблокирующее, можно закрыть) */}
      {error && (
        <div
          role="alert"
          className="max-w-4xl mx-auto mt-2 text-xs text-rose-600 dark:text-rose-400 font-medium bg-rose-50 dark:bg-rose-950/20 py-1.5 px-3 rounded-lg border border-rose-200 dark:border-rose-900/40 flex items-start gap-2"
        >
          <span className="flex-1 break-words whitespace-pre-wrap max-h-24 overflow-y-auto text-left">{error}</span>
          <button
            type="button"
            onClick={clearError}
            aria-label="Скрыть сообщение об ошибке"
            className="shrink-0 px-1 leading-none text-rose-500 hover:text-rose-700 dark:hover:text-rose-300"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
};
