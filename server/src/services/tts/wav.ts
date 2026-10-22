/** Разбор sample rate из mime вида 'audio/L16;codec=pcm;rate=24000'. */
export function parsePcmRate(mimeType: string | undefined, fallback = 24000): number {
  const m = /rate=(\d{4,6})/i.exec(mimeType || '');
  const rate = m ? parseInt(m[1], 10) : fallback;
  return rate >= 8000 && rate <= 192000 ? rate : fallback;
}

export function isRawPcm(mimeType: string | undefined): boolean {
  return /pcm|raw|l16/i.test(mimeType || '');
}

export function addWavHeader(samples: Buffer, sampleRate: number, numChannels = 1, bitsPerSample = 16): Buffer {
  const dataSize = samples.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, samples]);
}
