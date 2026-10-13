import { Router, Request, Response } from 'express';
import { Database } from '../db.js';
import { TtsService } from '../services/gemini.js';
import { requireAuth, authedUser, rateLimit, byUser } from '../middleware.js';

export const MAX_TTS_CHARS = 5000;

export function createTtsRouter(db: Database, gemini: TtsService): Router {
  const router = Router();

  router.post(
    '/stream',
    requireAuth(db),
    rateLimit({ windowMs: 60_000, max: () => 60, key: byUser }),
    async (req: Request, res: Response) => {
      const user = authedUser(res);
      const { text, voiceId } = req.body ?? {};

      if (typeof text !== 'string' || text.length < 1 || text.length > MAX_TTS_CHARS) {
        res.status(400).json({ error: `Поле text должно быть строкой длиной от 1 до ${MAX_TTS_CHARS} символов.` });
        return;
      }
      if (voiceId !== undefined && typeof voiceId !== 'string') {
        res.status(400).json({ error: 'Поле voiceId должно быть строкой.' });
        return;
      }

      const charCount = text.length;

      // Проверка и списание атомарны (синхронно в одном потоке).
      if (!db.deductBalance(user.id, charCount)) {
        res.status(402).json({
          error: 'Недостаточно символов на балансе для генерации.',
          balance: user.balance,
          required: charCount,
        });
        return;
      }

      try {
        const audioBuffer = await gemini.synthesize(text, voiceId || 'Aoede');
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('X-Remaining-Balance', user.balance.toString());
        res.setHeader('X-Characters-Used', charCount.toString());
        res.send(audioBuffer);
      } catch (err) {
        console.error('TTS Generation Error:', err);
        db.refundBalance(user.id, charCount);
        res.status(500).json({ error: 'Ошибка генерации аудио на сервере.', refunded: charCount });
      }
    },
  );

  return router;
}
