export interface MediaMetadataOptions {
  title: string;
  artist?: string;
  album?: string;
  artworkUrl?: string | null;
}

export interface MediaSessionActionHandlers {
  onPlay?: () => void;
  onPause?: () => void;
  onPreviousTrack?: () => void;
  onNextTrack?: () => void;
  onStop?: () => void;
}

class MediaSessionManager {
  private isSupported = typeof window !== 'undefined' && 'mediaSession' in navigator;
  private handlersRegistered = false;

  public setupHandlers(handlers: MediaSessionActionHandlers): void {
    if (!this.isSupported) return;
    if (this.handlersRegistered) return;
    this.handlersRegistered = true;

    const actionMap: Array<[MediaSessionAction, (() => void) | undefined]> = [
      ['play', handlers.onPlay],
      ['pause', handlers.onPause],
      ['stop', handlers.onStop],
      ['previoustrack', handlers.onPreviousTrack],
      ['nexttrack', handlers.onNextTrack],
    ];

    for (const [action, handler] of actionMap) {
      if (!handler) continue;
      try {
        navigator.mediaSession.setActionHandler(action, () => {
          handler();
        });
      } catch {
        // Some older browsers/OS may not support specific actions
      }
    }
  }

  public updateMetadata(options: MediaMetadataOptions): void {
    if (!this.isSupported) return;
    try {
      const artwork = options.artworkUrl
        ? [{ src: options.artworkUrl, sizes: '512x512', type: 'image/png' }]
        : [];

      navigator.mediaSession.metadata = new MediaMetadata({
        title: options.title || 'Чтение книги',
        artist: options.artist || 'AIBookReader',
        album: options.album || 'Электронная книга',
        artwork,
      });
    } catch {
      // ignore
    }
  }

  public setPlaybackState(state: 'none' | 'paused' | 'playing'): void {
    if (!this.isSupported) return;
    try {
      navigator.mediaSession.playbackState = state;
    } catch {
      // ignore
    }
  }
}

export const mediaSessionManager = new MediaSessionManager();
