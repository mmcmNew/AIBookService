import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresDatabase } from '../src/postgresDb.js';

test('PostgresDatabase: методы корректно формируют данные и вызывают пул', async () => {
  const queries: { sql: string; params?: any[] }[] = [];

  const mockClient = {
    async query(sql: string, params?: any[]) {
      queries.push({ sql, params });
      if (sql.includes('CREATE TABLE')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO users')) {
        return {
          rows: [
            {
              id: params?.[0],
              tokenHash: params?.[1],
              balance: params?.[2],
              totalPurchased: params?.[3],
              createdAt: params?.[4],
              lastActiveAt: params?.[5],
            },
          ],
        };
      }
      if (sql.includes('SELECT') && sql.includes('FROM users WHERE token_hash')) {
        return {
          rows: [
            {
              id: 'u-1',
              tokenHash: params?.[0],
              balance: '5000',
              totalPurchased: '0',
              createdAt: '1000',
              lastActiveAt: '1000',
            },
          ],
        };
      }
      if (sql.includes('UPDATE users') && sql.includes('WHERE id = $1 AND balance >= $2')) {
        return { rowCount: 1, rows: [{ balance: '4000' }] };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };

  const mockPool = {
    async connect() {
      return mockClient;
    },
    async query(sql: string, params?: any[]) {
      return mockClient.query(sql, params);
    },
    async end() {},
  };

  const db = new PostgresDatabase('postgres://fake:fake@localhost:5432/fakedb', mockPool);

  // 1. Создание пользователя
  const { user, token } = await db.createUser();
  assert.ok(user.id);
  assert.ok(token);
  assert.equal(user.balance, 15000);

  // 2. Авторизация по токену
  const authed = await db.authenticate(token);
  assert.ok(authed);
  assert.equal(authed?.id, 'u-1');

  // 3. Списание баланса
  const deducted = await db.deductBalance('u-1', 1000);
  assert.deepEqual(deducted, { balance: 4000 });

  // 4. Возврат баланса
  await db.refundBalance('u-1', 1000);
  const refundQuery = queries.find((q) => q.sql.includes('UPDATE users') && q.sql.includes('balance = balance + $2'));
  assert.ok(refundQuery);

  await db.close();
});
