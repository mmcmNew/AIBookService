import type { Chapter, SentenceItem } from '../../types/book';
import type { ReplacementRule } from '../../types/settings';
import { tokenizeSentences } from '../tokenizer/sentenceTokenizer';
import { escapeHtml } from '../parsers/htmlUtil';

/**
 * Модель редактирования: книга как список глав со списком абзацев (строк).
 * Исходные предложения неизменённых абзацев сохраняются (вместе с PDF-координатами и номерами страниц).
 */

export interface DraftParagraph {
  key: string;
  text: string;
  /** Исходный абзац (предложения и текст), если абзац пришёл из книги */
  source?: { index: number; text: string; sentences: SentenceItem[] };
  /**
   * Прежние предложения, которые можно переиспользовать (id, PDF-координаты), если их текст не изменился.
   * Заполняется при склейке/разбиении/правке абзаца; по умолчанию — предложения source.
   */
  pool?: SentenceItem[];
}

export interface DraftChapter {
  key: string;
  id: string;
  title: string;
  level: number;
  pageNumber?: number;
  paragraphs: DraftParagraph[];
  /** Исходная глава (null для созданных в редакторе) */
  original?: Chapter;
}

let keyCounter = 0;
export const nextKey = (prefix = 'k'): string => `${prefix}${++keyCounter}`;

/** Группирует предложения главы в абзацы по paragraphIndex (подряд идущие). */
export function groupSentences(chapter: Chapter): { text: string; sentences: SentenceItem[] }[] {
  const groups: { text: string; sentences: SentenceItem[]; pIndex: number }[] = [];
  for (const s of chapter.sentences) {
    const last = groups[groups.length - 1];
    if (last && last.pIndex === s.paragraphIndex) {
      last.sentences.push(s);
      last.text += ' ' + s.rawText;
    } else {
      groups.push({ text: s.rawText, sentences: [s], pIndex: s.paragraphIndex });
    }
  }
  return groups.map(({ text, sentences }) => ({ text, sentences }));
}

export function chaptersToDraft(chapters: Chapter[]): DraftChapter[] {
  return chapters.map((chapter) => ({
    key: nextKey('c'),
    id: chapter.id,
    title: chapter.title,
    level: chapter.level,
    pageNumber: chapter.pageNumber,
    original: chapter,
    paragraphs: groupSentences(chapter).map((g, index) => ({
      key: nextKey('p'),
      text: g.text,
      source: { index, text: g.text, sentences: g.sentences },
    })),
  }));
}

/** Глава изменена относительно исходной (заголовок, состав или текст абзацев). */
export function isChapterDirty(chapter: DraftChapter): boolean {
  const orig = chapter.original;
  if (!orig) return true;
  if (chapter.title !== orig.title) return true;
  const groups = groupSentences(orig);
  if (groups.length !== chapter.paragraphs.length) return true;
  return chapter.paragraphs.some((p, i) => !p.source || p.source.index !== i || p.text !== p.source.text);
}

export function isDraftDirty(draft: DraftChapter[], originalChapters: Chapter[]): boolean {
  if (draft.length !== originalChapters.length) return true;
  return draft.some((c, i) => c.original !== originalChapters[i] || isChapterDirty(c));
}

export interface RebuildOptions {
  userRules?: ReplacementRule[];
  lang?: string;
  /** С какого id выдавать номера новым предложениям (по умолчанию — максимальный id в исходной книге + 1) */
  firstFreeId?: number;
}

export interface RebuildResult {
  chapters: Chapter[];
  /** id глав, текст которых изменился (для сброса аудиокэша) */
  changedChapterIds: string[];
  /** Сколько пустых глав отброшено */
  droppedEmpty: number;
}

function maxSentenceId(draft: DraftChapter[]): number {
  let max = -1;
  for (const d of draft) {
    for (const s of d.original?.sentences ?? []) if (s.id > max) max = s.id;
  }
  return max;
}

/**
 * Пересобирает главы книги из черновика.
 *
 * Идентификаторы предложений уникальны в пределах книги. Неизменённые предложения (и предложения внутри
 * изменённого абзаца, текст которых не поменялся) сохраняют свой id, поэтому уже озвученное аудио из кэша
 * (ключ = id + текст) продолжает использоваться; изменённые и новые предложения получают свежие id и будут
 * озвучены заново. contentHtml пересобирается только для изменённых глав.
 */
export function draftToChapters(draft: DraftChapter[], options: RebuildOptions = {}): RebuildResult {
  const userRules = options.userRules ?? [];
  const lang = options.lang || 'ru';
  const chapters: Chapter[] = [];
  const changed: string[] = [];
  let nextId = options.firstFreeId ?? maxSentenceId(draft) + 1;
  let dropped = 0;
  const used = new Set<number>();
  // Старый id берём, только если он ещё не занят в новой книге; иначе выдаём свежий
  const claim = (oldId: number | null): number => {
    if (oldId !== null && !used.has(oldId)) {
      used.add(oldId);
      return oldId;
    }
    while (used.has(nextId)) nextId++;
    used.add(nextId);
    return nextId++;
  };

  for (const d of draft) {
    if (!isChapterDirty(d) && d.original) {
      for (const s of d.original.sentences) used.add(s.id);
      chapters.push(d.original);
      continue;
    }

    const sentences: SentenceItem[] = [];
    const html: string[] = [];
    let pIndex = 0;
    for (const p of d.paragraphs) {
      const text = p.text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      html.push(`<p class="my-3 leading-relaxed">${escapeHtml(text)}</p>`);
      const reuse = p.source && p.source.text.replace(/\s+/g, ' ').trim() === text;
      if (reuse && p.source) {
        for (const s of p.source.sentences) sentences.push({ ...s, id: claim(s.id), paragraphIndex: pIndex });
      } else {
        // Токенизируем с временными id; предложения, совпавшие с прежними, берут прежний id (и PDF-координаты)
        const fresh = tokenizeSentences(text, 0, pIndex, userRules, lang);
        const pool = (p.pool ?? p.source?.sentences ?? []).slice();
        for (const f of fresh) {
          const at = pool.findIndex((s) => s.rawText === f.rawText);
          if (at >= 0) {
            const [old] = pool.splice(at, 1);
            sentences.push({ ...old, id: claim(old.id), speechText: f.speechText, paragraphIndex: pIndex });
          } else {
            sentences.push({ ...f, id: claim(null) });
          }
        }
      }
      pIndex++;
    }

    if (sentences.length === 0) {
      dropped++;
      changed.push(d.id);
      continue;
    }
    changed.push(d.id);
    chapters.push({
      id: d.id,
      title: d.title.trim() || 'Без названия',
      level: d.level,
      pageNumber: d.pageNumber,
      contentHtml: html.join('\n'),
      sentences,
    });
  }

  return { chapters, changedChapterIds: changed, droppedEmpty: dropped };
}

/** Подбирает позицию чтения в пересобранной книге: та же глава, то же (или ближайшее) предложение. */
export function mapReadingPosition(
  oldChapters: Chapter[],
  newChapters: Chapter[],
  chapterId: string | undefined,
  sentenceId: number | null | undefined
): { chapterIndex: number; sentenceId: number | null } {
  if (newChapters.length === 0) return { chapterIndex: 0, sentenceId: null };
  const oldIdx = oldChapters.findIndex((c) => c.id === chapterId);
  const fallbackChapter = Math.min(Math.max(oldIdx, 0), newChapters.length - 1);

  const newIdx = newChapters.findIndex((c) => c.id === chapterId);
  if (newIdx < 0) {
    return { chapterIndex: fallbackChapter, sentenceId: newChapters[fallbackChapter].sentences[0]?.id ?? null };
  }

  const oldChapter = oldChapters[oldIdx];
  const newChapter = newChapters[newIdx];
  if (!newChapter.sentences.length) return { chapterIndex: newIdx, sentenceId: null };
  const oldPos = oldChapter ? oldChapter.sentences.findIndex((s) => s.id === sentenceId) : -1;
  if (oldPos < 0) return { chapterIndex: newIdx, sentenceId: newChapter.sentences[0].id };

  const oldText = oldChapter.sentences[oldPos].rawText;
  const scaled = Math.round((oldPos / Math.max(1, oldChapter.sentences.length)) * newChapter.sentences.length);
  // Ближайшее к ожидаемой позиции предложение с тем же текстом
  let best = -1;
  let bestDist = Infinity;
  newChapter.sentences.forEach((s, i) => {
    if (s.rawText === oldText) {
      const dist = Math.abs(i - scaled);
      if (dist < bestDist) {
        best = i;
        bestDist = dist;
      }
    }
  });
  const pos = best >= 0 ? best : Math.min(Math.max(scaled, 0), newChapter.sentences.length - 1);
  return { chapterIndex: newIdx, sentenceId: newChapter.sentences[pos].id };
}
