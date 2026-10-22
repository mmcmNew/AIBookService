import { Router, Request, Response } from 'express';
import { Database, IDatabase } from '../db.js';
import { requireAuth, authedUser, rateLimit, byIp, asyncHandler } from '../middleware.js';
import { config } from '../config.js';

export function createUserRouter(db: IDatabase | Database): Router {
  const router = Router();

  const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: () => config.registerLimitPerHour(),
    key: byIp,
    message: 'Слишком много регистраций с этого адреса. Попробуйте позже.',
  });

  // Токен возвращается один раз; в хранилище лежит только его sha256.
  router.post('/register', registerLimiter, asyncHandler(async (_req: Request, res: Response) => {
    const { user, token } = await db.createUser();
    res.status(201).json({ userId: user.id, token, balance: user.balance });
  }));

  router.get('/balance', requireAuth(db), (_req: Request, res: Response) => {
    const user = authedUser(res);
    res.json({
      userId: user.id,
      balance: user.balance,
      totalPurchased: user.totalPurchased,
    });
  });

  return router;
}
