import { audioManager } from './audioManager';
import { acceptEnded, PlayTrigger, shouldAnnounceChapter } from './playerState';
import { cancelPrepare, prepareAudio } from './audioFetch';
import { useBookStore } from '../../store/bookStore';
import { useAudioStore } from '../../store/audioStore';
import { useSettingsStore } from '../../store/settingsStore';
import { SynthesisOptions, TTSProviderType } from '../../types/tts';
import type { SentenceItem } from '../../types/book';
import { buildSynthesisOptions } from '../settings';
import {
  currentPhrase,
  flushProgress,
  focusPage,
  nextPhrase,
  observeBook,
  pageReady,
  type ExternalMove,
} from '../library';

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

function stopAll(notice: string | null = null): void {
  cancelPreparation();
  audioManager.stopPlayer(notice);
}

let waitMode: 'jump' | 'next' = 'next';

/** Чтение ждёт страницу: плеер в статусе loading, сообщение «Распознаём страницу N…» показывает панель страниц */
function beginWait(page: number, mode: 'jump' | 'next'): void {
  waitMode = mode;
  cancelPreparation();
  audioManager.beginPlayerWait(page);
  focusPage(page);
}

/** Страница, которую ждёт плеер, распознана — продолжаем чтение */
function checkWait(): void {
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
function startPlayback(trigger: PlayTrigger): void {
  const settings = useSettingsStore.getState();
  const phrase = currentPhrase(settings.autoAdvanceChapter);
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
function advance(auto: boolean): void {
  const autoAdvance = !auto || useSettingsStore.getState().autoAdvanceChapter;
  // Менеджер книги сам сдвигает позицию и сразу отвечает; события «внешний переход» на наш запрос нет
  const next = nextPhrase(autoAdvance);
  if (next.kind === 'phrase') {
    startPlayback(next.trigger);
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

/** «Хочу играть»: Оркестратор получил play на тишине — запускаем озвучку с текущей позиции */
export function onWantPlay(): void {
  startPlayback('start');
}

/** «Остановлен»: пользователь остановил плеер — отменяем подготовленное и просим Менеджера сохранить прогресс */
export function onStopped(): void {
  cancelPreparation();
  void flushProgress();
}

// Связываем AudioManager с координатором
audioManager.setHandlers({
  onStarted,
  onEnded,
  onFailed,
  onWantPlay,
  onStopped,
});

/** Пользователь сдвинул позицию через Менеджера книги: плеер подстраивается под новую фразу */
export function onExternalMove(move: ExternalMove): void {
  const status = useAudioStore.getState().status;
  switch (move.kind) {
    case 'jump':
      // Клик по предложению: играло или стояло на паузе — играем отсюда
      if (status === 'loading' || status === 'playing' || status === 'paused') startPlayback('navigate');
      break;
    case 'step': {
      // Кнопки «предыдущая/следующая фраза»: дальше как при автопереходе (в т.ч. ожидание страницы, конец)
      const result = move.result;
      if (result.kind === 'phrase') startPlayback(result.trigger);
      else if (result.kind === 'wait') beginWait(result.page, 'next');
      else if (result.kind === 'end') stopAll(result.notice);
      break;
    }
    case 'chapter':
      // Ручная смена главы текстовой книги
      if (status === 'idle') return;
      if (status === 'loading' || status === 'playing') startPlayback('chapter');
      else stopAll();
      break;
    case 'page':
      // Явная навигация по страницам PDF: плеер перестраивается
      if (status === 'loading' || status === 'playing') {
        audioManager.clearWaitingPage();
        startPlayback('chapter');
      } else if (status !== 'idle') {
        stopAll();
      }
      break;
  }
}

// Менеджер книги сообщает о событиях своей зоны; Координатор только реагирует
observeBook({
  onExternalMove,
  // Страницы распознаются: возможно, дождались нужной
  onPagesChanged: () => {
    if (useAudioStore.getState().waitingPage != null) checkWait();
  },
  // Книга сменена или закрыта во время воспроизведения
  onBookChanged: () => {
    if (useAudioStore.getState().status !== 'idle') stopAll();
  },
  onBookClosing: () => stopAll(),
});

/** Скорость и громкость применяются к играющему плееру сразу, остальные настройки подхватываются со следующим заданием */
export function applyLiveSettings(state: ReturnType<typeof useSettingsStore.getState>, prev: typeof state): void {
  if (state.speed !== prev.speed) audioManager.setSpeed(state.speed);
  if (state.volume !== prev.volume) audioManager.setVolume(state.volume);
}

useSettingsStore.subscribe(applyLiveSettings);
