import { makeBook } from 'foliate-js/view.js';
import { Chapter, Footnote, ParsedBook, SentenceItem } from '../../types/book';
import { ReplacementRule } from '../../types/settings';
import { tokenizeSentences } from '../tokenizer/sentenceTokenizer';
import { escapeHtml } from './htmlUtil';

/**
 * Универсальный парсер на базе ядра Foliate-js
 * Поддерживает: EPUB (2 и 3), FB2, FB2.ZIP, MOBI, AZW3, CBZ
 */
export async function parseWithFoliate(
  file: File,
  userRules: ReplacementRule[] = []
): Promise<ParsedBook> {
  const book = await makeBook(file);

  const rawTitle = book.metadata?.title || file.name.replace(/\.[^/.]+$/, '');
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : String(rawTitle);

  // Извлечение автора
  let author = 'Неизвестный автор';
  if (book.metadata?.author) {
    if (typeof book.metadata.author === 'string') {
      author = book.metadata.author;
    } else if (Array.isArray(book.metadata.author)) {
      author = book.metadata.author
        .map((a: any) => (typeof a === 'string' ? a : a?.name || ''))
        .filter(Boolean)
        .join(', ');
    } else if (typeof book.metadata.author === 'object') {
      author = book.metadata.author.name || 'Неизвестный автор';
    }
  }

  const lang = book.metadata?.language || 'ru';

  // Извлечение обложки
  let coverUrl: string | undefined = undefined;
  try {
    if (typeof book.getCover === 'function') {
      const coverBlob = await book.getCover();
      if (coverBlob) {
        coverUrl = URL.createObjectURL(coverBlob);
      }
    }
  } catch (err) {
    console.warn('Не удалось извлечь обложку через Foliate:', err);
  }

  const chapters: Chapter[] = [];
  const notes: Record<string, Footnote> = {};
  let globalSentenceId = 0;

  // Карта оглавления для названий глав
  const tocMap = new Map<number, string>();
  if (Array.isArray(book.toc)) {
    book.toc.forEach((item: any, idx: number) => {
      if (item?.label) {
        tocMap.set(idx, item.label.trim());
      }
    });
  }

  // Обход секций книги
  const sections = book.sections || [];

  for (let sIndex = 0; sIndex < sections.length; sIndex++) {
    const section = sections[sIndex];
    if (!section || typeof section.createDocument !== 'function') continue;

    let doc: Document;
    try {
      doc = await section.createDocument();
    } catch (e) {
      console.warn(`Ошибка загрузки секции ${sIndex}:`, e);
      continue;
    }

    if (!doc || !doc.body) continue;

    // Поиск заголовка секции
    const headingEl = doc.querySelector('h1, h2, h3, header, .title');
    const headingText = headingEl?.textContent?.trim();
    const chapterTitle =
      section.title?.trim() ||
      headingText ||
      tocMap.get(sIndex) ||
      `Раздел ${chapters.length + 1}`;

    const paragraphs: string[] = [];
    const chapterSentences: SentenceItem[] = [];
    let pIndex = 0;

    // Извлечение сносок в секции (если есть)
    doc.querySelectorAll('aside[epub\\:type~="footnote"], .footnote, .note').forEach((el) => {
      const noteId = el.id || `note_${sIndex}_${Object.keys(notes).length}`;
      const noteText = el.textContent?.trim();
      if (noteText) {
        notes[noteId] = {
          id: noteId,
          text: noteText,
        };
      }
    });

    // Извлечение основного текста по блочным элементам
    const blocks = doc.querySelectorAll('p, blockquote, .stanza, .poem, div.paragraph');
    if (blocks.length > 0) {
      blocks.forEach((node) => {
        // Пропускаем отдельные сноски в основном потоке чтения
        if (node.closest('aside[epub\\:type~="footnote"]')) return;

        const text = node.textContent?.trim();
        if (text && text.length > 1) {
          paragraphs.push(`<p class="my-3 leading-relaxed">${escapeHtml(text)}</p>`);
          const s = tokenizeSentences(text, globalSentenceId, pIndex++, userRules, lang);
          chapterSentences.push(...s);
          globalSentenceId += s.length;
        }
      });
    } else {
      // Если специфических тегов нет, разбиваем body по двойным переносам
      const bodyText = doc.body.textContent?.trim() || '';
      const lines = bodyText.split(/\n\s*\n/).map((l) => l.trim()).filter(Boolean);
      lines.forEach((line) => {
        if (line.length > 1) {
          paragraphs.push(`<p class="my-3 leading-relaxed">${escapeHtml(line)}</p>`);
          const s = tokenizeSentences(line, globalSentenceId, pIndex++, userRules, lang);
          chapterSentences.push(...s);
          globalSentenceId += s.length;
        }
      });
    }

    if (chapterSentences.length > 0) {
      chapters.push({
        id: `foliate_ch_${chapters.length}`,
        title: chapterTitle,
        level: 1,
        contentHtml: paragraphs.join('\n'),
        sentences: chapterSentences,
      });
    }
  }

  const bookId = `book_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  return {
    metadata: {
      id: bookId,
      title,
      author,
      lang,
      coverUrl,
      fileName: file.name,
      addedAt: Date.now(),
    },
    chapters,
    notes,
  };
}
