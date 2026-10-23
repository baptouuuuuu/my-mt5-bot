import express from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import { checkPassword, requireAuth, signToken } from './auth.js';
import { rateLimit } from './rateLimit.js';
import { newCorrelationId } from './logger.js';
import { HttpError } from './trading.js';
import { wouldCreateCycle } from './rules/copyTrading.js';
import * as S from './schemas.js';

const parse = (schema, data) => schema.parse(data);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createApp({ config, store, manager, trading, secretStore, logger }) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    req.ctx = { correlationId: req.headers['x-correlation-id']?.toString().slice(0, 64) || newCorrelationId() };
    res.setHeader('x-correlation-id', req.ctx.correlationId);
    next();
  });

  const publicAccount = (a) => ({
    id: a.id,
    name: a.name,
    login: a.login,
    server: a.server,
    provider: a.provider,
    active: a.active,
    status: a.status,
    lastError: a.last_error,
    lastSyncAt: a.last_sync_at,
    hasSecret: !!a.secret_enc,
  });
  const idParam = (req, name = 'id') => {
    const n = Number(req.params[name]);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'VALIDATION', `Invalid ${name}`);
    return n;
  };
  const ruleType = (req) => {
    if (!S.ruleSchemas[req.params.type]) throw new HttpError(404, 'NOT_FOUND', 'Unknown rule type');
    return req.params.type;
  };

  const api = express.Router();
  const critical = rateLimit({ max: config.actionRateLimit, windowMs: 60_000, name: 'critical actions' });

  api.get('/health', (req, res) => res.json({ status: 'ok' }));
  api.post(
    '/auth/login',
    rateLimit({ max: 10, windowMs: 60_000, name: 'login' }),
    wrap((req, res) => {
      const { password } = parse(S.loginBody, req.body);
      if (!checkPassword(password, config.appPassword)) {
        store.logEvent({
          level: 'warn',
          type: 'auth.failed',
          correlationId: req.ctx.correlationId,
          message: `Failed login from ${req.ip}`,
        });
        throw new HttpError(401, 'INVALID_PASSWORD', 'Invalid password');
      }
      res.json({ token: signToken(config.sessionSecret, config.sessionTtlSec), expiresInSec: config.sessionTtlSec });
    }),
  );

  api.use(rateLimit({ max: 600, windowMs: 60_000, name: 'api' }), requireAuth(config.sessionSecret));
  api.get('/auth/me', (req, res) => res.json({ authenticated: true }));

  // ---- accounts
  api.get('/accounts', (req, res) => res.json(store.listAccounts().map(publicAccount)));
  api.post(
    '/accounts',
    wrap(async (req, res) => {
      const b = parse(S.accountCreate, req.body);
      const secretEnc = b.password ? secretStore.encrypt({ password: b.password }) : null;
      const a = store.createAccount({ ...b, secretEnc });
      store.logEvent({
        type: 'account.created',
        accountId: a.id,
        correlationId: req.ctx.correlationId,
        message: `Account ${a.name} created`,
      });
      res.status(201).json(publicAccount(a));
    }),
  );
  api.patch(
    '/accounts/:id',
    wrap(async (req, res) => {
      const id = idParam(req);
      trading.account(id);
      const { password, ...b } = parse(S.accountUpdate, req.body);
      const patch = { ...b };
      if (password) patch.secretEnc = secretStore.encrypt({ password });
      if (b.active === false) patch.status = 'disabled';
      if (b.active === true) patch.status = 'unknown';
      const a = store.updateAccount(id, patch);
      await manager.drop(id); // credentials/provider may have changed
      store.logEvent({
        type: 'account.updated',
        accountId: id,
        correlationId: req.ctx.correlationId,
        message: `Account ${a.name} updated`,
      });
      res.json(publicAccount(a));
    }),
  );
  api.delete(
    '/accounts/:id',
    wrap(async (req, res) => {
      const id = idParam(req);
      const a = trading.account(id);
      await manager.drop(id);
      store.deleteAccount(id);
      store.logEvent({ type: 'account.deleted', correlationId: req.ctx.correlationId, message: `Account ${a.name} deleted` });
      res.status(204).end();
    }),
  );
  api.post(
    '/accounts/:id/sync',
    critical,
    wrap(async (req, res) => {
      const id = idParam(req);
      await trading.sync(id);
      res.json(publicAccount(store.getAccount(id)));
    }),
  );

  // ---- trades (served from the latest worker snapshot)
  const collect = (key) =>
    store
      .listAccounts()
      .flatMap((a) => (store.getSnapshot(a.id)?.[key] || []).map((x) => ({ ...x, accountId: a.id, accountName: a.name })));
  api.get('/positions', (req, res) => res.json(collect('positions')));
  api.get('/orders', (req, res) => res.json(collect('orders')));
  api.get(
    '/accounts/:id/history',
    wrap(async (req, res) => {
      const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
      res.json(await trading.history(idParam(req), days));
    }),
  );

  const positionAction = (path, schema, run) =>
    api.post(
      `/accounts/:id/positions/:ticket/${path}`,
      critical,
      wrap(async (req, res) => {
        const body = parse(schema, req.body ?? {});
        await run(idParam(req), req.params.ticket, body, req.ctx);
        await trading.sync(idParam(req)).catch(() => {});
        res.json({ ok: true });
      }),
    );
  positionAction('close', S.closeBody, (id, t, b, ctx) => trading.closePosition(id, t, b.volume, ctx));
  positionAction('modify', S.modifyBody, (id, t, b, ctx) => trading.modifyPosition(id, t, b, ctx));
  positionAction('breakeven', S.beBody, (id, t, b, ctx) => trading.moveToBreakEven(id, t, b.offsetPoints, ctx));

  // ---- rules
  const getRules = (accountId) => ({ be: store.getRuleScope('be', accountId), autosltp: store.getRuleScope('autosltp', accountId) });
  api.get('/rules', (req, res) => res.json(getRules(null)));
  api.put(
    '/rules/:type',
    wrap((req, res) => {
      const type = ruleType(req);
      const out = store.setRule(type, null, parse(S.ruleSchemas[type], req.body));
      store.logEvent({ type: 'rules.updated', correlationId: req.ctx.correlationId, message: `Global ${type} rule updated`, data: out });
      res.json(out);
    }),
  );
  api.get(
    '/accounts/:id/rules',
    wrap((req, res) => (trading.account(idParam(req)), res.json(getRules(idParam(req))))),
  );
  api.put(
    '/accounts/:id/rules/:type',
    wrap((req, res) => {
      const id = idParam(req);
      trading.account(id);
      const type = ruleType(req);
      const out = store.setRule(type, id, parse(S.ruleSchemas[type], req.body));
      store.logEvent({
        type: 'rules.updated',
        accountId: id,
        correlationId: req.ctx.correlationId,
        message: `Account ${type} rule updated`,
        data: out,
      });
      res.json(out);
    }),
  );
  api.delete(
    '/accounts/:id/rules/:type',
    wrap((req, res) => {
      trading.account(idParam(req));
      ruleType(req);
      store.deleteRule(req.params.type, idParam(req));
      res.status(204).end();
    }),
  );

  // ---- copy trading
  api.get('/copy-links', (req, res) => res.json(store.listLinks()));
  api.post(
    '/copy-links',
    wrap((req, res) => {
      const b = parse(S.linkCreate, req.body);
      trading.account(b.sourceAccountId);
      trading.account(b.destAccountId);
      const existing = store.listLinks().map((l) => ({ source: l.sourceAccountId, dest: l.destAccountId }));
      if (existing.some((l) => l.source === b.sourceAccountId && l.dest === b.destAccountId))
        throw new HttpError(409, 'DUPLICATE', 'Link already exists');
      if (wouldCreateCycle(existing, b.sourceAccountId, b.destAccountId))
        throw new HttpError(409, 'COPY_LOOP', 'This link would create a copy loop');
      const link = store.createLink(b);
      store.logEvent({
        type: 'copy.link.created',
        accountId: b.destAccountId,
        correlationId: req.ctx.correlationId,
        message: `Copy link ${b.sourceAccountId} -> ${b.destAccountId} created`,
      });
      res.status(201).json(link);
    }),
  );
  api.patch(
    '/copy-links/:id',
    wrap((req, res) => {
      const link = store.updateLink(idParam(req), parse(S.linkUpdate, req.body));
      if (!link) throw new HttpError(404, 'NOT_FOUND', 'Link not found');
      res.json(link);
    }),
  );
  api.delete(
    '/copy-links/:id',
    wrap((req, res) => {
      if (!store.deleteLink(idParam(req))) throw new HttpError(404, 'NOT_FOUND', 'Link not found');
      res.status(204).end();
    }),
  );

  // ---- settings / events / overview
  api.get('/settings', (req, res) => res.json(store.getSettings()));
  api.put(
    '/settings',
    critical,
    wrap((req, res) => {
      const out = store.setSettings(parse(S.settingsBody, req.body));
      store.logEvent({
        level: 'warn',
        type: 'settings.updated',
        correlationId: req.ctx.correlationId,
        message: `Settings changed: killSwitch=${out.killSwitch} dryRun=${out.dryRun}`,
      });
      res.json(out);
    }),
  );
  api.get('/events', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json(
      store.listEvents({
        limit,
        level: req.query.level?.toString(),
        type: req.query.type?.toString(),
        accountId: Number(req.query.accountId) || undefined,
      }),
    );
  });
  api.get('/overview', (req, res) => {
    const accounts = store.listAccounts();
    const snaps = accounts.map((a) => ({ a, s: store.getSnapshot(a.id) }));
    const sum = (f) => snaps.reduce((t, { s }) => t + (s ? f(s) : 0), 0);
    res.json({
      accounts: accounts.length,
      connected: accounts.filter((a) => a.status === 'connected').length,
      errors: accounts.filter((a) => a.status === 'error').length,
      openPositions: sum((s) => s.positions.length),
      pendingOrders: sum((s) => s.orders.length),
      balance: sum((s) => s.info?.balance || 0),
      equity: sum((s) => s.info?.equity || 0),
      floatingPnl: sum((s) => s.positions.reduce((t, p) => t + p.profit, 0)),
      settings: store.getSettings(),
      perAccount: snaps.map(({ a, s }) => ({
        ...publicAccount(a),
        info: s?.info || null,
        positions: s?.positions.length || 0,
        pnl: s ? s.positions.reduce((t, p) => t + p.profit, 0) : 0,
      })),
    });
  });

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: 'Invalid payload',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    if (err?.name === 'Mt5Error') {
      return res.status(err.transient ? 503 : 502).json({ error: { code: err.code, message: err.message } });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid JSON' } });
    if (err?.message?.includes('UNIQUE constraint'))
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'Resource already exists' } });
    logger.error('Unhandled error', { correlationId: req.ctx?.correlationId, err: err?.stack || String(err) });
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error', correlationId: req.ctx?.correlationId } });
  });
  return app;
}
