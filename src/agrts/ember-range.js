'use strict';
// Ember's BUY RANGE rule (docs/BUY-RANGE.md, "Ember"). Pure: decide(view) -> null or { what: 'all'|'gun'|'turret', cost, why }.
// Ember buys range only when DEFENDING and OUTNUMBERED: Green ground units in Ember's half (z5-z8) AND Ember fields fewer units than Green,
// for each target (gun tower, base turret) that is alive, above KNOBS.minHpPct, has no boost running and has a Green unit within its boosted
// reach + KNOBS.threatPad (the threatened weapon). Two threatened = ALL (full price), one = that weapon (70%). The bank after its own
// reinforcement need (one cheapest unit, when it may still buy) must cover the price. Ahead or even = skip (credits do more as units).
// Limits (no top-up, RANGE_BUY_MAX a match) are the engine's; this rule just never asks when they would refuse.
const KNOBS = Object.freeze({ minHpPct: 0.4, threatPad: 40, halfFromZone: 4, reserve: 20, saveMaxS: 15, baseCritical: 25 });

/** The trigger without the bank check: null or { what, cost }. Used to decide whether to SAVE for the boost. */
function want(v, k = KNOBS) {
  const r = decide({ ...v, bank: Infinity, reinfNeed: 0 }, k);
  return r ? { what: r.what, cost: r.cost } : null;
}

/**
 * Saving (Ray, Oct 21): while want() holds, Ember's unit buys and auto-buy pause until bank >= cost + KNOBS.reserve, then it buys range.
 * Safety: saving stops when the trigger clears, after KNOBS.saveMaxS seconds (then no new save until the trigger clears once),
 * or when Ember's base HP is at or below KNOBS.baseCritical. st = { since, expired } (kept by the match). Returns { buy, save, st }.
 */
function step(v, st, now, k = KNOBS) {
  st = st || { since: null, expired: false };
  const w = want(v, k);
  if (!w) return { buy: null, save: false, st: { since: null, expired: false } };
  if (v.bank >= w.cost + k.reserve) {
    const d = decide({ ...v, reinfNeed: k.reserve }, k);
    return { buy: d, save: false, st: { since: null, expired: false } };
  }
  if (st.expired || v.baseHp <= k.baseCritical) return { buy: null, save: false, st: { since: null, expired: st.expired } };
  const since = st.since == null ? now : st.since;
  if (now - since > k.saveMaxS) return { buy: null, save: false, st: { since: null, expired: true } };
  return { buy: null, save: true, st: { since, expired: false }, need: w.cost + k.reserve };
}

function decide(v, k = KNOBS) {
  if (!v || !v.on) return null;
  if (v.buysLeft <= 0) return null;
  if (!(v.greenInHalf > 0)) return null;
  if (!(v.emberField < v.greenField)) return null;   // ahead or even: skip
  const pick = [];
  for (const key of ['gun', 'turret']) {
    const t = v[key];
    if (!t || !t.alive || t.rounds > 0) continue;
    if (!(t.max > 0) || t.hp / t.max <= k.minHpPct) continue;
    if (!(t.threat > 0)) continue;
    pick.push(key);
  }
  if (!pick.length) return null;
  const what = pick.length === 2 ? 'all' : pick[0];
  const cost = what === 'all' ? v.priceAll : v.priceOne;
  if (v.bank - v.reinfNeed < cost) return null;
  return { what, cost, why: `defending: ${v.greenInHalf} Green in our half, ${v.emberField} vs ${v.greenField} units` };
}

module.exports = { decide, want, step, KNOBS };
