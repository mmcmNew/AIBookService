import type { PdfBlock } from '../parsers/pdfSidecar';
import { cleanParagraph } from '../cleanup/pipeline';
import { detectShiftedCyrillic, repairShiftedCyrillic } from '../cleanup/shiftedCyrillic';
import type { CleanupOp } from '../cleanup/types';

/**
 * Флаги склейки на границах страницы + плоский текст страницы (как finalize_page в sidecar).
 * Нужны для движков, которые не умеют этого сами (pdfjs, Gemini): continuesParagraph у первого блока тела,
 * endsWithHyphen / endsWithOpenSentence у последнего. Блоки header/footer/pagenum в тело не входят.
 */
const BODY = new Set(['heading', 'paragraph', 'list', 'caption']);
const HYPHENS = new Set(['-', '‐', '‑', '­', '¬']);
const TERMINAL = /[.!?…»"”)\]:;]$/;

export function finalizePageBlocks(blocks: PdfBlock[]): string {
  const body = blocks.filter((b) => BODY.has(b.type) && b.text.trim());
  if (body.length === 0) return '';
  const first = body[0];
  const last = body[body.length - 1];
  const f = first.text.trim().charAt(0);
  if (first.type === 'paragraph' && f && f.toLowerCase() === f && f.toUpperCase() !== f) first.continuesParagraph = true;
  const lt = last.text.trimEnd();
  if (last.type === 'paragraph' && lt.length >= 2 && HYPHENS.has(lt[lt.length - 1]) && /\p{L}/u.test(lt[lt.length - 2])) {
    last.text = lt.slice(0, -1);
    last.endsWithHyphen = true;
  } else if (last.type === 'paragraph' && !TERMINAL.test(lt)) {
    last.endsWithOpenSentence = true;
  }
  return body.map((b) => b.text).join('\n\n');
}

/** Безопасная автоочистка текста блоков: Markdown, мусорные символы, пробелы. Сдвинутую кириллицу не трогает. */
export const AUTO_CLEAN_OPS: CleanupOp[] = ['markdown', 'control', 'whitespace'];

export function cleanBlocks(blocks: PdfBlock[], ops: CleanupOp[] = AUTO_CLEAN_OPS): { blocks: PdfBlock[]; changed: number } {
  let changed = 0;
  const out = blocks.map((b) => {
    // Управляющие символы 0x10–0x1F в «сдвинутой кириллице» — это буквы: до исправления их не удаляем
    const useOps = detectShiftedCyrillic(b.text).isShifted ? ops.filter((o) => o !== 'control') : ops;
    const t = cleanParagraph(b.text, useOps).text;
    if (t !== b.text) {
      changed++;
      return { ...b, text: t };
    }
    return b;
  });
  return { blocks: out, changed };
}

/** Применяет исправление сдвинутой кириллицы к блокам (только по решению пользователя). */
export function repairBlocksShifted(blocks: PdfBlock[]): { blocks: PdfBlock[]; changed: number } {
  let changed = 0;
  const out = blocks.map((b) => {
    if (!detectShiftedCyrillic(b.text).isShifted) return b;
    const t = repairShiftedCyrillic(b.text).text;
    if (t !== b.text) {
      changed++;
      return { ...b, text: t };
    }
    return b;
  });
  return { blocks: out, changed };
}
