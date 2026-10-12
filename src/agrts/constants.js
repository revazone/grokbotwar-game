'use strict';
// Iteration 11 field and match constants. Shared by the match sim and the team-decision hooks.
// Unit movement, targeting, attacking and healing use these numbers; they are not team decisions.

// Unit types come from units.csv (src/agrts/units.js), re-read at the start of every match.
// TYPES, TYPE_IDS and FIELD_COST are live objects: they are refilled in place, never reassigned.
const U = require('./units');
const { TYPES, TYPE_IDS, FIELD_COST } = U;
// Matchmaking protocol version (PvP). Defined in version.js, the single source of truth for versions.
const { PVP_PROTOCOL, GAME_VERSION } = require('./version');
const DRAFT_BUDGET = 200;
const ROSTER_LIMIT = 24;
const MAX_BUYS = 6;
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
const ZONE_INCOME = 12;
const INCOME_TICK_S = 4.167;
const BASE_INCOME = envNumber('BASE_INCOME', 4);
// Active units per side on the field (drones included). More stay in reserve; DEPLOY fields up to
// the cap and a lost unit frees a slot. Deploying from reserve is free. Env ACTIVE_CAP; 0 = no cap.
const ACTIVE_CAP = Math.floor(envNumber('ACTIVE_CAP', 6));
const FIELD_W = 800;
const FIELD_H = 380;
const MATCH_CAP = 480; // sim seconds; then the base with more HP wins
const STEP = 0.05;
const SPEED = 1.2;
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

module.exports = {
  TYPES, TYPE_IDS, FIELD_COST, DRAFT_BUDGET, ROSTER_LIMIT, MAX_BUYS,
  ZONE_INCOME, INCOME_TICK_S, BASE_INCOME, ACTIVE_CAP, envNumber,
  FIELD_W, FIELD_H, MATCH_CAP, STEP, SPEED, STYLES, OPENING_STYLES, TEAM,
  ZONES, ASSIST_RADIUS_DEFAULT, ASSIST_RADIUS_ORDER, zoneOf,
  mulberry32, cloneCounts, emptyCounts, minDraftCost, total, spent, units: U,
  PVP_PROTOCOL, GAME_VERSION,
};
