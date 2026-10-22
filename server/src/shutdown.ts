import type { Server } from 'node:http';

export interface GracefulShutdownOptions {
  timeoutMs?: number;
  onExit?: (code: number) => void;
}

export function createGracefulShutdown(
  server: Server,
  db: { flush(): Promise<void>; close?(): Promise<void> },
  options: GracefulShutdownOptions = {}
) {
  const defaultTimeout = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 8000;
  const timeoutMs = options.timeoutMs ?? defaultTimeout;
  const onExit = options.onExit ?? ((code: number) => process.exit(code));
  let isShuttingDown = false;

  return async function shutdown(signal?: string, exitCode = 0): Promise<void> {
    if (isShuttingDown) {
      console.warn(`[shutdown] Повторный сигнал ${signal || ''} проигнорирован.`);
      return;
    }
    isShuttingDown = true;
    console.log(`[shutdown] Остановка по сигналу ${signal || 'STOP'} (таймаут ${timeoutMs}мс)...`);

    await new Promise<void>((resolve) => {
      let closed = false;
      const done = () => {
        if (!closed) {
          closed = true;
          resolve();
        }
      };

      const timer = setTimeout(() => {
        console.warn(`[shutdown] Таймаут ${timeoutMs}мс истек. Принудительное закрытие соединений.`);
        if (typeof (server as any).closeAllConnections === 'function') {
          (server as any).closeAllConnections();
        }
        done();
      }, timeoutMs);
      timer.unref();

      if (typeof (server as any).closeIdleConnections === 'function') {
        (server as any).closeIdleConnections();
      }

      server.close((_err) => {
        clearTimeout(timer);
        done();
      });
    });

    try {
      if (typeof db.flush === 'function') {
        await db.flush();
      }
    } catch (err) {
      console.error('[shutdown] Ошибка при db.flush():', err);
    }

    try {
      if (typeof db.close === 'function') {
        await db.close();
      }
    } catch (err) {
      console.error('[shutdown] Ошибка при db.close():', err);
    }

    console.log('[shutdown] Остановка завершена.');
    onExit(exitCode);
  };
}
