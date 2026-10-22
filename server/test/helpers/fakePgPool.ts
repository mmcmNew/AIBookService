import { EventEmitter } from 'node:events';

export interface FakeUser {
  id: string;
  tokenHash: string;
  balance: number;
  totalPurchased: number;
  createdAt: number;
  lastActiveAt: number;
}

export class FakePgPool extends EventEmitter {
  public users = new Map<string, FakeUser>();
  public connectFails: Error | null = null;
  public queryFails: Error | null = null;
  public queries: { sql: string; params?: any[] }[] = [];

  async connect() {
    if (this.connectFails) {
      const err = this.connectFails;
      throw err;
    }
    return {
      query: (sql: string, params?: any[]) => this.query(sql, params),
      release: () => {},
    };
  }

  async query(sql: string, params?: any[]): Promise<any> {
    this.queries.push({ sql, params });

    if (this.queryFails) {
      throw this.queryFails;
    }

    if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) {
      return { rows: [] };
    }

    if (sql.includes('INSERT INTO users')) {
      const user: FakeUser = {
        id: params?.[0],
        tokenHash: params?.[1],
        balance: Number(params?.[2]),
        totalPurchased: Number(params?.[3]),
        createdAt: Number(params?.[4]),
        lastActiveAt: Number(params?.[5]),
      };
      this.users.set(user.id, user);
      return {
        rows: [
          {
            id: user.id,
            tokenHash: user.tokenHash,
            balance: user.balance,
            totalPurchased: user.totalPurchased,
            createdAt: user.createdAt,
            lastActiveAt: user.lastActiveAt,
          },
        ],
      };
    }

    if (sql.includes('FROM users WHERE token_hash')) {
      const tokenHash = params?.[0];
      for (const u of this.users.values()) {
        if (u.tokenHash === tokenHash) {
          return {
            rows: [
              {
                id: u.id,
                tokenHash: u.tokenHash,
                balance: u.balance,
                totalPurchased: u.totalPurchased,
                createdAt: u.createdAt,
                lastActiveAt: u.lastActiveAt,
              },
            ],
          };
        }
      }
      return { rows: [] };
    }

    if (sql.includes('FROM users WHERE id')) {
      const id = params?.[0];
      const u = this.users.get(id);
      if (u) {
        return {
          rows: [
            {
              id: u.id,
              tokenHash: u.tokenHash,
              balance: u.balance,
              totalPurchased: u.totalPurchased,
              createdAt: u.createdAt,
              lastActiveAt: u.lastActiveAt,
            },
          ],
        };
      }
      return { rows: [] };
    }

    if (sql.includes('UPDATE users') && sql.includes('balance = balance - $2') && sql.includes('balance >= $2')) {
      const id = params?.[0];
      const chars = Number(params?.[1]);
      const now = Number(params?.[2]);
      const u = this.users.get(id);
      if (!u || u.balance < chars) {
        return { rowCount: 0, rows: [] };
      }
      u.balance -= chars;
      u.lastActiveAt = now;
      return {
        rowCount: 1,
        rows: [{ balance: u.balance }],
      };
    }

    if (sql.includes('UPDATE users') && sql.includes('balance = balance + $2')) {
      const id = params?.[0];
      const chars = Number(params?.[1]);
      const now = Number(params?.[2]);
      const u = this.users.get(id);
      if (u) {
        u.balance += chars;
        u.lastActiveAt = now;
        return {
          rowCount: 1,
          rows: [{ balance: u.balance }],
        };
      }
      return { rowCount: 0, rows: [] };
    }

    return { rows: [], rowCount: 1 };
  }

  async end() {
    return Promise.resolve();
  }
}
