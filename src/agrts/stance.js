'use strict';
// Unit stances (docs/STANCES.md). How a unit fights and moves inside the order it has (or with none).
// Every ground unit has one; a per-role default comes from units.csv `role`. `STANCE <units> <stance>`
// replaces it until the next STANCE. Drones (kamikaze, flying) have none: launch and forget.
//   HOLD    today's behavior: chase inside the post zone, up to half a zone past its edge.
//   CHARGE  (armor)  when hit, close on the shooter even outside the post zone (leash), then walk back.
//   KITE    (ranged) hold our own max range from the nearest enemy; back off when it is closer.
//   ESCORT  (healer) trail the nearest friendly group by about half a zone; never lead it.
//   RUN     (fast)   go to the goal (MOVE zone or their base) without stopping to fight; shoot in passing.

const U = require('./units');

const STANCES = ['HOLD', 'CHARGE', 'KITE', 'ESCORT', 'RUN'];
const LETTER = { HOLD: 'H', CHARGE: 'C', KITE: 'K', ESCORT: 'E', RUN: 'R' };
const ROLE_DEFAULT = { armor: 'CHARGE', ranged: 'KITE', healer: 'ESCORT', fast: 'RUN', mortar: 'HOLD' };

// CHARGE: a hit is remembered this long; the chase may run this many zones past the post zone's edge.
const CHARGE_MEMORY_S = 3;
const CHARGE_LEASH_ZONES = 1.5;
// KITE: back off when the nearest enemy is inside this share of our range; stand (and shoot) up to
// KITE_STAND of it; farther, close in as usual. The gap is hysteresis so a kiter does not jitter.
const KITE_BACK = 0.8;
const KITE_STAND = 0.92;
// KITE gives at most this much ground (zones) per back-off, then stands and fights.
const KITE_GIVE_ZONES = 0.5;
// KITE only backs off while it is not already in combat (fired or was hit in the last 2 s): no endless
// back-pedalling in front of a charging Breaker. Once engaged it stands and shoots.
// ESCORT: trail distance behind the group (zones) and the radius that makes a group around its nearest member.
const ESCORT_TRAIL_ZONES = 0.5;
const ESCORT_GROUP_R = 90;

function hasStance(type) {
  return !!U.TYPES[type] && U.roleOf(type) !== 'kamikaze' && !U.isFlying(type);
}

/** Default stance of a type, or null for a type with none (drones). `mode` 'hold' makes every default HOLD (sims). */
function defaultStance(type, mode) {
  if (!hasStance(type)) return null;
  if (mode === 'hold') return 'HOLD';
  return ROLE_DEFAULT[U.roleOf(type)] || 'HOLD';
}

/** `CHARGE` from `CHARGE`, `C`, `charge`; DEFAULT returns 'DEFAULT'; null when unknown. */
function parseStance(tok) {
  const t = String(tok || '').toUpperCase();
  if (t === 'DEFAULT') return 'DEFAULT';
  if (STANCES.includes(t)) return t;
  const hit = Object.keys(LETTER).find(k => LETTER[k] === t);
  return hit || null;
}

module.exports = {
  STANCES, LETTER, ROLE_DEFAULT, CHARGE_MEMORY_S, CHARGE_LEASH_ZONES, KITE_BACK, KITE_STAND, KITE_GIVE_ZONES,
  ESCORT_TRAIL_ZONES, ESCORT_GROUP_R, hasStance, defaultStance, parseStance,
};
