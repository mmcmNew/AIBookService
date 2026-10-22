import { Router, Request, Response } from 'express';
import { YooKassaService } from '../services/yookassa.js';
import { Database, IDatabase } from '../db.js';
import { requireAuth, authedUser, asyncHandler } from '../middleware.js';
import { sanitizeReturnUrl } from '../config.js';
import { isDatabaseError } from '../app.js';

const PACKS: Record<string, { characters: number; amountRub: number; title: string }> = {
  starter: { characters: 200000, amountRub: 149, title: 'Пакет «Стартовый» (200 000 символов)' },
  reader: { characters: 1000000, amountRub: 490, title: 'Пакет «Книголюб» (1 000 000 символов)' },
  marathon: { characters: 3000000, amountRub: 1190, title: 'Пакет «Марафонец» (3 000 000 символов)' },
};

export function createPaymentRouter(db: IDatabase | Database, yookassa: YooKassaService): Router {
  const router = Router();
  const auth = requireAuth(db);

  router.post('/create', auth, asyncHandler(async (req: Request, res: Response) => {
    try {
      const user = authedUser(res);
      const { packId, returnUrl } = req.body ?? {};

      if (typeof packId !== 'string' || !Object.prototype.hasOwnProperty.call(PACKS, packId)) {
        res.status(400).json({ error: 'Неизвестный тарифный пакет.' });
        return;
      }
      const pack = PACKS[packId];

      const payment = await yookassa.createPayment({
        userId: user.id,
        amountRub: pack.amountRub,
        characters: pack.characters,
        description: `AIBookReader: ${pack.title}`,
        returnUrl: sanitizeReturnUrl(returnUrl),
      });

      res.json({
        success: true,
        paymentId: payment.paymentId,
        confirmationUrl: payment.confirmationUrl,
        characters: pack.characters,
        amountRub: pack.amountRub,
      });
    } catch (err) {
      if (isDatabaseError(err)) throw err;
      console.error('Error creating payment:', err);
      res.status(500).json({ error: 'Ошибка создания платежа.' });
    }
  }));

  // Вебхук ЮKassa: тело не доверенное, платёж перепроверяется через API.
  router.post('/webhook', asyncHandler(async (req: Request, res: Response) => {
    try {
      const result = await yookassa.handleWebhook(req.body);
      res.status(200).json(result);
    } catch (err) {
      if (isDatabaseError(err)) throw err;
      console.error('Error processing YooKassa webhook:', err);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  }));

  // Только dev: без ключей ЮKassa и вне production.
  router.post('/confirm-mock', auth, asyncHandler(async (req: Request, res: Response) => {
    if (yookassa.isConfigured() || process.env.NODE_ENV === 'production') {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const mockPaymentId = req.body?.mockPaymentId;
    if (typeof mockPaymentId !== 'string' || !mockPaymentId.startsWith('mock_pay_')) {
      res.status(400).json({ error: 'Некорректный mockPaymentId' });
      return;
    }
    const newBalance = await yookassa.confirmMockPayment(mockPaymentId, authedUser(res).id);
    if (newBalance !== null) {
      res.json({ success: true, newBalance });
    } else {
      res.status(404).json({ error: 'Платеж не найден или уже подтвержден' });
    }
  }));

  return router;
}
