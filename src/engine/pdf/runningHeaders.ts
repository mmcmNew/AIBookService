import type { PdfBlock } from '../parsers/pdfSidecar';
import { headerKey } from '../cleanup/textOps';
import type { PdfPageRecord } from './types';

/**
 * Накопительная статистика повторяющихся колонтитулов по распознанным страницам.
 * Строка, повторяющаяся (с точностью до цифр) на многих страницах в верхнем/нижнем поле, считается колонтитулом
 * и скрывается из текста и озвучки, даже если sidecar/pdfjs не пометил её как header/footer. Данные страниц не меняются.
 */

const CHAPTER_WORD = /^(глава|часть|раздел|книга|том|chapter|part|section|book)\s/i;

/** Блок лежит в верхнем или нижнем поле страницы (по bbox в pt, начало координат сверху). */
export function isMarginBlock(b: PdfBlock, pageHeight?: number): boolean {
  if (!b.bbox || !pageHeight) return false;
  return b.bbox[3] <= pageHeight * 0.12 || b.bbox[1] >= pageHeight * 0.88;
}

function candidateKey(b: PdfBlock, pageHeight?: number): string | null {
  const t = (b.text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length < 3 || t.length > 90) return null;
  if (!/\p{L}/u.test(t)) return null;
  const typed = b.type === 'header' || b.type === 'footer';
  const margin = isMarginBlock(b, pageHeight) || (!b.bbox && typed);
  if (!typed && !margin) return null;
  if (!typed && (b.type === 'heading' || CHAPTER_WORD.test(t))) return null; // заголовки глав не колонтитулы
  const key = headerKey(t);
  if (key.replace(/[#\s]/g, '').length < 3) return null;
  return key;
}

/** Ключи (headerKey) строк-колонтитулов по набору распознанных страниц. */
export function computeRunningKeys(
  records: Iterable<PdfPageRecord>,
  opts: { minPages?: number; ratio?: number } = {},
): Set<string> {
  const counts = new Map<string, number>();
  let seen = 0;
  for (const r of records) {
    if (r.status !== 'done' || r.blocks.length === 0) continue;
    seen++;
    const onPage = new Set<string>();
    for (const b of r.blocks) {
      const k = candidateKey(b, r.height);
      if (k) onPage.add(k);
    }
    for (const k of onPage) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out = new Set<string>();
  if (seen < 3) return out;
  const threshold = Math.max(opts.minPages ?? 3, Math.ceil(seen * (opts.ratio ?? 0.05)));
  for (const [k, n] of counts) if (n >= threshold) out.add(k);
  return out;
}

/** Блок — колонтитул из накопленного набора. */
export function isRunningHeaderBlock(b: PdfBlock, pageHeight: number | undefined, keys: Set<string>): boolean {
  if (keys.size === 0) return false;
  const k = candidateKey(b, pageHeight);
  return k !== null && keys.has(k);
}
