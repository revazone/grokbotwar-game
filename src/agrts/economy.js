'use strict';
// Optional territory-income rules (docs/TERRITORY-INCOME.md). Diminish, catch-up, the Breaker
// discount and bank decay default off. The zone cap defaults to 3 when TERRITORY_CAP is unset
// (the measured pick, docs/TERRITORY-INCOME.md). Explicit 0, off, none or false pays every zone.
// A match may pass the same knobs as opts; the env is what the live arena and the version stamp read.

function raw(env, name) {
  const v = env[name];
  return v == null ? '' : String(v).trim().toLowerCase();
}

function offToken(s) {
  return s === '' || s === '0' || s === 'off' || s === 'none' || s === 'false';
}

/** 0 = no cap (pay every enemy-half zone). Otherwise at most this many zones, clamped to 8. */
function capValue(v) {
  if (v == null || v === false) return 0;
  const s = String(v).trim().toLowerCase();
  if (offToken(s)) return 0;
  const n = Number(s);
  return Number.isFinite(n) && n >= 1 ? Math.min(8, Math.floor(n)) : 0;
}

/** 1 = full price on every zone. A fraction in (0, 1) diminishes each extra zone. `half` is 0.5. */
function diminishValue(v) {
  if (v == null || v === false) return 1;
  const s = String(v).trim().toLowerCase();
  if (s === 'half') return 0.5;
  if (offToken(s) || s === '1' || s === 'full') return 1;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : 1;
}

/** CR added per zone of map deficit each income tick. 0 = off. */
function catchupValue(v) {
  if (v == null || v === false) return 0;
  const s = String(v).trim().toLowerCase();
  if (offToken(s)) return 0;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Fraction off the Breaker's live price while this side holds fewer zones. 0 = off.
 * A number above 1 is a percent (50 = half off). 100% off is refused so a Breaker is never free.
 */
function discountValue(v) {
  if (v == null || v === false) return 0;
  const s = String(v).trim().toLowerCase();
  if (offToken(s)) return 0;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const f = n > 1 ? n / 100 : n;
  return f > 0 && f < 1 ? f : 0;
}

/**
 * Fraction of the bank above one Breaker's listed price removed each income tick, and only while
 * that side's field is at the active cap. 0 = off. A number above 1 is a percent. 1 wipes the excess.
 */
function decayValue(v) {
  if (v == null || v === false) return 0;
  const s = String(v).trim().toLowerCase();
  if (offToken(s)) return 0;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const f = n > 1 ? n / 100 : n;
  return f > 1 ? 1 : f;
}

const RULES = require('./rules');

function fromEnv(env = RULES.env()) {
  const capRaw = env.TERRITORY_CAP;
  // Unset or blank is the branch default (3). 0, off, none, false and a bad token are no cap.
  const capUnset = capRaw == null || String(capRaw).trim() === '';
  return {
    cap: capUnset ? 3 : capValue(capRaw),
    diminish: diminishValue(env.TERRITORY_DIMINISH),
    catchup: catchupValue(env.CATCHUP_INCOME),
    discount: discountValue(env.BREAKER_DISCOUNT),
    decay: decayValue(env.BANK_DECAY),
  };
}

/**
 * Credits the `zones` paying zones are worth this tick.
 * Cap counts at most `cap` of them (0 = all).
 * Diminish: the k-th counted zone (k from 0) pays round(zoneIncome × rate^k). The first is full price.
 * Cap applies first, then the series, so a cap of 2 with rate 0.5 pays the 12 and the 6, not the tail.
 */
function zoneIncomePay(zones, zoneIncome, cap, diminish) {
  const n = Math.max(0, zones | 0);
  if (!n || !(zoneIncome > 0)) return 0;
  const counted = cap > 0 ? Math.min(n, cap) : n;
  if (!(diminish > 0 && diminish < 1)) return counted * zoneIncome;
  let pay = 0;
  for (let k = 0; k < counted; k++) pay += Math.round(zoneIncome * Math.pow(diminish, k));
  return pay;
}

/** Listed price after a while-behind discount. Unchanged when the discount is off. */
function discountedPrice(cost, discount) {
  if (!(discount > 0) || !(discount < 1)) return cost;
  return Math.max(1, Math.round(cost * (1 - discount)));
}

/** Bank after one decay step. Credits at or under the ceiling stay. */
function decayedBank(bank, ceiling, rate) {
  if (!(rate > 0) || !(bank > ceiling)) return bank;
  return bank - (bank - ceiling) * rate;
}

/**
 * Small integer folded into the rules stamp (× 1e13) so a live arena with a flag on does not pair
 * with one that still pays full zone income. 0 when every flag is off, which adds nothing.
 * Buckets are coarse; the stamp also carries the exact numbers and the relay compares those.
 * Max code is 639, so the addend stays inside Number.MAX_SAFE_INTEGER next to the hospital bit.
 */
function economyCode(e) {
  if (!e) return 0;
  const cap = e.cap > 0 ? Math.min(4, Math.floor(e.cap)) : 0;
  const dim = !(e.diminish > 0 && e.diminish < 1) ? 0 : e.diminish <= 0.6 ? 1 : e.diminish <= 0.85 ? 2 : 3;
  const cu = !(e.catchup > 0) ? 0 : e.catchup <= 6 ? 1 : e.catchup <= 12 ? 2 : 3;
  const di = !(e.discount > 0) ? 0 : e.discount <= 0.35 ? 1 : e.discount <= 0.6 ? 2 : 3;
  const de = e.decay > 0 ? 1 : 0;
  return cap + 5 * (dim + 4 * (cu + 4 * (di + 4 * de)));
}

module.exports = {
  capValue, diminishValue, catchupValue, discountValue, decayValue, fromEnv,
  zoneIncomePay, discountedPrice, decayedBank, economyCode,
};
