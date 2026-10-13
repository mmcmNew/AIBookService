import { audioManager } from './audioManager';
import {
  acceptEnded,
  PlayTrigger,
  shouldAnnounceChapter,
} from './playerState';
import { nextTextStep } from './textSource';
import { useBookStore } from '../../store/bookStore';
import { usePagedStore } from '../../store/pagedStore';
import { useAudioStore } from '../../store/audioStore';
import {
  firstSentenceAtOrAfterPage,
  nextStep,
  prevSentenceOf,
  type ComposedBook,
} from '../pdf/composer';
import { pageOfSentenceId } from '../pdf/pageSentences';
import type { SentenceItem } from '../../types/book';
import { useSettingsStore } from '../../store/settingsStore';
import { SynthesisOptions } from '../../types/tts';
import { getCatalogModelInfo, getKnownModelVoices, normalizeAggregatorVoice } from '../providers/openRouterTts';

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

/** true, пока мы сами меняем главу (подписка на bookStore не должна запускать озвучку повторно) */
let internalChapterChange = false;

export function setChapterInternally(index: number): void {
  internalChapterChange = true;
  try {
    useBookStore.getState().setChapterIndex(index);
  } finally {
    internalChapterChange = false;
  }
}

export function stopAll(notice: string | null = null): void {
  audioManager.stop();
  useAudioStore.getState().dispatch({ type: 'stop' });
  useAudioStore.setState({ notice, waitingPage: null });
}

/** Ключ «главы» для аудиокэша: по странице, а не по главе — главы достраиваются и могут менять id */
const pagedKey = (sentence: SentenceItem) => `pg${pageOfSentenceId(sentence.id)}`;
let waitMode: 'jump' | 'next' = 'next';

const isPaged = () => Boolean(useBookStore.getState().currentBook?.metadata.paged);

/** Чтение ждёт страницу: плеер в статусе loading, сообщение «Распознаём страницу N…» показывает панель страниц */
export function beginWait(page: number, mode: 'jump' | 'next'): void {
  audioManager.stop();
  useAudioStore.getState().dispatch({ type: 'request' });
  waitMode = mode;
  useAudioStore.setState({ notice: null, waitingPage: page });
  usePagedStore.getState().setFocusPage(page);
}

const readyPageState = (composed: ComposedBook, page: number) => {
  const paged = usePagedStore.getState();
  return paged.stateOf(page) === 'done' && composed.pages[page - 1]?.state === 'done';
};

export function startPagedPlayback(trigger: PlayTrigger): void {
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

  const state = useAudioStore.getState().dispatch({ type: 'request' });
  useAudioStore.setState({ notice: null, waitingPage: null });

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
}

export function advancePaged(auto: boolean): void {
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
}

/** Страница, которую ждёт плеер, распознана — продолжаем чтение */
export function checkWait(): void {
  const audioState = useAudioStore.getState();
  const w = audioState.waitingPage;
  if (w == null) return;
  if (audioState.status !== 'loading') {
    useAudioStore.setState({ waitingPage: null });
    return;
  }
  const composed = usePagedStore.getState().composed;
  if (!composed || !readyPageState(composed, w)) return;
  useAudioStore.setState({ waitingPage: null });
  if (waitMode === 'jump' || useBookStore.getState().currentSentenceId == null) startPlayback('navigate');
  else advancePaged(false);
}

/** Запускает озвучку с текущей позиции (предложение уже выбрано в bookStore) */
export function startPlayback(trigger: PlayTrigger): void {
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

  const state = useAudioStore.getState().dispatch({ type: 'request' });
  useAudioStore.setState({ notice: null });

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
}

/** Переход к следующей фразе; auto=true — по окончании фразы (учитывает «авто-переход») */
export function advance(auto: boolean): void {
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
}

export function onStarted(token: number): void {
  useAudioStore.getState().dispatch({ type: 'started', token });
}

export function onEnded(token: number): void {
  const cur = useAudioStore.getState();
  if (!acceptEnded({ status: cur.status, error: cur.error, token: cur.playToken }, token)) return;
  advance(true);
}

export function onFailed(token: number, message: string): void {
  const before = useAudioStore.getState().playToken;
  const next = useAudioStore.getState().dispatch({ type: 'failed', token, message });
  if (next.token !== before) audioManager.stop();
}

export async function play(): Promise<void> {
  const { status } = useAudioStore.getState();
  if (status === 'paused') resume();
  else if (status === 'idle' || status === 'error') startPlayback('start');
}

export function pause(): void {
  const status = useAudioStore.getState().status;
  if (status === 'playing') {
    audioManager.pause();
    useAudioStore.getState().dispatch({ type: 'pause' });
  } else if (status === 'loading') {
    stopAll();
  }
}

export function resume(): void {
  if (useAudioStore.getState().status !== 'paused') return;
  useAudioStore.getState().dispatch({ type: 'resume' });
  audioManager.resume();
}

export function stop(): void {
  stopAll();
}

export async function playNextSentence(): Promise<void> {
  advance(false);
}

export async function playPrevSentence(): Promise<void> {
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
}

export async function jumpToSentence(sentenceId: number): Promise<void> {
  useBookStore.getState().setSentenceId(sentenceId);
  const status = useAudioStore.getState().status;
  if (status === 'loading' || status === 'playing' || status === 'paused') startPlayback('navigate');
}

export function clearError(): void {
  useAudioStore.getState().clearError();
}

// Связываем AudioManager с координатором
audioManager.setHandlers({
  onStarted,
  onEnded,
  onFailed,
});

// Слушаем изменения страниц для постраничных книг
usePagedStore.subscribe((state, prev) => {
  if (state.navNonce !== prev.navNonce) {
    const status = useAudioStore.getState().status;
    if (status === 'loading' || status === 'playing') {
      useAudioStore.setState({ waitingPage: null });
      startPlayback('chapter');
    } else if (status !== 'idle') {
      stopAll();
    }
    return;
  }
  if (useAudioStore.getState().waitingPage != null) checkWait();
});

// Ручная смена главы / закрытие книги во время воспроизведения
useBookStore.subscribe((state, prev) => {
  if (internalChapterChange) return;
  const bookChanged = state.currentBook?.metadata.id !== prev.currentBook?.metadata.id;
  const chapterChanged = state.currentChapterIndex !== prev.currentChapterIndex;
  if (!bookChanged && !chapterChanged) return;
  const status = useAudioStore.getState().status;
  if (status === 'idle') return;
  if (bookChanged || !state.currentBook) {
    stopAll();
  } else if (state.currentBook.metadata.paged) {
    return;
  } else if (status === 'loading' || status === 'playing') {
    startPlayback('chapter');
  } else {
    stopAll();
  }
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
  startPagedPlayback,
  beginWait,
  checkWait,
  setChapterInternally,
  buildSynthesisOptions,
};
