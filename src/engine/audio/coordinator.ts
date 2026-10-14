import { audioManager } from './audioManager';
import { acceptEnded, PlayTrigger, shouldAnnounceChapter } from './playerState';
import { cancelPrepare, prepareAudio } from './audioFetch';
import { useBookStore } from '../../store/bookStore';
import { useAudioStore } from '../../store/audioStore';
import { useSettingsStore } from '../../store/settingsStore';
import { SynthesisOptions, TTSProviderType } from '../../types/tts';
import type { SentenceItem } from '../../types/book';
import { getCatalogModelInfo, getKnownModelVoices, normalizeAggregatorVoice } from '../providers/openRouterTts';
import {
  chapterTarget,
  flushProgress,
  focusPage,
  goToPagedPage,
  navigatePaged,
  observeBook,
  pageReady,
  pagedPageRef,
  phraseAfterCurrent,
  phraseBeforeCurrent,
  phraseToPlay,
  progressRef,
  queueProgress,
  sentenceLocation,
} from '../library';

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

/** true, пока мы сами меняем главу (подписка на книгу не должна запускать озвучку повторно) */
let internalChapterChange = false;

export function setChapterInternally(index: number): void {
  internalChapterChange = true;
  try {
    setChapterIndex(index);
  } finally {
    internalChapterChange = false;
  }
}

/** Задание на подготовку озвучки следующей фразы: запускается, когда текущая зазвучала */
let pendingPrepare: {
  token: number;
  bookId: string;
  chapterKey: string;
  sentence: SentenceItem;
  providerType: TTSProviderType;
  options: SynthesisOptions;
} | null = null;

/** «Отмени»: Поставщик озвучки бросает подготовку следующей фразы */
function cancelPreparation(): void {
  pendingPrepare = null;
  cancelPrepare();
}

export function stopAll(notice: string | null = null): void {
  cancelPreparation();
  audioManager.stopPlayer(notice);
}

let waitMode: 'jump' | 'next' = 'next';

/** Чтение ждёт страницу: плеер в статусе loading, сообщение «Распознаём страницу N…» показывает панель страниц */
export function beginWait(page: number, mode: 'jump' | 'next'): void {
  waitMode = mode;
  cancelPreparation();
  audioManager.beginPlayerWait(page);
  focusPage(page);
}

/** Страница, которую ждёт плеер, распознана — продолжаем чтение */
export function checkWait(): void {
  const audioState = useAudioStore.getState();
  const w = audioState.waitingPage;
  if (w == null) return;
  if (audioState.status !== 'loading') {
    audioManager.clearWaitingPage();
    return;
  }
  if (!pageReady(w)) return;
  audioManager.clearWaitingPage();
  if (waitMode === 'jump' || useBookStore.getState().currentSentenceId == null) startPlayback('navigate');
  else advance(false);
}

/**
 * Запускает озвучку с текущей позиции (предложение уже выбрано в позиции чтения).
 * Фразу даёт Менеджер книги; Координатор собирает параметры синтеза ОДИН раз и отдаёт
 * Оркестратору «играй это», а Поставщику озвучки — «приготовь» следующую фразу (с теми же параметрами).
 */
export function startPlayback(trigger: PlayTrigger): void {
  const settings = useSettingsStore.getState();
  const phrase = phraseToPlay(settings.autoAdvanceChapter);
  if (phrase.kind === 'none') {
    stopAll();
    return;
  }
  if (phrase.kind === 'wait') {
    beginWait(phrase.page, 'jump');
    return;
  }
  if (phrase.kind === 'end') {
    stopAll('Конец книги');
    return;
  }
  if (phrase.positionFix) setSentenceId(phrase.sentence.id);

  const state = audioManager.startPlayerRequest();

  // Название главы озвучиваем только в её начале; переход между страницами внутри главы — без объявления
  const announce = shouldAnnounceChapter({
    enabled: settings.announceChapters,
    title: phrase.chapterTitle,
    sentenceIndex: phrase.announceIndex,
    trigger,
  });

  const options = buildSynthesisOptions(settings);
  cancelPreparation();
  pendingPrepare = phrase.next
    ? {
        token: state.token,
        bookId: phrase.bookId,
        chapterKey: phrase.next.chapterKey,
        sentence: phrase.next.sentence,
        providerType: settings.activeProvider,
        options,
      }
    : null;
  audioManager.speak({
    token: state.token,
    bookId: phrase.bookId,
    chapterId: phrase.chapterKey,
    sentence: phrase.sentence,
    providerType: settings.activeProvider,
    options,
    intro: announce && phrase.chapterTitle ? { title: phrase.chapterTitle, chime: settings.chapterChime } : null,
  });
}

/** Переход к следующей фразе; auto=true — по окончании фразы (учитывает «авто-переход») */
export function advance(auto: boolean): void {
  const autoAdvance = !auto || useSettingsStore.getState().autoAdvanceChapter;
  const next = phraseAfterCurrent(autoAdvance);
  if (next.kind === 'sentence') {
    setSentenceId(next.sentenceId);
    startPlayback(next.trigger);
  } else if (next.kind === 'chapter') {
    setChapterInternally(next.chapterIndex);
    startPlayback('chapter');
  } else if (next.kind === 'wait') {
    beginWait(next.page, 'next');
  } else if (next.kind === 'end') {
    stopAll(next.notice);
  }
}

export function onStarted(token: number): void {
  audioManager.onPlayerStarted(token);
  // Фраза зазвучала — Поставщик озвучки готовит следующую
  if (pendingPrepare && pendingPrepare.token === token) {
    const job = pendingPrepare;
    pendingPrepare = null;
    prepareAudio(job.bookId, job.chapterKey, job.sentence, job.providerType, job.options);
  }
}

export function onEnded(token: number): void {
  const cur = useAudioStore.getState();
  if (!acceptEnded({ status: cur.status, error: cur.error, token: cur.playToken }, token)) return;
  advance(true);
}

/** «Не получилось»: ошибку синтеза/воспроизведения Оркестратор сообщает одним событием (отмену — нет) */
export function onFailed(token: number, message: string): void {
  const before = useAudioStore.getState().playToken;
  const next = audioManager.onPlayerFailed(token, message);
  if (next.token !== before) {
    cancelPreparation();
    audioManager.stop();
  }
}

export async function play(): Promise<void> {
  const { status } = useAudioStore.getState();
  if (status === 'paused') resume();
  else if (status === 'idle' || status === 'error') startPlayback('start');
}

export function pause(): void {
  const status = useAudioStore.getState().status;
  if (status === 'playing') {
    audioManager.pausePlayer();
  } else if (status === 'loading') {
    stopAll();
  }
}

export function resume(): void {
  if (useAudioStore.getState().status !== 'paused') return;
  audioManager.resumePlayer();
}

export function stop(): void {
  stopAll();
}

export async function playNextSentence(): Promise<void> {
  advance(false);
}

export async function playPrevSentence(): Promise<void> {
  const prevId = phraseBeforeCurrent();
  if (prevId === null) return;
  setSentenceId(prevId);
  startPlayback('navigate');
}

export async function jumpToSentence(sentenceId: number): Promise<void> {
  setSentenceId(sentenceId);
  const status = useAudioStore.getState().status;
  if (status === 'loading' || status === 'playing' || status === 'paused') startPlayback('navigate');
}

export function clearError(): void {
  audioManager.clearError();
}

// ---------------------------------------------------------------------------
// Управление позицией чтения (b_dom_coord — владелец st_position)
// ---------------------------------------------------------------------------

export function setReadingPosition(pos: { chapterIndex?: number; sentenceId?: number | null; page?: number }): void {
  useBookStore.getState().setPosition(pos);
}

export function resetReadingPosition(): void {
  useBookStore.getState().resetPosition();
}

export function goToPage(page: number): void {
  goToPagedPage(page);
}

export function setViewPage(page: number): void {
  const ref = pagedPageRef(page);
  if (!ref) return;
  if (ref.page === useBookStore.getState().currentPage) return;
  useBookStore.getState().setViewPage(ref.page);
  focusPage(ref.page);
  queueProgress(ref.bookId, { 'metadata.lastPage': ref.page, 'metadata.lastReadAt': Date.now() });
}

export function setChapterIndex(index: number): void {
  const target = chapterTarget(index);
  if (!target) return;
  if (target.kind === 'paged-sentence') {
    navigatePaged(target.page, target.sentenceId, false);
    return;
  }
  if (target.kind === 'paged-page') {
    goToPage(target.page);
    return;
  }

  useBookStore.getState().setPosition({
    chapterIndex: index,
    sentenceId: target.sentenceId,
  });

  queueProgress(target.bookId, {
    'metadata.lastReadAt': Date.now(),
    'metadata.lastChapterId': target.chapterId,
    'metadata.lastSentenceId': target.sentenceId ?? undefined,
  });
  void flushProgress();
}

export function setSentenceId(id: number | null): void {
  if (id !== null && useBookStore.getState().currentSentenceId === id) return;
  if (id === null) {
    useBookStore.getState().setSentenceId(null);
    return;
  }
  const located = sentenceLocation(id);
  if (located) {
    const chapterIndex = located.chapterIndex ?? useBookStore.getState().currentChapterIndex;
    useBookStore.getState().setPosition({
      sentenceId: id,
      page: located.page,
      chapterIndex,
    });
    focusPage(located.page, true);
    const ref = progressRef(chapterIndex);
    if (ref) {
      queueProgress(ref.bookId, {
        'metadata.lastReadAt': Date.now(),
        'metadata.lastPage': located.page,
        'metadata.lastChapterId': ref.chapterId,
        'metadata.lastSentenceId': id,
      });
    }
    return;
  }
  useBookStore.getState().setSentenceId(id);
  const ref = progressRef(useBookStore.getState().currentChapterIndex);
  if (ref) {
    queueProgress(ref.bookId, {
      'metadata.lastReadAt': Date.now(),
      'metadata.lastChapterId': ref.chapterId,
      'metadata.lastSentenceId': id,
    });
  }
}

// Связываем AudioManager с координатором
audioManager.setHandlers({
  onStarted,
  onEnded,
  onFailed,
});

// События книги (подписки на сторы книги живут в зоне книги, Координатор только реагирует)
observeBook({
  // Явная навигация по страницам: плеер перестраивается
  onNavigated: () => {
    const status = useAudioStore.getState().status;
    if (status === 'loading' || status === 'playing') {
      audioManager.clearWaitingPage();
      startPlayback('chapter');
    } else if (status !== 'idle') {
      stopAll();
    }
  },
  // Страницы распознаются: возможно, дождались нужной
  onPagesChanged: () => {
    if (useAudioStore.getState().waitingPage != null) checkWait();
  },
  // Ручная смена главы / закрытие книги во время воспроизведения
  onBookOrChapterChanged: ({ bookChanged, closed, paged }) => {
    if (internalChapterChange) return;
    const status = useAudioStore.getState().status;
    if (status === 'idle') return;
    if (bookChanged || closed) {
      stopAll();
    } else if (paged) {
      return;
    } else if (status === 'loading' || status === 'playing') {
      startPlayback('chapter');
    } else {
      stopAll();
    }
  },
});

// Скорость и громкость применяются сразу
useSettingsStore.subscribe((state, prev) => {
  if (state.speed !== prev.speed) audioManager.setSpeed(state.speed);
  if (state.volume !== prev.volume) audioManager.setVolume(state.volume);
});

export const coordinator = {
  play,
  pause,
  resume,
  stop,
  playNextSentence,
  playPrevSentence,
  jumpToSentence,
  clearError,
  advance,
  stopAll,
  startPlayback,
  beginWait,
  checkWait,
  setChapterInternally,
  buildSynthesisOptions,
  setChapterIndex,
  setViewPage,
  goToPage,
  setSentenceId,
  setReadingPosition,
  resetReadingPosition,
};
