import type { PdfBlock } from '../parsers/pdfSidecar';
import { classifyHeading } from '../cleanup/chapters';
import { isPageNumber } from '../cleanup/textOps';
import { finalizePageBlocks } from './pageClean';

/**
 * Разбор текстового слоя одной страницы (элементы pdf.js) в блоки того же формата, что отдаёт sidecar:
 * колонки, строки, абзацы, заголовки, header/footer/pagenum, флаги склейки. Чистая функция (без pdf.js и DOM).
 * Координаты — в pt, начало сверху слева (как у sidecar).
 */

export interface LayoutItem {
  str: string;
  /** Левый край */
  x: number;
  /** Базовая линия (сверху вниз) */
  y: number;
  /** Ширина */
  w: number;
  /** Кегль */
  fs: number;
}

interface Line {
  text: string;
  x0: number;
  x1: number;
  yTop: number;
  yBot: number;
  fs: number;
  col: number;
}

const BULLET = /^([•·▪●○■\-–—*]|\d{1,2}[.)])\s+\S/;
const TERMINAL = /[.!?…»"”)]$/;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Бакеты по базовой линии: элементы одной строки, внутри — слева направо. */
function groupRows(items: LayoutItem[]): LayoutItem[][] {
  const sorted = items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: LayoutItem[][] = [];
  let cur: LayoutItem[] = [];
  let curY = 0;
  let curFs = 0;
  for (const it of sorted) {
    if (cur.length && Math.abs(it.y - curY) <= 0.4 * Math.max(curFs, it.fs)) {
      cur.push(it);
      curFs = Math.max(curFs, it.fs);
    } else {
      if (cur.length) rows.push(cur);
      cur = [it];
      curY = it.y;
      curFs = it.fs;
    }
  }
  if (cur.length) rows.push(cur);
  return rows.map((r) => r.sort((a, b) => a.x - b.x));
}

function rowToLine(row: LayoutItem[], col: number): Line | null {
  let text = '';
  let prevEnd = -Infinity;
  let prevFs = 0;
  for (const it of row) {
    const gap = it.x - prevEnd;
    const needSpace = text && !/\s$/.test(text) && !/^\s/.test(it.str) && gap > 0.12 * Math.max(prevFs, it.fs);
    text += (needSpace ? ' ' : '') + it.str;
    prevEnd = it.x + it.w;
    prevFs = it.fs;
  }
  text = text.replace(/ /g, ' ').replace(/[\t ]+/g, ' ').trim();
  if (!text) return null;
  const longest = row.reduce((a, b) => (b.str.length > a.str.length ? b : a), row[0]);
  const fs = longest.fs || 11;
  const y = median(row.map((r) => r.y));
  return {
    text,
    x0: Math.min(...row.map((r) => r.x)),
    x1: Math.max(...row.map((r) => r.x + r.w)),
    yTop: y - 0.8 * fs,
    yBot: y + 0.2 * fs,
    fs,
    col,
  };
}

/** Строки страницы в порядке чтения (учитывает две колонки). */
export function buildLines(items: LayoutItem[], W: number): Line[] {
  const its = items.filter((i) => i.str && i.str.trim());
  if (its.length === 0) return [];
  const mid = W / 2;
  const tol = 0.02 * W;
  const left = its.filter((i) => i.x + i.w <= mid + tol);
  const right = its.filter((i) => i.x >= mid - tol);
  const cross = its.filter((i) => !(i.x + i.w <= mid + tol) && !(i.x >= mid - tol));
  const two = left.length >= 15 && right.length >= 15 && cross.length < 0.15 * its.length;

  const lines: Line[] = [];
  const pushRows = (list: LayoutItem[], col: number) => {
    for (const row of groupRows(list)) {
      const l = rowToLine(row, col);
      if (l) lines.push(l);
    }
  };
  if (!two) {
    pushRows(its, 0);
  } else {
    const colItems = [...left, ...right];
    const yMin = Math.min(...colItems.map((i) => i.y));
    pushRows(cross.filter((i) => i.y < yMin - 1), 0);
    pushRows(left, 1);
    pushRows(right, 2);
    pushRows(cross.filter((i) => i.y >= yMin - 1), 0);
  }
  return lines;
}

function joinTexts(parts: string[]): string {
  let out = '';
  for (const raw of parts) {
    const t = raw.trim();
    if (!t) continue;
    if (!out) {
      out = t;
      continue;
    }
    // Перенос слова: «пред-» + «ложение» (строчная буква) -> «предложение»
    if (/[\p{L}][-­]$/u.test(out) && /^\p{Ll}/u.test(t)) out = out.slice(0, -1) + t;
    else out += ' ' + t;
  }
  return out;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

function bboxOf(lines: Line[]): [number, number, number, number] {
  return [
    r1(Math.min(...lines.map((l) => l.x0))),
    r1(Math.min(...lines.map((l) => l.yTop))),
    r1(Math.max(...lines.map((l) => l.x1))),
    r1(Math.max(...lines.map((l) => l.yBot))),
  ];
}

export interface LayoutResult {
  blocks: PdfBlock[];
  text: string;
}

/**
 * Блоки страницы. bodyFont — медианный кегль основного текста (из info); если не задан, берётся по странице.
 */
export function layoutPage(items: LayoutItem[], W: number, H: number, bodyFont: number | null): LayoutResult {
  const lines = buildLines(items, W);
  if (lines.length === 0) return { blocks: [], text: '' };
  const body = bodyFont && bodyFont > 3 ? bodyFont : median(lines.filter((l) => l.text.length > 25).map((l) => l.fs)) || median(lines.map((l) => l.fs)) || 11;

  const topZone = 0.08 * H;
  const bottomZone = 0.92 * H;
  const headerLines: Line[] = [];
  const footerLines: Line[] = [];
  const bodyLines: Line[] = [];
  for (const l of lines) {
    const shortish = l.text.length <= 80 || isPageNumber(l.text);
    if (l.yBot <= topZone && shortish) headerLines.push(l);
    else if (l.yTop >= bottomZone && shortish) footerLines.push(l);
    else bodyLines.push(l);
  }

  const blocks: PdfBlock[] = [];
  const marginBlock = (ls: Line[], kind: 'header' | 'footer') => {
    if (ls.length === 0) return;
    const text = joinTexts(ls.map((l) => l.text));
    blocks.push({ type: isPageNumber(text) ? 'pagenum' : kind, text, bbox: bboxOf(ls), fontSize: r1(median(ls.map((l) => l.fs))) });
  };
  marginBlock(headerLines, 'header');

  // колонки: правый край для оценки «короткой последней строки абзаца»
  const colRight = new Map<number, number>();
  for (const l of bodyLines) colRight.set(l.col, Math.max(colRight.get(l.col) ?? 0, l.x1));

  let acc: Line[] = [];
  let accKind: 'paragraph' | 'list' = 'paragraph';
  const flush = () => {
    if (acc.length === 0) return;
    blocks.push({
      type: accKind,
      text: joinTexts(acc.map((l) => l.text)),
      bbox: bboxOf(acc),
      fontSize: r1(median(acc.map((l) => l.fs))),
    });
    acc = [];
    accKind = 'paragraph';
  };

  let first = true;
  let prev: Line | null = null;
  for (const l of bodyLines) {
    const ratio = l.fs / body;
    const h = classifyHeading({ text: l.text, heightRatio: ratio, newPage: first });
    // Заголовок по одному лишь тексту (без увеличенного кегля) должен стоять отдельной строкой, а не внутри абзаца
    const gapBefore = prev && prev.col === l.col ? l.yTop - prev.yBot : Infinity;
    const isolated = first || gapBefore > 0.65 * l.fs || acc.length === 0;
    const bySize = ratio >= 1.12;
    const isHeading = h !== null && !['numbered', 'bold', 'weak'].includes(h.reason) && (bySize || isolated);
    first = false;

    if (isHeading) {
      flush();
      const last = blocks[blocks.length - 1];
      // Заголовок из нескольких строк одного кегля — один блок
      if (last && last.type === 'heading' && prev && Math.abs(prev.fs - l.fs) < 0.6 && l.yTop - prev.yBot < 0.8 * l.fs && prev.col === l.col) {
        last.text = joinTexts([last.text, l.text]);
        if (last.bbox) last.bbox = [Math.min(last.bbox[0], r1(l.x0)), last.bbox[1], Math.max(last.bbox[2], r1(l.x1)), r1(l.yBot)];
      } else {
        blocks.push({
          type: 'heading',
          text: l.text,
          level: ratio >= 1.6 ? 1 : ratio >= 1.3 ? 2 : h && ['keyword', 'special', 'markdown'].includes(h.reason) ? 2 : 3,
          bbox: bboxOf([l]),
          fontSize: r1(l.fs),
          bold: undefined,
        });
      }
      prev = l;
      continue;
    }

    if (prev && acc.length > 0) {
      const gap = l.yTop - prev.yBot;
      const sameCol = prev.col === l.col;
      const paraLeft = Math.min(...acc.map((x) => x.x0));
      const prevEnds = TERMINAL.test(prev.text);
      const indent = l.x0 - paraLeft > 0.7 * l.fs;
      const right = colRight.get(prev.col) ?? prev.x1;
      const shortLast = prev.x1 < right - 3 * prev.fs;
      const startsList = BULLET.test(l.text);
      if (!sameCol || gap > 0.65 * l.fs || gap < -l.fs || startsList || (prevEnds && (indent || shortLast))) flush();
    } else if (acc.length === 0 && BULLET.test(l.text) && /^[•·▪●○■\-–—*]/.test(l.text)) {
      accKind = 'list';
    }
    if (acc.length === 0 && BULLET.test(l.text) && /^[•·▪●○■\-–—*]/.test(l.text)) accKind = 'list';
    acc.push(l);
    prev = l;
  }
  flush();
  marginBlock(footerLines, 'footer');

  const text = finalizePageBlocks(blocks);
  return { blocks, text };
}
