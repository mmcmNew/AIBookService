import { Router, Request, Response } from 'express';
import { Database, IDatabase } from '../db.js';
import { TtsService } from '../services/gemini.js';
import { TtsManager, TTSProviderId } from '../services/tts/index.js';
import { requireAuth, authedUser, rateLimit, byUser, byIp, asyncHandler } from '../middleware.js';

export const MAX_TTS_CHARS = 5000;

export function createTtsRouter(db: IDatabase | Database, ttsService: TtsManager | TtsService): Router {
  const router = Router();

  // Получение доступных голосов и провайдеров, настроенных на сервере
  router.get(
    '/voices',
    rateLimit({ windowMs: 60_000, max: () => 120, key: byIp }),
    asyncHandler(async (_req: Request, res: Response) => {
      try {
        if ('getAllVoices' in ttsService) {
          const voices = await ttsService.getAllVoices();
          const providers = ttsService.getAvailableProviders();
          res.json({ voices, providers });
        } else {
          // Заглушка для legacy TtsService
          res.json({
            voices: [
              { id: 'Aoede', name: 'Aoede (Женский)', lang: 'ru-RU', gender: 'female', provider: 'gemini' },
              { id: 'Charon', name: 'Charon (Мужской)', lang: 'ru-RU', gender: 'male', provider: 'gemini' },
            ],
            providers: [{ id: 'gemini', name: 'Google Gemini Audio', configured: true }],
          });
        }
      } catch (err: any) {
        console.error('TTS Voices Error:', err);
        res.status(500).json({ error: 'Не удалось получить список доступных голосов.' });
      }
    }),
  );

  router.post(
    '/stream',
    requireAuth(db),
    rateLimit({ windowMs: 60_000, max: () => 60, key: byUser }),
    asyncHandler(async (req: Request, res: Response) => {
      const user = authedUser(res);
      let { text, voiceId, provider, speed, pitch } = req.body ?? {};

      if (!provider || provider === 'cloud' || provider === 'auto') {
        if ('findProviderForVoice' in ttsService) {
          const detected = await (ttsService as any).findProviderForVoice(voiceId);
          provider = detected || ((ttsService as any).getConnector?.('gemini')?.isConfigured() ? 'gemini' : 'edge-tts');
        } else {
          provider = 'gemini';
        }
      }

      if (typeof text !== 'string' || text.length < 1 || text.length > MAX_TTS_CHARS) {
        res.status(400).json({ error: `Поле text должно быть строкой длиной от 1 до ${MAX_TTS_CHARS} символов.` });
        return;
      }
      if (voiceId !== undefined && typeof voiceId !== 'string') {
        res.status(400).json({ error: 'Поле voiceId должно быть строкой.' });
        return;
      }
      if (typeof provider !== 'string') {
        res.status(400).json({ error: 'Поле provider должно быть строкой.' });
        return;
      }

      const charCount = text.length;

      // Проверка и списание атомарны.
      let deductResult: { balance: number } | null;
      try {
        deductResult = await db.deductBalance(user.id, charCount);
      } catch (err) {
        console.error('Ошибка списания баланса перед синтезом:', err);
        res.setHeader('Retry-After', '5');
        res.status(503).json({ error: 'Сервис временно недоступен. Попробуйте позже.' });
        return;
      }

      if (deductResult === null) {
        res.status(402).json({
          error: 'Недостаточно символов на балансе для генерации.',
          balance: user.balance,
          required: charCount,
        });
        return;
      }

      try {
        let audioBuffer: Buffer;
        let contentType = 'audio/wav';

        if ('synthesize' in ttsService && 'getAllVoices' in ttsService) {
          // Полноценный TtsManager
          const result = await (ttsService as TtsManager).synthesize(provider as TTSProviderId, {
            text,
            voiceId,
            speed: typeof speed === 'number' ? speed : undefined,
            pitch: typeof pitch === 'number' ? pitch : undefined,
          });
          audioBuffer = result.audio;
          contentType = result.contentType;
        } else {
          // Legacy TtsService
          audioBuffer = await (ttsService as TtsService).synthesize(text, voiceId || 'Aoede');
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Remaining-Balance', deductResult.balance.toString());
        res.setHeader('X-Characters-Used', charCount.toString());
        res.send(audioBuffer);
      } catch (err: any) {
        console.error('TTS Generation Error:', err);
        try {
          await db.refundBalance(user.id, charCount);
        } catch (refundErr) {
          console.error(`[BILLING] возврат не выполнен user=${user.id} chars=${charCount}`, refundErr);
        }
        res.status(500).json({
          error: err?.message || 'Ошибка генерации аудио на сервере.',
          refunded: charCount,
        });
      }
    }),
  );

  return router;
}
