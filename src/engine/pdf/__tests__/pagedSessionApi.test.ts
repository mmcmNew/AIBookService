import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setCenter,
  retryPage,
  skipPage,
  rerecognize,
  savePageBlocks,
  setEngine,
  setPaused,
  switchEngine,
  setAutoClean,
  cleanRecognizedPages,
  repairShiftedPages,
  setManualChapters,
  getPageBlocks,
  isEdited,
  getPageMeta,
  countShiftedPages,
  closePagedSession,
} from '../pagedSession';
import { isSidecarEngineAvailable, getAvailableEngines } from '../engineChoice';

test('pagedSession API safe defaults when active session is null', async () => {
  // Ensure session is closed
  closePagedSession();

  // Test all 16 functions
  assert.doesNotThrow(() => setCenter(5));
  assert.doesNotThrow(() => retryPage(1));
  assert.doesNotThrow(() => skipPage(2));
  assert.doesNotThrow(() => rerecognize({ from: 1, to: 2, engine: 'gemini', overwriteEdited: false }));
  await assert.doesNotReject(async () => {
    await savePageBlocks(1, []);
  });
  assert.doesNotThrow(() => setEngine('pdfjs'));
  assert.doesNotThrow(() => setPaused(true));
  await assert.doesNotReject(async () => {
    await switchEngine('gemini', 1);
  });
  assert.doesNotThrow(() => setAutoClean(true));

  const cleaned = await cleanRecognizedPages();
  assert.equal(cleaned, 0);

  const repaired = await repairShiftedPages();
  assert.equal(repaired, 0);

  await assert.doesNotReject(async () => {
    await setManualChapters([]);
  });

  const blocks = await getPageBlocks(1);
  assert.equal(blocks, null);

  const edited = await isEdited(1);
  assert.equal(edited, false);

  const meta = getPageMeta(1);
  assert.equal(meta, null);

  const shiftedCount = await countShiftedPages();
  assert.equal(shiftedCount, 0);
});

test('engineChoice: sidecar detection in browser vs tauri', () => {
  const originalWindow = (globalThis as unknown as { window?: unknown }).window;
  try {
    // Browser mode (no Tauri)
    (globalThis as unknown as { window?: unknown }).window = undefined;
    assert.equal(isSidecarEngineAvailable(), false);
    assert.deepEqual(getAvailableEngines(), ['pdfjs', 'gemini']);

    // Tauri mode
    (globalThis as unknown as { window: unknown }).window = {
      __TAURI_INTERNALS__: {},
    };
    assert.equal(isSidecarEngineAvailable(), true);
    assert.deepEqual(getAvailableEngines(), ['auto', 'ocr', 'text', 'pdfjs', 'gemini']);
  } finally {
    (globalThis as unknown as { window?: unknown }).window = originalWindow;
  }
});

test('createPagedPdfBook: identifies corrupted text layer and sets corruptedLayerSuspected', async () => {
  const originalWindow = (globalThis as unknown as { window?: unknown }).window;
  try {
    (globalThis as unknown as { window: unknown }).window = {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string) => {
          if (cmd === 'pdf_open') return 'h_test';
          if (cmd === 'pdf_info') {
            return JSON.stringify({
              pageCount: 10,
              metadata: { title: 'Corrupted Book', author: 'Author', fileName: 'test.pdf' },
              coverUrl: null,
              outline: [],
              pageSize: { width: 600, height: 800 },
              hasTextLayer: true,
              corruptedLayerSuspected: false,
              bodyFontSize: 12,
              recommendedMode: 'text',
              textSample: 'Mbl 3HaeM KaK qTo rrerKo cE Mbl CTOJIK Beqep TpeBo lilC testing corrupted layer sample text',
            });
          }
          if (cmd === 'pdf_close') return;
          return null;
        },
      },
    };

    const { createPagedPdfBook } = await import('../createPagedBook');
    const dummyFile = new File([new ArrayBuffer(16)], 'test.pdf', { type: 'application/pdf' });

    const book = await createPagedPdfBook(dummyFile, 'auto');
    assert.equal(book.metadata.paged?.corruptedLayerSuspected, true);
    assert.equal(book.metadata.paged?.recommendedMode, 'ocr');
  } finally {
    (globalThis as unknown as { window?: unknown }).window = originalWindow;
  }
});
