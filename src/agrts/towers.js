'use strict';
// Towers and Team HP (docs/TOWERS.md, spec: gbw-dev/tower-spec.md). Everything here is behind TOWERS=1 (master).
// With TOWERS=0 (an available setting; the default is now on) the match plays byte for byte like before: no new
// HP rule, no new structure, the old 480 s cap and the old "equal HP is a draw".
//
// Team HP is match.hp[side] (100 at the start). The base, towers, lost zones and sieges all take from it:
//   direct   = hits on the base (unit shots, mortar shells, drone blasts). Can reach 0: that ends the match.
//   indirect = tower kills, zone losses, siege drain. Never takes a side below TEAM_HP_FLOOR, and softens
//              below COMEBACK_BELOW. Only the base can finish a team.
// Every number is a setting (env, or opts.towers on a match); the defaults are Ray's Oct 14 decisions.

const RULES = require('./rules'); // economy.csv: a number with no env variable set reads the ruleset (env wins, else the CSV)

/** Env flag: on unless 0/off/false/no/none (empty = the default). */
function flag(name, def, env = process.env) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return def;
  return !['0', 'off', 'false', 'no', 'none'].includes(String(raw).trim().toLowerCase());
}
function num(name, def, env = process.env) {
  const raw = env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/** Master switch from the environment. Default ON (Oct 15 rollout); TOWERS=0 turns it off. */
const TOWERS_DEFAULT = true;
function towersOn(env = RULES.env()) { return flag('TOWERS', TOWERS_DEFAULT, env); }

// Credits and Team HP per tower kind. Points are the tie-break weight at the time limit.
const KINDS = {
  gun:      { points: RULES.value('points_gun'), label: 'gun tower' },
  hospital: { points: RULES.value('points_hospital'), label: 'field hospital' },
  depot:    { points: RULES.value('points_depot'), label: 'depot' },
};

/**
 * The settings for one match. `o` overrides the environment: true/false (master only) or an object
 * { on, timeLimit, floor, ... } using the keys below. Anything unset follows the env, then the default.
 */
function config(o, env = RULES.env()) {
  const ov = o && typeof o === 'object' ? o : {};
  const scalar = o != null && typeof o !== 'object'; // true / false / 1 / '1' / 'off'
  const on = scalar ? !['0', 'off', 'false', 'no', 'none', ''].includes(String(o).trim().toLowerCase()) : ov.on != null ? !!ov.on : towersOn(env);
  const pick = (key, envName, def) => (ov[key] != null ? ov[key] : num(envName, def, env));
  const pickFlag = (key, envName, def) => (ov[key] != null ? !!ov[key] : flag(envName, def, env));
  const c = {
    on,
    timeLimit: pick('timeLimit', 'TIME_LIMIT_S', 360),
    floor: pick('floor', 'TEAM_HP_FLOOR', 20),
    comebackBelow: pick('comebackBelow', 'COMEBACK_BELOW', 40),
    comebackMult: pick('comebackMult', 'COMEBACK_MULT', 0.5),
    // Extra HP rules (PR2). zoneLoss is a scale on the per-depth weights (0 = off); siege is HP/s per
    // unit (0 = off); regen is seconds per HP (0 = off).
    zoneLoss: pick('zoneLoss', 'ZONE_LOSS_HP', 1),
    zoneHoldS: pick('zoneHoldS', 'ZONE_HOLD_S', 10),
    zoneCooldownS: pick('zoneCooldownS', 'ZONE_LOSS_COOLDOWN_S', 30),
    siege: pick('siege', 'SIEGE_DRAIN', 0.1),
    siegeMax: pick('siegeMax', 'SIEGE_MAX', 0.2),
    regenS: pick('regenS', 'HOSP_REGEN_S', 15),
    regenMin: pick('regenMin', 'HOSP_REGEN_MIN', 50),
    regenMax: pick('regenMax', 'HOSP_REGEN_MAX', 90),
    // Hospital as a tower (PR2): HP cost for its owner, CR to the attacker. Later kills cost half.
    hospHp: pick('hospHp', 'HOSP_HP_COST', 0),
    hospCr: pick('hospCr', 'HOSP_CR_BONUS', 20),
    // Gun tower (PR3).
    gun: pickFlag('gun', 'GUN_TOWER', true),
    gunHp: pick('gunHp', 'GUN_HP', 100),
    gunDmg: pick('gunDmg', 'GUN_DMG', 6),
    gunCool: pick('gunCool', 'GUN_COOL', 1.0),
    gunRange: pick('gunRange', 'GUN_RANGE', 105),
    gunHpCost: pick('gunHpCost', 'GUN_HP_COST', 0),
    gunCr: pick('gunCr', 'GUN_CR_BONUS', 25),
    // Depot (PR4). Rebuild numbers follow the field hospital's (60 s, 40 CR, paid when the timer ends).
    depot: pickFlag('depot', 'DEPOT', true),
    depotHp: pick('depotHp', 'DEPOT_HP', 160),
    depotShield: pick('depotShield', 'DEPOT_SHIELD', 0.6),
    depotRebuildS: pick('depotRebuildS', 'DEPOT_REBUILD_S', 60),
    depotRebuildCr: pick('depotRebuildCr', 'DEPOT_REBUILD_CR', 40),
    depotHpCost: pick('depotHpCost', 'DEPOT_HP_COST', 0),
    depotCr: pick('depotCr', 'DEPOT_CR_BONUS', 40),
    depotIncome: pick('depotIncome', 'DEPOT_INCOME', 0),
    // Bought gun towers (BUY TOWER, off by default: docs/BUY-TOWERS.md). A credit sink: price, most per match, build time, HP, bounty to the attacker.
    buy: pickFlag('buy', 'BUY_TOWERS', false),
    buyCr: pick('buyCr', 'TOWER_BUY_CR', 120),
    buyMax: pick('buyMax', 'TOWER_BUY_MAX', 2),
    buyBuildS: pick('buyBuildS', 'TOWER_BUILD_S', 8),
    buyHp: pick('buyHp', 'TOWER_BUY_HP', 80),
    buyBounty: pick('buyBounty', 'TOWER_BUY_BOUNTY', 15),
    buyEmber: pickFlag('buyEmber', 'TOWER_BUY_EMBER', false),
    // BUY RANGE [TOWER|TURRET|ALL] (off by default): a range boost counted in rounds (shots) on our gun tower(s) and/or base turret. ALL costs rangeCr, one target 70% of it.
    rangeBuy: pickFlag('rangeBuy', 'BUY_RANGE', RULES.value('range_buy') > 0),
    rangeCr: pick('rangeCr', 'RANGE_BUY_CR', RULES.value('range_buy_cr')),
    rangePct: pick('rangePct', 'RANGE_BUY_PCT', RULES.value('range_buy_pct')),
    rangeS: pick('rangeS', 'RANGE_BUY_S', RULES.value('range_buy_s')),               // seconds of a weapon's own fire one purchase is worth: rounds = round(rangeS / cooldown), per weapon
    rangeRoundsGun: pick('rangeRoundsGun', 'RANGE_BUY_ROUNDS_GUN', RULES.value('range_buy_rounds_gun')),       // 0 = derive from rangeS
    rangeRoundsTurret: pick('rangeRoundsTurret', 'RANGE_BUY_ROUNDS_TURRET', RULES.value('range_buy_rounds_turret')),
    rangeCool: pick('rangeCool', 'RANGE_BUY_COOL_S', RULES.value('range_buy_cool_s')),
    rangeMax: pick('rangeMax', 'RANGE_BUY_MAX', RULES.value('range_buy_max')),
  };
  return Object.freeze(c);
}

// Structure positions. A 180-degree mirror of the 800 x 380 field: (x, y) -> (800 - x, 380 - y).
// Gun tower: Green z3 bottom lane, Ember z6 top lane (the opposite lane from each side's hospital).
// Depot: z1 / z8 beside the base, outside the base turret's body but inside its range.
const GUN_R = 14, DEPOT_R = 18;
const NOMINAL = Object.freeze({
  gun: [{ zone: 2, x: 250, y: 285 }, { zone: 5, x: 550, y: 95 }],
  depot: [{ zone: 0, x: 62, y: 285 }, { zone: 7, x: 738, y: 95 }],
});

/**
 * A walkable spot for a structure: the nominal point when `blocked(x, y)` (the match's wall test, padded by the
 * hull) allows it, else the nearest free point in the same zone and the same lane (below / above the midline).
 * Falls back to the nominal point when the whole lane cell is walled in.
 */
function place(kind, side, blocked) {
  const nom = NOMINAL[kind][side];
  if (!blocked(nom.x, nom.y)) return { zone: nom.zone, x: nom.x, y: nom.y };
  const zw = 100;
  const lo = nom.zone * zw + 22, hi = (nom.zone + 1) * zw - 22;
  const low = nom.y > 190; // bottom lane
  // The depot may sit closer to the midline (y 214 / 166) than the gun tower so it can stay beside the base turret.
  const yLo = low ? (kind === 'depot' ? 214 : 236) : 40, yHi = low ? 340 : (kind === 'depot' ? 166 : 144);
  // The depot should stay inside its base turret's reach (the turret at x 40 / 760, y 190, range 110): first pass
  // only takes spots within 106 px of it, the second takes any free spot in the cell.
  const tx = side === 0 ? 40 : 760;
  const ok = kind === 'depot' ? [(x, y) => { const d = Math.hypot(x - tx, y - 190); return d <= 106 && d >= 40; }, () => true] : [() => true];
  for (const want of ok) {
    for (let rad = 8; rad <= 110; rad += 8) {
      for (let a = 0; a < 24; a++) {
        const x = Math.max(lo, Math.min(hi, nom.x + Math.cos(a / 24 * Math.PI * 2) * rad));
        const y = Math.max(yLo, Math.min(yHi, nom.y + Math.sin(a / 24 * Math.PI * 2) * rad * 0.8));
        if (Math.floor(x / zw) !== nom.zone) continue;
        if (want(x, y) && !blocked(x, y)) return { zone: nom.zone, x, y };
      }
    }
  }
  return { zone: nom.zone, x: nom.x, y: nom.y };
}

/** A spot for a bought gun tower in zone index `zone` (0..7): the lane (bottom y 285 / top y 95) with fewer towers, else the nearest free point. */
function placeAt(zone, laneLow, blocked) {
  const zw = 100, lo = zone * zw + 22, hi = (zone + 1) * zw - 22;
  const nx = zone * zw + 50, ny = laneLow ? 285 : 95;
  if (!blocked(nx, ny)) return { zone, x: nx, y: ny };
  for (let rad = 8; rad <= 60; rad += 8) for (let a = 0; a < 24; a++) {
    const x = Math.max(lo, Math.min(hi, nx + Math.cos(a / 24 * Math.PI * 2) * rad));
    const y = Math.max(laneLow ? 236 : 40, Math.min(laneLow ? 340 : 144, ny + Math.sin(a / 24 * Math.PI * 2) * rad * 0.8));
    if (!blocked(x, y)) return { zone, x, y };
  }
  return { zone, x: nx, y: ny };
}

/** Zone-loss weights by depth from the owner's home zone: z1/z2/z3/z4/z5/z6-8 = 5/4/3/2/2/1. */
const ZONE_WEIGHT = [1, 2, 3, 4, 5, 6, 7, 8].map(i => RULES.value(`zone_weight_${i}`));
let appliedSig = RULES.signature();
/** Re-read the tie-break points and zone weights from the ruleset (at a match boot; only when a number changed). */
function applyRules() {
  const sig = RULES.signature();
  if (sig === appliedSig) return false;
  appliedSig = sig;
  KINDS.gun.points = RULES.value('points_gun'); KINDS.hospital.points = RULES.value('points_hospital'); KINDS.depot.points = RULES.value('points_depot');
  for (let i = 0; i < 8; i++) ZONE_WEIGHT[i] = RULES.value(`zone_weight_${i + 1}`);
  return true;
}
/** Depth of zone index i (0..7) for a side: 0 is its own home zone. */
function depth(side, i) { return side === 0 ? i : 7 - i; }

module.exports = { applyRules, GUN_R, DEPOT_R, NOMINAL, place, placeAt, KINDS, ZONE_WEIGHT, TOWERS_DEFAULT, config, towersOn, flag, num, depth };
