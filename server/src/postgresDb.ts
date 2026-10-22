import pg from 'pg';
import crypto from 'crypto';
import { UserRecord, PaymentRecord, hashToken, IDatabase } from './db.js';
import { config } from './config.js';

const { Pool } = pg;

export class PostgresDatabase implements IDatabase {
  private pool: pg.Pool;
  private initPromise: Promise<void> | null = null;

  constructor(connectionString?: string, customPool?: any) {
    const connStr = connectionString || config.databaseUrl();
    if (!connStr && !customPool) {
      throw new Error('DATABASE_URL не указана для PostgresDatabase');
    }
    this.pool =
      customPool ||
      new Pool({
        connectionString: connStr,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });

    if (typeof (this.pool as any).on === 'function') {
      (this.pool as any).on('error', (err: Error) => {
        console.error('Непредвиденная ошибка пула PostgreSQL:', err);
      });
    }

    void this.ready().catch((err) => {
      console.error('Ошибка инициализации схемы PostgreSQL при старте:', err);
    });
  }

  public async ready(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initSchema().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async initSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          balance BIGINT NOT NULL DEFAULT 0,
          total_purchased BIGINT NOT NULL DEFAULT 0,
          created_at BIGINT NOT NULL,
          last_active_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_users_token_hash ON users(token_hash);

        CREATE TABLE IF NOT EXISTS payments (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          amount_rub NUMERIC(10, 2) NOT NULL,
          characters BIGINT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'canceled')),
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
      `);
    } finally {
      client.release();
    }
  }

  public async ensureReady(): Promise<void> {
    await this.ready();
  }

  public async createUser(): Promise<{ user: UserRecord; token: string }> {
    await this.ready();
    const token = crypto.randomBytes(32).toString('hex');
    const id = crypto.randomUUID();
    const tokenHash = hashToken(token);
    const now = Date.now();
    const balance = config.freeCharacters();
    const totalPurchased = 0;

    const res = await this.pool.query(
      `INSERT INTO users (id, token_hash, balance, total_purchased, created_at, last_active_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, token_hash as "tokenHash", balance, total_purchased as "totalPurchased", created_at as "createdAt", last_active_at as "lastActiveAt"`,
      [id, tokenHash, balance, totalPurchased, now, now],
    );

    const userRow = res.rows[0];
    const user: UserRecord = {
      id: userRow.id,
      tokenHash: userRow.tokenHash,
      balance: Number(userRow.balance),
      totalPurchased: Number(userRow.totalPurchased),
      createdAt: Number(userRow.createdAt),
      lastActiveAt: Number(userRow.lastActiveAt),
    };

    return { user, token };
  }

  public async authenticate(token: string): Promise<UserRecord | null> {
    if (!token || token.length > 256) return null;
    await this.ready();
    const tokenHash = hashToken(token);

    const res = await this.pool.query(
      `SELECT id, token_hash as "tokenHash", balance, total_purchased as "totalPurchased", created_at as "createdAt", last_active_at as "lastActiveAt"
       FROM users WHERE token_hash = $1`,
      [tokenHash],
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0];

    const a = Buffer.from(tokenHash, 'hex');
    const b = Buffer.from(row.tokenHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    return {
      id: row.id,
      tokenHash: row.tokenHash,
      balance: Number(row.balance),
      totalPurchased: Number(row.totalPurchased),
      createdAt: Number(row.createdAt),
      lastActiveAt: Number(row.lastActiveAt),
    };
  }

  public async getUser(userId: string): Promise<UserRecord | null> {
    await this.ready();
    const res = await this.pool.query(
      `SELECT id, token_hash as "tokenHash", balance, total_purchased as "totalPurchased", created_at as "createdAt", last_active_at as "lastActiveAt"
       FROM users WHERE id = $1`,
      [userId],
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      tokenHash: row.tokenHash,
      balance: Number(row.balance),
      totalPurchased: Number(row.totalPurchased),
      createdAt: Number(row.createdAt),
      lastActiveAt: Number(row.lastActiveAt),
    };
  }

  public async deductBalance(userId: string, chars: number): Promise<{ balance: number } | null> {
    if (!Number.isSafeInteger(chars) || chars <= 0) {
      throw new Error('Invalid characters amount');
    }
    await this.ready();
    const now = Date.now();

    const res = await this.pool.query(
      `UPDATE users
       SET balance = balance - $2, last_active_at = $3
       WHERE id = $1 AND balance >= $2
       RETURNING balance`,
      [userId, chars, now],
    );

    if (res.rowCount === null || res.rowCount === 0) {
      return null;
    }
    return { balance: Number(res.rows[0].balance) };
  }

  public async refundBalance(userId: string, chars: number): Promise<void> {
    if (!Number.isSafeInteger(chars) || chars <= 0) {
      throw new Error('Invalid characters amount');
    }
    await this.ready();
    const now = Date.now();

    await this.pool.query(
      `UPDATE users
       SET balance = balance + $2, last_active_at = $3
       WHERE id = $1`,
      [userId, chars, now],
    );
  }

  public async savePayment(payment: PaymentRecord): Promise<void> {
    await this.ready();
    await this.pool.query(
      `INSERT INTO payments (id, user_id, amount_rub, characters, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE
       SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
      [
        payment.id,
        payment.userId,
        payment.amountRub,
        payment.characters,
        payment.status,
        payment.createdAt,
        payment.updatedAt,
      ],
    );
  }

  public async getPayment(paymentId: string): Promise<PaymentRecord | null> {
    await this.ready();
    const res = await this.pool.query(
      `SELECT id, user_id as "userId", amount_rub as "amountRub", characters, status, created_at as "createdAt", updated_at as "updatedAt"
       FROM payments WHERE id = $1`,
      [paymentId],
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      userId: row.userId,
      amountRub: Number(row.amountRub),
      characters: Number(row.characters),
      status: row.status,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  public async settlePayment(paymentId: string): Promise<number | null> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const payRes = await client.query(
        `UPDATE payments
         SET status = 'succeeded', updated_at = $2
         WHERE id = $1 AND status = 'pending'
         RETURNING user_id as "userId", characters`,
        [paymentId, Date.now()],
      );

      if (payRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const { userId, characters } = payRes.rows[0];
      const charsNum = Number(characters);
      const now = Date.now();

      const userRes = await client.query(
        `UPDATE users
         SET balance = balance + $2, total_purchased = total_purchased + $2, last_active_at = $3
         WHERE id = $1
         RETURNING balance`,
        [userId, charsNum, now],
      );

      if (userRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      await client.query('COMMIT');
      return Number(userRes.rows[0].balance);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async cancelPayment(paymentId: string): Promise<boolean> {
    await this.ready();
    const res = await this.pool.query(
      `UPDATE payments
       SET status = 'canceled', updated_at = $2
       WHERE id = $1 AND status = 'pending'`,
      [paymentId, Date.now()],
    );
    return res.rowCount !== null && res.rowCount > 0;
  }

  public async flush(): Promise<void> {
    // В PostgreSQL транзакции фиксируются на диске сервером БД сразу
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
