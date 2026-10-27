'use strict';
// Red's smart buying (docs/RED-AI.md). What to buy, and when to wait: ONE decision per command window, from what Green fields.
// It only chooses. Every buy still goes through the same rules as Green's (symBlock / pay in range/src/engine.js: prices, caps, cooldowns,
// bank): the commander posts `BUY x` / `AUTOBUY x` and the shared path accepts or refuses it. Nothing here reads Green's bank, reserve or
// roster: only the units on the field (which any player sees) and Red's own state.
//
// How it decides (plain words):
//   1. Read Green: the types on the field, smoothed over windows (KNOBS.threatAlpha), so a lull does not erase what it fielded.
//   2. Score every unit Red may buy now (caps respected): how well it trades, per credit, against what Green fields (matchup(), computed
//      from units.csv: dps, hp, range, bonus_vs, splash, blast_resist, plane, live_cost), times a mix correction (a type Red already has plenty
//      of is worth less: no rifle spam), times situation rules (medic when hurt, drones on a clump / a turtle / a bare hospital, mortar behind a
//      screen, tanks to finish structures), times an adapt factor (a type that keeps dying is worth less; behind in strength leans harder on counters).
//   3. Buy the best one. If the best is not affordable yet and clearly better than the best affordable one (a hole), wait for it, but only up to
//      KNOBS.saveMaxS seconds / KNOBS.saveMaxGap credits short, and never with KNOBS.parkBank or more in the bank.
//   4. Seeded: its own rng (seed ^ BUY_SALT): a per-match buying style (KNOBS.styles) and a small noise on every score. Same seed + same Green
//      actions = same Red. The commander's own temperament dice are untouched.
// All numbers are in KNOBS (documented in docs/RED-AI.md); nothing below is a magic number.

const C = require('./constants');
const U = require('./units');
const { TYPES, TYPE_IDS, zoneOf, mulberry32 } = C;

const BUY_SALT = 0x7bd1c5e3;

const DEFAULTS = {
  // --- reading Green
  threatAlpha: 0.5,        // share of this window's field in the smoothed read (1 = no memory)
  threatMin: 1.5,          // below this many (hp-weighted) Green units the read is "none": the base mix decides
  // --- mix targets: share of Red's army value by ROLE (units.csv role); split evenly between the types of a role
  baseMix: Object.freeze({ ranged: 0.55, fast: 0.0, armor: 0.17, healer: 0.12, mortar: 0.10, mine: 0 }),   // kamikaze and mine are not in the army mix: it is bought by its own rules
  mixWeight: 1.0,          // how hard the mix pulls (0 = off)
  mixClamp: Object.freeze([0.45, 1.8]),
  // --- matchup (units.csv derived)
  rangeWeight: 0.5,        // dps gain at the full range edge (range difference / rangeNorm, clamped to +-1)
  rangeNorm: 100,
  effClamp: Object.freeze([0.3, 3.0]),
  counterExp: 1.0,         // exponent on the matchup number in the score
  splashPerClump: 0.35,    // extra targets a splash unit hits per Green ground unit in the biggest stack beyond the first (max +2)
  interceptRefCost: 40,    // the live cost the intercept number is quoted at (a unit that costs more is worth proportionally less per credit)
  interceptW: 1.6,         // vs a Drone: matchup = drones the unit can shoot down before they connect (shots in its reach time x chance to kill) x this
  indirectHit: 0.6,
  minRangeHit: 0.5,        // share of a tube's fire left against a unit whose range is inside its min_range (it closes in and the tube goes quiet)        // share of a Mortar's (indirect) shells that land on a moving target
  droneHit: 0.3,           // share of a Drone pack that connects (the rest dies to fire first)
  mine: Object.freeze({ baseMult: 0.6, clump: 3, clumpMult: 2 }),   // a mine pack (docs/MINES.md): its own rule, boosted when Green clumps
  dronePack: 3,            // drones per buy (the engine's pack)
  // --- situation rules
  medic: Object.freeze({ perFighters: 4, minFighters: 3, needMult: 4.0, fullMult: 0.0, lowMult: 0.3, hurtBelow: 20, hurtN: 2 }),   // hurtBelow = HP missing that counts as hurt
  mortar: Object.freeze({ fightersPerTube: 3, maxTubes: 2, screenMult: 0.0, tankMult: 1.3 }),                                   // no screen = no tube
  drone: Object.freeze({ baseMult: 0.5, clump: 5, clumpMult: 2.4, engagedMult: 1.5, turtleMult: 1.8, turtleN: 3, bareMult: 1.6, bareGround: 1, vsAirMult: 0.25, noArmyMult: 0.4 }),
  // Scout roles (docs/SCOUT.md): flanker = Green fields units the Scout has bonus_vs against (mortar, medic): x backMult per such unit, up to backMax;
  // runner = Red has forward posts down: x postMult (Scouts build them in scout_post_build_s). maxShare caps Scouts' share of Red's army value.
  runner: Object.freeze({ noBackMult: 1.0, backMult: 0.2, backMax: 1.4, postMult: 1.2, maxShare: 0.15, overMult: 0.2 }),
  finish: Object.freeze({ theirGround: 2, tankMult: 1.6 }),        // few Green ground units left: structure damage (base_mult) decides, tanks first
  // --- waiting for the right counter
  saveMargin: 1.35,        // the best must beat the best affordable by this factor to be worth waiting for
  saveMaxS: 9,             // seconds Red may wait for one unit
  saveMaxGap: 50,          // credits short at most
  explicitWaitGap: 25,     // a Medic / Drone pack that is this close (or closer) is waited for; further away, the bank keeps buying the best AUTOBUY unit
  parkBank: 100,           // never wait with this much (or more) in the bank
  // --- adapting to what is happening
  lossDecay: 0.4,          // smoothing of the per-window loss rate of a type
  lossHi: 0.15,            // per-window loss rate above which a type is worth less
  lossMinAlive: 2,         // only judged once this many were alive
  lossPenalty: 0.5,        // score cut at twice lossHi
  lossFloor: 0.5,
  behindRatio: 0.8,        // strength ratio below this: lean on counters
  behindBoost: 0.5,        // counterExp x (1 + this) when behind
  // --- unpredictability
  jitter: 0.12,            // each score x (1 +- jitter)
  // --- buying styles, rolled once per match (shift the base mix by role; weights sum to 1)
  styles: Object.freeze([
    Object.freeze({ name: 'balanced', w: 0.40, mix: Object.freeze({}) }),
    Object.freeze({ name: 'gunline', w: 0.20, mix: Object.freeze({ ranged: 0.14, armor: -0.08, fast: -0.03 }) }),
    Object.freeze({ name: 'armored', w: 0.15, mix: Object.freeze({ armor: 0.12, ranged: -0.08, fast: -0.03 }) }),
    Object.freeze({ name: 'artillery', w: 0.15, mix: Object.freeze({ mortar: 0.10, ranged: -0.06, fast: -0.03 }) }),
    Object.freeze({ name: 'swarm', w: 0.10, mix: Object.freeze({ fast: 0.14, armor: -0.08, mortar: -0.06 }) }),
  ]),
  decisionsKept: 12,
  // --- the opening team (the setup card's limits apply; Red cannot see Green's card, so it is by style only). Units in preference order are dropped from the END if a limit is hit.
  // Rollover-aware (branch red-rollover): unspent setup budget becomes the starting bank at LIVE prices (about twice the draft price), so a cheap
  // wide opening plus a planned first buy from the carry fields more than a dear one. Each opening fills the 6 slots with mostly Rifles (cheapest efficient unit).
  openings: Object.freeze({
    balanced: Object.freeze({ rifle: 6 }),
    gunline: Object.freeze({ rifle: 6 }),
    armored: Object.freeze({ rifle: 5, tank: 1 }),
    artillery: Object.freeze({ rifle: 6 }),
    swarm: Object.freeze({ rifle: 5, drone: 1 }),
  }),
  // --- the carried bank (rollover) and the first live buys: see plan() step 2b
  rollover: Object.freeze({
    earlyS: 20,        // the opening phase: the first windows after the countdown, while the carried bank is spent
    comingS: 4,        // for this long after the first window Red counts Green's carried bank (read off the field) as units on their way
    massN: 0,          // Green fields (or has coming) at least this many more ground units than Red's fighters: a mass to answer
    lineMult: 0.85,    // in the opening phase vs a mass: line units (role ranged) x this (below 1: a line on a line is an even trade; sustain first)
    mortarMult: 0.2,   // in the opening phase vs a mass: a Mortar x this (slow, the mass walks inside its min_range, the screen is not set yet)
    droneMult: 0.4,    // in the opening phase vs a mass: a Drone pack x this (shot down by the stack)
    medicMult: 2.0,    // in the opening phase vs a mass: a Medic x this (sustain wins the even line fight; one per medic.perFighters still applies)
    planMult: 1.3,     // the style's planned first buy (openingPlan) x this, until it is bought or the phase ends
  }),
  openingPlan: Object.freeze({ balanced: 'medic', gunline: 'rifle', armored: 'rifle', artillery: 'mortar', swarm: 'rifle' }),
};

/** DEFAULTS with the dev override RED_BUY_KNOBS='{"saveMaxS":0,"drone":{"clumpMult":1}}' (self-play tuning, docs/RED-AI.md) merged in, then frozen. */
function build(base, over) {
  const out = {};
  for (const [k, v] of Object.entries(base)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && over && over[k] && typeof over[k] === 'object' ? build(v, over[k]) : (over && k in over ? over[k] : v);
  // keys only in the override (e.g. a unit type an opening did not list) are taken as given
  if (over && typeof over === 'object' && !Array.isArray(over) && !Array.isArray(base)) for (const [k, v] of Object.entries(over)) if (!(k in base)) out[k] = v;
  return Object.freeze(out);
}
let OVER = null; try { OVER = process.env.RED_BUY_KNOBS ? JSON.parse(process.env.RED_BUY_KNOBS) : null; } catch (e) { OVER = null; }
const KNOBS = build(DEFAULTS, OVER);

const roleOf = k => U.roleOf(k);
const isHealer = k => roleOf(k) === 'healer';
const isKamikaze = k => roleOf(k) === 'kamikaze';
const isMine = k => roleOf(k) === 'mine';
const isFlying = k => U.isFlying(k);
const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));
const codeOf = k => U.CODE_BY_TYPE[k];

/** Per-match state: style (seeded), rng, smoothed read of Green, loss rates, waiting state, last decisions. seed null = plain (no noise, balanced). */
function newState(seed) {
  const st = { rng: null, style: KNOBS.styles[0], threat: {}, prev: null, lossRate: {}, save: null, decisions: [], windows: 0, spent: 0 };
  if (Number.isFinite(seed)) {
    st.rng = mulberry32((seed ^ BUY_SALT) >>> 0);
    let r = st.rng(), acc = 0; st.style = KNOBS.styles[KNOBS.styles.length - 1];
    for (const s of KNOBS.styles) { acc += s.w; if (r < acc) { st.style = s; break; } }
  }
  st.planned = (KNOBS.openingPlan && KNOBS.openingPlan[st.style.name]) || null;   // the first buy the opening was costed with (rollover)
  return st;
}

/** Rough fighting value of a unit at its HP (the commander's unitValue): sqrt(hp x dps). */
function value(type, hp) {
  const t = TYPES[type]; if (!t) return 0;
  const dps = t.cool > 0 ? t.dmg / t.cool : t.dmg;
  return Math.sqrt(Math.max(0, hp) * Math.max(0.5, dps));
}

/** Damage per second `a` deals to `b` (units.csv: dmg, cooldown, bonus_vs, plane vs indirect fire, blast_resist vs splash), before range and splash extras. */
// One unit's share of a buy's price: a Scout buy fields spawn_count (3) for one live_cost (Drones have their own formula).
const perUnit = (k, f = 'live') => (TYPES[k][f] || 0) / Math.max(1, (!isKamikaze(k) && TYPES[k].spawnCount) || 1);

function dpsVs(a, b, scale = 0.7) {
  const A = TYPES[a], B = TYPES[b];
  if (A.indirect && B.flying) return 0;                                  // a tube cannot hit the air
  let d = A.dmg * scale * ((A.bonusVs && A.bonusVs[B.code]) || 1);
  if (A.splash > 0) d *= 1 - (B.blastResist || 0);
  return A.cool > 0 ? d / A.cool : d;
}

/**
 * How well one `c` (bought) trades per credit against one `e` (Green's): > 1 good, < 1 bad. Square-law strength per credit squared
 * (dps x hp / live_cost^2), dps adjusted by the range edge. A Drone pack is its own formula (it dies connecting): kill value per credit.
 * `targets` = how many units a splash hits (from the clump).
 */
function matchup(c, e, o = {}) {
  const K = KNOBS, tc = TYPES[c], te = TYPES[e], targets = o.targets || 1;
  if (isHealer(c) || isMine(c)) return 1;
  if (isKamikaze(c)) {
    if (te.flying) return K.effClamp[0];
    const dmg = tc.dmg * (o.scale || 0.7) * (1 - (te.blastResist || 0));
    const per = Math.min(1, dmg / te.hp) * Math.min(1 + (targets - 1), 3) * te.live;
    return clamp(K.dronePack * K.droneHit * per / tc.live, K.effClamp);
  }
  if (isKamikaze(e)) {
    // Against a Drone pack: how many it shoots down on the way in (one shot at full range, more if its cooldown fits the flight), by its damage vs the drone's HP.
    if (tc.indirect || !(tc.range > 0)) return K.effClamp[0];
    const dmg = tc.dmg * (o.scale || 0.7) * ((tc.bonusVs && tc.bonusVs[te.code]) || 1);
    const shots = tc.cool > 0 ? 1 + Math.floor((tc.range / Math.max(1, te.speed)) / tc.cool) : 1;
    return clamp(shots * Math.min(1, dmg / te.hp) * K.interceptW * K.interceptRefCost / tc.live, K.effClamp);
  }
  const edge = clamp((tc.range - te.range) / K.rangeNorm, [-1, 1]);
  // min_range (units.csv): a tube cannot fire at a unit that fights from inside it, so against such a unit it only shoots on the approach
  const inside = (a, b) => (a.minRange > 0 && b.range > 0 && b.range < a.minRange ? K.minRangeHit : 1);
  const mine = dpsVs(c, e) * (1 + K.rangeWeight * edge) * (tc.splash > 0 ? targets : 1) * (tc.indirect ? K.indirectHit : 1) * inside(tc, te);
  const theirs = dpsVs(e, c) * (1 - K.rangeWeight * edge) * (te.splash > 0 ? targets : 1) * (te.indirect ? K.indirectHit : 1) * inside(te, tc);
  if (mine <= 0) return K.effClamp[0];
  if (theirs <= 0) return K.effClamp[1];
  const lc = perUnit(c), le = perUnit(e), pc = mine * tc.hp / (lc * lc), pe = theirs * te.hp / (le * le);
  return clamp(pc / pe, K.effClamp);
}

const zoneCounts = list => { const per = Array(C.ZONES).fill(0); for (const u of list) per[zoneOf(u.x)]++; return per; };

/**
 * One window's buying decision. `view` is the commander's view (+ view.caps from the match: caps[type] = { block, room });
 * returns { buyNow: type|null (explicit BUY, then DEPLOY), autoType: type|null (standing AUTOBUY, null = off), why, decision }.
 */
function plan(view, st) {
  const K = KNOBS, side = view.side, t = view.elapsed;
  const ours = view.units.filter(u => u.side === side && u.hp > 0), theirs = view.units.filter(u => u.side !== side && u.hp > 0);
  const theirGround = theirs.filter(u => !isFlying(u.type));
  const bank = view.bank;
  st.windows++;

  // ---- 1. read Green: hp-weighted counts, smoothed
  const now = {};
  for (const u of theirs) now[u.type] = (now[u.type] || 0) + 0.5 + 0.5 * Math.max(0, Math.min(1, u.hp / u.max));
  for (const k of TYPE_IDS) st.threat[k] = (st.threat[k] || 0) * (1 - K.threatAlpha) + (now[k] || 0) * K.threatAlpha;
  const tTotal = TYPE_IDS.reduce((a, k) => a + st.threat[k], 0);
  const haveRead = tTotal >= K.threatMin;
  const share = k => (haveRead ? st.threat[k] / tTotal : 0);

  // ---- own army (field + reserve), by type
  const own = {}; for (const k of TYPE_IDS) own[k] = (view.reserve[k] || 0);
  for (const u of ours) own[u.type] = (own[u.type] || 0) + 1;
  const ground = ours.filter(u => !isFlying(u.type));
  const fighters = ground.filter(u => !isHealer(u.type) && !isKamikaze(u.type));
  const hurt = ours.filter(u => u.hp <= u.max - K.medic.hurtBelow).length;
  const healer = U.idsWithRole('healer')[0], tube = view.mortar || null, armor = U.idsWithRole('armor')[0];
  const nHealers = healer ? own[healer] : 0;
  const nTubes = tube ? own[tube] : 0, nTanks = armor ? own[armor] : 0;

  // ---- losses: units of ours that vanished since the last window (drones are meant to die), rate per type, smoothed
  const tags = new Map(ours.map(u => [u.tag, u.type]));
  if (st.prev) {
    const prevN = {}, lost = {};
    for (const [tag, ty] of st.prev) { prevN[ty] = (prevN[ty] || 0) + 1; if (!tags.has(tag)) lost[ty] = (lost[ty] || 0) + 1; }
    for (const k of TYPE_IDS) {
      if (isKamikaze(k)) continue;
      const r = prevN[k] >= K.lossMinAlive ? (lost[k] || 0) / prevN[k] : 0;
      st.lossRate[k] = (st.lossRate[k] || 0) * K.lossDecay + r * (1 - K.lossDecay);
    }
  }
  st.prev = tags;

  // ---- strength (the commander's measure): own field + reserve vs Green's field
  const ourValue = ours.reduce((a, u) => a + value(u.type, u.hp), 0) + TYPE_IDS.reduce((a, k) => a + (view.reserve[k] || 0) * value(k, TYPES[k].hp), 0);
  const theirValue = theirs.reduce((a, u) => a + value(u.type, u.hp), 0);
  const ratio = theirValue > 0 ? ourValue / theirValue : 9;
  const behind = ratio < K.behindRatio;

  // ---- situation reads
  const clumpN = theirGround.length ? Math.max(...zoneCounts(theirGround)) : 0;
  const targets = 1 + Math.min(2, Math.max(0, clumpN - 1) * K.splashPerClump);
  const tw = view.towers || null;
  let turtle = false;
  if (tw && tw.theirs) {
    for (const key of ['gun', 'hospital']) { const s = tw.theirs[key]; if (s && s.alive && theirGround.filter(u => zoneOf(u.x) === s.zone).length >= K.drone.turtleN) turtle = true; }
  }
  const hosp = view.enemyHospital;
  const bare = !!(hosp && hosp.alive) && theirGround.length <= K.drone.bareGround;
  const finishing = theirGround.length <= K.finish.theirGround && !theirs.some(u => isFlying(u.type));   // a bare field, no Drones about
  const stack = (view.engagedStack || 0) >= 2;
  const theirAir = theirs.filter(u => isFlying(u.type)).length;
  // ---- 2b. the opening phase (rollover): the carried bank buys the first live units. Against a mass on the field (more ground units than our
  // fighters) Red matches it with line units first; a Mortar (slow, no screen yet) or a Drone pack into the stack waits. Red reads only the field.
  const R = K.rollover || {};
  const early = t <= (R.earlyS || 0);
  // Green's rollover, read off the field: at the first window (countdown end) Green's whole setup team is on the field, so what it left of the public
  // setup budget (DRAFT_BUDGET - the draft cost of what stands there) is what it carried. Red counts that bank as Rifle-priced units still to come.
  if (st.firstT == null) {
    st.firstT = t;
    let cost = 0; for (const u of theirs) cost += isKamikaze(u.type) ? (TYPES[u.type].cost || 0) / K.dronePack : perUnit(u.type, 'cost');
    const line = U.idsWithRole('ranged')[0], carry = Math.max(0, C.DRAFT_BUDGET - cost);
    // only a first window AT countdown end sees their whole setup team (a state first used later, e.g. a constructed test, reads nothing)
    st.theirCarry = t <= (R.comingS || 0) ? { cr: Math.round(carry), units: line && view.price[line] > 0 ? Math.floor(carry / view.price[line]) : 0 } : { cr: null, units: 0 };
  }
  const coming = t - st.firstT <= (R.comingS || 0) ? st.theirCarry.units : 0;   // their carried bank lands as units within a few seconds
  const mass = early && theirGround.length + coming >= fighters.length + (R.massN || 0);
  if (!early) st.planned = null;

  // ---- 2. eligible units and their scores
  const caps = view.caps || {};
  const cand = TYPE_IDS.filter(k => {
    if (!TYPES[k]) return false;
    if (isKamikaze(k) && !view.drone) return false;
    if (roleOf(k) === 'mortar' && k !== tube) return false;
    const c = caps[k]; if (c && c.block) return false;
    return true;
  });
  // mix: own share of army value (kamikaze excluded), target share by role split between the role's types
  const armyTypes = TYPE_IDS.filter(k => !isKamikaze(k) && !isMine(k) && (roleOf(k) !== 'mortar' || k === tube));
  const mix = { ...K.baseMix };
  for (const [r, d] of Object.entries(st.style.mix)) mix[r] = Math.max(0, (mix[r] || 0) + d);
  const perRole = {}; for (const k of armyTypes) perRole[roleOf(k)] = (perRole[roleOf(k)] || 0) + 1;
  const mixTot = armyTypes.reduce((a, k) => a + (mix[roleOf(k)] || 0) / perRole[roleOf(k)], 0) || 1;
  const wOf = k => perUnit(k) * (own[k] || 0);
  const ownTot = armyTypes.reduce((a, k) => a + wOf(k), 0);
  const noise = TYPE_IDS.map(() => (st.rng ? st.rng() : 0.5));   // always one draw per type, in table order
  const exp = K.counterExp * (1 + (behind ? K.behindBoost : 0));
  const scores = {}, parts = {};
  for (const k of cand) {
    let counter = 1, vs = null;
    if (haveRead && !isHealer(k)) {
      let lg = 0, best = 0;
      for (const e of TYPE_IDS) {
        const s = share(e); if (!(s > 0)) continue;
        const m = matchup(k, e, { targets });
        lg += s * Math.log(m);
        if (s * Math.abs(Math.log(m)) > best) { best = s * Math.abs(Math.log(m)); vs = e; }
      }
      counter = Math.exp(lg * exp);
    }
    let mixM = 1;
    if (armyTypes.includes(k) && ownTot > 0 && !(mass && roleOf(k) === 'ranged')) {   // matching a mass: the line is not "plenty" yet
      const target = (mix[roleOf(k)] || 0) / perRole[roleOf(k)] / mixTot, cur = wOf(k) / ownTot;
      mixM = target <= 0.001 ? K.mixClamp[0] : clamp(1 + K.mixWeight * (target - cur) / Math.max(target, 0.05), K.mixClamp);   // a role with no target (Scouts, unless the style asks) is bought last
    }
    let role = 1, tag = '', pre = 1, preTag = '';
    if (mass) {
      if (roleOf(k) === 'ranged') { pre = R.lineMult; preTag = 'match their line'; }
      else if (roleOf(k) === 'mortar') pre = R.mortarMult;
      else if (isKamikaze(k)) pre = R.droneMult;
      else if (isHealer(k)) { pre = R.medicMult; preTag = 'sustain vs their mass'; }
    }
    if (early && st.planned === k && !mass) { pre = R.planMult; preTag = 'opening plan'; }
    if (isHealer(k)) {
      const need = nHealers < Math.ceil(fighters.length / K.medic.perFighters);
      if (fighters.length < K.medic.minFighters) role = K.medic.lowMult;
      else if (hurt >= K.medic.hurtN && nHealers === 0) { role = K.medic.needMult; tag = `${hurt} hurt, no medic`; }
      else if (need) { role = (hurt >= 1 ? 1.4 : 0.9); tag = tag || 'sustain'; }
      else role = K.medic.fullMult;
    } else if (roleOf(k) === 'mortar') {
      const screen = fighters.filter(u => u.type !== tube).length;
      if (nTubes >= K.mortar.maxTubes || screen < K.mortar.fightersPerTube * (nTubes + 1) - (nTanks >= 1 ? K.mortar.fightersPerTube - 1 : 0)) role = K.mortar.screenMult;
      else if (nTanks >= 1) { role = K.mortar.tankMult; tag = tag || 'behind the tanks'; }
      if (turtle) { role *= K.drone.turtleMult; tag = 'outranges their turtle'; }
    } else if (isKamikaze(k)) {
      role = (fighters.length || ours.length ? 1 : K.drone.noArmyMult) * K.drone.baseMult;
      if (theirAir >= 2 && !clumpN) role *= K.drone.vsAirMult;
      if (clumpN >= K.drone.clump) { role *= K.drone.clumpMult; tag = stack ? 'on their stack' : 'their stack'; }
      if (stack) role *= K.drone.engagedMult;
      if (turtle) { role *= K.drone.turtleMult; tag = tag || 'on their turtle'; }
      if (bare) { role *= K.drone.bareMult; tag = tag || 'their hospital is bare'; }
    } else if (isMine(k)) {
      role = K.mine.baseMult;
      if (clumpN >= K.mine.clump) { role *= K.mine.clumpMult; tag = 'mine their path'; }
    } else if (roleOf(k) === 'fast') {
      const bv = TYPES[k].bonusVs || {}, back = theirs.filter(u => bv[codeOf(u.type)]).length;
      if (back) { role *= Math.min(K.runner.backMax, 1 + K.runner.backMult * back); tag = 'dive their backline'; } else role *= K.runner.noBackMult;
      if ((view.postsDown || 0) > 0) { role *= K.runner.postMult; tag = tag || 'run up a post'; }
      if (ownTot > 0 && wOf(k) / ownTot > K.runner.maxShare) role *= K.runner.overMult;
    } else if (k === armor && finishing && theirs.length <= K.finish.theirGround + 2) { role = K.finish.tankMult; tag = 'finish structures'; }
    role *= pre; if (preTag && (pre > 1 || !tag)) tag = preTag;   // the opening phase (2b) last, so it also tempers the turtle / tank boosts
    let adapt = 1;
    if (!isKamikaze(k) && (st.lossRate[k] || 0) > K.lossHi) {
      adapt = Math.max(K.lossFloor, 1 - K.lossPenalty * Math.min(1, ((st.lossRate[k] - K.lossHi) / K.lossHi)));
      tag = tag || 'they keep dying';
    }
    const jit = 1 + K.jitter * (2 * noise[TYPE_IDS.indexOf(k)] - 1);
    scores[k] = counter * mixM * role * adapt * jit;
    parts[k] = { counter: +counter.toFixed(2), mix: +mixM.toFixed(2), role: +role.toFixed(2), adapt: +adapt.toFixed(2), vs, tag };
  }

  // ---- 3. choose: best overall, best affordable; wait for the best only when it is clearly better, close, and bounded
  const order = cand.slice().sort((a, b) => scores[b] - scores[a] || TYPE_IDS.indexOf(a) - TYPE_IDS.indexOf(b));
  const afford = order.filter(k => scores[k] > 0 && bank >= view.price[k]);
  const live = order.filter(k => scores[k] > 0);
  const best = live[0] || null, bestAff = afford[0] || null;
  const explicit = k => k != null && (isHealer(k) || isKamikaze(k) || isMine(k));
  const autoable = live.filter(k => !explicit(k));
  let pick = bestAff, wait = null;
  if (best && best !== bestAff) {
    const gap = view.price[best] - bank;
    if (!bestAff) pick = null;                                  // nothing affordable: the best is simply next
    else if (scores[best] >= K.saveMargin * scores[bestAff] && gap <= K.saveMaxGap && bank < K.parkBank) {
      if (!st.save || st.save.type !== best) st.save = { type: best, since: t };
      if (t - st.save.since <= K.saveMaxS) wait = best;
    }
  }
  if (!wait) st.save = null;
  if (st.planned && pick === st.planned && !wait) st.planned = null;   // the planned first buy goes out now (or something better did)
  const why = k => {
    const p = parts[k]; if (!p) return '';
    const nm = k2 => TYPES[k2].name;
    const code = codeOf(k);
    if (p.tag) return `${code}: ${p.tag}`;
    if (p.vs && p.counter >= 1.25) return `${code}: counters ${nm(p.vs)}`;
    if (p.mix >= 1.2) return `${code}: mix short`;
    if (p.adapt < 1) return `${code}: they keep dying`;
    return haveRead ? `${code}: best trade` : `${code}: opening mix`;
  };
  let buyNow = null, autoType = null, text = '', how = 'none';
  if (view.buyCapped || !cand.length) { text = view.buyCapped ? 'buy room full' : 'nothing allowed'; how = 'none'; }
  else if (wait) {
    how = 'save'; text = `save for ${codeOf(wait)} (${view.price[wait] - bank} CR): ${parts[wait].tag || (parts[wait].vs ? 'counters ' + TYPES[parts[wait].vs].name : 'best trade')}`;
    autoType = explicit(wait) ? null : wait;
  } else if (pick) {
    text = why(pick);
    if (explicit(pick)) { buyNow = pick; how = 'buy'; autoType = autoable.length ? autoable[0] : null; }
    else { autoType = pick; how = 'auto'; }
  } else if (best) {
    // nothing affordable yet: next in line (an AUTOBUY buys it the moment the bank covers it; an explicit one waits for the next window)
    how = 'next'; text = `next ${codeOf(best)} (${Math.max(0, view.price[best] - bank)} CR)`;
    autoType = !explicit(best) ? best : (view.price[best] - bank <= K.explicitWaitGap ? null : (autoable[0] || null));   // an explicit unit that is close: wait for it, do not spend the bank on something else
  }
  const top = order.slice(0, 3).map(k => [k, +scores[k].toFixed(2)]);
  const decision = { t: +t.toFixed(1), early, mass, theirCarry: st.theirCarry ? st.theirCarry.cr : null, how, pick: buyNow || autoType || null, buyNow, autoType, why: text, bank, ratio: +Math.min(9, ratio).toFixed(2), style: st.style.name, read: haveRead ? Object.fromEntries(TYPE_IDS.filter(k => st.threat[k] >= 0.3).map(k => [k, +st.threat[k].toFixed(1)])) : null, top, parts: Object.fromEntries(order.map(k => [k, parts[k]])) };
  st.decisions.push(decision); if (st.decisions.length > K.decisionsKept) st.decisions.shift();
  return { buyNow, autoType, why: text, decision };
}

/**
 * Red's opening team for a style: the table above, cut to the card's limits ({ slots, budget, caps }) by dropping the unit Red has most of
 * (a tie: the cheaper), the same cut the engine uses for any team. Unknown / unavailable types are skipped.
 */
function opening(style, lim, mortarOn = true) {
  const name = style && style.name ? style.name : style;
  const src = KNOBS.openings[name] || KNOBS.openings.balanced, r = {};
  for (const [k, n] of Object.entries(src)) if (TYPES[k] && (roleOf(k) !== 'mortar' || mortarOn)) r[k] = n;
  for (const k of Object.keys(r)) if (lim.caps[k] && r[k] > lim.caps[k]) r[k] = lim.caps[k];
  const slots = () => Object.values(r).reduce((a, v) => a + v, 0), cost = () => Object.keys(r).reduce((a, k) => a + r[k] * TYPES[k].cost, 0);
  while (slots() > lim.slots || cost() > lim.budget) {
    const k = Object.keys(r).sort((a, b) => r[b] - r[a] || TYPES[a].cost - TYPES[b].cost)[0];
    if (--r[k] <= 0) delete r[k];
  }
  return r;
}

module.exports = { opening, KNOBS, newState, plan, matchup, dpsVs, value, BUY_SALT };
