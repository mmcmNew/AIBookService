import { SentenceItem } from '../../types/book';
import { ReplacementRule } from '../../types/settings';
import { applyPronunciationDictionary } from './dictionaryReplacer';

const segmenterCache = new Map<string, any>();

function getSegmenter(locale: string): any {
  let seg = segmenterCache.get(locale);
  if (!seg) {
    let loc = locale;
    try {
      // @ts-ignore
      seg = new Intl.Segmenter(loc, { granularity: 'sentence' });
    } catch {
      // Некорректный тег языка (например, из метаданных книги) — откатываемся на ru
      // @ts-ignore
      seg = new Intl.Segmenter('ru', { granularity: 'sentence' });
    }
    segmenterCache.set(locale, seg);
  }
  return seg;
}

/**
 * Разбивает текст параграфа или главы на отдельные предложения
 * с помощью нативного Intl.Segmenter с учетом языка и пунктуации.
 */
export function tokenizeSentences(
  text: string,
  startSentenceId = 0,
  paragraphIndex = 0,
  userRules: ReplacementRule[] = [],
  locale = 'ru'
): SentenceItem[] {
  if (!text || !text.trim()) return [];

  const sentences: SentenceItem[] = [];
  let currentId = startSentenceId;

  // Проверка поддержки нативного Intl.Segmenter
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = getSegmenter(locale);
    const segments = segmenter.segment(text);

    for (const segment of segments) {
      const rawText = segment.segment.trim();
      // Пропускаем сегменты, не содержащие букв или цифр
      if (!/[a-zA-Zа-яА-ЯёЁ0-9]/.test(rawText)) continue;

      const speechText = applyPronunciationDictionary(rawText, userRules);

      sentences.push({
        id: currentId++,
        rawText,
        speechText,
        paragraphIndex,
      });
    }
  } else {
    // Надежный фолбэк через регулярные выражения
    const regex = /([^.!?…]+[.!?…]+["»]?|\s*\n\s*)/g;
    let match: RegExpExecArray | null;

    let lastEnd = 0;
    while ((match = regex.exec(text)) !== null) {
      lastEnd = regex.lastIndex;
      const rawText = match[0].trim();
      if (!/[a-zA-Zа-яА-ЯёЁ0-9]/.test(rawText)) continue;

      const speechText = applyPronunciationDictionary(rawText, userRules);

      sentences.push({
        id: currentId++,
        rawText,
        speechText,
        paragraphIndex,
      });
    }

    // Хвост без завершающей пунктуации
    const tail = text.slice(lastEnd).trim();
    if (tail && /[a-zA-Zа-яА-ЯёЁ0-9]/.test(tail)) {
      sentences.push({
        id: currentId++,
        rawText: tail,
        speechText: applyPronunciationDictionary(tail, userRules),
        paragraphIndex,
      });
    }

    // Если ничего не разбилось, берем текст целиком
    if (sentences.length === 0 && /[a-zA-Zа-яА-ЯёЁ0-9]/.test(text.trim())) {
      const rawText = text.trim();
      sentences.push({
        id: currentId++,
        rawText,
        speechText: applyPronunciationDictionary(rawText, userRules),
        paragraphIndex,
      });
    }
  }

  return sentences;
}
