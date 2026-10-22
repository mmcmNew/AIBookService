import { Request, Response, NextFunction } from 'express';
import { Database, IDatabase, UserRecord } from './db.js';

export interface RateLimitOptions {
  windowMs: number;
  max: () => number;
  key: (req: Request, res: Response) => string;
  message?: string;
}

/** Простой in-memory fixed-window rate limiter. */
export function rateLimit(opts: RateLimitOptions) {
  const hits = new Map<string, { count: number; reset: number }>();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.min(opts.windowMs, 60_000));
  timer.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = opts.key(req, res);
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > opts.max()) {
      if (entry.count === opts.max() + 1) {
        console.warn(`[rate-limit] 429 ${key} ${req.method} ${req.path}`);
      }
      res.setHeader('Retry-After', Math.ceil((entry.reset - now) / 1000).toString());
      res.status(429).json({ error: opts.message || 'Слишком много запросов. Попробуйте позже.' });
      return;
    }
    next();
  };
}

export const byIp = (req: Request) => req.ip || req.socket.remoteAddress || 'unknown';
export const byUser = (req: Request, res: Response) => (res.locals.user as UserRecord | undefined)?.id || byIp(req);

export type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<any>;

/** Оборачивает асинхронный обработчик для перехвата отклоненных промисов в Express 4 */
export function asyncHandler(fn: AsyncRequestHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function requireAuth(db: IDatabase | Database) {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization || '';
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    const user = m ? await db.authenticate(m[1]) : null;
    if (!user) {
      res.status(401).json({ error: 'Требуется авторизация.' });
      return;
    }
    res.locals.user = user;
    next();
  });
}

export const authedUser = (res: Response): UserRecord => res.locals.user as UserRecord;
