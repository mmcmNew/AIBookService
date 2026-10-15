import type { PdfBlock } from '../parsers/pdfSidecar';
import { isRunningHeaderBlock } from './runningHeaders';
import type { ComposedPage, ComposedParagraph, PagePart, ParagraphKind, PdfPageRecord } from '../../types/pdf';

export type { ComposedPage, ComposedParagraph, PagePart, ParagraphKind };

const HIDDEN_TYPES = new Set(['header', 'footer', 'pagenum']);
const TERMINAL = /[.!?…»"”)\]:;]\s*$/;

export function normalizeBlockText(text: string | undefined): string {
  return (text ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

const startsLower = (t: string) => {
  const c = t.charAt(0);
  return c !== '' && c.toLowerCase() === c && c.toUpperCase() !== c;
};

export interface BodyBlock {
  b: PdfBlock;
  idx: number;
  text: string;
}

export function bodyBlocks(rec: PdfPageRecord, runningKeys: Set<string>): { body: BodyBlock[]; hidden: number } {
  const body: BodyBlock[] = [];
  let hidden = 0;
  rec.blocks.forEach((b, idx) => {
    const text = normalizeBlockText(b.text);
    if (!text) return;
    if (HIDDEN_TYPES.has(b.type) || isRunningHeaderBlock(b, rec.height, runningKeys)) {
      hidden++;
      return;
    }
    body.push({ b, idx, text });
  });
  return { body, hidden };
}

/** Можно ли приклеить блок first к абзацу tail (последний абзац предыдущей страницы). */
export function canJoin(
  tail: { type: ParagraphKind; text: string; hyphen: boolean; open: boolean },
  first: BodyBlock,
): { join: boolean; sep: string } {
  if (tail.type !== 'paragraph' || first.b.type !== 'paragraph') return { join: false, sep: ' ' };
  if (tail.hyphen) return { join: true, sep: '' };
  const open = tail.open || !TERMINAL.test(tail.text);
  if (open && (first.b.continuesParagraph || startsLower(first.text))) return { join: true, sep: ' ' };
  return { join: false, sep: ' ' };
}

export function composePages(
  pageCount: number,
  getRecord: (page: number) => PdfPageRecord | undefined,
  runningKeys: Set<string> = new Set(),
): ComposedPage[] {
  const out: ComposedPage[] = [];
  type Tail = { par: ComposedParagraph; hyphen: boolean; open: boolean };
  let tail = null as Tail | null;

  for (let p = 1; p <= pageCount; p++) {
    const rec = getRecord(p);
    if (!rec || rec.status !== 'done') {
      out.push({ page: p, state: 'missing', skipped: false, paragraphs: [], hidden: 0 });
      tail = null; // граница с нераспознанной страницей: склейку выполним, когда страница появится
      continue;
    }
    const { body, hidden } = bodyBlocks(rec, runningKeys);
    const paragraphs: ComposedParagraph[] = [];
    let startAt = 0;

    if (body.length > 0 && tail) {
      const first = body[0];
      const j = canJoin({ type: tail.par.type, text: tail.par.text, hyphen: tail.hyphen, open: tail.open }, first);
      if (j.join) {
        const par: ComposedParagraph = tail.par;
        const start = par.text.length + j.sep.length;
        par.text = par.text + j.sep + first.text;
        par.parts.push({
          page: p,
          bbox: first.b.bbox,
          fontSize: first.b.fontSize,
          pageHeight: rec.height,
          start,
          end: par.text.length,
        });
        startAt = 1;
        // Единственный блок страницы, сам оборванный: цепочка продолжится на следующую страницу
        if (body.length === 1) {
          tail = { par, hyphen: Boolean(first.b.endsWithHyphen), open: Boolean(first.b.endsWithOpenSentence) };
        }
      }
    }

    for (let i = startAt; i < body.length; i++) {
      const { b, idx, text } = body[i];
      const type: ParagraphKind = b.type === 'heading' || b.type === 'list' || b.type === 'caption' ? b.type : 'paragraph';
      paragraphs.push({
        page: p,
        block: idx,
        type,
        level: b.type === 'heading' ? b.level : undefined,
        text,
        parts: [{ page: p, bbox: b.bbox, fontSize: b.fontSize, pageHeight: rec.height, start: 0, end: text.length }],
      });
    }

    if (body.length > 0 && !(body.length === 1 && startAt === 1)) {
      const lastBody = body[body.length - 1];
      const lastPar = paragraphs[paragraphs.length - 1];
      if (lastPar) {
        tail = { par: lastPar, hyphen: Boolean(lastBody.b.endsWithHyphen), open: Boolean(lastBody.b.endsWithOpenSentence) };
      }
    }
    out.push({ page: p, state: 'done', skipped: Boolean(rec.skipped), paragraphs, hidden });
  }
  return out;
}
