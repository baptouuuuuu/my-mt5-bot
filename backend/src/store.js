import { now } from './db.js';
import { BE_DEFAULTS } from './rules/breakEven.js';
import { AUTOSLTP_DEFAULTS } from './rules/autoSltp.js';
import { COPY_DEFAULTS } from './rules/copyTrading.js';

const DEFAULTS = { be: BE_DEFAULTS, autosltp: AUTOSLTP_DEFAULTS };
const json = (s, d = null) => (s ? JSON.parse(s) : d);

/** Persistence layer: the only module that talks SQL. */
export class Store {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  // ---- events
  logEvent({ level = 'info', type, accountId = null, correlationId = null, message, data = null }) {
    this.db
      .prepare('INSERT INTO events (ts, level, type, account_id, correlation_id, message, data) VALUES (?,?,?,?,?,?,?)')
      .run(now(), level, type, accountId, correlationId, message, data ? JSON.stringify(data) : null);
    this.logger?.[level]?.(message, { type, accountId, correlationId, ...(data || {}) });
  }

  listEvents({ limit = 100, level, accountId, type } = {}) {
    const where = [];
    const args = [];
    if (level) (where.push('level = ?'), args.push(level));
    if (accountId) (where.push('account_id = ?'), args.push(accountId));
    if (type) (where.push('type = ?'), args.push(type));
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return this.db
      .prepare(sql)
      .all(...args, limit)
      .map((r) => ({ ...r, data: json(r.data) }));
  }

  // ---- settings
  getSettings() {
    const rows = Object.fromEntries(
      this.db
        .prepare('SELECT key, value FROM settings')
        .all()
        .map((r) => [r.key, r.value]),
    );
    return { killSwitch: rows.kill_switch === 'true', dryRun: rows.dry_run === 'true' };
  }

  setSettings({ killSwitch, dryRun }) {
    const up = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    if (killSwitch !== undefined) up.run('kill_switch', String(killSwitch));
    if (dryRun !== undefined) up.run('dry_run', String(dryRun));
    return this.getSettings();
  }

  // ---- accounts
  #account(r) {
    return r && { ...r, active: !!r.active };
  }

  listAccounts() {
    return this.db
      .prepare('SELECT * FROM accounts ORDER BY id')
      .all()
      .map((r) => this.#account(r));
  }

  getAccount(id) {
    return this.#account(this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
  }

  createAccount({ name, login, server, provider, secretEnc, active }) {
    const t = now();
    const r = this.db
      .prepare(
        'INSERT INTO accounts (name, login, server, provider, secret_enc, active, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(name, login, server, provider, secretEnc, active ? 1 : 0, active ? 'unknown' : 'disabled', t, t);
    return this.getAccount(Number(r.lastInsertRowid));
  }

  updateAccount(id, patch) {
    const map = {
      name: 'name',
      login: 'login',
      server: 'server',
      provider: 'provider',
      secretEnc: 'secret_enc',
      active: 'active',
      status: 'status',
      lastError: 'last_error',
      lastSyncAt: 'last_sync_at',
    };
    const sets = [];
    const args = [];
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] === undefined) continue;
      sets.push(`${col} = ?`);
      args.push(k === 'active' ? (patch[k] ? 1 : 0) : patch[k]);
    }
    if (!sets.length) return this.getAccount(id);
    this.db.prepare(`UPDATE accounts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, now(), id);
    return this.getAccount(id);
  }

  deleteAccount(id) {
    return this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes > 0;
  }

  // ---- snapshots
  saveSnapshot(accountId, { info, positions, orders }) {
    this.db
      .prepare(
        `INSERT INTO snapshots (account_id, account_info, positions, orders, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(account_id) DO UPDATE SET account_info = excluded.account_info, positions = excluded.positions, orders = excluded.orders, updated_at = excluded.updated_at`,
      )
      .run(accountId, JSON.stringify(info), JSON.stringify(positions), JSON.stringify(orders), now());
  }

  getSnapshot(accountId) {
    const r = this.db.prepare('SELECT * FROM snapshots WHERE account_id = ?').get(accountId);
    return r && { info: json(r.account_info), positions: json(r.positions, []), orders: json(r.orders, []), updatedAt: r.updated_at };
  }

  // ---- rules
  /** Account-specific row wins over the global one (even when disabled). */
  getRule(type, accountId) {
    const own = accountId ? this.#ruleRow(type, accountId) : null;
    const row = own || this.#ruleRow(type, null);
    return {
      enabled: !!row?.enabled,
      config: { ...DEFAULTS[type], ...json(row?.config, {}) },
      scope: row ? (row.account_id ? 'account' : 'global') : 'default',
    };
  }

  #ruleRow(type, accountId) {
    return accountId
      ? this.db.prepare('SELECT * FROM rule_configs WHERE type = ? AND account_id = ?').get(type, accountId)
      : this.db.prepare('SELECT * FROM rule_configs WHERE type = ? AND account_id IS NULL').get(type);
  }

  getRuleScope(type, accountId) {
    const row = this.#ruleRow(type, accountId ?? null);
    return row ? { enabled: !!row.enabled, config: { ...DEFAULTS[type], ...json(row.config, {}) } } : null;
  }

  setRule(type, accountId, { enabled, config }) {
    const existing = this.#ruleRow(type, accountId ?? null);
    if (existing) {
      this.db
        .prepare('UPDATE rule_configs SET enabled = ?, config = ?, updated_at = ? WHERE id = ?')
        .run(enabled ? 1 : 0, JSON.stringify(config), now(), existing.id);
    } else {
      this.db
        .prepare('INSERT INTO rule_configs (type, account_id, enabled, config, updated_at) VALUES (?,?,?,?,?)')
        .run(type, accountId ?? null, enabled ? 1 : 0, JSON.stringify(config), now());
    }
    return this.getRuleScope(type, accountId);
  }

  deleteRule(type, accountId) {
    return this.db.prepare('DELETE FROM rule_configs WHERE type = ? AND account_id = ?').run(type, accountId).changes > 0;
  }

  // ---- cooldowns
  cooldownActive(accountId, ticket, rule, cooldownSec, nowMs = Date.now()) {
    const r = this.db
      .prepare('SELECT last_at FROM rule_cooldowns WHERE account_id = ? AND ticket = ? AND rule = ?')
      .get(accountId, String(ticket), rule);
    return !!r && nowMs - r.last_at < cooldownSec * 1000;
  }

  touchCooldown(accountId, ticket, rule, nowMs = Date.now()) {
    this.db
      .prepare(
        'INSERT INTO rule_cooldowns (account_id, ticket, rule, last_at) VALUES (?,?,?,?) ON CONFLICT(account_id, ticket, rule) DO UPDATE SET last_at = excluded.last_at',
      )
      .run(accountId, String(ticket), rule, nowMs);
  }

  // ---- copy trading
  #link(r) {
    return (
      r && {
        id: r.id,
        sourceAccountId: r.source_account_id,
        destAccountId: r.dest_account_id,
        enabled: !!r.enabled,
        config: { ...COPY_DEFAULTS, ...json(r.config, {}) },
        createdAt: r.created_at,
      }
    );
  }

  listLinks() {
    return this.db
      .prepare('SELECT * FROM copy_links ORDER BY id')
      .all()
      .map((r) => this.#link(r));
  }

  getLink(id) {
    return this.#link(this.db.prepare('SELECT * FROM copy_links WHERE id = ?').get(id));
  }

  createLink({ sourceAccountId, destAccountId, enabled, config }) {
    const r = this.db
      .prepare('INSERT INTO copy_links (source_account_id, dest_account_id, enabled, config, created_at) VALUES (?,?,?,?,?)')
      .run(sourceAccountId, destAccountId, enabled ? 1 : 0, JSON.stringify(config), now());
    return this.getLink(Number(r.lastInsertRowid));
  }

  updateLink(id, { enabled, config }) {
    const cur = this.getLink(id);
    if (!cur) return null;
    this.db
      .prepare('UPDATE copy_links SET enabled = ?, config = ? WHERE id = ?')
      .run((enabled ?? cur.enabled) ? 1 : 0, JSON.stringify(config ?? cur.config), id);
    return this.getLink(id);
  }

  deleteLink(id) {
    return this.db.prepare('DELETE FROM copy_links WHERE id = ?').run(id).changes > 0;
  }

  /** Idempotent claim: returns true only the first time (source, ticket, dest) is seen. */
  claimCopy(sourceAccountId, sourceTicket, destAccountId, status = 'pending') {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO copy_map (source_account_id, source_ticket, dest_account_id, status, created_at) VALUES (?,?,?,?,?)')
      .run(sourceAccountId, String(sourceTicket), destAccountId, status, now());
    return r.changes > 0;
  }

  updateCopy(sourceAccountId, sourceTicket, destAccountId, { status, destTicket }) {
    this.db
      .prepare(
        'UPDATE copy_map SET status = ?, dest_ticket = COALESCE(?, dest_ticket) WHERE source_account_id = ? AND source_ticket = ? AND dest_account_id = ?',
      )
      .run(status, destTicket ?? null, sourceAccountId, String(sourceTicket), destAccountId);
  }

  listCopies(sourceAccountId, destAccountId) {
    return this.db
      .prepare('SELECT * FROM copy_map WHERE source_account_id = ? AND dest_account_id = ?')
      .all(sourceAccountId, destAccountId);
  }
}
