/** «Звук перехода» между главами: два мягких тона, генерируется Web Audio API (без внешних файлов). */

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx || ctx.state === 'closed') ctx = new Ctor();
  return ctx;
}

export const CHIME_DURATION_MS = 450;

export interface ChimeHandle {
  /** Резолвится по окончании сигнала (или сразу, если звук невозможен/отключён) */
  done: Promise<void>;
  cancel: () => void;
}

export function playChime(volume: number): ChimeHandle {
  const level = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
  const audio = level > 0 ? getContext() : null;
  if (!audio) return { done: Promise.resolve(), cancel: () => undefined };

  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const oscillators: OscillatorNode[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    void audio.resume?.();
    const t0 = audio.currentTime + 0.02;
    const tones: Array<{ freq: number; start: number; length: number }> = [
      { freq: 659.25, start: 0, length: 0.2 }, // E5
      { freq: 880.0, start: 0.17, length: 0.26 }, // A5
    ];
    const master = audio.createGain();
    master.gain.value = 0.28 * level;
    master.connect(audio.destination);

    for (const tone of tones) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = tone.freq;
      const s = t0 + tone.start;
      gain.gain.setValueAtTime(0.0001, s);
      gain.gain.linearRampToValueAtTime(1, s + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, s + tone.length);
      osc.connect(gain);
      gain.connect(master);
      osc.start(s);
      osc.stop(s + tone.length + 0.02);
      oscillators.push(osc);
    }
    timer = setTimeout(finish, CHIME_DURATION_MS);
  } catch {
    finish();
  }

  return {
    done,
    cancel: () => {
      if (timer) clearTimeout(timer);
      for (const osc of oscillators) {
        try {
          osc.stop();
        } catch {
          // уже остановлен
        }
      }
      finish();
    },
  };
}
