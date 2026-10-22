/**
 * Клиентское шифрование на базе Web Crypto API (globalThis.crypto.subtle).
 * Блок b_infra_server / Crypto.
 * Чистый модуль без зависимостей от Store и Domain.
 */

function getSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto API (globalThis.crypto.subtle) недоступен в данной среде.');
  }
  return subtle;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  const CHUNK_SIZE = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    chunks.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK_SIZE))));
  }
  return btoa(chunks.join(''));
}

export function base64ToUint8Array(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(base64, 'base64');
    const u8 = new Uint8Array(buf.length);
    u8.set(buf);
    return u8;
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Выводит 256-битный AES-GCM ключ через PBKDF2-HMAC-SHA256 (100 000 итераций).
 * В качестве соли используется userId или email.
 */
export async function deriveEncryptionKey(
  password: string,
  salt: string
): Promise<CryptoKey> {
  const subtle = getSubtleCrypto();
  const enc = new TextEncoder();

  const keyMaterial = await subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(salt),
      iterations: 100_000,
      hash: 'SHA-256',
    },
    keyMaterial,
    {
      name: 'AES-GCM',
      length: 256,
    },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Сериализует payload в JSON, генерирует случайный IV (12 байт),
 * шифрует AES-GCM и возвращает base64 строки ciphertext и iv.
 */
export async function encryptPayload(
  payload: any,
  key: CryptoKey
): Promise<{ ciphertext: string; iv: string }> {
  const subtle = getSubtleCrypto();

  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const jsonStr = JSON.stringify(payload === undefined ? null : payload);
  const data = new TextEncoder().encode(jsonStr);

  const cipherBuffer = await subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    data
  );

  return {
    ciphertext: uint8ArrayToBase64(new Uint8Array(cipherBuffer)),
    iv: uint8ArrayToBase64(iv),
  };
}

/**
 * Расшифровывает AES-GCM из base64 строк ciphertext и iv и парсит JSON.
 */
export async function decryptPayload(
  ciphertext: string,
  iv: string,
  key: CryptoKey
): Promise<any> {
  const subtle = getSubtleCrypto();

  const ivBytes = base64ToUint8Array(iv);
  const ciphertextBytes = base64ToUint8Array(ciphertext);

  const decryptedBuffer = await subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes as BufferSource,
    },
    key,
    ciphertextBytes as BufferSource
  );

  const jsonStr = new TextDecoder().decode(decryptedBuffer);
  return JSON.parse(jsonStr);
}
