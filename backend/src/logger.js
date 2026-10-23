import { randomUUID } from 'node:crypto';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = 'info', write = (l) => process.stdout.write(l + '\n')) {
  const min = LEVELS[level] ?? 20;
  const make = (base) => {
    const log = (lvl, msg, extra = {}) => {
      if (LEVELS[lvl] < min) return;
      write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...base, ...extra }));
    };
    return {
      debug: (m, e) => log('debug', m, e),
      info: (m, e) => log('info', m, e),
      warn: (m, e) => log('warn', m, e),
      error: (m, e) => log('error', m, e),
      child: (extra) => make({ ...base, ...extra }),
    };
  };
  return make({});
}

export const newCorrelationId = () => randomUUID();
