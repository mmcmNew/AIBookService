import { sniffAudioMime } from '../../engine/audio/mime';

function sanitizeSpeed(v: number | undefined): number {
  return Number.isFinite(v) ? Math.max(0.25, Math.min(4, v as number)) : 1;
}

function sanitizeVolume(v: number | undefined): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v as number)) : 1;
}

export interface HtmlAudioCallbacks {
  onEnded?: () => void;
  onError?: () => void;
}

export class HtmlAudioPlayer {
  private audioElement: HTMLAudioElement | null = null;
  private currentObjectUrl: string | null = null;
  private callbacks: HtmlAudioCallbacks = {};

  constructor() {
    if (typeof window !== 'undefined') {
      this.audioElement = new Audio();
      this.audioElement.addEventListener('ended', () => this.callbacks.onEnded?.());
      this.audioElement.addEventListener('error', () => this.callbacks.onError?.());
    }
  }

  public setCallbacks(callbacks: HtmlAudioCallbacks): void {
    this.callbacks = callbacks;
  }

  public setupAudioBuffer(buffer: ArrayBuffer, speed: number, volume: number): void {
    const audio = this.audioElement;
    if (!audio) return;
    if (this.currentObjectUrl) URL.revokeObjectURL(this.currentObjectUrl);
    this.currentObjectUrl = URL.createObjectURL(new Blob([buffer], { type: sniffAudioMime(buffer) }));
    audio.src = this.currentObjectUrl;
    audio.playbackRate = sanitizeSpeed(speed);
    audio.volume = sanitizeVolume(volume);
  }

  public async play(): Promise<void> {
    await this.audioElement?.play();
  }

  public pause(): void {
    this.audioElement?.pause();
  }

  public stop(): void {
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.currentTime = 0;
    }
  }

  public setSpeed(speed: number): void {
    if (this.audioElement) this.audioElement.playbackRate = sanitizeSpeed(speed);
  }

  public setVolume(volume: number): void {
    if (this.audioElement) this.audioElement.volume = sanitizeVolume(volume);
  }

  public waitForEnd(): Promise<void> {
    const audio = this.audioElement;
    if (!audio) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        audio.removeEventListener('ended', done);
        audio.removeEventListener('error', done);
        resolve();
      };
      audio.addEventListener('ended', done, { once: true });
      audio.addEventListener('error', done, { once: true });
    });
  }
}

export const htmlAudioPlayer = new HtmlAudioPlayer();
