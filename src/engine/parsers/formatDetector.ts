import JSZip from 'jszip';

export interface DetectedFormat {
  extension: 'epub' | 'fb2' | 'fb2.zip' | 'pdf' | 'mobi' | 'txt' | 'cbz';
  mimeType: string;
}

export const SUPPORTED_EXTENSIONS = [
  '.fb2',
  '.fb2.zip',
  '.fbz',
  '.epub',
  '.mobi',
  '.azw',
  '.azw3',
  '.pdf',
  '.txt',
  '.zip',
];

/**
 * Проверяет, имеет ли имя файла поддерживаемое расширение электронной книги.
 */
export function isSupportedBookFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Проверяет сигнатуру PDF (%PDF- в первых 1024 байтах).
 */
function isPdfSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false;
  const maxScan = Math.min(bytes.length - 4, 1024);
  for (let i = 0; i < maxScan; i++) {
    if (
      bytes[i] === 0x25 && // %
      bytes[i + 1] === 0x50 && // P
      bytes[i + 2] === 0x44 && // D
      bytes[i + 3] === 0x46 && // F
      bytes[i + 4] === 0x2d // -
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Проверяет сигнатуру ZIP архива (PK\x03\x04).
 */
function isZipSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  );
}

/**
 * Проверяет заголовок MOBI / Kindle (BOOKMOBI в заголовке PalmDoc).
 */
function isMobiSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 68) return false;
  const magic = String.fromCharCode(...bytes.slice(60, 68));
  return magic === 'BOOKMOBI' || magic.startsWith('TPZ');
}

/**
 * Проверяет, является ли содержимое XML-документом FictionBook (FB2).
 */
function isFb2Content(bytes: Uint8Array): boolean {
  const sampleLength = Math.min(bytes.length, 8192);
  let sample = '';
  try {
    sample = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, sampleLength));
  } catch {
    return false;
  }

  const lower = sample.toLowerCase();
  if (lower.includes('<fictionbook') || lower.includes('xmlns="http://www.gribuser.ru/xml/fictionbook')) {
    return true;
  }
  if (lower.includes('<?xml') && lower.includes('<description>') && lower.includes('<title-info>')) {
    return true;
  }
  return false;
}

/**
 * Проверяет, является ли файл обычным читаемым текстом (TXT).
 */
function isPlainText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const sampleLength = Math.min(bytes.length, 2048);
  let nullBytes = 0;
  for (let i = 0; i < sampleLength; i++) {
    if (bytes[i] === 0) nullBytes++;
  }
  // В текстовых файлах не должно быть нулевых байтов
  return nullBytes === 0;
}

/**
 * Определяет формат книги по содержимому буфера (магическим байтам и структуре архива).
 */
export async function detectFormatFromBuffer(
  buffer: ArrayBuffer | Uint8Array
): Promise<DetectedFormat | null> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length === 0) return null;

  // 1. PDF
  if (isPdfSignature(bytes)) {
    return { extension: 'pdf', mimeType: 'application/pdf' };
  }

  // 2. MOBI / AZW3
  if (isMobiSignature(bytes)) {
    return { extension: 'mobi', mimeType: 'application/x-mobipocket-ebook' };
  }

  // 3. ZIP-архивы (EPUB, FB2.ZIP, CBZ)
  if (isZipSignature(bytes)) {
    try {
      const zip = await JSZip.loadAsync(bytes);
      const fileNames = Object.keys(zip.files).map((f) => f.toLowerCase());

      // Проверка на FB2 внутри ZIP
      if (fileNames.some((n) => n.endsWith('.fb2'))) {
        return { extension: 'fb2.zip', mimeType: 'application/x-zip-compressed-fb2' };
      }

      // Проверка на EPUB (наличие META-INF/container.xml или mimetype application/epub+zip или .opf файла)
      if (
        fileNames.some((n) => n.includes('meta-inf/container.xml') || n.endsWith('.opf'))
      ) {
        return { extension: 'epub', mimeType: 'application/epub+zip' };
      }

      const mimetypeFile = zip.file('mimetype');
      if (mimetypeFile) {
        const mimeContent = (await mimetypeFile.async('text')).trim().toLowerCase();
        if (mimeContent.includes('epub')) {
          return { extension: 'epub', mimeType: 'application/epub+zip' };
        }
      }

      // Проверка на комиксы (CBZ)
      if (fileNames.some((n) => /\.(jpg|jpeg|png|webp)$/i.test(n))) {
        return { extension: 'cbz', mimeType: 'application/vnd.comicbook+zip' };
      }

      // Если в архиве есть XML с FictionBook
      for (const entry of Object.values(zip.files)) {
        if (!entry.dir && (entry.name.endsWith('.xml') || !entry.name.includes('.'))) {
          const entryBytes = await entry.async('uint8array');
          if (isFb2Content(entryBytes)) {
            return { extension: 'fb2.zip', mimeType: 'application/x-zip-compressed-fb2' };
          }
        }
      }
    } catch (e) {
      console.warn('[FormatDetector] Не удалось прочитать ZIP структуру:', e);
    }
  }

  // 4. FB2 (несжатый XML)
  if (isFb2Content(bytes)) {
    return { extension: 'fb2', mimeType: 'application/x-fictionbook+xml' };
  }

  // 5. Обычный текст (TXT)
  if (isPlainText(bytes)) {
    return { extension: 'txt', mimeType: 'text/plain' };
  }

  return null;
}

/**
 * Извлекает читаемое имя файла без мусорных префиксов SAF Android (document:, msf: и т.д.).
 */
export function sanitizeBaseFileName(name: string): string {
  let clean = name.trim();
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // оставляем как есть
  }
  clean = clean.split(/[/\\]/).pop() || 'book';
  // Удаляем префиксы URI Android Storage Access Framework
  clean = clean.replace(/^(document|msf|raw|primary)[:%_-]+/i, '');
  clean = clean.replace(/\.[^/.]+$/, '');
  return clean.trim() || 'book';
}

/**
 * Нормализует объект File:
 * - Если имя файла не имеет расширения (например, из Android SAF document%3A12345),
 *   определяет формат по сигнатуре содержимого и добавляет правильное расширение.
 * - Если файл имеет расширение .zip, проверяет, не является ли он fb2.zip или epub,
 *   и при необходимости переименовывает с точным расширением.
 */
export async function normalizeBookFile(file: File): Promise<File> {
  const fileNameLower = file.name.toLowerCase();

  // Если расширение уже известное и не требует уточнения
  const isGenericZip = fileNameLower.endsWith('.zip') && !fileNameLower.endsWith('.fb2.zip');
  const hasExactExtension =
    (fileNameLower.endsWith('.fb2') ||
      fileNameLower.endsWith('.fb2.zip') ||
      fileNameLower.endsWith('.fbz') ||
      fileNameLower.endsWith('.epub') ||
      fileNameLower.endsWith('.mobi') ||
      fileNameLower.endsWith('.azw') ||
      fileNameLower.endsWith('.azw3') ||
      fileNameLower.endsWith('.pdf') ||
      fileNameLower.endsWith('.txt') ||
      fileNameLower.endsWith('.cbz')) &&
    !isGenericZip;

  if (hasExactExtension) {
    return file;
  }

  // Файл без расширения, с generic .zip или с неизвестным расширением
  const buffer = await file.arrayBuffer();
  const detected = await detectFormatFromBuffer(buffer);

  if (detected) {
    const base = sanitizeBaseFileName(file.name);
    const newName = `${base}.${detected.extension}`;
    return new File([buffer], newName, {
      type: detected.mimeType || file.type,
      lastModified: file.lastModified || Date.now(),
    });
  }

  return file;
}
