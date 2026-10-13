import { detectChapters, type DetectOptions, type DetectParagraph, type DetectResult } from './chapters';
import { nextKey, type DraftChapter, type DraftParagraph } from './bookModel';

/**
 * Определение глав для черновика редактора: работает над уже сохранёнными книгами без повторного распознавания.
 */

export interface FlatItem {
  /** Абзац черновика; null — синтетический абзац (заголовок существующей главы) */
  para: DraftParagraph | null;
  text: string;
}

export interface DraftDetectionOptions extends DetectOptions {
  /** Обрабатывать только главу с этим индексом (иначе — всю книгу) */
  chapterIndex?: number;
  /** Учитывать названия уже существующих глав как подсказки (для многоглавых книг) */
  useExistingTitles?: boolean;
}

export interface DraftDetection {
  flat: FlatItem[];
  detect: DetectParagraph[];
  result: DetectResult;
  /** Диапазон глав черновика, которые будут заменены: [from, to) */
  range: [number, number];
}

const GENERIC = /^(начало|основной текст|без названия|текст|часть\s+\d+)$/i;

export function detectDraftChapters(draft: DraftChapter[], options: DraftDetectionOptions = {}): DraftDetection {
  const from = options.chapterIndex ?? 0;
  const to = options.chapterIndex !== undefined ? options.chapterIndex + 1 : draft.length;
  const flat: FlatItem[] = [];
  const detect: DetectParagraph[] = [];
  let lastPage: number | undefined;
  const useTitles = options.useExistingTitles ?? draft.length > 1;

  for (let ci = from; ci < to; ci++) {
    const chapter = draft[ci];
    if (!chapter) continue;
    // Заголовок существующей главы - подсказка, кроме первой главы, если она называется служебно
    if (useTitles && chapter.title.trim() && !GENERIC.test(chapter.title.trim()) && !(ci === from && options.chapterIndex !== undefined)) {
      flat.push({ para: null, text: chapter.title.trim() });
      detect.push({ text: chapter.title.trim(), forced: true });
    }
    for (const p of chapter.paragraphs) {
      const page = p.source?.sentences[0]?.pageNumber;
      flat.push({ para: p, text: p.text });
      detect.push({ text: p.text, page, newPage: page !== undefined && lastPage !== undefined && page !== lastPage });
      if (page !== undefined) lastPage = page;
    }
  }
  const result = detectChapters(detect, options);
  return { flat, detect, result, range: [from, to] };
}

/** Заменяет диапазон глав черновика найденными главами. */
export function applyDraftDetection(draft: DraftChapter[], detection: DraftDetection, titles?: string[]): DraftChapter[] {
  const { flat, result, range } = detection;
  if (result.chapters.length === 0) return draft;
  const stamp = Date.now().toString(36);
  const chapters: DraftChapter[] = result.chapters.map((c, k) => {
    const paragraphs: DraftParagraph[] = c.items.map((i) => flat[i].para ?? { key: nextKey('p'), text: flat[i].text });
    return {
      key: nextKey('c'),
      id: `det_${stamp}_${k}`,
      title: (titles?.[k] ?? c.title).trim() || `Часть ${k + 1}`,
      level: c.level,
      paragraphs,
    };
  });
  // Единственный результат в диапазоне из одной главы: сохраняем идентичность главы (id, pageNumber)
  if (chapters.length === 1 && range[1] - range[0] === 1) {
    const old = draft[range[0]];
    return draft.map((c, i) => (i === range[0] ? { ...old, title: chapters[0].title, paragraphs: chapters[0].paragraphs } : c));
  }
  return [...draft.slice(0, range[0]), ...chapters, ...draft.slice(range[1])];
}
