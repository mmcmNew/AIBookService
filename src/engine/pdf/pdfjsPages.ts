import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfInfo, PdfPageResult } from '../../types/pdf';
import { extractCover, loadOutline } from './pdfjsDoc';
import { layoutPage, type LayoutItem } from './textLayout';

/**
 * Постраничное распознавание через pdf.js (браузер без Tauri и запасной режим): тот же формат результата,
 * что у sidecar (PdfInfo / PdfPageResult), поэтому весь конвейер страниц общий.
 */

function sampleIndexes(n: number, k: number): number[] {
  if (n <= k) return Array.from({ length: n }, (_, i) => i + 1);
  const out = new Set<number>();
  for (let i = 0; i < k; i++) out.add(Math.min(n, Math.max(1, Math.round(1 + (i * (n - 1)) / (k - 1)))));
  return [...out];
}

async function pageItems(doc: PDFDocumentProxy, pageNo: number): Promise<{ items: LayoutItem[]; W: number; H: number }> {
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items: LayoutItem[] = [];
  for (const raw of tc.items as Array<{ str?: string; transform?: number[]; width?: number }>) {
    if (!raw.str || !raw.str.trim() || !raw.transform) continue;
    const t = raw.transform;
    const fs = Math.hypot(t[0], t[1]) || Math.abs(t[3]) || 11;
    const [vx, vy] = vp.convertToViewportPoint(t[4], t[5]);
    const [vx2] = vp.convertToViewportPoint(t[4] + (raw.width ?? raw.str.length * fs * 0.5), t[5]);
    items.push({ str: raw.str, x: Math.min(vx, vx2), y: vy, w: Math.abs(vx2 - vx), fs });
  }
  page.cleanup();
  return { items, W: vp.width, H: vp.height };
}

export async function pdfjsGetInfo(doc: PDFDocumentProxy, fileName: string): Promise<PdfInfo> {
  const pageCount = doc.numPages;
  let title = fileName.replace(/\.[^/.]+$/, '');
  let author = 'Не указан';
  try {
    const meta = await doc.getMetadata();
    const info = meta?.info as { Title?: unknown; Author?: unknown } | undefined;
    if (typeof info?.Title === 'string' && info.Title.trim().length > 1) title = info.Title.trim();
    if (typeof info?.Author === 'string' && info.Author.trim().length > 1) author = info.Author.trim();
  } catch {
    /* метаданные необязательны */
  }

  let coverUrl: string | null = null;
  let pageSize = { width: 595, height: 842 };
  try {
    const first = await doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    pageSize = { width: Math.round(vp.width * 10) / 10, height: Math.round(vp.height * 10) / 10 };
    coverUrl = (await extractCover(first)) ?? null;
  } catch {
    /* обложка необязательна */
  }

  // Выборка до 8 страниц: есть ли текстовый слой, не битый ли он, медианный кегль основного текста
  const idxs = sampleIndexes(pageCount, 8);
  let withText = 0;
  const texts: string[] = [];
  const sizes: Array<{ fs: number; w: number }> = [];
  for (const p of idxs) {
    try {
      const { items } = await pageItems(doc, p);
      const text = items.map((i) => i.str).join(' ');
      texts.push(text);
      if (text.replace(/[^\p{L}\p{N}]/gu, '').length >= 50) withText++;
      for (const i of items) if (i.str.trim().length > 3) sizes.push({ fs: i.fs, w: i.str.trim().length });
    } catch {
      texts.push('');
    }
  }
  const hasTextLayer = withText > 0 && withText >= Math.max(1, Math.round(idxs.length / 3));
  const joined = texts.join('\n').slice(0, 8000);
  let bodyFontSize: number | null = null;
  if (hasTextLayer && sizes.length) {
    sizes.sort((a, b) => a.fs - b.fs);
    const total = sizes.reduce((a, s) => a + s.w, 0);
    let acc = 0;
    for (const s of sizes) {
      acc += s.w;
      if (acc >= total / 2) {
        bodyFontSize = Math.round(s.fs * 10) / 10;
        break;
      }
    }
  }
  const outline = (await loadOutline(doc))
    .filter((o) => o.page !== undefined)
    .map((o) => ({ level: o.level ?? 1, title: o.title, page: o.page as number }));

  return {
    pageCount,
    metadata: { title, author, fileName },
    coverUrl,
    outline,
    pageSize,
    hasTextLayer,
    corruptedLayerSuspected: false,
    textSample: joined,
    bodyFontSize,
    recommendedMode: !hasTextLayer ? 'ocr' : 'text',
  };
}

export const inspectPdfjsPage = pdfjsGetInfo;

export async function pdfjsRecognizePage(doc: PDFDocumentProxy, pageNo: number, bodyFontSize: number | null): Promise<PdfPageResult> {
  const { items, W, H } = await pageItems(doc, pageNo);
  const { blocks, text } = layoutPage(items, W, H, bodyFontSize);
  const warnings: string[] = [];
  if (blocks.length === 0) warnings.push('no-text-layer');
  if (text.includes('\uFFFD')) warnings.push('replacement-chars');
  return { page: pageNo, source: 'text', width: Math.round(W * 10) / 10, height: Math.round(H * 10) / 10, blocks, text, warnings };
}
