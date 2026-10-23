import { Mt5Error } from './errors.js';

/**
 * Provider talking to an external MT5 bridge over HTTP (the official MetaTrader5
 * Python package is Windows-only, so run a small bridge next to the terminal).
 * Expected contract (JSON): see docs/architecture.md.
 */
export class BridgeProvider {
  constructor({ login, server, secrets, bridgeUrl, bridgeToken }) {
    this.login = String(login);
    this.server = server;
    this.secrets = secrets;
    this.base = bridgeUrl.replace(/\/$/, '');
    this.token = bridgeToken;
  }

  async #call(method, path, body) {
    let res;
    try {
      res = await fetch(`${this.base}/accounts/${encodeURIComponent(this.login)}${path}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: ['Bearer', this.token].join(' ') },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new Mt5Error(`Bridge unreachable: ${e.message}`, { transient: true, code: 'NETWORK' });
    }
    if (!res.ok) {
      throw new Mt5Error(`Bridge returned HTTP ${res.status}`, { transient: res.status >= 500, code: 'BRIDGE' });
    }
    return res.status === 204 ? undefined : res.json();
  }

  connectAccount() {
    return this.#call('POST', '/connect', { server: this.server, password: this.secrets?.password });
  }
  disconnect() {
    return this.#call('POST', '/disconnect');
  }
  fetchAccountInfo() {
    return this.#call('GET', '/info');
  }
  fetchPositions() {
    return this.#call('GET', '/positions');
  }
  fetchOrders() {
    return this.#call('GET', '/orders');
  }
  fetchHistory({ days = 7 } = {}) {
    return this.#call('GET', `/history?days=${Number(days)}`);
  }
  getSymbolInfo(symbol) {
    return this.#call('GET', `/symbols/${encodeURIComponent(symbol)}`);
  }
  placeOrder(order) {
    return this.#call('POST', '/orders', order);
  }
  modifyPosition(ticket, changes) {
    return this.#call('POST', `/positions/${encodeURIComponent(ticket)}/modify`, changes);
  }
  closePosition(ticket, volume) {
    return this.#call('POST', `/positions/${encodeURIComponent(ticket)}/close`, { volume });
  }
}
