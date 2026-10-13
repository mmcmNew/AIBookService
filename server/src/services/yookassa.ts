import crypto from 'crypto';
import { Database } from '../db.js';
import { config } from '../config.js';

export interface CreatePaymentParams {
  userId: string;
  amountRub: number;
  characters: number;
  description: string;
  returnUrl: string;
}

export type FetchLike = typeof fetch;

export class YooKassaService {
  constructor(private db: Database, private fetchImpl: FetchLike = fetch) {}

  isConfigured(): boolean {
    return config.yookassaConfigured();
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${config.yookassaShopId()}:${config.yookassaSecret()}`).toString('base64');
  }

  /** Создаёт платёж в ЮKassa или (без ключей, вне production) симуляционный. */
  async createPayment(params: CreatePaymentParams): Promise<{ paymentId: string; confirmationUrl: string }> {
    const { userId, amountRub, characters, description, returnUrl } = params;

    if (!this.isConfigured()) {
      if (config.isProduction()) {
        throw new Error('YooKassa is not configured in production');
      }
      const mockPaymentId = `mock_pay_${crypto.randomUUID()}`;
      this.db.savePayment({
        id: mockPaymentId,
        userId,
        amountRub,
        characters,
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const u = new URL(returnUrl);
      u.searchParams.set('mock_payment_id', mockPaymentId);
      u.searchParams.set('status', 'success');
      return { paymentId: mockPaymentId, confirmationUrl: u.toString() };
    }

    const body = {
      amount: { value: amountRub.toFixed(2), currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: returnUrl },
      description,
      metadata: { userId },
    };

    const response = await this.fetchImpl('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotence-Key': crypto.randomUUID(),
        Authorization: this.authHeader(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`YooKassa API Error (${response.status}): ${err}`);
    }

    const data: any = await response.json();
    if (typeof data?.id !== 'string' || typeof data?.confirmation?.confirmation_url !== 'string') {
      throw new Error('YooKassa API returned unexpected payload');
    }

    this.db.savePayment({
      id: data.id,
      userId,
      amountRub,
      characters,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return { paymentId: data.id, confirmationUrl: data.confirmation.confirmation_url };
  }

  /** Перепроверяет платёж напрямую через API ЮKassa. */
  private async fetchRemotePayment(paymentId: string): Promise<any> {
    const response = await this.fetchImpl(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`, {
      method: 'GET',
      headers: { Authorization: this.authHeader() },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new Error(`YooKassa verify failed (${response.status})`);
    }
    return response.json();
  }

  /**
   * Вебхук. Тело НЕ доверенное: используется только id платежа,
   * статус и сумма перепроверяются через API, символы берутся из PaymentRecord.
   * Бросает исключение, если проверка не удалась (ответ 5xx => ЮKassa повторит).
   */
  async handleWebhook(eventBody: any): Promise<{ success: boolean; message: string }> {
    const paymentId = eventBody?.object?.id;
    if (typeof paymentId !== 'string' || !paymentId) {
      return { success: false, message: 'Invalid webhook payload' };
    }

    const payment = this.db.getPayment(paymentId);
    if (!payment) return { success: true, message: 'Unknown payment ignored' };
    if (payment.status !== 'pending') return { success: true, message: 'Already processed' };

    // Без настроенной ЮKassa проверить платёж нечем — вебхук игнорируется.
    if (!this.isConfigured()) return { success: true, message: 'Webhook ignored (YooKassa not configured)' };

    const remote = await this.fetchRemotePayment(paymentId);
    if (remote?.id !== paymentId) {
      return { success: true, message: 'Payment id mismatch ignored' };
    }

    if (remote.status === 'succeeded') {
      const value = remote.amount?.value;
      const currency = remote.amount?.currency;
      if (currency !== 'RUB' || Number(value) !== payment.amountRub) {
        console.error(`Payment ${paymentId}: amount mismatch (remote ${value} ${currency}, stored ${payment.amountRub})`);
        return { success: true, message: 'Amount mismatch ignored' };
      }
      const newBalance = this.db.settlePayment(paymentId);
      if (newBalance !== null) {
        console.log(`Платеж ${paymentId} успешен, начислено ${payment.characters} символов`);
        return { success: true, message: 'Balance credited successfully' };
      }
      return { success: true, message: 'Already processed' };
    }

    if (remote.status === 'canceled') {
      this.db.cancelPayment(paymentId);
      return { success: true, message: 'Payment marked as canceled' };
    }

    return { success: true, message: 'Payment still pending' };
  }

  /** Тестовое подтверждение (только mock_pay_, без ключей ЮKassa, не production). */
  confirmMockPayment(mockPaymentId: string, userId: string): number | null {
    if (this.isConfigured() || config.isProduction()) return null;
    if (!mockPaymentId.startsWith('mock_pay_')) return null;
    const payment = this.db.getPayment(mockPaymentId);
    if (!payment || payment.userId !== userId) return null;
    return this.db.settlePayment(mockPaymentId);
  }
}
