'use strict';
// Field hospitals (docs/FIELD-HOSPITAL.md). Off unless FIELD_HOSPITAL=1 (version.fieldHospital).
// One building per side. Numbers here are the design calls; the match sim applies them.

const { FIELD_W, FIELD_H, ZONES } = require('./constants');
const RULES = require('./rules'); // economy.csv (hospital_* keys); applyRules() refreshes the live numbers at a match boot

const HP = RULES.value('hospital_hp');
const ARMOR = RULES.value('hospital_armor'); // soft target: incoming damage (after DAMAGE_SCALE) lands in full
const HEAL = RULES.value('hospital_heal'); // HP per second for each unit in a slot
const HEAL_TO = RULES.value('hospital_heal_to'); // leave at this share of max HP and go back to the fight
const SLOTS = RULES.value('hospital_slots');
const RETREAT = RULES.value('hospital_retreat'); // at or below this share of max HP, a ground unit walks here on its own
const QUIET = RULES.value('hospital_quiet_s'); // seconds since the last hit, and no enemy inside weapon range, before a retreat starts
const REBUILD = RULES.value('hospital_rebuild_s'); // seconds down before it can be bought back
const COST = RULES.value('hospital_rebuild_cr'); // credits to rebuild, paid when the timer ends; waits if the bank is short
const R = 16; // hull radius, px (drawing and splash reach; no collision)
const PAD = 22; // px from the center that counts as arrived
// Front columns, opposite lanes. Green z4 (zone 3) in the top lane, Ember z5 (zone 4) in the
// bottom lane, mirrored across the midline and across y = FIELD_H / 2. y=42 and y=338 are inside
// the owner's bands (40–60 and 320–340) and stay clear of every wall layout, including the padding
// place() checks. The hull stays inside the zone. A blocked cell snaps inside the same zone and
// the same lane, not back toward the center line.
const NOMINAL = [
  { zone: 3, x: 350, y: 42 },
  { zone: 4, x: 450, y: 338 },
];

/**
 * A walkable point in the nominal zone, still in that side's lane. `blocked(x, y)` is the match's wall test.
 * Stays in the zone when it can; otherwise the nominal point (the walker paths around the wall).
 */
function place(side, blocked) {
  const nom = NOMINAL[side] || NOMINAL[0];
  const zw = FIELD_W / ZONES;
  if (!blocked(nom.x, nom.y)) return { zone: nom.zone, x: nom.x, y: nom.y };
  const lo = nom.zone * zw + 20;
  const hi = (nom.zone + 1) * zw - 20;
  const top = nom.y < FIELD_H / 2;
  const yLo = top ? 36 : 316;
  const yHi = top ? 64 : Math.min(FIELD_H - 28, 352);
  for (let rad = 8; rad <= 72; rad += 8) {
    for (let a = 0; a < 16; a++) {
      const x = Math.max(lo, Math.min(hi, nom.x + Math.cos(a / 16 * Math.PI * 2) * rad));
      const y = Math.max(yLo, Math.min(yHi, nom.y + Math.sin(a / 16 * Math.PI * 2) * rad * 0.6));
      if (Math.floor(x / zw) !== nom.zone) continue;
      if (top ? y > 64 : y < 316) continue;
      if (!blocked(x, y)) return { zone: nom.zone, x, y };
    }
  }
  return { zone: nom.zone, x: nom.x, y: nom.y };
}

let appliedSig = RULES.signature();
const api = { HP, ARMOR, HEAL, HEAL_TO, SLOTS, RETREAT, QUIET, REBUILD, COST, R, PAD, NOMINAL, place, applyRules };
/** Re-read the hospital numbers from the ruleset (at a match boot; only when a number changed). Consumers read HH.HP etc. at use time. */
function applyRules() {
  const sig = RULES.signature();
  if (sig === appliedSig) return false;
  appliedSig = sig;
  api.HP = RULES.value('hospital_hp'); api.ARMOR = RULES.value('hospital_armor'); api.HEAL = RULES.value('hospital_heal');
  api.HEAL_TO = RULES.value('hospital_heal_to'); api.SLOTS = RULES.value('hospital_slots'); api.RETREAT = RULES.value('hospital_retreat');
  api.QUIET = RULES.value('hospital_quiet_s'); api.REBUILD = RULES.value('hospital_rebuild_s'); api.COST = RULES.value('hospital_rebuild_cr');
  return true;
}

module.exports = api;
