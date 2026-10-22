import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { Database, IDatabase } from './db.js';
import { config } from './config.js';
import { YooKassaService } from './services/yookassa.js';
import { ServerGeminiService, TtsService } from './services/gemini.js';
import { TtsManager } from './services/tts/index.js';
import { createPaymentRouter } from './routes/payment.js';
import { createTtsRouter } from './routes/tts.js';
import { createUserRouter } from './routes/user.js';
import { createPdfRouter } from './routes/pdf.js';
import { rateLimit, byIp, byUser, requireAuth } from './middleware.js';

export interface AppDeps {
  db?: IDatabase | Database;
  yookassa?: YooKassaService;
  gemini?: TtsService;
  tts?: TtsManager | TtsService;
}

export function isDatabaseError(err: any): boolean {
  if (!err) return false;
  const code = String(err.code || '');
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === '57P01' ||
    code === '57P03' ||
    code === '53300' ||
    code.startsWith('08')
  ) {
    return true;
  }
  const msg = String(err.message || '').toLowerCase();
  if (
    msg.includes('connection terminated') ||
    msg.includes('timeout exceeded when trying to connect') ||
    msg.includes('connection refused') ||
    msg.includes('database unavailable') ||
    msg.includes('failed to connect') ||
    msg.includes('could not connect to server')
  ) {
    return true;
  }
  return false;
}

export function createApp(deps: AppDeps = {}) {
  const db = deps.db ?? new Database();
  const yookassa = deps.yookassa ?? new YooKassaService(db);
  const tts = deps.tts ?? deps.gemini ?? new TtsManager();

  const app = express();
  app.disable('x-powered-by');
  const tp = config.trustProxy();
  if (tp) app.set('trust proxy', tp);

  app.use(
    cors({
      origin: (origin, cb) => {
        // Запросы без Origin (вебхуки, curl, нативные клиенты) CORS не затрагивает.
        cb(null, !origin || config.corsOrigins().includes(origin));
      },
      exposedHeaders: ['X-Remaining-Balance', 'X-Characters-Used'],
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Общий лимит по IP на весь API (защита в том числе от перебора токенов).
  app.use('/api', rateLimit({ windowMs: 60_000, max: () => 300, key: byIp }));

  // PDF: сначала auth и лимиты, затем уже большой JSON-парсер (50mb только здесь).
  app.use(
    '/api/pdf',
    requireAuth(db),
    rateLimit({ windowMs: 60_000, max: () => 6, key: byUser }),
    express.json({ limit: '50mb' }),
    createPdfRouter(db),
  );

  app.use(express.json({ limit: '100kb' }));

  app.use('/api/payments', createPaymentRouter(db, yookassa));
  app.use('/api/tts', createTtsRouter(db, tts));
  app.use('/api/user', createUserRouter(db));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (isDatabaseError(err)) {
      console.error('Ошибка недоступности базы данных:', err);
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: 'Сервис временно недоступен. Попробуйте позже.' });
      return;
    }
    const status = err?.status === 413 || err?.type === 'entity.too.large' ? 413 : err?.status === 400 ? 400 : 500;
    if (status === 500) console.error('Unhandled error:', err);
    res.status(status).json({
      error:
        status === 413
          ? 'Слишком большой запрос.'
          : status === 400
            ? 'Некорректный запрос.'
            : 'Внутренняя ошибка сервера.',
    });
  });

  return { app, db };
}
