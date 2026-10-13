import type { PdfBoundingRect, SentenceItem } from '../../types/book';
import type { ReplacementRule } from '../../types/settings';
import { tokenizeSentences } from '../tokenizer/sentenceTokenizer';
import type { ComposedParagraph, PagePart } from './pageCompose';

/**
 * Стабильные id предложений постраничной книги: page * 1_000_000 + block * 1000 + k,
 * где block — индекс блока в записи страницы, k — номер предложения в абзаце.
 * Склейка границ страниц или появление/исчезновение соседних абзацев не сдвигает id остальных предложений.
 */
export const PAGE_ID_STRIDE = 1_000_000;
export const BLOCK_ID_STRIDE = 1000;
/** paragraphIndex = page * PARAGRAPH_PAGE_STRIDE + block (уникален в пределах книги) */
export const PARAGRAPH_PAGE_STRIDE = 1000;

export function sentenceIdFor(page: number, block: number, k: number): number {
  return page * PAGE_ID_STRIDE + Math.min(block, 999) * BLOCK_ID_STRIDE + Math.min(k, 999);
}
export function pageOfSentenceId(id: number): number {
  return Math.floor(id / PAGE_ID_STRIDE);
}
export function paragraphIndexFor(page: number, block: number): number {
  return page * PARAGRAPH_PAGE_STRIDE + Math.min(block, 999);
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Прямоугольники подсветки для диапазона символов [a, b) внутри части (блока страницы).
 * bbox блока — в pt, начало координат сверху; результат — в координатах PDF (начало снизу), как ждёт PdfBookView.
 * Блок бьётся на строки по кеглю, символы распределяются по строкам равномерно.
 */
export function rectsForRange(part: PagePart, a: number, b: number): PdfBoundingRect[] {
  if (!part.bbox || !part.pageHeight) return [];
  const [x0, y0, x1, y1] = part.bbox;
  const textLen = Math.max(1, part.end - part.start);
  const fs = part.fontSize && part.fontSize > 3 ? part.fontSize : 11;
  const boxH = Math.max(1, y1 - y0);
  const lines = Math.max(1, Math.min(80, Math.round(boxH / (fs * 1.2))));
  const lineH = boxH / lines;
  const cpl = textLen / lines;
  const out: PdfBoundingRect[] = [];
  for (let k = 0; k < lines; k++) {
    const ls = k * cpl;
    const le = (k + 1) * cpl;
    const s = Math.max(a, ls);
    const e = Math.min(b, le);
    if (e <= s) continue;
    const xa = x0 + (x1 - x0) * ((s - ls) / cpl);
    const xb = x0 + (x1 - x0) * ((e - ls) / cpl);
    out.push({
      pageNumber: part.page,
      x: round1(xa),
      y: round1(part.pageHeight - (y0 + (k + 1) * lineH)),
      width: round1(Math.max(xb - xa, 6)),
      height: round1(lineH),
    });
  }
  return out;
}

/** Предложения абзаца с id, номерами страниц и прямоугольниками подсветки. */
export function buildParagraphSentences(par: ComposedParagraph, userRules: ReplacementRule[], lang = 'ru'): SentenceItem[] {
  const base = tokenizeSentences(par.text, 0, paragraphIndexFor(par.page, par.block), userRules, lang);
  let cursor = 0;
  return base.map((s, k) => {
    const found = par.text.indexOf(s.rawText, cursor);
    const a = found >= 0 ? found : cursor;
    const b = a + s.rawText.length;
    cursor = b;
    const rects: PdfBoundingRect[] = [];
    for (const part of par.parts) {
      const lo = Math.max(a, part.start);
      const hi = Math.min(b, part.end);
      if (hi > lo) rects.push(...rectsForRange(part, lo - part.start, hi - part.start));
    }
    const pageNumber = rects[0]?.pageNumber ?? par.parts.find((p) => b > p.start && a < p.end)?.page ?? par.page;
    const item: SentenceItem = {
      id: sentenceIdFor(par.page, par.block, k),
      rawText: s.rawText,
      speechText: s.speechText,
      paragraphIndex: s.paragraphIndex,
      pageNumber,
    };
    if (rects.length > 0) item.pdfRects = rects;
    return item;
  });
}
