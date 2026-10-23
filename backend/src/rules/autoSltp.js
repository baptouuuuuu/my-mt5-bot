import { dir, hasValue, matchesFilters, roundPrice, toPoints } from './common.js';

export const AUTOSLTP_DEFAULTS = {
  unit: 'pips', // 'points' | 'pips'
  slDistance: 20,
  tpDistance: 40,
  riskPercent: 0, // if > 0, SL distance is derived from balance * risk% instead of slDistance
  overwrite: false,
  symbols: [],
  magics: [],
  commentContains: '',
  session: null, // { startHour, endHour } in UTC, wraps midnight when start > end
};

export function inSession(session, date) {
  if (!session) return true;
  const h = date.getUTCHours();
  const { startHour: s, endHour: e } = session;
  return s <= e ? h >= s && h < e : h >= s || h < e;
}

/** Returns { sl?, tp? } for positions lacking protection, otherwise null. */
export function evaluateAutoSltp(p, sym, cfg, { balance = 0, now = new Date() } = {}) {
  if (!matchesFilters(p, cfg) || !inSession(cfg.session, now)) return null;
  const d = dir(p);
  const out = {};

  let slPts = cfg.slDistance > 0 ? toPoints(cfg.slDistance, cfg.unit, sym) : 0;
  if (cfg.riskPercent > 0 && balance > 0 && p.volume > 0 && sym.tickValue > 0) {
    slPts = (balance * cfg.riskPercent) / 100 / (p.volume * sym.tickValue);
  }
  const tpPts = cfg.tpDistance > 0 ? toPoints(cfg.tpDistance, cfg.unit, sym) : 0;

  if (slPts > 0 && (cfg.overwrite || !hasValue(p.sl))) {
    const sl = roundPrice(p.openPrice - d * slPts * sym.point, sym);
    if (d * (p.currentPrice - sl) > 0) out.sl = sl;
  }
  if (tpPts > 0 && (cfg.overwrite || !hasValue(p.tp))) {
    const tp = roundPrice(p.openPrice + d * tpPts * sym.point, sym);
    if (d * (tp - p.currentPrice) > 0) out.tp = tp;
  }
  return Object.keys(out).length ? out : null;
}
