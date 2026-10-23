export const COPY_MAGIC = 987654;
export const COPY_COMMENT_PREFIX = 'mt5bot-copy';

export const COPY_DEFAULTS = {
  multiplier: 1,
  minLot: 0.01,
  maxLot: 100,
  symbols: [],
  inverse: false,
};

/** Positions produced by copy trading must never be copied again (anti-loop). */
export const isCopyOrigin = (p) => p.magic === COPY_MAGIC || (p.comment || '').startsWith(COPY_COMMENT_PREFIX);

export function computeCopyOrder(p, cfg) {
  if (isCopyOrigin(p)) return null;
  if (cfg.symbols?.length && !cfg.symbols.includes(p.symbol)) return null;
  const raw = p.volume * cfg.multiplier;
  const volume = Math.min(cfg.maxLot, Math.max(cfg.minLot, Math.round(raw * 100) / 100));
  const type = cfg.inverse ? (p.type === 'buy' ? 'sell' : 'buy') : p.type;
  return {
    symbol: p.symbol,
    type,
    volume,
    sl: cfg.inverse ? 0 : p.sl || 0,
    tp: cfg.inverse ? 0 : p.tp || 0,
    magic: COPY_MAGIC,
    comment: `${COPY_COMMENT_PREFIX}:${p.ticket}`,
  };
}

/** True if adding the edge source->dest would create a cycle in the copy graph. */
export function wouldCreateCycle(links, source, dest) {
  if (source === dest) return true;
  const adj = new Map();
  for (const l of links) {
    if (!adj.has(l.source)) adj.set(l.source, []);
    adj.get(l.source).push(l.dest);
  }
  const seen = new Set();
  const stack = [dest];
  while (stack.length) {
    const n = stack.pop();
    if (n === source) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(adj.get(n) || []));
  }
  return false;
}
