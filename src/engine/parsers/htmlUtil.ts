/** Экранирует текст для безопасной вставки в HTML-строку. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Допустимы только data:image/(png|jpeg|gif|webp);base64 — без SVG (может содержать скрипты). */
export function safeImageDataUrl(contentType: string, base64: string): string | null {
  const ct = contentType.trim().toLowerCase();
  if (!/^image\/(png|jpe?g|gif|webp|bmp)$/.test(ct)) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) return null;
  return `data:${ct};base64,${base64}`;
}
