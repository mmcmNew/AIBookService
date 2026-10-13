import type { PdfEngine } from '../../types/book';

/**
 * Выбор способа обработки PDF по режиму из модалки/настроек и среде.
 *   pdfjs   -> постранично, pdf.js (везде);
 *   pymupdf -> Tauri: постранично через sidecar (auto: текст или OCR на странице); браузер: серверный «целиком»;
 *   ocr     -> Tauri: постранично, принудительный OCR; браузер: Gemini по странице (если есть ключ), иначе ошибка;
 *   gemini  -> с ключом пользователя: постранично; без ключа: серверный «целиком» (запасной, как раньше).
 */
export type PdfTarget =
  | { kind: 'paged'; engine: PdfEngine }
  | { kind: 'remote'; mode: 'pymupdf' | 'gemini' }
  | { kind: 'unavailable'; reason: string };

export interface EngineEnv {
  sidecar: boolean;
  geminiKey?: string;
}

export function resolvePdfTarget(mode: string | undefined, env: EngineEnv): PdfTarget {
  const hasKey = Boolean(env.geminiKey && env.geminiKey.trim());
  switch (mode) {
    case 'pymupdf':
      return env.sidecar ? { kind: 'paged', engine: 'auto' } : { kind: 'remote', mode: 'pymupdf' };
    case 'ocr':
      if (env.sidecar) return { kind: 'paged', engine: 'ocr' };
      if (hasKey) return { kind: 'paged', engine: 'gemini' };
      return { kind: 'unavailable', reason: 'Встроенный OCR доступен только в десктопном приложении. В браузере используйте Gemini (нужен ключ API).' };
    case 'gemini':
      return hasKey ? { kind: 'paged', engine: 'gemini' } : { kind: 'remote', mode: 'gemini' };
    case 'pdfjs':
    default:
      return { kind: 'paged', engine: 'pdfjs' };
  }
}

export const ENGINE_LABELS: Record<PdfEngine, string> = {
  auto: 'Авто (текст или OCR по странице)',
  text: 'Текстовый слой (встроенный)',
  ocr: 'OCR (Tesseract)',
  pdfjs: 'PDF.js (текстовый слой)',
  gemini: 'Gemini (AI, по странице)',
};

/** Движки, доступные в текущей среде. */
export function availableEngines(env: EngineEnv): PdfEngine[] {
  const list: PdfEngine[] = env.sidecar ? ['auto', 'ocr', 'text', 'pdfjs'] : ['pdfjs'];
  list.push('gemini');
  return list;
}
