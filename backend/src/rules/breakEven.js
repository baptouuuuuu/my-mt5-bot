import { dir, hasValue, matchesFilters, roundPrice, toPoints } from './common.js';

export const BE_DEFAULTS = {
  mode: 'points', // 'points' | 'pips' | 'money'
  threshold: 100,
  offsetPoints: 0,
  symbols: [],
  magics: [],
  commentContains: '',
  cooldownSec: 60,
};

/** Returns { sl } when the position must be moved to break-even, otherwise null. */
export function evaluateBreakEven(p, sym, cfg) {
  if (!matchesFilters(p, cfg)) return null;
  const d = dir(p);
  const progress = cfg.mode === 'money' ? p.profit : (d * (p.currentPrice - p.openPrice)) / sym.point;
  const threshold = cfg.mode === 'money' ? cfg.threshold : toPoints(cfg.threshold, cfg.mode, sym);
  if (progress < threshold) return null;
  const target = roundPrice(p.openPrice + d * cfg.offsetPoints * sym.point, sym);
  if (hasValue(p.sl) && d * (p.sl - target) >= 0) return null; // already protected at/after BE
  if (d * (p.currentPrice - target) <= 0) return null; // price would be on the wrong side of the stop
  return { sl: target };
}
