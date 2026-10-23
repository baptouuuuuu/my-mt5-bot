import { Mt5Error } from './errors.js';

const SYMBOLS = {
  EURUSD: { price: 1.085, point: 0.00001, digits: 5, tickValue: 1 },
  GBPUSD: { price: 1.27, point: 0.00001, digits: 5, tickValue: 1 },
  USDJPY: { price: 150.0, point: 0.001, digits: 3, tickValue: 0.67 },
  XAUUSD: { price: 2350, point: 0.01, digits: 2, tickValue: 1 },
};

function prng(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** In-memory MT5 simulator. login "fail" => permanent error, "flaky" => first connect fails transiently. */
export class MockProvider {
  constructor({ id, login, balance = 10000 }) {
    this.id = id;
    this.login = String(login);
    this.rand = prng(Number(id) * 7919 + 17);
    this.balance = balance;
    this.connected = false;
    this.prices = Object.fromEntries(Object.entries(SYMBOLS).map(([k, v]) => [k, v.price]));
    this.positions = [];
    this.history = [];
    this.nextTicket = Number(id) * 100000 + 1;
    this.flakyUsed = false;
  }

  async connectAccount() {
    if (this.login === 'fail') throw new Mt5Error('Invalid credentials', { code: 'AUTH' });
    if (this.login === 'flaky' && !this.flakyUsed) {
      this.flakyUsed = true;
      throw new Mt5Error('Terminal unreachable', { transient: true, code: 'NETWORK' });
    }
    if (!this.connected) {
      this.connected = true;
      if (this.positions.length === 0 && this.login !== 'empty') {
        this.#open('EURUSD', 'buy', 0.1, 1.0845, 0, 0, 0, 'manual');
        this.#open('XAUUSD', 'sell', 0.05, 2352, 2360, 2330, 0, 'seed');
      }
    }
  }

  async disconnect() {
    this.connected = false;
  }

  #assert() {
    if (!this.connected) throw new Mt5Error('Not connected', { transient: true, code: 'NOT_CONNECTED' });
  }

  /** Advance the simulated market one step; closes positions that hit SL/TP. */
  tick() {
    for (const [sym, info] of Object.entries(SYMBOLS)) {
      this.prices[sym] += (this.rand() - 0.5) * 20 * info.point * (sym === 'XAUUSD' ? 5 : 1);
    }
    for (const p of [...this.positions]) {
      const px = this.prices[p.symbol];
      const hitSl = p.sl && (p.type === 'buy' ? px <= p.sl : px >= p.sl);
      const hitTp = p.tp && (p.type === 'buy' ? px >= p.tp : px <= p.tp);
      if (hitSl || hitTp) this.#close(p, hitSl ? p.sl : p.tp);
    }
  }

  #profit(p, price) {
    const s = SYMBOLS[p.symbol];
    const pts = (p.type === 'buy' ? price - p.openPrice : p.openPrice - price) / s.point;
    return Math.round(pts * s.tickValue * p.volume * 100) / 100;
  }

  #open(symbol, type, volume, openPrice, sl, tp, magic, comment) {
    const p = {
      ticket: String(this.nextTicket++),
      symbol,
      type,
      volume,
      openPrice,
      sl,
      tp,
      magic,
      comment,
      openTime: new Date().toISOString(),
    };
    this.positions.push(p);
    return p;
  }

  #close(p, price, volume = p.volume) {
    const profit = this.#profit({ ...p, volume }, price);
    this.balance += profit;
    this.history.push({ ticket: p.ticket, symbol: p.symbol, type: p.type, volume, price, profit, time: new Date().toISOString() });
    if (volume >= p.volume) this.positions = this.positions.filter((x) => x !== p);
    else p.volume = Math.round((p.volume - volume) * 100) / 100;
  }

  #find(ticket) {
    const p = this.positions.find((x) => x.ticket === String(ticket));
    if (!p) throw new Mt5Error(`Position ${ticket} not found`, { code: 'NOT_FOUND' });
    return p;
  }

  async fetchAccountInfo() {
    this.#assert();
    const floating = (await this.fetchPositions()).reduce((a, p) => a + p.profit, 0);
    return {
      balance: Math.round(this.balance * 100) / 100,
      equity: Math.round((this.balance + floating) * 100) / 100,
      margin: 0,
      freeMargin: Math.round((this.balance + floating) * 100) / 100,
      currency: 'USD',
      leverage: 100,
    };
  }

  async fetchPositions() {
    this.#assert();
    return this.positions.map((p) => ({
      ...p,
      currentPrice: this.prices[p.symbol],
      profit: this.#profit(p, this.prices[p.symbol]),
    }));
  }

  async fetchOrders() {
    this.#assert();
    return [];
  }

  async fetchHistory() {
    this.#assert();
    return [...this.history];
  }

  async getSymbolInfo(symbol) {
    const s = SYMBOLS[symbol];
    if (!s) throw new Mt5Error(`Unknown symbol ${symbol}`, { code: 'SYMBOL' });
    const pipSize = s.digits === 3 || s.digits === 5 ? s.point * 10 : s.point;
    return { symbol, point: s.point, digits: s.digits, pipSize, tickValue: s.tickValue, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01 };
  }

  async placeOrder({ symbol, type, volume, sl = 0, tp = 0, magic = 0, comment = '' }) {
    this.#assert();
    await this.getSymbolInfo(symbol);
    const p = this.#open(symbol, type, volume, this.prices[symbol], sl, tp, magic, comment);
    return { ticket: p.ticket };
  }

  async modifyPosition(ticket, { sl, tp }) {
    this.#assert();
    const p = this.#find(ticket);
    if (sl !== undefined) p.sl = sl;
    if (tp !== undefined) p.tp = tp;
  }

  async closePosition(ticket, volume) {
    this.#assert();
    const p = this.#find(ticket);
    this.#close(p, this.prices[p.symbol], volume && volume < p.volume ? volume : p.volume);
  }
}
