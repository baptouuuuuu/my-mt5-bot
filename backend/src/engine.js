import { newCorrelationId } from './logger.js';
import { evaluateBreakEven } from './rules/breakEven.js';
import { evaluateAutoSltp } from './rules/autoSltp.js';
import { computeCopyOrder } from './rules/copyTrading.js';

/** Polling worker: sync every active account, then apply automations (unless kill switch is on). */
export class Engine {
  constructor({ store, manager, trading, config }) {
    this.store = store;
    this.manager = manager;
    this.trading = trading;
    this.config = config;
    this.running = false;
    this.timer = null;
    this.dirty = new Set();
  }

  start() {
    const loop = async () => {
      await this.tick().catch((e) => this.store.logger?.error('Engine tick failed', { err: e.stack || String(e) }));
      this.timer = setTimeout(loop, this.config.pollIntervalMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return { skipped: true };
    this.running = true;
    const correlationId = newCorrelationId();
    try {
      const settings = this.store.getSettings();
      const synced = new Map();
      for (const a of this.store.listAccounts().filter((x) => x.active)) {
        try {
          const prev = a.status;
          if (this.config.mockMarket) this.manager.tickMock(a.id); // simulated market moves
          const r = await this.trading.sync(a.id);
          synced.set(a.id, r);
          if (prev === 'error')
            this.store.logEvent({ type: 'sync.recovered', accountId: a.id, correlationId, message: `Account ${a.name} reconnected` });
        } catch (e) {
          if (a.status !== 'error' || a.last_error !== e.message) {
            this.store.logEvent({
              level: 'error',
              type: 'sync.error',
              accountId: a.id,
              correlationId,
              message: `Sync failed for ${a.name}: ${e.message}`,
            });
          }
        }
      }
      if (settings.killSwitch) return { synced: synced.size, automation: 'kill-switch' };
      const ctx = { correlationId, dryRun: settings.dryRun };
      for (const [id, s] of synced) {
        await this.#applyAccountRules(this.store.getAccount(id), s, ctx);
      }
      await this.#runCopyTrading(synced, ctx);
      for (const id of this.dirty) await this.trading.sync(id).catch(() => {}); // refresh snapshots after changes
      this.dirty.clear();
      return { synced: synced.size, automation: settings.dryRun ? 'dry-run' : 'live' };
    } finally {
      this.running = false;
    }
  }

  async #applyAccountRules(account, s, ctx) {
    const be = this.store.getRule('be', account.id);
    const asl = this.store.getRule('autosltp', account.id);
    if (!be.enabled && !asl.enabled) return;
    const symCache = new Map();
    const symbol = async (name) => {
      if (!symCache.has(name)) symCache.set(name, await s.provider.getSymbolInfo(name));
      return symCache.get(name);
    };
    for (const pos of s.positions) {
      try {
        const sym = await symbol(pos.symbol);
        if (asl.enabled) {
          const ch = evaluateAutoSltp(pos, sym, asl.config, { balance: s.info.balance });
          if (ch) await this.#modify(account, s.provider, pos, 'autosltp', ch, 60, ctx);
        }
        if (be.enabled) {
          const ch = evaluateBreakEven(pos, sym, be.config);
          if (ch) await this.#modify(account, s.provider, pos, 'be', ch, be.config.cooldownSec, ctx);
        }
      } catch (e) {
        this.store.logEvent({
          level: 'error',
          type: 'rule.error',
          accountId: account.id,
          correlationId: ctx.correlationId,
          message: `Rule error on #${pos.ticket}: ${e.message}`,
        });
      }
    }
  }

  async #modify(account, provider, pos, rule, changes, cooldownSec, ctx) {
    if (this.store.cooldownActive(account.id, pos.ticket, rule, cooldownSec)) return;
    this.store.touchCooldown(account.id, pos.ticket, rule); // also on failure: anti-spam
    const data = { ticket: pos.ticket, rule, changes, dryRun: ctx.dryRun };
    const label = `${rule.toUpperCase()} #${pos.ticket} ${pos.symbol} ${JSON.stringify(changes)}`;
    if (ctx.dryRun) {
      this.store.logEvent({
        type: `rule.${rule}.dryrun`,
        accountId: account.id,
        correlationId: ctx.correlationId,
        message: `[dry-run] ${label}`,
        data,
      });
      return;
    }
    try {
      await provider.modifyPosition(pos.ticket, changes);
      this.dirty.add(account.id);
      this.store.logEvent({
        type: `rule.${rule}`,
        accountId: account.id,
        correlationId: ctx.correlationId,
        message: `Applied ${label}`,
        data,
      });
    } catch (e) {
      this.store.logEvent({
        level: 'error',
        type: `rule.${rule}.failed`,
        accountId: account.id,
        correlationId: ctx.correlationId,
        message: `Failed ${label}: ${e.message}`,
        data,
      });
    }
  }

  async #runCopyTrading(synced, ctx) {
    for (const link of this.store.listLinks().filter((l) => l.enabled)) {
      const src = synced.get(link.sourceAccountId);
      const dst = synced.get(link.destAccountId);
      if (!src || !dst) continue;
      const open = new Set(src.positions.map((p) => p.ticket));
      const base = { accountId: link.destAccountId, correlationId: ctx.correlationId };

      for (const pos of src.positions) {
        const order = computeCopyOrder(pos, link.config);
        if (!order) continue;
        if (!this.store.claimCopy(link.sourceAccountId, pos.ticket, link.destAccountId, ctx.dryRun ? 'dryrun' : 'pending')) continue;
        const data = { sourceAccountId: link.sourceAccountId, sourceTicket: pos.ticket, order, dryRun: ctx.dryRun };
        if (ctx.dryRun) {
          this.store.logEvent({
            ...base,
            type: 'copy.dryrun',
            message: `[dry-run] copy #${pos.ticket} -> ${order.type} ${order.volume} ${order.symbol}`,
            data,
          });
          continue;
        }
        try {
          const { ticket } = await dst.provider.placeOrder(order);
          this.dirty.add(link.destAccountId);
          this.store.updateCopy(link.sourceAccountId, pos.ticket, link.destAccountId, { status: 'open', destTicket: ticket });
          this.store.logEvent({
            ...base,
            type: 'copy.success',
            message: `Copied #${pos.ticket} -> #${ticket} (${order.type} ${order.volume} ${order.symbol})`,
            data: { ...data, destTicket: ticket },
          });
        } catch (e) {
          this.store.updateCopy(link.sourceAccountId, pos.ticket, link.destAccountId, { status: 'failed' });
          this.store.logEvent({ ...base, level: 'error', type: 'copy.failed', message: `Copy #${pos.ticket} failed: ${e.message}`, data });
        }
      }

      for (const m of this.store.listCopies(link.sourceAccountId, link.destAccountId)) {
        if (m.status !== 'open' || open.has(m.source_ticket)) continue;
        try {
          await dst.provider.closePosition(m.dest_ticket);
        } catch (e) {
          if (e.code !== 'NOT_FOUND') {
            this.store.logEvent({
              ...base,
              level: 'error',
              type: 'copy.close.failed',
              message: `Closing copy #${m.dest_ticket} failed: ${e.message}`,
            });
            continue;
          }
        }
        this.dirty.add(link.destAccountId);
        this.store.updateCopy(link.sourceAccountId, m.source_ticket, link.destAccountId, { status: 'closed' });
        this.store.logEvent({ ...base, type: 'copy.closed', message: `Closed copy #${m.dest_ticket} (source #${m.source_ticket} closed)` });
      }
    }
  }
}
