import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { LocalSecretStore } from '../src/secretStore.js';
import { signToken, verifyToken, checkPassword } from '../src/auth.js';
import { Mt5Error, withRetry } from '../src/mt5/errors.js';
import { MockProvider } from '../src/mt5/mockProvider.js';
import { openDb } from '../src/db.js';

test('secret store round-trips and is not plaintext', () => {
  const s = new LocalSecretStore({ secretKey: 'k', secretKeyFile: path.join(os.tmpdir(), 'unused') });
  const enc = s.encrypt({ password: 'hunter2' });
  assert.ok(!enc.includes('hunter2'));
  assert.deepEqual(s.decrypt(enc), { password: 'hunter2' });
  const other = new LocalSecretStore({ secretKey: 'other', secretKeyFile: 'x' });
  assert.throws(() => other.decrypt(enc));
});

test('tokens: valid, expired, tampered', () => {
  const t = signToken('secret-secret-secret', 60, 1000);
  assert.ok(verifyToken(t, 'secret-secret-secret', 2000));
  assert.ok(!verifyToken(t, 'secret-secret-secret', 1000 + 61_000));
  assert.ok(!verifyToken(t, 'another-secret-value', 2000));
  assert.ok(!verifyToken(t.slice(0, -2) + 'xx', 'secret-secret-secret', 2000));
  assert.ok(!verifyToken(undefined, 'x'));
});

test('password check', () => {
  assert.ok(checkPassword('a', 'a'));
  assert.ok(!checkPassword('a', 'b'));
});

test('withRetry retries transient errors only', async () => {
  let n = 0;
  const r = await withRetry(
    async () => {
      if (++n < 3) throw new Mt5Error('boom', { transient: true });
      return 'ok';
    },
    { retries: 2, backoffMs: 1 },
  );
  assert.equal(r, 'ok');
  n = 0;
  await assert.rejects(withRetry(async () => (n++, Promise.reject(new Mt5Error('perm'))), { retries: 3, backoffMs: 1 }));
  assert.equal(n, 1);
  await assert.rejects(
    withRetry(() => new Promise(() => {}), { retries: 0, timeoutMs: 20 }),
    /timed out/,
  );
});

test('mock provider: open, modify, partial close, SL hit', async () => {
  const p = new MockProvider({ id: 1, login: 'x' });
  await p.connectAccount();
  const { ticket } = await p.placeOrder({ symbol: 'EURUSD', type: 'buy', volume: 1 });
  await p.modifyPosition(ticket, { sl: 1.0 });
  await p.closePosition(ticket, 0.4);
  const pos = (await p.fetchPositions()).find((x) => x.ticket === ticket);
  assert.equal(pos.volume, 0.6);
  assert.equal(pos.sl, 1.0);
  p.prices.EURUSD = 0.9;
  p.tick();
  assert.ok(!(await p.fetchPositions()).find((x) => x.ticket === ticket));
  await assert.rejects(new MockProvider({ id: 2, login: 'fail' }).connectAccount(), /credentials/);
});

test('migrations are idempotent', () => {
  const db = openDb(':memory:');
  const n = db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
  assert.ok(n >= 1);
});
