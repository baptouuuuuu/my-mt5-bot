/** Fixed-window in-memory limiter keyed by client IP. Use a shared store (Redis) when scaling out. */
export function rateLimit({ max, windowMs, name = 'rate' }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const t = Date.now();
    let h = hits.get(key);
    if (!h || t - h.start >= windowMs) {
      h = { start: t, count: 0 };
      hits.set(key, h);
    }
    if (++h.count > max) {
      res.setHeader('Retry-After', Math.ceil((h.start + windowMs - t) / 1000));
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: `Too many requests (${name})` } });
    }
    if (hits.size > 10000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    next();
  };
}
