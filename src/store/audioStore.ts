import { create } from 'zustand';
import { audioManager } from '../engine/audio/audioManager';
import {
  INITIAL_PLAYER_STATE,
  PlayerEvent,
  PlayerState,
  PlayerStatus,
  PlayTrigger,
  acceptEnded,
  isPausedStatus,
  isPlayingStatus,
  reducePlayer,
  shouldAnnounceChapter,
} from '../engine/audio/playerState';
import { nextTextStep } from '../engine/audio/textSource';
import { useBookStore } from './bookStore';
import { usePagedStore } from './pagedStore';
import {
  firstSentenceAtOrAfterPage,
  nextStep,
  prevSentenceOf,
  type ComposedBook,
} from '../engine/pdf/composer';
import { pageOfSentenceId } from '../engine/pdf/pageSentences';
import type { SentenceItem } from '../types/book';
import { useSettingsStore } from './settingsStore';
import { SynthesisOptions } from '../types/tts';
import { getCatalogModelInfo, getKnownModelVoices, normalizeAggregatorVoice } from '../engine/providers/openRouterTts';

/**
 * Собирает параметры синтеза из текущих настроек (общая точка для плеера и кнопки «Тест озвучки»).
 * Голос берётся отдельно для каждого провайдера; для агрегатора пустой голос = «по умолчанию модели».
 */
export function buildSynthesisOptions(settings = useSettingsStore.getState()): SynthesisOptions {
  const provider = settings.activeProvider;
  const apiKey = provider === 'gemini' ? settings.apiKeys.gemini
    : provider === 'openai' ? settings.apiKeys.openai
    : provider === 'elevenlabs' ? settings.apiKeys.elevenlabs
    : provider === 'openrouter' ? settings.apiKeys.openrouter
    : undefined;

  const model = provider === 'gemini' ? settings.geminiModel
    : provider === 'openrouter' ? (settings.openRouterModel?.trim() || 'openai/gpt-audio-mini')
    : undefined;

  let voiceId = settings.selectedVoiceIds?.[provider] ?? '';
  if (provider === 'openrouter') {
    voiceId = normalizeAggregatorVoice(voiceId);
    // Если модель известна и голос ей не подходит — не отправляем его вовсе
    const catalogVoices = getCatalogModelInfo(settings.openRouterBaseUrl, model)?.voices;
    if (voiceId && catalogVoices && catalogVoices.length > 0) {
      if (!catalogVoices.includes(voiceId)) voiceId = '';
    } else {
      const known = getKnownModelVoices(model);
      if (voiceId && known && !known.some((v) => v.id === voiceId)) voiceId = '';
    }
  }

  const speed = Number.isFinite(settings.speed) ? Math.max(0.5, Math.min(2.5, settings.speed)) : 1;
  const volume = Number.isFinite(settings.volume) ? Math.max(0, Math.min(1, settings.volume)) : 1;

  return {
    voiceId,
    speed,
    pitch: Number.isFinite(settings.pitch) ? settings.pitch : 0,
    volume,
    apiKey,
    model,
    baseUrl: provider === 'openrouter' ? (settings.openRouterBaseUrl || 'https://openrouter.ai/api/v1') : undefined,
    apiMode: provider === 'openrouter' ? (settings.openRouterApiMode || 'auto') : undefined,
  };
}

interface AudioState {
  /** ЕДИНСТВЕННЫЙ источник истины о плеере (см. engine/audio/playerState.ts) */
  status: PlayerStatus;
  error: string | null;
  /** Информационное сообщение об остановке («Конец книги», «Конец главы»); сбрасывается при новом запуске */
  notice: string | null;
  /** Номер актуальной команды воспроизведения (защита от устаревших событий) */
  playToken: number;
  /** Постраничные PDF: чтение ждёт распознавания этой страницы (status = loading) */
  waitingPage: number | null;

  /** Производные (только чтение, для обратной совместимости): isPlaying = loading|playing, isPaused = paused */
  isPlaying: boolean;
  isPaused: boolean;
  isBuffering: boolean;

  clearError: () => void;
  /** idle/error → старт; paused → продолжить; loading/playing → ничего */
  play: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  playNextSentence: () => Promise<void>;
  playPrevSentence: () => Promise<void>;
  jumpToSentence: (sentenceId: number) => Promise<void>;
}

function derive(status: PlayerStatus) {
  return {
    isPlaying: isPlayingStatus(status),
    isPaused: isPausedStatus(status),
    isBuffering: status === 'loading',
  };
}

export const useAudioStore = create<AudioState>((set, get) => {
  /** Применяет событие к машине состояний одним set(): статус и производные флаги меняются атомарно */
  const dispatch = (event: PlayerEvent): PlayerState => {
    const cur = get();
    const prev: PlayerState = { status: cur.status, error: cur.error, token: cur.playToken };
    const next = reducePlayer(prev, event);
    if (next !== prev) {
      set({ status: next.status, error: next.error, playToken: next.token, ...derive(next.status) });
    }
    return next;
  };

  /** true, пока мы сами меняем главу (подписка на bookStore не должна запускать озвучку повторно) */
  let internalChapterChange = false;
  const setChapterInternally = (index: number) => {
    internalChapterChange = true;
    try {
      useBookStore.getState().setChapterIndex(index);
    } finally {
      internalChapterChange = false;
    }
  };

  const stopAll = (notice: string | null = null) => {
    audioManager.stop();
    dispatch({ type: 'stop' });
    set({ notice, waitingPage: null });
  };

  // ------------------------------------------------------------------ постраничные PDF

  /** Ключ «главы» для аудиокэша: по странице, а не по главе — главы достраиваются и могут менять id */
  const pagedKey = (sentence: SentenceItem) => `pg${pageOfSentenceId(sentence.id)}`;
  let waitMode: 'jump' | 'next' = 'next';

  const isPaged = () => Boolean(useBookStore.getState().currentBook?.metadata.paged);

  /** Чтение ждёт страницу: плеер в статусе loading, сообщение «Распознаём страницу N…» показывает панель страниц */
  const beginWait = (page: number, mode: 'jump' | 'next') => {
    audioManager.stop();
    dispatch({ type: 'request' });
    waitMode = mode;
    set({ notice: null, waitingPage: page });
    usePagedStore.getState().setFocusPage(page);
  };

  const readyPageState = (composed: ComposedBook, page: number) => {
    const paged = usePagedStore.getState();
    return paged.stateOf(page) === 'done' && composed.pages[page - 1]?.state === 'done';
  };

  const startPagedPlayback = (trigger: PlayTrigger) => {
    const book = useBookStore.getState();
    const paged = usePagedStore.getState();
    const settings = useSettingsStore.getState();
    const composed = paged.composed;
    if (!book.currentBook || !composed) {
      stopAll();
      return;
    }
    let sentenceId = book.currentSentenceId;
    if (sentenceId == null || !composed.indexById.has(sentenceId)) {
      // Позиция не определена: страница не распознана (ждём её) либо пуста (берём ближайший текст дальше)
      const page = book.currentPage;
      if (!readyPageState(composed, page)) {
        beginWait(page, 'jump');
        return;
      }
      const first = firstSentenceAtOrAfterPage(composed, page);
      if (!first) {
        let waitPage: number | null = null;
        for (let p = page + 1; p <= composed.pageCount; p++) {
          if (paged.stateOf(p) !== 'done') {
            waitPage = p;
            break;
          }
        }
        if (waitPage !== null) beginWait(waitPage, 'jump');
        else stopAll('Конец книги');
        return;
      }
      sentenceId = first.id;
      useBookStore.getState().setSentenceId(sentenceId);
    }
    const sentence = composed.order[composed.indexById.get(sentenceId) as number];
    const chapterIndex = composed.chapterOfSentence.get(sentenceId) ?? 0;
    const chapter = composed.chapters[chapterIndex];

    const state = dispatch({ type: 'request' });
    set({ notice: null, waitingPage: null });

    // Следующая фраза для предзагрузки (только если следующая страница уже распознана)
    const step = nextStep(composed, (p) => paged.stateOf(p), sentence.id);
    let next: { chapterId: string; sentence: SentenceItem } | null = null;
    if (step.kind === 'sentence' && (step.chapterIndex === chapterIndex || settings.autoAdvanceChapter)) {
      next = { chapterId: pagedKey(step.sentence), sentence: step.sentence };
    }

    // Название главы озвучиваем только в её начале; переход между страницами внутри главы — без объявления
    const startsChapter = Boolean(chapter) && chapter.sentences[0]?.id === sentence.id && composed.pages[(chapter.startPage ?? 1) - 1]?.state === 'done';
    const announce = shouldAnnounceChapter({
      enabled: settings.announceChapters,
      title: chapter?.title,
      sentenceIndex: startsChapter ? 0 : 1,
      trigger,
    });

    audioManager.speak({
      token: state.token,
      bookId: book.currentBook.metadata.id,
      chapterId: pagedKey(sentence),
      sentence,
      providerType: settings.activeProvider,
      options: buildSynthesisOptions(settings),
      intro: announce && chapter ? { title: chapter.title, chime: settings.chapterChime } : null,
      next,
    });
  };

  const advancePaged = (auto: boolean) => {
    const book = useBookStore.getState();
    const paged = usePagedStore.getState();
    const composed = paged.composed;
    const cur = book.currentSentenceId;
    if (!composed || cur == null) return;
    const autoAdvance = !auto || useSettingsStore.getState().autoAdvanceChapter;
    const step = nextStep(composed, (p) => paged.stateOf(p), cur);
    if (step.kind === 'sentence') {
      const sameChapter = step.chapterIndex === book.currentChapterIndex;
      if (!sameChapter && !autoAdvance) {
        stopAll('Конец главы');
        return;
      }
      book.setSentenceId(step.sentence.id);
      startPlayback(sameChapter ? 'navigate' : 'chapter');
    } else if (step.kind === 'wait') {
      beginWait(step.page, 'next');
    } else {
      stopAll('Конец книги');
    }
  };

  /** Страница, которую ждёт плеер, распознана — продолжаем чтение */
  const checkWait = () => {
    const w = get().waitingPage;
    if (w == null) return;
    if (get().status !== 'loading') {
      set({ waitingPage: null });
      return;
    }
    const composed = usePagedStore.getState().composed;
    if (!composed || !readyPageState(composed, w)) return;
    set({ waitingPage: null });
    if (waitMode === 'jump' || useBookStore.getState().currentSentenceId == null) startPlayback('navigate');
    else advancePaged(false);
  };

  usePagedStore.subscribe((state, prev) => {
    if (state.navNonce !== prev.navNonce) {
      // Явный переход (страница, глава) во время озвучки: читаем с новой позиции
      const status = get().status;
      if (status === 'loading' || status === 'playing') {
        set({ waitingPage: null });
        startPlayback('chapter');
      } else if (status !== 'idle') {
        stopAll();
      }
      return;
    }
    if (get().waitingPage != null) checkWait();
  });

  /** Запускает озвучку с текущей позиции (предложение уже выбрано в bookStore) */
  const startPlayback = (trigger: PlayTrigger) => {
    if (isPaged()) {
      startPagedPlayback(trigger);
      return;
    }
    const book = useBookStore.getState();
    const settings = useSettingsStore.getState();
    const chapter = book.getCurrentChapter();
    if (!book.currentBook || !chapter || chapter.sentences.length === 0) {
      stopAll();
      return;
    }
    const sentenceIndex = book.getCurrentSentenceIndex();
    const sentence = chapter.sentences[sentenceIndex];

    const state = dispatch({ type: 'request' });
    set({ notice: null });

    // Следующая фраза (в т.ч. первая в следующей главе) — для предзагрузки
    let next: { chapterId: string; sentence: typeof sentence } | null = null;
    if (sentenceIndex + 1 < chapter.sentences.length) {
      next = { chapterId: chapter.id, sentence: chapter.sentences[sentenceIndex + 1] };
    } else if (settings.autoAdvanceChapter) {
      const following = book.currentBook.chapters.slice(book.currentChapterIndex + 1).find((c) => c.sentences.length > 0);
      if (following) next = { chapterId: following.id, sentence: following.sentences[0] };
    }

    const announce = shouldAnnounceChapter({
      enabled: settings.announceChapters,
      title: chapter.title,
      sentenceIndex,
      trigger,
    });

    audioManager.speak({
      token: state.token,
      bookId: book.currentBook.metadata.id,
      chapterId: chapter.id,
      sentence,
      providerType: settings.activeProvider,
      options: buildSynthesisOptions(settings),
      intro: announce ? { title: chapter.title, chime: settings.chapterChime } : null,
      next,
    });
  };

  /** Переход к следующей фразе; auto=true — по окончании фразы (учитывает «авто-переход») */
  const advance = (auto: boolean) => {
    if (isPaged()) {
      advancePaged(auto);
      return;
    }
    const book = useBookStore.getState();
    const bookData = book.currentBook;
    if (!bookData) return;
    const autoAdvance = !auto || useSettingsStore.getState().autoAdvanceChapter;
    const result = nextTextStep({
      book: bookData,
      currentChapterIndex: book.currentChapterIndex,
      currentSentenceIndex: book.getCurrentSentenceIndex(),
      autoAdvanceChapter: autoAdvance,
    });

    if (result.kind === 'sentence') {
      book.setSentenceId(result.sentence.id);
      startPlayback('navigate');
    } else if (result.kind === 'chapter') {
      setChapterInternally(result.chapterIndex);
      startPlayback('chapter');
    } else {
      stopAll(result.kind === 'end-of-book' ? 'Конец книги' : 'Конец главы');
    }
  };

  audioManager.setHandlers({
    onStarted: (token) => {
      dispatch({ type: 'started', token });
    },
    onEnded: (token) => {
      const cur = get();
      if (!acceptEnded({ status: cur.status, error: cur.error, token: cur.playToken }, token)) return;
      advance(true);
    },
    onFailed: (token, message) => {
      const before = get().playToken;
      const next = dispatch({ type: 'failed', token, message });
      if (next.token !== before) audioManager.stop(); // ошибка принята — гасим остатки движка
    },
  });

  // Ручная смена главы / закрытие книги во время воспроизведения
  useBookStore.subscribe((state, prev) => {
    if (internalChapterChange) return;
    const bookChanged = state.currentBook?.metadata.id !== prev.currentBook?.metadata.id;
    const chapterChanged = state.currentChapterIndex !== prev.currentChapterIndex;
    if (!bookChanged && !chapterChanged) return;
    const status = get().status;
    if (status === 'idle') return;
    if (bookChanged || !state.currentBook) {
      stopAll();
    } else if (state.currentBook.metadata.paged) {
      // Постраничная книга: смена индекса главы при достройке содержания — не навигация (см. navNonce)
      return;
    } else if (status === 'loading' || status === 'playing') {
      startPlayback('chapter');
    } else {
      stopAll(); // на паузе/в ошибке: старое аудио относится к прежней главе
    }
  });

  // Скорость и громкость применяются сразу, не дожидаясь следующей фразы
  useSettingsStore.subscribe((state, prev) => {
    if (state.speed !== prev.speed) audioManager.setSpeed(state.speed);
    if (state.volume !== prev.volume) audioManager.setVolume(state.volume);
  });

  return {
    status: INITIAL_PLAYER_STATE.status,
    error: null,
    notice: null,
    playToken: INITIAL_PLAYER_STATE.token,
    waitingPage: null,
    ...derive('idle'),

    clearError: () => set({ error: null }),

    play: async () => {
      const { status } = get();
      if (status === 'paused') get().resume();
      else if (status === 'idle' || status === 'error') startPlayback('start');
    },

    pause: () => {
      const status = get().status;
      if (status === 'playing') {
        audioManager.pause();
        dispatch({ type: 'pause' });
      } else if (status === 'loading') {
        stopAll(); // пауза во время загрузки = остановка
      }
    },

    resume: () => {
      if (get().status !== 'paused') return;
      dispatch({ type: 'resume' });
      audioManager.resume();
    },

    stop: () => stopAll(),

    playNextSentence: async () => advance(false),

    playPrevSentence: async () => {
      const book = useBookStore.getState();
      if (book.currentBook?.metadata.paged) {
        const composed = usePagedStore.getState().composed;
        const cur = book.currentSentenceId;
        const prev = composed && cur != null ? prevSentenceOf(composed, cur) : null;
        if (prev) {
          book.setSentenceId(prev.sentence.id);
          startPlayback('navigate');
        }
        return;
      }
      const chapter = book.getCurrentChapter();
      if (!chapter || chapter.sentences.length === 0) return;
      const prevIndex = Math.max(0, book.getCurrentSentenceIndex() - 1);
      book.setSentenceId(chapter.sentences[prevIndex].id);
      startPlayback('navigate');
    },

    jumpToSentence: async (sentenceId: number) => {
      useBookStore.getState().setSentenceId(sentenceId);
      const status = get().status;
      if (status === 'loading' || status === 'playing' || status === 'paused') startPlayback('navigate');
    },
  };
});

if (typeof window !== 'undefined' && (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __aibrAudio?: typeof useAudioStore }).__aibrAudio = useAudioStore;
}
