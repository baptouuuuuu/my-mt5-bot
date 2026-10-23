import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBreakEven, BE_DEFAULTS } from '../src/rules/breakEven.js';
import { evaluateAutoSltp, AUTOSLTP_DEFAULTS, inSession } from '../src/rules/autoSltp.js';
import { computeCopyOrder, wouldCreateCycle, COPY_DEFAULTS, COPY_MAGIC } from '../src/rules/copyTrading.js';

const sym = { point: 0.00001, digits: 5, pipSize: 0.0001, tickValue: 1 };
const buy = {
  ticket: '1',
  symbol: 'EURUSD',
  type: 'buy',
  volume: 0.1,
  openPrice: 1.1,
  currentPrice: 1.1,
  sl: 0,
  tp: 0,
  profit: 0,
  magic: 0,
  comment: '',
};
const sell = { ...buy, type: 'sell' };

test('BE: not triggered below threshold', () => {
  const cfg = { ...BE_DEFAULTS, threshold: 100 };
  assert.equal(evaluateBreakEven({ ...buy, currentPrice: 1.1005 }, sym, cfg), null);
});

test('BE: buy triggered with offset', () => {
  const cfg = { ...BE_DEFAULTS, threshold: 100, offsetPoints: 20 };
  assert.deepEqual(evaluateBreakEven({ ...buy, currentPrice: 1.1015 }, sym, cfg), { sl: 1.1002 });
});

test('BE: sell triggered, pips mode', () => {
  const cfg = { ...BE_DEFAULTS, mode: 'pips', threshold: 10 };
  assert.deepEqual(evaluateBreakEven({ ...sell, currentPrice: 1.099 }, sym, cfg), { sl: 1.1 });
});

test('BE: money mode and no-op when SL already at BE or better', () => {
  const cfg = { ...BE_DEFAULTS, mode: 'money', threshold: 50 };
  assert.equal(evaluateBreakEven({ ...buy, currentPrice: 1.102, profit: 40 }, sym, cfg), null);
  assert.deepEqual(evaluateBreakEven({ ...buy, currentPrice: 1.102, profit: 60 }, sym, cfg), { sl: 1.1 });
  assert.equal(evaluateBreakEven({ ...buy, currentPrice: 1.102, profit: 60, sl: 1.1005 }, sym, cfg), null);
});

test('BE: honours filters', () => {
  const p = { ...buy, currentPrice: 1.102, magic: 5, comment: 'abc' };
  assert.equal(evaluateBreakEven(p, sym, { ...BE_DEFAULTS, symbols: ['GBPUSD'] }), null);
  assert.equal(evaluateBreakEven(p, sym, { ...BE_DEFAULTS, magics: [6] }), null);
  assert.equal(evaluateBreakEven(p, sym, { ...BE_DEFAULTS, commentContains: 'zzz' }), null);
  assert.ok(evaluateBreakEven(p, sym, { ...BE_DEFAULTS, magics: [5], commentContains: 'ab' }));
});

test('AutoSLTP: sets missing SL/TP by pips', () => {
  const r = evaluateAutoSltp(buy, sym, { ...AUTOSLTP_DEFAULTS, slDistance: 20, tpDistance: 40 });
  assert.deepEqual(r, { sl: 1.098, tp: 1.104 });
  const s = evaluateAutoSltp(sell, sym, { ...AUTOSLTP_DEFAULTS, slDistance: 20, tpDistance: 40 });
  assert.deepEqual(s, { sl: 1.102, tp: 1.096 });
});

test('AutoSLTP: never overwrites unless asked', () => {
  const p = { ...buy, sl: 1.09 };
  assert.deepEqual(evaluateAutoSltp(p, sym, AUTOSLTP_DEFAULTS), { tp: 1.104 });
  assert.deepEqual(evaluateAutoSltp(p, sym, { ...AUTOSLTP_DEFAULTS, overwrite: true }), { sl: 1.098, tp: 1.104 });
  assert.equal(evaluateAutoSltp({ ...p, tp: 1.2 }, sym, AUTOSLTP_DEFAULTS), null);
});

test('AutoSLTP: risk percent derives SL distance', () => {
  // risk 1% of 10000 = 100 USD, 0.1 lot, tickValue 1 => 1000 points = 0.01
  const r = evaluateAutoSltp(buy, sym, { ...AUTOSLTP_DEFAULTS, riskPercent: 1, tpDistance: 0 }, { balance: 10000 });
  assert.deepEqual(r, { sl: 1.09 });
});

test('AutoSLTP: session filter (wraps midnight)', () => {
  const night = { startHour: 22, endHour: 6 };
  assert.ok(inSession(night, new Date('2026-01-01T23:00:00Z')));
  assert.ok(inSession(night, new Date('2026-01-01T03:00:00Z')));
  assert.ok(!inSession(night, new Date('2026-01-01T12:00:00Z')));
  assert.equal(evaluateAutoSltp(buy, sym, { ...AUTOSLTP_DEFAULTS, session: night }, { now: new Date('2026-01-01T12:00:00Z') }), null);
});

test('Copy: lot sizing, clamps, inverse, symbol filter', () => {
  const o = computeCopyOrder({ ...buy, volume: 0.1 }, { ...COPY_DEFAULTS, multiplier: 2.5 });
  assert.equal(o.volume, 0.25);
  assert.equal(computeCopyOrder({ ...buy, volume: 0.1 }, { ...COPY_DEFAULTS, multiplier: 0.01 }).volume, 0.01);
  assert.equal(computeCopyOrder({ ...buy, volume: 5 }, { ...COPY_DEFAULTS, maxLot: 1 }).volume, 1);
  assert.equal(computeCopyOrder(buy, { ...COPY_DEFAULTS, inverse: true }).type, 'sell');
  assert.equal(computeCopyOrder(buy, { ...COPY_DEFAULTS, symbols: ['XAUUSD'] }), null);
});

test('Copy: anti-loop skips copied positions and detects cycles', () => {
  assert.equal(computeCopyOrder({ ...buy, magic: COPY_MAGIC }, COPY_DEFAULTS), null);
  assert.equal(computeCopyOrder({ ...buy, comment: 'mt5bot-copy:1' }, COPY_DEFAULTS), null);
  const links = [
    { source: 1, dest: 2 },
    { source: 2, dest: 3 },
  ];
  assert.ok(wouldCreateCycle(links, 3, 1));
  assert.ok(wouldCreateCycle(links, 1, 1));
  assert.ok(!wouldCreateCycle(links, 1, 3));
});
