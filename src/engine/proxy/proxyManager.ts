export interface DesktopProxyConfig {
  enabled: boolean;
  server: string;
}

export function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

export async function getDesktopProxy(): Promise<DesktopProxyConfig | null> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<DesktopProxyConfig | null>('get_desktop_proxy');
    } catch (e) {
      console.warn('Не удалось получить настройки прокси из Tauri:', e);
    }
  }
  return null;
}

export async function setDesktopProxy(config: DesktopProxyConfig | null): Promise<void> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_desktop_proxy', { config });
    } catch (e) {
      console.warn('Не удалось сохранить настройки прокси в Tauri:', e);
      throw e;
    }
  }
}

export async function restartDesktopApp(): Promise<void> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('restart_desktop_app');
    } catch (e) {
      console.warn('Не удалось перезапустить приложение:', e);
      throw e;
    }
  }
}
