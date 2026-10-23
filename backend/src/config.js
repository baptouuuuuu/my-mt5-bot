import path from 'node:path';

export function loadConfig(env = process.env) {
  const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
  const bool = (v, d) => (v === undefined || v === '' ? d : v === 'true' || v === '1');
  return {
    port: num(env.PORT, 4000),
    dbPath: env.DB_PATH || path.resolve('data', 'bot.db'),
    appPassword: env.APP_PASSWORD || '',
    sessionSecret: env.SESSION_SECRET || '',
    sessionTtlSec: num(env.SESSION_TTL_SEC, 8 * 3600),
    secretKey: env.SECRET_KEY || '',
    secretKeyFile: env.SECRET_KEY_FILE || path.resolve('data', 'secret.key'),
    corsOrigins: (env.CORS_ORIGINS || 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    embedWorker: bool(env.EMBED_WORKER, true),
    pollIntervalMs: num(env.POLL_INTERVAL_MS, 5000),
    mt5Timeout: num(env.MT5_TIMEOUT_MS, 8000),
    mt5Retries: num(env.MT5_RETRIES, 2),
    mockMarket: bool(env.MOCK_MARKET, true),
    bridgeUrl: env.MT5_BRIDGE_URL || '',
    bridgeToken: env.MT5_BRIDGE_TOKEN || '',
    logLevel: env.LOG_LEVEL || 'info',
    actionRateLimit: num(env.ACTION_RATE_LIMIT_PER_MIN, 30),
  };
}

export function validateConfig(cfg) {
  const errors = [];
  if (!cfg.appPassword) errors.push('APP_PASSWORD is required');
  if (cfg.sessionSecret.length < 16) errors.push('SESSION_SECRET is required (min 16 chars)');
  if (errors.length) throw new Error(`Invalid configuration: ${errors.join('; ')}`);
}
