export class Mt5Error extends Error {
  constructor(message, { transient = false, code = 'MT5_ERROR' } = {}) {
    super(message);
    this.name = 'Mt5Error';
    this.transient = transient;
    this.code = code;
  }
}

export const withTimeout = (promise, ms, label = 'operation') =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Mt5Error(`${label} timed out after ${ms}ms`, { transient: true, code: 'TIMEOUT' })), ms);
    promise.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });

/** Runs fn with timeout; retries transient errors with linear backoff. */
export async function withRetry(fn, { retries = 2, timeoutMs = 8000, backoffMs = 200, label } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await withTimeout(Promise.resolve().then(fn), timeoutMs, label);
    } catch (e) {
      lastErr = e;
      if (!(e instanceof Mt5Error) || !e.transient || attempt === retries) break;
      await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
    }
  }
  throw lastErr;
}
