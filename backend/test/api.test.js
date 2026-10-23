import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { bootstrap } from '../src/bootstrap.js';
import { createApp } from '../src/app.js';

let ctx, server, base, token;
const call = async (method, url, body, auth = true) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(auth && token ? { authorization: ['Bearer', token].join(' ') } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

before(async () => {
  const config = loadConfig({
    APP_PASSWORD: 'test-pass',
    SESSION_SECRET: 'x'.repeat(32),
    SECRET_KEY: 'test-key',
    SECRET_KEY_FILE: path.join(os.tmpdir(), 'mt5bot-test.key'),
    ACTION_RATE_LIMIT_PER_MIN: '1000',
    MOCK_MARKET: 'false',
  });
  ctx = bootstrap(config, { dbPath: ':memory:' });
  ctx.logger = { info() {}, warn() {}, error() {}, debug() {} };
  ctx.store.logger = ctx.logger;
  server = createApp(ctx).listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

test('requires authentication', async () => {
  assert.equal((await call('GET', '/accounts', undefined, false)).status, 401);
  assert.equal((await call('GET', '/health', undefined, false)).status, 200);
  assert.equal((await call('POST', '/auth/login', { password: 'nope' }, false)).status, 401);
  const r = await call('POST', '/auth/login', { password: 'test-pass' }, false);
  assert.equal(r.status, 200);
  token = r.body.token;
  assert.equal((await call('GET', '/auth/me')).status, 200);
});

test('validation and secrets never exposed', async () => {
  assert.equal((await call('POST', '/accounts', { name: '' })).status, 400);
  const a = await call('POST', '/accounts', { name: 'A', login: '1', server: 'Demo', password: 'pw-secret' });
  assert.equal(a.status, 201);
  assert.ok(!JSON.stringify(a.body).includes('pw-secret'));
  assert.equal(a.body.hasSecret, true);
  assert.ok(!('secret_enc' in a.body));
  assert.ok(!JSON.stringify((await call('GET', '/accounts')).body).includes('secret_enc'));
});

test('copy links reject loops; rules validate', async () => {
  const b = (await call('POST', '/accounts', { name: 'B', login: '2', server: 'Demo' })).body;
  const [a] = (await call('GET', '/accounts')).body;
  assert.equal((await call('POST', '/copy-links', { sourceAccountId: a.id, destAccountId: b.id })).status, 201);
  assert.equal((await call('POST', '/copy-links', { sourceAccountId: a.id, destAccountId: b.id })).status, 409);
  assert.equal((await call('POST', '/copy-links', { sourceAccountId: b.id, destAccountId: a.id })).body.error.code, 'COPY_LOOP');
  assert.equal((await call('PUT', '/rules/be', { enabled: true, config: { mode: 'bad', threshold: 1 } })).status, 400);
  assert.equal((await call('PUT', '/rules/be', { enabled: true, config: { mode: 'points', threshold: 50 } })).status, 200);
});

test('engine: sync, auto SL/TP, dry-run then live, copy trading idempotent, kill switch', async () => {
  const [a, b] = (await call('GET', '/accounts')).body;
  await call('PUT', '/rules/autosltp', { enabled: true, config: { unit: 'pips', slDistance: 20, tpDistance: 40 } });

  // dry run (default): nothing modified, only logged
  await ctx.engine.tick();
  let pos = (await call('GET', '/positions')).body;
  assert.ok(pos.length >= 2);
  assert.ok(pos.some((p) => p.accountId === a.id && p.sl === 0 && p.tp === 0));
  let events = (await call('GET', '/events?limit=200')).body;
  assert.ok(events.some((e) => e.type === 'rule.autosltp.dryrun'));
  assert.ok(events.some((e) => e.type === 'copy.dryrun'));

  // kill switch blocks automations entirely
  await call('PUT', '/settings', { killSwitch: true, dryRun: false });
  ctx.db.exec('DELETE FROM rule_cooldowns; DELETE FROM copy_map');
  await ctx.engine.tick();
  pos = (await call('GET', '/positions')).body;
  assert.ok(pos.some((p) => p.accountId === a.id && p.sl === 0));
  assert.equal(pos.filter((p) => p.accountId === b.id).length, 2);

  // live
  await call('PUT', '/settings', { killSwitch: false, dryRun: false });
  await ctx.engine.tick();
  pos = (await call('GET', '/positions')).body;
  const eur = pos.find((p) => p.accountId === a.id && p.symbol === 'EURUSD' && !p.comment.startsWith('mt5bot'));
  assert.ok(eur.sl > 0 && eur.tp > 0);
  const copies = pos.filter((p) => p.accountId === b.id && p.comment.startsWith('mt5bot-copy'));
  assert.equal(copies.length, 2);

  // idempotence: further ticks do not duplicate
  await ctx.engine.tick();
  await ctx.engine.tick();
  pos = (await call('GET', '/positions')).body;
  assert.equal(pos.filter((p) => p.accountId === b.id && p.comment.startsWith('mt5bot-copy')).length, 2);

  // closing the source closes the copy
  const src = pos.find((p) => p.accountId === a.id && p.symbol === 'EURUSD');
  assert.equal((await call('POST', `/accounts/${a.id}/positions/${src.ticket}/close`, {})).status, 200);
  await ctx.engine.tick();
  pos = (await call('GET', '/positions')).body;
  assert.equal(pos.filter((p) => p.accountId === b.id && p.comment === `mt5bot-copy:${src.ticket}`).length, 0);
});

test('manual actions validate stops and BE', async () => {
  const [a] = (await call('GET', '/accounts')).body;
  const pos = (await call('GET', '/positions')).body.find((p) => p.accountId === a.id);
  const wrong = pos.type === 'buy' ? pos.currentPrice + 1 : pos.currentPrice - 1;
  const r = await call('POST', `/accounts/${a.id}/positions/${pos.ticket}/modify`, { sl: wrong });
  assert.equal(r.body.error.code, 'INVALID_STOPS');
  assert.equal((await call('POST', `/accounts/${a.id}/positions/${pos.ticket}/modify`, {})).status, 400);
  assert.equal((await call('POST', `/accounts/${a.id}/positions/999999/close`, {})).status, 404);
});

test('failing account is reported, others keep working', async () => {
  await call('POST', '/accounts', { name: 'Bad', login: 'fail', server: 'Demo' });
  await ctx.engine.tick();
  const accounts = (await call('GET', '/accounts')).body;
  const bad = accounts.find((x) => x.name === 'Bad');
  assert.equal(bad.status, 'error');
  assert.ok(accounts.find((x) => x.name === 'A').status === 'connected');
});
