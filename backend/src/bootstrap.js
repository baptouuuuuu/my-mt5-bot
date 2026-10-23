import { loadConfig, validateConfig } from './config.js';
import { createLogger } from './logger.js';
import { openDb } from './db.js';
import { Store } from './store.js';
import { LocalSecretStore } from './secretStore.js';
import { ProviderManager } from './mt5/manager.js';
import { TradingService } from './trading.js';
import { Engine } from './engine.js';

export function bootstrap(config = loadConfig(), { factory, dbPath } = {}) {
  validateConfig(config);
  const logger = createLogger(config.logLevel);
  const db = openDb(dbPath || config.dbPath);
  const store = new Store(db, logger);
  const secretStore = new LocalSecretStore(config);
  const manager = new ProviderManager({ config, secretStore, factory });
  const trading = new TradingService({ store, manager });
  const engine = new Engine({ store, manager, trading, config });
  return { config, logger, db, store, secretStore, manager, trading, engine };
}
