'use strict';
// The NPC commander: the simulated Ember plays with the same orders a warrior seat posts.
//
// Once per NPC decision window (NPC_DECISION_S, 4.4 s by default) the match asks
// commanderOrders(view, mem) for at most 3 order lines plus a WHY, and applies them through
// applyProtocolOrders: the same parser, checks, panel rows and standing orders a seat gets.
// Nothing here moves a unit or picks a target; MOVE, ASSIST, FOCUS, AUTOBUY, FALLBACK and
// CLEAR do that in src/agrts/match.js exactly as they do for Green.
//
// What it does, in order of priority each window:
//   1. DEPLOY whatever is in reserve (one army, no waves) into the free active slots (ACTIVE_CAP; none
//      posted while the field is full), Drones excepted (see below). BUY M first when no medic is on
//      the field, two or more allies are hurt and the bank covers it. Once AUTOBUY has used the
//      6 buys, a manual BUY of our main unit when the bank covers it plus a medic (rule 11 of
//      the warrior's table: manual BUY has no cap).
//   2. Group, then push together. Rally the army one zone in front of home (z6 for Ember),
//      then advance it one zone at a time with MOVE ALL, only while the group is together (or none
//      of their ground units is left on the field, so stragglers do not hold it back) and
//      not outmatched. Outmatched: fall back a zone toward reinforcements. Enemy in our home
//      zones: CLEAR ALL, so the normal pick goes for the intruders. Their home zone is the last
//      MOVE ALL: it walks every unit into range of their base, where it shoots.
//   3. ASSIST a fight (both sides in a zone) where we are not ahead and have units 1 zone away.
//   4. FOCUS their medics while any is on the field; with none, their breakers when 3+ are.
//   5. AUTOBUY our plan's main unit, RESERVE one medic's price, so a medic buy stays affordable.
//   6. FALLBACK one badly hurt unit to our medic.
// Drones (the kamikaze role in units.csv), unless the match turns them off (npcDrones):
//   draftDrones swaps 0-2 units of the simulated draft for Drones, with its own seeded dice.
//   BUY D (up to max_alive, 4) when they have 5+ ground units in one zone, the bank covering a medic too.
//   Drones are launch and forget (src/agrts/match.js _kamikazeGoal): they lock a target when they
//   launch and never hold or wait. So we keep our Drones in reserve (DEPLOY names every other unit)
//   and DEPLOY them only while their units are fighting ours in a stack (view.engagedStack,
//   ENGAGED_STACK or more): a launched Drone then picks that engaged stack first. None at T0.
//   FOCUS D when they field 2+ Drones, and while they have 2+ alive our army spreads over two
//   neighbouring zones (two MOVE lines) instead of one stack.
// Agency (seeded): a match passes newMemory(seed) and the commander rolls a temperament for
// that match (rally zone, push nerve, focus pick, fallback threshold) and draws a few numbers
// every window (push a window late or early, hold a window, regroup early when it is close).
// The same seed replays the same match. newMemory() with no seed is the plain commander.
// The view is plain data; zones in it are absolute (0 = Green home .. 7 = Ember home).
// Internally we count "forward" zones from our own home, so the same code plays either side.

const { TYPES, TYPE_IDS, ZONES, DRAFT_BUDGET, ROSTER_LIMIT, zoneOf, mulberry32, spent, total } = require('./constants');
const U = require('./units');

const RALLY_FZ = 2; // forward zone we gather in first: z3 for Green, z6 for Ember
const PUSH_RATIO = 0.85; // we advance while our strength is at least this share of theirs
const RETREAT_RATIO = 0.6; // below this we fall back a zone
const RALLY_WAIT_S = 4; // seconds gathered at the rally zone before the first push

// The plain commander: what newMemory() without a seed plays (and what the unit tests pin).
const PLAIN_STYLE = Object.freeze({ rallyFz: RALLY_FZ, pushRatio: PUSH_RATIO, focus: 'medic', fallbackHp: 0.4, jitter: false });
// Agency odds. Temperament is rolled once per match; the window odds apply each decision window.
const AGENCY = Object.freeze({
  // Tuned so a 60-match sweep stays near even (about 40-60% either way) against the
  // warrior-like Greens and the autopilot. z7 and a non-medic focus are the sharper rolls.
  rally: [[RALLY_FZ, 0.70], [RALLY_FZ + 1, 0.18], [RALLY_FZ - 1, 0.12]], // z6 / z5 / z7 for Ember
  pushRatio: [0.82, 0.90], // uniform, a narrow band around 0.85
  focus: [['medic', 0.72], ['armor', 0.12], ['ranged', 0.11], ['biggest', 0.05]],
  fallbackHp: [0.35, 0.45], // FALLBACK a fighter at or under this share of its HP
  late: 0.08, // a push that is ready waits one more window
  early: 0.08, // the first push goes without the rally wait
  hold: 0.05, // while pushing, hold the zone for a window instead of advancing
  caution: 0.12, // strength in [RETREAT_RATIO, RETREAT_RATIO + 0.15): regroup early
});
const FOCUS_NAME = { medic: 'medics', armor: 'breakers', ranged: 'rifles', biggest: 'their biggest group' };

function pickWeighted(r, list) {
  let acc = 0;
  for (const [v, w] of list) { acc += w; if (r < acc) return v; }
  return list[list.length - 1][0];
}
/** One match's temperament from its seeded rng (always 4 draws, in this order). */
function rollStyle(rng) {
  const a = rng(), b = rng(), c = rng(), d = rng();
  return {
    rallyFz: pickWeighted(a, AGENCY.rally),
    pushRatio: +(AGENCY.pushRatio[0] + b * (AGENCY.pushRatio[1] - AGENCY.pushRatio[0])).toFixed(3),
    focus: pickWeighted(c, AGENCY.focus),
    fallbackHp: +(AGENCY.fallbackHp[0] + d * (AGENCY.fallbackHp[1] - AGENCY.fallbackHp[0])).toFixed(3),
    jitter: true,
  };
}
/** Plain words for the opening line: `rally z5, push together, focus rifles`. */
function describeStyle(mem, side = 1) {
  const st = (mem && mem.style) || PLAIN_STYLE;
  return `rally ${wireZone(side, st.rallyFz)}, push together, focus ${FOCUS_NAME[st.focus] || 'medics'}`;
}

function fwd(side, zone) { return side === 0 ? zone : ZONES - 1 - zone; }
function wireZone(side, fz) { return `z${(side === 0 ? fz : ZONES - 1 - fz) + 1}`; }
function codeOf(type) { return U.CODE_BY_TYPE[type]; }
const isHealer = type => U.roleOf(type) === 'healer';
const isKamikaze = type => U.roleOf(type) === 'kamikaze';
const isFlying = type => U.isFlying(type);

// Drone draft odds: [count, weight]. Most plans get 0-2; an armor plan leans to fewer.
const DRONE_DRAFT = Object.freeze({
  default: [[0, 0.30], [1, 0.45], [2, 0.25]],
  armor: [[0, 0.50], [1, 0.40], [2, 0.10]],
});
const CLUMP = 5; // their ground units in one zone that make us buy Drones
const SPREAD_AT = 2; // their Drones alive that make us spread out (and FOCUS D)
const ENGAGED_STACK = 2; // their engaged units in one blast's reach that launch our reserved Drones

/**
 * The commander's opening Drones. Swaps units of the simulated draft (Scouts first, then the most
 * common non-medic, non-armor type) for Drones until the 200 CR budget and 24-unit roster fit.
 * Its own rng from the side's commander seed, so the match rng and the window dice are untouched.
 */
function draftDrones(counts, seed, plan) {
  const drone = U.idsWithRole('kamikaze')[0];
  if (!drone || !Number.isFinite(seed)) return counts;
  const rng = mulberry32((seed ^ 0x5d2a1f37) >>> 0);
  let n = pickWeighted(rng(), DRONE_DRAFT[plan] || DRONE_DRAFT.default);
  const cap = TYPES[drone].maxAlive | 0;
  if (cap > 0) n = Math.min(n, cap - (counts[drone] || 0));
  const out = { ...counts };
  for (let i = 0; i < n; i++) {
    let guard = 0;
    while ((spent(out) + TYPES[drone].cost > DRAFT_BUDGET || total(out) >= ROSTER_LIMIT) && guard++ < 24) {
      const fast = TYPE_IDS.find(k => U.roleOf(k) === 'fast' && out[k] > 0);
      const pool = TYPE_IDS.filter(k => out[k] > 0 && k !== drone && !isHealer(k) && U.roleOf(k) !== 'armor');
      const k = fast || pool.sort((a, b) => out[b] - out[a])[0];
      if (!k) break;
      out[k]--;
    }
    if (spent(out) + TYPES[drone].cost > DRAFT_BUDGET || total(out) >= ROSTER_LIMIT) break;
    out[drone] = (out[drone] || 0) + 1;
  }
  return out;
}

/** Rough fighting value of one unit at its current HP: sqrt(hp x damage per second). */
function unitValue(u) {
  const t = TYPES[u.type];
  if (!t) return 0;
  const dps = t.cool > 0 ? t.dmg / t.cool : t.dmg;
  return Math.sqrt(Math.max(0, u.hp) * Math.max(0.5, dps));
}
function reserveValue(reserve) {
  let v = 0;
  for (const k of TYPE_IDS) if (reserve[k] > 0) v += reserve[k] * unitValue({ type: k, hp: TYPES[k].hp });
  return v;
}

/** Commander memory for one side and match. A seed turns on agency (see AGENCY). */
function newMemory(seed) {
  const mem = { phase: 'rally', target: null, focus: null, autobuy: null, rallySince: null, style: PLAIN_STYLE, rng: null, late: false };
  if (Number.isFinite(seed)) { mem.rng = mulberry32(seed >>> 0); mem.style = rollStyle(mem.rng); }
  return mem;
}

/** Our plan's main buy: the most common non-medic type in the reinforcement queue, else armor. */
function mainBuy(queue) {
  const n = {};
  for (const k of queue || []) if (TYPES[k] && !isHealer(k)) n[k] = (n[k] || 0) + 1;
  let best = null;
  for (const k of TYPE_IDS) if (n[k] && (!best || n[k] > n[best])) best = k;
  return best || U.idsWithRole('armor')[0] || TYPE_IDS.find(k => !isHealer(k)) || null;
}

/**
 * view: { side, elapsed, units: [{ side, tag, type, x, hp, max, radio: null|{kind, zone, phase} }],
 *         reserve, bank, price: { type: live price }, focus, autobuy, buyCapped, queue }
 * mem: newMemory(), kept by the match for this side across windows (reset each match).
 * Returns { lines (<= 3 orders), why, title, detail }.
 */
function commanderOrders(view, mem) {
  const side = view.side;
  const fz = u => fwd(side, zoneOf(u.x));
  const ours = view.units.filter(u => u.side === side);
  const theirs = view.units.filter(u => u.side !== side);
  // Fighters and the army are ground units; Drones fly their own dive (src/agrts/match.js _stepKamikaze).
  const ground = ours.filter(u => !isFlying(u.type));
  const fighters = ground.filter(u => !isHealer(u.type) && !isKamikaze(u.type));
  const healer = U.idsWithRole('healer')[0];
  const drone = view.drone || null; // our Drone type when the commander may draft and buy them
  const kamikaze = U.idsWithRole('kamikaze')[0];
  const theirDrones = kamikaze ? theirs.filter(u => u.type === kamikaze).length : 0;
  const theirGround = theirs.filter(u => !isFlying(u.type));
  const armor = U.idsWithRole('armor')[0];
  const lines = [];
  const why = [];
  let title = '';
  const room = () => lines.length < 3;
  const st = mem.style || PLAIN_STYLE;
  const rallyFz = st.rallyFz;
  const pushRatio = st.pushRatio;
  // This window's dice: always 3 draws when seeded, so the sequence does not depend on the branch.
  const dice = st.jitter && mem.rng ? [mem.rng(), mem.rng(), mem.rng()] : null;
  const late = !!dice && dice[0] < AGENCY.late;
  const early = !!dice && dice[1] < AGENCY.early;
  const hold = !!dice && dice[2] < AGENCY.hold;
  const cautious = !!dice && dice[2] >= 1 - AGENCY.caution;

  // 1. Field everything. A medic when nobody can heal our hurt.
  const reserveN = TYPE_IDS.reduce((a, k) => a + (view.reserve[k] || 0), 0);
  const ourMedics = ours.filter(u => isHealer(u.type)).length + (healer ? view.reserve[healer] || 0 : 0);
  const hurt = ours.filter(u => u.hp <= u.max - 20).length;
  const medicPrice = healer ? view.price[healer] : null;
  const main = mainBuy(view.queue);
  // Drones are launch and forget, so the launch is the timing decision: our Drones stay in reserve
  // until their units are already fighting ours in a stack (view.engagedStack, ENGAGED_STACK+), and
  // then every Drone in reserve goes at once. Everything else deploys as soon as it is in reserve.
  const launch = (view.engagedStack || 0) >= ENGAGED_STACK;
  // The active cap (view.activeCap, drones included): we deploy only into free slots, so a full
  // field posts no DEPLOY (no ERR rows) and reinforcements go out as our units die.
  const slots = view.activeCap > 0 ? Math.max(0, view.activeCap - ours.length) : Infinity;
  const deployLine = bought => {
    if (slots <= 0) return null;
    const res = { ...view.reserve };
    if (bought) res[bought] = (res[bought] || 0) + 1;
    const n = TYPE_IDS.reduce((a, k) => a + (res[k] || 0), 0);
    const drones = TYPE_IDS.filter(k => isKamikaze(k) && (res[k] || 0) > 0);
    // Nothing held back (or launching and it all fits): plain DEPLOY ALL (the arena fills the slots
    // one of each ground type first).
    if (!drones.length || (launch && n <= slots)) return n ? 'DEPLOY ALL' : null;
    // Drones in reserve: launching, they take the free slots first (a drone into the fight is worth
    // more than another walker); held, we name every other unit.
    const codes = [];
    if (launch) for (const k of drones) for (let i = 0; i < res[k]; i++) codes.push(codeOf(k));
    // The rest one of each type, round and round (the DEPLOY ALL order), so a capped field
    // still gets a breaker and a medic instead of the first six in table order.
    const left = { ...res };
    for (let more = true; more;) {
      more = false;
      for (const k of TYPE_IDS) if (!isKamikaze(k) && (left[k] || 0) > 0) { codes.push(codeOf(k)); left[k]--; more = true; }
    }
    if (!codes.length) return null;
    return `DEPLOY ${codes.slice(0, Math.min(ROSTER_LIMIT, slots)).join(' ')}`;
  };
  const buyAnd = type => { lines.push(`BUY ${codeOf(type)}`); const d = deployLine(type); if (d) lines.push(d); };
  if (healer && !ourMedics && hurt >= 2 && view.bank >= medicPrice) {
    buyAnd(healer);
    why.push('medic for our hurt');
  } else if (view.buyCapped && main && view.bank >= view.price[main] + (medicPrice || 0)) {
    buyAnd(main);
  } else if (drone && view.droneRoom > 0 && clumped(theirGround) && view.bank >= view.price[drone] + (medicPrice || 0)) {
    buyAnd(drone);
    why.push(launch ? `${codeOf(drone)} on their stack` : `${codeOf(drone)} kept for a fight`);
  } else if (reserveN) {
    const d = deployLine(null);
    if (d) lines.push(d);
    if (d && launch && drone && (view.reserve[drone] || 0) > 0) why.push(`${codeOf(drone)} into the fight`);
  }

  // Strength: our field plus what we just fielded, against their field.
  // Units held in reserve by the active cap still count: they replace our losses for free, so they
  // are staying power. (Counting only what fits in the free slots made Ember timid: 40-20 for Green.)
  const ourValue = ours.reduce((a, u) => a + unitValue(u), 0) + reserveValue(view.reserve);
  const theirValue = theirs.reduce((a, u) => a + unitValue(u), 0);
  const ratio = theirValue > 0 ? ourValue / theirValue : 9;

  // 2. Group, then push together.
  const army = (fighters.length ? fighters : ground.length ? ground : ours).map(fz).sort((a, b) => a - b);
  const center = army.length ? army[army.length >> 1] : 0;
  // With none of their ground units left on the field, stragglers walking up from home do not hold
  // the push back: we used to buy a Breaker every window and wait for it to catch up, forever (a lost
  // Green army meant 100+ s of Ember standing in z3 before it went for the base).
  const open = theirGround.length === 0;
  const together = open || (army.length > 0 && army.filter(z => Math.abs(z - center) <= 1).length >= Math.ceil(army.length * 0.75));
  const intruders = theirGround.filter(u => fz(u) <= 1);
  let target;
  let defend = false;
  if (intruders.length >= 2 && center > 1) {
    // Their units in our two home zones: CLEAR, and the normal pick goes for home-zone
    // intruders first (the same base-threat rule every unit without an order uses).
    defend = true;
    mem.phase = 'rally';
    mem.rallySince = null;
    why.push('defend home');
    title = `DEFEND · ${wireZone(side, Math.min(...intruders.map(fz))).toUpperCase()}`;
  } else if (mem.phase === 'rally') {
    target = mem.target == null ? rallyFz : mem.target;
    if (mem.rallySince == null) mem.rallySince = view.elapsed;
    const gathered = together && center >= target - 1 && center <= target + 1 && (open || army.filter(z => z >= target - 1).length >= Math.ceil(army.length * 0.75));
    const waited = view.elapsed - mem.rallySince >= RALLY_WAIT_S || early;
    const ready = gathered && ratio >= pushRatio && waited;
    // A push that is ready sometimes waits one more window (never two in a row).
    const wait = ready && late && !mem.late;
    mem.late = wait;
    if (ready && !wait) {
      mem.phase = 'push';
      mem.rallySince = null;
      target = Math.min(ZONES - 1, Math.max(target, center) + 1);
      why.push(`push ${wireZone(side, target)}`);
      title = `PUSH → ${wireZone(side, target).toUpperCase()}`;
    } else {
      why.push(`${wait ? 'wait' : 'rally'} ${wireZone(side, target)}`);
      title = `${wait ? 'WAIT' : 'RALLY'} · ${wireZone(side, target).toUpperCase()}`;
    }
  } else {
    // Pushing.
    target = mem.target == null ? rallyFz : mem.target;
    const close = ratio < RETREAT_RATIO + 0.15 && cautious;
    if ((ratio < RETREAT_RATIO || close) && center > 0) {
      target = Math.max(1, center - 1);
      mem.phase = 'rally';
      mem.rallySince = view.elapsed;
      why.push(`regroup ${wireZone(side, target)}`);
      title = `REGROUP · ${wireZone(side, target).toUpperCase()}`;
    } else {
      const advance = together && center >= target && ratio >= pushRatio && target < ZONES - 1;
      // While pushing, sometimes hold the zone a window (never two in a row, never at their base).
      const wait = advance && hold && !mem.late;
      mem.late = wait;
      if (advance && !wait) target += 1;
      why.push(`${wait ? 'hold' : 'push'} ${wireZone(side, target)}`);
      title = wait ? `HOLD · ${wireZone(side, target).toUpperCase()}` : `PUSH → ${wireZone(side, target).toUpperCase()}`;
    }
  }
  const loose = ours.some(u => !u.radio);
  function clumped(list) {
    const per = Array(ZONES).fill(0);
    for (const u of list) per[zoneOf(u.x)]++;
    return Math.max(...per) >= CLUMP;
  }
  if (defend) {
    if (room() && ours.some(u => u.radio && u.radio.kind !== 'fallback')) lines.push('CLEAR ALL');
    target = null; // after the threat we rally again
  } else {
    // Their home zone is a MOVE like any other: once it is empty, MOVE walks each unit into range
    // of their base and it shoots (it used to hold at the zone's edge, so we posted CLEAR ALL).
    if (target === ZONES - 1) title = 'BASE ATTACK';
    // Their Drones: spread the ground army over the target zone and the one behind it, so one blast
    // catches half as much. Two MOVE lines, re-posted when the target or the split changes.
    const spread = theirDrones >= SPREAD_AT && fighters.length >= 4 && target > 0;
    const back = spread ? target - 1 : null;
    if (spread && room() && (target !== mem.target || !mem.spread || loose) && lines.length <= 1) {
      const sorted = ground.slice().sort((a, b) => a.y - b.y);
      const a = sorted.filter((_, i) => i % 2 === 0).map(u => u.tag).slice(0, 12);
      const b = sorted.filter((_, i) => i % 2 === 1).map(u => u.tag).slice(0, 12);
      lines.push(`MOVE ${a.join(' ')} ${wireZone(side, target)}`);
      if (b.length) lines.push(`MOVE ${b.join(' ')} ${wireZone(side, back)}`);
      why.push('spread vs drones');
      mem.spread = true;
    } else if (!spread && mem.spread && ours.length && room()) {
      lines.push(`MOVE ALL ${wireZone(side, target)}`);
      mem.spread = false;
    } else if (spread && mem.spread && target === mem.target) {
      // Spread and on target: nothing to post.
    } else if (ours.length && room() && target !== mem.target) lines.push(`MOVE ALL ${wireZone(side, target)}`);
    else if (loose && room()) {
      // New units (autobuys) join the group; units on ASSIST or FALLBACK keep their order.
      const ids = ours.filter(u => !u.radio).map(u => u.tag).slice(0, 12);
      lines.push(`MOVE ${ids.join(' ')} ${wireZone(side, target)}`);
    }
  }
  mem.target = target;

  // 3. ASSIST a nearby fight we are not winning.
  if (room()) {
    const n = Array.from({ length: ZONES }, () => [0, 0]);
    for (const u of view.units) if (!isFlying(u.type)) n[zoneOf(u.x)][u.side === side ? 0 : 1]++;
    let best = null;
    for (let z = 0; z < ZONES; z++) {
      if (!(n[z][0] > 0 && n[z][1] > 0 && n[z][1] >= n[z][0])) continue;
      const helpers = ours.filter(u => Math.abs(zoneOf(u.x) - z) === 1 && !(u.radio && u.radio.kind === 'fallback')).length;
      if (helpers && (!best || n[z][1] - n[z][0] > best.gap)) best = { z, gap: n[z][1] - n[z][0] };
    }
    if (best) { lines.push(`ASSIST z${best.z + 1} 1`); why.push(`assist z${best.z + 1}`); }
  }

  // 4. FOCUS: their medics, else their breakers when 3+. A match whose temperament picked
  // breakers, rifles or their biggest group focuses that while 2+ are on the field.
  let focus = null;
  const count = k => theirs.filter(u => u.type === k).length;
  let pref = null;
  if (st.focus === 'armor') pref = armor;
  else if (st.focus === 'ranged') pref = U.idsWithRole('ranged')[0];
  else if (st.focus === 'biggest') {
    for (const k of TYPE_IDS) if (count(k) && (!pref || count(k) > count(pref))) pref = k;
  }
  if (kamikaze && theirDrones >= SPREAD_AT) focus = kamikaze;
  else if (pref && count(pref) >= 2) focus = pref;
  else if (healer && theirs.some(u => u.type === healer)) focus = healer;
  else if (armor && count(armor) >= 3) focus = armor;
  if (focus !== (view.focus || null) && room() && (focus || view.focus)) {
    lines.push(focus ? `FOCUS ${codeOf(focus)}` : 'FOCUS NONE');
    if (focus) why.push(`focus ${codeOf(focus)}`);
  }

  // 5. AUTOBUY our main unit, keeping one medic's price in the bank.
  if (!view.autobuy && !view.buyCapped && room()) {
    const k = main;
    if (k) lines.push(`AUTOBUY ${codeOf(k)}${medicPrice ? ` RESERVE ${medicPrice}` : ''}`);
  }

  // 6. FALLBACK one badly hurt fighter when our medic is on the field.
  if (room() && ours.some(u => isHealer(u.type))) {
    const low = fighters.find(u => u.hp <= u.max * st.fallbackHp && !(u.radio && u.radio.kind === 'fallback'));
    if (low) lines.push(`FALLBACK ${low.tag}`);
  }

  return { lines, why: why.slice(0, 2).join(', ').slice(0, 60), title: title || 'COMMANDING', detail: `${ours.length} on the field v ${theirs.length} · strength ${ratio >= 9 ? 'clear' : ratio.toFixed(2)}` };
}

module.exports = { commanderOrders, newMemory, mainBuy, unitValue, rollStyle, describeStyle, draftDrones, RALLY_FZ, PUSH_RATIO, RETREAT_RATIO, AGENCY, PLAIN_STYLE, DRONE_DRAFT, CLUMP, SPREAD_AT, ENGAGED_STACK };
