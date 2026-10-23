import { MockProvider } from './mockProvider.js';
import { BridgeProvider } from './bridgeProvider.js';
import { Mt5Error, withRetry } from './errors.js';
import { PROVIDER_METHODS } from './provider.js';

/** Caches one provider per account and wraps every call with timeout + retries. */
export class ProviderManager {
  constructor({ config, secretStore, factory }) {
    this.config = config;
    this.secretStore = secretStore;
    this.factory = factory || ((account, secrets) => this.#build(account, secrets));
    this.cache = new Map();
  }

  #build(account, secrets) {
    if (account.provider === 'mock') return new MockProvider({ id: account.id, login: account.login });
    if (account.provider === 'bridge') {
      if (!this.config.bridgeUrl) throw new Mt5Error('MT5_BRIDGE_URL is not configured', { code: 'CONFIG' });
      return new BridgeProvider({ ...account, secrets, bridgeUrl: this.config.bridgeUrl, bridgeToken: this.config.bridgeToken });
    }
    throw new Mt5Error(`Unknown provider ${account.provider}`, { code: 'CONFIG' });
  }

  #wrap(raw) {
    const opts = { retries: this.config.mt5Retries, timeoutMs: this.config.mt5Timeout, backoffMs: 100 };
    const wrapped = {};
    for (const m of PROVIDER_METHODS) {
      // order placement is never retried automatically to avoid duplicate executions
      const o = m === 'placeOrder' ? { ...opts, retries: 0 } : opts;
      wrapped[m] = (...args) => withRetry(() => raw[m](...args), { ...o, label: m });
    }
    wrapped.raw = raw;
    return wrapped;
  }

  async get(account) {
    let p = this.cache.get(account.id);
    if (!p) {
      const secrets = account.secret_enc ? this.secretStore.decrypt(account.secret_enc) : {};
      p = this.#wrap(this.factory(account, secrets));
      this.cache.set(account.id, p);
    }
    return p;
  }

  async connected(account) {
    const p = await this.get(account);
    await p.connectAccount();
    return p;
  }

  tickMock(accountId) {
    this.cache.get(accountId)?.raw.tick?.();
  }

  async drop(accountId) {
    const p = this.cache.get(accountId);
    this.cache.delete(accountId);
    if (p) await p.disconnect().catch(() => {});
  }
}
