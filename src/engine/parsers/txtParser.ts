import { Chapter, ParsedBook, SentenceItem } from '../../types/book';
import { ReplacementRule } from '../../types/settings';
import { tokenizeSentences } from '../tokenizer/sentenceTokenizer';
import { escapeHtml } from './htmlUtil';

export function parseTXT(
  fileContent: string,
  fileName: string,
  userRules: ReplacementRule[] = []
): ParsedBook {
  const title = fileName.replace(/\.[^/.]+$/, '');
  const paragraphs = fileContent.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

  const chapters: Chapter[] = [];
  let currentChapterSentences: SentenceItem[] = [];
  let currentChapterHtml: string[] = [];
  let currentChapterTitle = 'Начало';
  let globalSentenceId = 0;
  let pIndex = 0;

  for (const para of paragraphs) {
    // Проверка, является ли параграф заголовком главы (например: "Глава 1", "Часть 2" или короткая строка ЗАГЛАВНЫМИ)
    const isHeading = 
      /^(глава|часть|раздел|пролог|эпилог)\s+\d+/i.test(para) || 
      (para.length < 50 && para === para.toUpperCase() && /[А-ЯA-Z]/.test(para));

    if (isHeading && currentChapterSentences.length > 0) {
      chapters.push({
        id: `txt_ch_${chapters.length}`,
        title: currentChapterTitle,
        level: 1,
        contentHtml: currentChapterHtml.join('\n'),
        sentences: currentChapterSentences,
      });

      currentChapterTitle = para;
      currentChapterSentences = [];
      currentChapterHtml = [];
      pIndex = 0;
      continue;
    }

    currentChapterHtml.push(`<p class="my-3 leading-relaxed">${escapeHtml(para)}</p>`);
    const s = tokenizeSentences(para, globalSentenceId, pIndex++, userRules, 'ru');
    currentChapterSentences.push(...s);
    globalSentenceId += s.length;
  }

  if (currentChapterSentences.length > 0 || chapters.length === 0) {
    chapters.push({
      id: `txt_ch_${chapters.length}`,
      title: currentChapterTitle,
      level: 1,
      contentHtml: currentChapterHtml.join('\n'),
      sentences: currentChapterSentences,
    });
  }

  const bookId = `txt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  return {
    metadata: {
      id: bookId,
      title,
      author: 'Не указан',
      lang: 'ru',
      fileName,
      addedAt: Date.now(),
    },
    chapters,
    notes: {},
  };
}
