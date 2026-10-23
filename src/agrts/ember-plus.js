'use strict';
// Ember add-on layer (Oct 14), run right after the NPC commander's window (match._commanderWindow).
// Level (match opt emberPlus / env EMBER_PLUS), default 0:
//   0 off: the plain commander (this is what plays live).
//   1 retired (Oct 14 audit): the old "spend" level (bank >= 120 CR, push at 250) never fired once zone upkeep
//     and the Rifle AUTOBUY kept Ember's bank under 100; 48 seeds played the same with it on or off. A level 1 is
//     read as 0.
//   2 attack: spend into reserve when the bank is >= 120 CR (medic first, then Breaker to 2, Mortar to 2, Rifle),
//     at most 3 waiting, plus the attack logic below. Orders go through applyProtocolOrders like any seat's.
//     - push when we have the bigger army (count and HP) or a big bank with an even army: MOVE ALL toward
//       their base, all the way (FOCUS TURRET) with a clear lead;
//     - raid: when Green is pushed deep (3+ of their ground units in our three home zones), buy fast units and
//       send them at the Green base while the main army defends;
//     - turtle breaker: when Green sits in its own three home zones, buy mortars (to 2) and walk the army up to
//       mortar range of the cluster.
const C = require('./constants');
const U = require('./units');

const role = r => U.idsWithRole(r)[0];
// Attack thresholds (level 2). EP_TUNE env (JSON) overrides them for headless tuning.
const TUNE = Object.assign({ pushLead: 1, pushHp: 0, crushLead: 2, crushHp: 80, lateT: 999, stage: 5, mass: 5, drones: 1, droneGap: 20 },
  (() => { try { return JSON.parse(process.env.EP_TUNE || '{}'); } catch { return {}; } })());

function level(v) {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) && Math.floor(n) >= 2 ? 2 : 0; // 1 is retired: it plays as 0
}

/** Ember posts this window: an array of order-line arrays (each one post, at most 3 lines). mem persists per match. */
function emberPlusOrders(m, side, lvl, mem) {
  if (lvl < 2) return [];
  const T = role('armor'), M = role('healer'), O = m.mortarOn ? role('mortar') : null, R = role('ranged'), S = role('fast');
  const code = k => U.CODE_BY_TYPE[k];
  const bank = m.fieldCredits[side], res = C.total(m.reserve[side]);
  const ours = m.units.filter(u => u.side === side && u.hp > 0 && !U.isFlying(u.type));
  const theirs = m.units.filter(u => u.side !== side && u.hp > 0 && !U.isFlying(u.type));
  const alive = k => k ? ours.filter(u => u.type === k).length + (m.reserve[side][k] || 0) : 0;
  const cap = m.activeCap || 6;
  // Field slots in use, Drones included (m._activeCount): `ours` is ground units only, so counting it
  // posted DEPLOY ALL into a field the Drones had already filled (ERR cap reached).
  const used = m._activeCount(side);
  const fz = u => side === 1 ? 7 - C.zoneOf(u.x) : C.zoneOf(u.x); // our forward zone, 0 = our home
  const abs = f => `z${(side === 1 ? 7 - f : f) + 1}`;
  const price = k => m._livePrice(side, k);
  const stat = k => { mem.stats = mem.stats || {}; mem.stats[k] = (mem.stats[k] || 0) + 1; };
  const posts = [];
  const K = TUNE;
  // 1. spend: reinforcements into reserve, deploy into free slots
  const spend = [];
  let left = bank;
  const want = () => alive(M) < 1 ? M : alive(T) < 2 ? T : O && alive(O) < 2 ? O : R;
  if (bank >= 120 && res < 3) { const k = want(); if (left >= price(k)) { spend.push(`BUY ${code(k)}`); left -= price(k); } }
  else if (used + res < cap) {
    // keeps the field full with real fighters (Breakers so the tubes advance, then Rifles), not Scouts
    const k = alive(T) < 2 ? T : alive(M) < 1 && ours.length >= 4 ? M : R;
    // short of a Breaker: save for it unless the field is thin
    const pick = left >= price(k) ? k : (k !== T || ours.length < 4) && left >= price(R) ? R : null;
    if (pick) { spend.push(`BUY ${code(pick)}`); left -= price(pick); }
  }
  if (used < cap && (res || spend.length)) spend.push('DEPLOY ALL');
  if (spend.length) posts.push(spend);
  // 2. attack
  const t = m.elapsed;
  const hpOf = arr => arr.reduce((a, u) => a + u.hp, 0);
  const lead = ours.length - theirs.length, hpLead = hpOf(ours) - hpOf(theirs);
  const deepThem = theirs.filter(u => fz(u) <= 2).length;           // Green units in our three home zones
  const turtle = t >= 60 && theirs.length >= 2 && theirs.every(u => fz(u) >= 5); // Green sits at home
  if (deepThem >= 3 && S && t - (mem.raidAt || -99) >= 40 && left >= price(S) * 2) {
    posts.push([`BUY ${code(S)}`, `BUY ${code(S)}`, `MOVE ${code(S)} ${abs(7)}`]);
    mem.raidAt = t; stat('raid');
    return posts;
  }
  const D = role('kamikaze');
  if (turtle) {
    stat('turtle');
    // a home cluster (their tubes, the turret screen): Drones dive it, a tube shells it
    const dOk = D && K.drones && !m._buyCapReason(side, D);
    if (dOk && left >= price(D) * 2 && t - (mem.droneAt || -99) >= K.droneGap) {
      posts.push([`BUY ${code(D)}`, `BUY ${code(D)}`, `DEPLOY ${code(D)} ${code(D)}`]); left -= price(D) * 2; mem.droneAt = t; stat('drones');
    } else if (O && alive(O) < 2 && left >= price(O)) posts.push([`BUY ${code(O)}`, 'DEPLOY ALL']);
  }
  const strong = (lead >= K.pushLead && hpLead > K.pushHp) || (lead >= 0 && hpLead >= 40 && bank >= 150) || (t >= K.lateT && lead >= 0);
  const crushing = (lead >= K.crushLead && hpLead >= K.crushHp) || (turtle && lead >= 0) || (t >= K.lateT && lead >= 1);
  if (ours.length >= 4 && (strong || turtle) && t >= 45) {
    const front = Math.max(...ours.map(fz));
    let target = crushing ? 7 : Math.min(7, front + 1);
    // mass before the assault: everyone at the staging zone (their side's z3 from us = forward 5) first
    const stage = K.stage;
    if (target === 7 && !mem.allIn) {
      const near = ours.filter(u => Math.abs(fz(u) - stage) <= 1).length;
      if (near < Math.min(K.mass, ours.length)) { target = stage; stat('stage'); }
    }
    stat(target === 7 ? 'allin' : 'push');
    const l = [];
    if (target === 7 && !mem.allIn) { l.push('FOCUS TURRET'); mem.allIn = true; }
    l.push(`MOVE ALL ${abs(target)}`);
    posts.push(l);
  } else if (mem.allIn) mem.allIn = false;
  return posts;
}

module.exports = { emberPlusOrders, level };
