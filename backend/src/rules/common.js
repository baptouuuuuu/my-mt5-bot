export const dir = (p) => (p.type === 'buy' ? 1 : -1);
export const hasValue = (v) => typeof v === 'number' && v > 0;

export function matchesFilters(p, cfg) {
  if (cfg.symbols?.length && !cfg.symbols.includes(p.symbol)) return false;
  if (cfg.magics?.length && !cfg.magics.includes(p.magic)) return false;
  if (cfg.commentContains && !(p.comment || '').includes(cfg.commentContains)) return false;
  return true;
}

/** Converts a distance expressed in `unit` to points. */
export function toPoints(value, unit, sym) {
  return unit === 'pips' ? value * (sym.pipSize / sym.point) : value;
}

export const roundPrice = (price, sym) => Number(price.toFixed(sym.digits));
