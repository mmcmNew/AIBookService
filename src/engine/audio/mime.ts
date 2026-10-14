/** Определяет MIME по сигнатуре, чтобы WAV/OGG не подавались как audio/mpeg */
export function sniffAudioMime(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf, 0, Math.min(12, buf.byteLength));
  const ascii = (o: number, n: number) => String.fromCharCode(...Array.from(b.subarray(o, o + n)));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  return 'audio/mpeg';
}
