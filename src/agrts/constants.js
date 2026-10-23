'use strict';
// Iteration 11 field and match constants. Shared by the match sim and the team-decision hooks.
// Unit movement, targeting, attacking and healing use these numbers; they are not team decisions.

// Unit types come from units.csv (src/agrts/units.js), re-read at the start of every match.
// TYPES, TYPE_IDS and FIELD_COST are live objects: they are refilled in place, never reassigned.
const U = require('./units');
const { TYPES, TYPE_IDS, FIELD_COST } = U;
// Matchmaking protocol version (PvP). Defined in version.js, the single source of truth for versions.
const { PVP_PROTOCOL, GAME_VERSION, RULES_VERSION } = require('./version');
// The economy and tower numbers below come from the ruleset (economy.csv, src/agrts/rules.js): an env variable if set,
// else the CSV value, else the built-in default. applyRules() refreshes them when the ruleset changes (at a match boot).
const RULES = require('./rules');
const DRAFT_BUDGET = 200;
const ROSTER_LIMIT = 24;
/** A non-negative number from the environment, else the default. */
function envNumber(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}
// Credits each base pays its side every income tick (INCOME_TICK_S), on top of zone income
// (ZONE_INCOME per frontier zone held). Small on purpose: territory stays the main income, but a side
// pushed back to its base can still buy a unit now and then. Env BASE_INCOME; 0 turns it off.
const ZONE_INCOME = RULES.value('zone_income');
const INCOME_TICK_S = RULES.value('income_tick_s');
const BASE_INCOME = envNumber('BASE_INCOME', RULES.value('base_income'));
// Credits for capturing a frontier zone (a one-time bonus).
const ZONE_CAPTURE_CR = RULES.value('zone_capture_cr');
// Buys per side per match (queue, AUTOBUY and manual BUY together). Env BUY_CAP (balance test, default 6);
// 0, 'unlimited' or 'inf' = no cap (Infinity). Part of the PvP rules stamp (version.js), like BASE_INCOME.
const MAX_BUYS = require('./version').buyCap();
// Active units per side on the field (drones included). More stay in reserve; DEPLOY fields up to
// the cap and a lost unit frees a slot. Deploying from reserve is free. Env ACTIVE_CAP; 0 = no cap.
const ACTIVE_CAP = Math.floor(envNumber('ACTIVE_CAP', RULES.value('active_cap')));
const FIELD_W = 800;
const FIELD_H = 380;
const MATCH_CAP = RULES.value('match_cap_s'); // sim seconds (TOWERS=0 only); then the base with more HP wins
const STEP = 0.05;
// Real-time pace: sim seconds per wall second while live. 1.2 base x GAME_SPEED (default 1.15, Oct 14:
// the whole game 15% faster). Only the wall clock changes: every rule, cooldown, income tick and the
// 480 s match cap are in sim seconds, so a match plays the same, just sooner. Headless runs ignore it.
const GAME_SPEED = envNumber('GAME_SPEED', 1.15) > 0 ? envNumber('GAME_SPEED', 1.15) : 1.15;
const SPEED = 1.2 * GAME_SPEED;
const STYLES = ['balanced', 'pressure', 'armor', 'counter'];
const OPENING_STYLES = ['balanced', 'pressure', 'armor'];
const ZONES = 8; // field columns z1..z8, Green home is z1, Ember home is z8
// Default assist: a unit with no radio order and no enemy in its own range joins a fight
// (a zone with units of both sides) within this many zones of its own. 0 disables it.
const ASSIST_RADIUS_DEFAULT = 1;
// Radio ASSIST <zone> with no radius reaches our units within this many zones.
const ASSIST_RADIUS_ORDER = 2;
/** Zone index 0..7 for a field x. The report writes it 1-based (z1..z8). */
function zoneOf(x) { return Math.min(ZONES - 1, Math.max(0, Math.floor(x / (FIELD_W / ZONES)))); }
// Base turret: one per base, placed in front of it. Fixed, cannot be captured, pays nothing and takes no
// active slot. It shoots the enemy inside RANGE px: a unit hitting our base first, then the nearest ground
// unit, then a Drone. No heal, no repair: once down it stays down for the match. It takes full splash.
// Numbers: a lone Scout, Rifle or Breaker dies before it kills the turret; 3-4 units kill it in 4-7 s.
// Env TURRET_HP=0 turns it off. These are game rules: RULES_VERSION (version.js) changes with them.
const TURRET = {
  hp: envNumber('TURRET_HP', RULES.value('turret_hp')),
  range: RULES.value('turret_range'),      // px; the Rifle reaches 100, so nothing outranges it
  dmg: RULES.value('turret_dmg'),          // per shot
  cool: RULES.value('turret_cool'),        // s between shots (10 DPS)
  firstShot: RULES.value('turret_first_shot'),  // s from a target entering range to the first shot
  dx: 40,          // px in from the field edge (the base is at 16)
  r: 12,           // hull radius, px
};
// Balance test flag: every unit's damage (shots, splash/blast, drones, vs base and vs turret) is multiplied
// by this. The base turret's own damage and medic healing are not. 1 = normal rules. Env DAMAGE_SCALE
// (e.g. 0.7); a match also takes opts.damageScale. Part of the PvP rules stamp (version.js).
const damageScaleNow = () => { const d = RULES.value('damage_scale'); const v = envNumber('DAMAGE_SCALE', d); return v > 0 && v <= 5 ? v : d; };
const DAMAGE_SCALE = damageScaleNow();
const TEAM = [
  { seat: 'Green', label: 'GREEN COMMAND', base: 'HAVEN-01', color: '#bafc82', log: 'GREEN' },
  { seat: 'Ember', label: 'EMBER COMMAND', base: 'CINDER-09', color: '#ff7768', log: 'EMBER' },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** One count per current unit type, zeros included. Unknown keys are dropped. */
function cloneCounts(o) {
  const out = {};
  for (const k of TYPE_IDS) out[k] = (o && o[k]) || 0;
  return out;
}
function emptyCounts() { return cloneCounts({}); }
/** Cheapest opening (draft) price in the table. */
function minDraftCost() { return TYPE_IDS.reduce((m, k) => Math.min(m, TYPES[k].cost), Infinity); }
function total(o) { return TYPE_IDS.reduce((a, k) => a + (o[k] || 0), 0); }
function spent(o) { return TYPE_IDS.reduce((a, k) => a + TYPES[k].cost * (o[k] || 0), 0); }

// Re-read the ruleset numbers into the live constants. Called at a match boot; it does nothing unless a resolved
// number changed since the last call, so a tool that sets a constant by hand (tools/econ-tune.js) keeps it.
let appliedSig = RULES.signature();
function applyRules() {
  const sig = RULES.signature();
  if (sig === appliedSig) return false;
  appliedSig = sig;
  const x = module.exports;
  x.ZONE_INCOME = RULES.value('zone_income');
  x.INCOME_TICK_S = RULES.value('income_tick_s');
  x.BASE_INCOME = envNumber('BASE_INCOME', RULES.value('base_income'));
  x.ZONE_CAPTURE_CR = RULES.value('zone_capture_cr');
  x.MAX_BUYS = require('./version').buyCap();
  x.ACTIVE_CAP = Math.floor(envNumber('ACTIVE_CAP', RULES.value('active_cap')));
  x.MATCH_CAP = RULES.value('match_cap_s');
  x.DAMAGE_SCALE = damageScaleNow();
  Object.assign(TURRET, { hp: envNumber('TURRET_HP', RULES.value('turret_hp')), range: RULES.value('turret_range'), dmg: RULES.value('turret_dmg'), cool: RULES.value('turret_cool'), firstShot: RULES.value('turret_first_shot') });
  return true;
}

module.exports = {
  TYPES, TYPE_IDS, FIELD_COST, DRAFT_BUDGET, ROSTER_LIMIT, MAX_BUYS,
  ZONE_INCOME, INCOME_TICK_S, BASE_INCOME, ZONE_CAPTURE_CR, ACTIVE_CAP, envNumber, applyRules,
  FIELD_W, FIELD_H, MATCH_CAP, STEP, SPEED, GAME_SPEED, STYLES, OPENING_STYLES, TEAM,
  ZONES, ASSIST_RADIUS_DEFAULT, ASSIST_RADIUS_ORDER, zoneOf,
  mulberry32, cloneCounts, emptyCounts, minDraftCost, total, spent, units: U,
  PVP_PROTOCOL, GAME_VERSION, RULES_VERSION, TURRET, DAMAGE_SCALE,
};
