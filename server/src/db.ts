import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { config } from './config.js';

export interface UserRecord {
  id: string;
  tokenHash: string;      // sha256(token) в hex; сам токен не хранится
  balance: number;        // Остаток символов
  totalPurchased: number;
  createdAt: number;
  lastActiveAt: number;
}

export interface PaymentRecord {
  id: string;
  userId: string;
  amountRub: number;
  characters: number;
  status: 'pending' | 'succeeded' | 'canceled';
  createdAt: number;
  updatedAt: number;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function assertChars(chars: number): void {
  if (!Number.isSafeInteger(chars) || chars <= 0) {
    throw new Error('Invalid characters amount');
  }
}

/** Файл JSON с неблокирующей сериализованной атомарной записью (tmp + rename). */
class JsonFile<T extends object> {
  private chain: Promise<void> = Promise.resolve();
  private dirty = false;
  private scheduled = false;

  constructor(private file: string, private getData: () => T) {}

  load(): T | null {
    if (!fs.existsSync(this.file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return parsed as T;
    } catch (e) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      console.error(`Файл ${this.file} повреждён, переименован в ${backup}:`, e);
      try {
        fs.renameSync(this.file, backup);
      } catch (e2) {
        console.error('Не удалось переименовать повреждённый файл:', e2);
      }
      return null;
    }
  }

  markDirty(): void {
    this.dirty = true;
    if (this.scheduled) return;
    this.scheduled = true;
    this.chain = this.chain.then(async () => {
      this.scheduled = false;
      if (!this.dirty) return;
      this.dirty = false;
      const tmp = `${this.file}.tmp`;
      try {
        await fs.promises.writeFile(tmp, JSON.stringify(this.getData(), null, 2), 'utf-8');
        await fs.promises.rename(tmp, this.file);
      } catch (e) {
        console.error(`Ошибка записи ${this.file}:`, e);
        this.dirty = true;
      }
    });
  }

  flush(): Promise<void> {
    return this.chain;
  }
}

export class Database {
  private users: Record<string, UserRecord> = {};
  private payments: Record<string, PaymentRecord> = {};
  private byTokenHash = new Map<string, string>();
  private usersFile: JsonFile<Record<string, UserRecord>>;
  private paymentsFile: JsonFile<Record<string, PaymentRecord>>;

  constructor(dataDir?: string) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dir = path.resolve(dataDir || config.dataDir() || path.join(here, '../data'));
    fs.mkdirSync(dir, { recursive: true });
    this.usersFile = new JsonFile(path.join(dir, 'users.json'), () => this.users);
    this.paymentsFile = new JsonFile(path.join(dir, 'payments.json'), () => this.payments);

    const u = this.usersFile.load();
    if (u) {
      for (const [id, rec] of Object.entries(u)) {
        if (!rec || typeof rec.tokenHash !== 'string') continue; // записи старого формата без токена не поддерживаются
        rec.balance = safeInt(rec.balance);
        rec.totalPurchased = safeInt(rec.totalPurchased);
        this.users[id] = rec;
        this.byTokenHash.set(rec.tokenHash, id);
      }
    }
    const p = this.paymentsFile.load();
    if (p) this.payments = p;
  }

  /** Создаёт пользователя; токен возвращается один раз. */
  public createUser(): { user: UserRecord; token: string } {
    const token = crypto.randomBytes(32).toString('hex');
    const id = crypto.randomUUID();
    const now = Date.now();
    const user: UserRecord = {
      id,
      tokenHash: hashToken(token),
      balance: config.freeCharacters(),
      totalPurchased: 0,
      createdAt: now,
      lastActiveAt: now,
    };
    this.users[id] = user;
    this.byTokenHash.set(user.tokenHash, id);
    this.usersFile.markDirty();
    return { user, token };
  }

  public authenticate(token: string): UserRecord | null {
    if (!token || token.length > 256) return null;
    const hash = hashToken(token);
    const id = this.byTokenHash.get(hash);
    if (!id) return null;
    const user = this.users[id];
    if (!user) return null;
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(user.tokenHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return user;
  }

  public getUser(userId: string): UserRecord | null {
    return this.users[userId] || null;
  }

  /** Атомарно (синхронно) списывает символы. */
  public deductBalance(userId: string, chars: number): boolean {
    assertChars(chars);
    const user = this.users[userId];
    if (!user || user.balance < chars) return false;
    user.balance -= chars;
    user.lastActiveAt = Date.now();
    this.usersFile.markDirty();
    return true;
  }

  /** Возврат ранее списанных символов (не считается покупкой). */
  public refundBalance(userId: string, chars: number): void {
    assertChars(chars);
    const user = this.users[userId];
    if (!user) return;
    user.balance += chars;
    this.usersFile.markDirty();
  }

  public savePayment(payment: PaymentRecord): void {
    this.payments[payment.id] = payment;
    this.paymentsFile.markDirty();
  }

  public getPayment(paymentId: string): PaymentRecord | null {
    return this.payments[paymentId] || null;
  }

  /**
   * Идемпотентно проводит платёж: pending -> succeeded + начисление.
   * Возвращает новый баланс или null, если платёж не найден / уже обработан.
   */
  public settlePayment(paymentId: string): number | null {
    const payment = this.payments[paymentId];
    if (!payment || payment.status !== 'pending') return null;
    const user = this.users[payment.userId];
    if (!user) return null;
    assertChars(payment.characters);
    payment.status = 'succeeded';
    payment.updatedAt = Date.now();
    user.balance += payment.characters;
    user.totalPurchased += payment.characters;
    user.lastActiveAt = Date.now();
    this.usersFile.markDirty();
    this.paymentsFile.markDirty();
    return user.balance;
  }

  public cancelPayment(paymentId: string): boolean {
    const payment = this.payments[paymentId];
    if (!payment || payment.status !== 'pending') return false;
    payment.status = 'canceled';
    payment.updatedAt = Date.now();
    this.paymentsFile.markDirty();
    return true;
  }

  public async flush(): Promise<void> {
    await Promise.all([this.usersFile.flush(), this.paymentsFile.flush()]);
  }
}
