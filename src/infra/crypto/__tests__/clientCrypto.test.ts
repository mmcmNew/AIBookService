import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveEncryptionKey,
  encryptPayload,
  decryptPayload,
  uint8ArrayToBase64,
  base64ToUint8Array,
} from '../clientCrypto';

test('clientCrypto: deriveEncryptionKey создает валидный 256-битный AES-GCM CryptoKey', async () => {
  const key = await deriveEncryptionKey('my-secret-password', 'user@example.com');

  assert.ok(key, 'Ключ должен быть создан');
  assert.equal(key.type, 'secret');
  assert.equal((key.algorithm as any).name, 'AES-GCM');
  assert.equal((key.algorithm as any).length, 256);
  assert.ok(key.usages.includes('encrypt'));
  assert.ok(key.usages.includes('decrypt'));
});

test('clientCrypto: encryptPayload и decryptPayload успешно выполняют раундтрип данных', async () => {
  const password = 'super-strong-password-123!';
  const salt = 'user-id-42';
  const key = await deriveEncryptionKey(password, salt);

  const payload = {
    keys: {
      openai: 'sk-abcdef1234567890',
      gemini: 'AIzaSyTestKey-987654',
      elevenlabs: 'xi-api-key-test',
    },
    settings: {
      theme: 'dark',
      fontSize: 18,
      russianText: 'Русский текст с эмодзи 🚀 🔑',
    },
    replacementRules: [
      { pattern: 'книга', replacement: 'фолиант' },
    ],
  };

  const encrypted = await encryptPayload(payload, key);

  assert.ok(typeof encrypted.ciphertext === 'string' && encrypted.ciphertext.length > 0);
  assert.ok(typeof encrypted.iv === 'string' && encrypted.iv.length > 0);
  assert.notEqual(encrypted.ciphertext, JSON.stringify(payload));

  const decrypted = await decryptPayload(encrypted.ciphertext, encrypted.iv, key);
  assert.deepEqual(decrypted, payload);
});

test('clientCrypto: encryptPayload и decryptPayload работают с примитивами, массивами и null', async () => {
  const key = await deriveEncryptionKey('password', 'salt');

  const cases = [
    'простая строка',
    1234567,
    [1, 'два', { три: 3 }],
    null,
    true,
  ];

  for (const item of cases) {
    const enc = await encryptPayload(item, key);
    const dec = await decryptPayload(enc.ciphertext, enc.iv, key);
    assert.deepEqual(dec, item);
  }
});

test('clientCrypto: расшифровка с неверным паролем отклоняется с ошибкой', async () => {
  const key1 = await deriveEncryptionKey('correct-password', 'user-id');
  const key2 = await deriveEncryptionKey('wrong-password', 'user-id');

  const payload = { secret: 'top-secret-token' };
  const encrypted = await encryptPayload(payload, key1);

  await assert.rejects(
    async () => {
      await decryptPayload(encrypted.ciphertext, encrypted.iv, key2);
    },
    (err: any) => {
      assert.ok(err);
      return true;
    }
  );
});

test('clientCrypto: расшифровка с неверной солью отклоняется с ошибкой', async () => {
  const key1 = await deriveEncryptionKey('same-password', 'user-1');
  const key2 = await deriveEncryptionKey('same-password', 'user-2');

  const payload = { secret: 'data' };
  const encrypted = await encryptPayload(payload, key1);

  await assert.rejects(async () => {
    await decryptPayload(encrypted.ciphertext, encrypted.iv, key2);
  });
});

test('clientCrypto: расшифровка с испорченным IV отклоняется с ошибкой', async () => {
  const key = await deriveEncryptionKey('password', 'salt');
  const encrypted = await encryptPayload({ test: 123 }, key);

  // Испортим IV (заменим байты)
  const ivBytes = base64ToUint8Array(encrypted.iv);
  ivBytes[0] = (ivBytes[0] + 1) % 256;
  const badIv = uint8ArrayToBase64(ivBytes);

  await assert.rejects(async () => {
    await decryptPayload(encrypted.ciphertext, badIv, key);
  });
});

test('clientCrypto: расшифровка с поврежденным шифротекстом отклоняется с ошибкой', async () => {
  const key = await deriveEncryptionKey('password', 'salt');
  const encrypted = await encryptPayload({ test: 123 }, key);

  // Испортим данные ciphertext
  const cipherBytes = base64ToUint8Array(encrypted.ciphertext);
  cipherBytes[0] = (cipherBytes[0] + 1) % 256;
  const badCiphertext = uint8ArrayToBase64(cipherBytes);

  await assert.rejects(async () => {
    await decryptPayload(badCiphertext, encrypted.iv, key);
  });
});

test('clientCrypto: base64ToUint8Array и uint8ArrayToBase64 корректно конвертируют произвольные байты', () => {
  const sample = new Uint8Array([0, 1, 2, 127, 128, 254, 255, 65, 66, 67]);
  const b64 = uint8ArrayToBase64(sample);
  const back = base64ToUint8Array(b64);
  assert.deepEqual(back, sample);
});
