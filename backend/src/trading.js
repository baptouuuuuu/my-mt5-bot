import { dir, hasValue, roundPrice } from './rules/common.js';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Manual trading actions + account sync, shared by the API and the worker. */
export class TradingService {
  constructor({ store, manager }) {
    this.store = store;
    this.manager = manager;
  }

  account(id) {
    const a = this.store.getAccount(id);
    if (!a) throw new HttpError(404, 'NOT_FOUND', `Account ${id} not found`);
    return a;
  }

  async #provider(id) {
    const a = this.account(id);
    if (!a.active) throw new HttpError(409, 'ACCOUNT_DISABLED', 'Account is disabled');
    return { a, p: await this.manager.connected(a) };
  }

  async #position(p, ticket) {
    const pos = (await p.fetchPositions()).find((x) => x.ticket === String(ticket));
    if (!pos) throw new HttpError(404, 'NOT_FOUND', `Position ${ticket} not found`);
    return pos;
  }

  /** Pulls account info/positions/orders into the snapshot table and updates health status. */
  async sync(accountId) {
    const a = this.account(accountId);
    try {
      const p = await this.manager.connected(a);
      const [info, positions, orders] = await Promise.all([p.fetchAccountInfo(), p.fetchPositions(), p.fetchOrders()]);
      this.store.saveSnapshot(a.id, { info, positions, orders });
      this.store.updateAccount(a.id, { status: 'connected', lastError: null, lastSyncAt: new Date().toISOString() });
      return { provider: p, info, positions };
    } catch (e) {
      this.store.updateAccount(a.id, { status: 'error', lastError: e.message });
      throw e;
    }
  }

  async history(accountId, days = 7) {
    const { p } = await this.#provider(accountId);
    return p.fetchHistory({ days });
  }

  async closePosition(accountId, ticket, volume, ctx = {}) {
    const { p } = await this.#provider(accountId);
    const pos = await this.#position(p, ticket);
    if (volume !== undefined && volume > pos.volume) throw new HttpError(400, 'VALIDATION', 'Volume exceeds position size');
    await p.closePosition(ticket, volume);
    this.#log(accountId, ctx, 'manual.close', `Closed ${volume ?? 'all'} of #${ticket} (${pos.symbol})`, { ticket, volume });
  }

  async modifyPosition(accountId, ticket, { sl, tp }, ctx = {}) {
    const { p } = await this.#provider(accountId);
    const pos = await this.#position(p, ticket);
    const d = dir(pos);
    if (sl && d * (pos.currentPrice - sl) <= 0) throw new HttpError(400, 'INVALID_STOPS', 'SL is on the wrong side of the current price');
    if (tp && d * (tp - pos.currentPrice) <= 0) throw new HttpError(400, 'INVALID_STOPS', 'TP is on the wrong side of the current price');
    await p.modifyPosition(ticket, { sl, tp });
    this.#log(accountId, ctx, 'manual.modify', `Modified #${ticket}: sl=${sl} tp=${tp}`, { ticket, sl, tp });
  }

  async moveToBreakEven(accountId, ticket, offsetPoints = 0, ctx = {}) {
    const { p } = await this.#provider(accountId);
    const pos = await this.#position(p, ticket);
    const sym = await p.getSymbolInfo(pos.symbol);
    const d = dir(pos);
    const sl = roundPrice(pos.openPrice + d * offsetPoints * sym.point, sym);
    if (d * (pos.currentPrice - sl) <= 0) throw new HttpError(409, 'NOT_IN_PROFIT', 'Price has not reached break-even yet');
    if (hasValue(pos.sl) && d * (pos.sl - sl) >= 0) throw new HttpError(409, 'ALREADY_PROTECTED', 'SL is already at or beyond break-even');
    await p.modifyPosition(ticket, { sl });
    this.#log(accountId, ctx, 'manual.be', `Moved #${ticket} to BE (${sl})`, { ticket, sl });
  }

  #log(accountId, ctx, type, message, data) {
    this.store.logEvent({ type, accountId, correlationId: ctx.correlationId, message, data });
  }
}
