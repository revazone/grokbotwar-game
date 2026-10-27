// Per-bot lessons: bounded Play Loop tunables the agent sets with tools/lesson.js (optional replay judge: tools/improve.js). The Play Loop reads them at every match start.
// File: $GBW_LESSONS or state/lessons.json (gitignored, one per bot). Missing file or key = default = the shipped behavior. Every value is clamped to [min, max].
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const TUNABLES = {
  medicByT:      { def: 0,  min: 0,  max: 120, step: 30, why: 'opening medic on the field by this T (0 = off)' },
  rifleRepMin:   { def: 0,  min: 0,  max: 6,   step: 1,  why: 'max rifle buys per 60 s (0 = no limit)' },
  pushMargin:    { def: 2,  min: 0,  max: 4,   step: 1,  why: 'push a zone when ahead and our units exceed theirs by this many' },
  tankHotWindow: { def: 60, min: 30, max: 120, step: 30, why: 'tank floor pauses after 2 tank deaths inside this many seconds' },
  spendGuardCR:  { def: 40, min: 30, max: 80,  step: 10, why: 'never sit on this many CR with a free field slot' },
  // per-unit caps on our own units alive (field + reserve); defaults = the shipped buy list (LIST_CAP)
  capRifle:      { def: 6,  min: 2,  max: 8,   step: 1,  why: 'max rifles alive' },
  capTank:       { def: 3,  min: 1,  max: 4,   step: 1,  why: 'max tanks alive' },
  capScoutTrios: { def: 1,  min: 0,  max: 2,   step: 1,  why: 'max scout trios alive (0 = never buy scouts)' },
  capMortar:     { def: 2,  min: 0,  max: 2,   step: 1,  why: 'max mortars alive' },
  capMedic:      { def: 2,  min: 0,  max: 3,   step: 1,  why: 'max medics alive' },
  capDronePacks: { def: 1,  min: 0,  max: 2,   step: 1,  why: 'max drone packs alive (0 = never buy drones)' },
  capMinePacks:  { def: 1,  min: 0,  max: 1,   step: 1,  why: 'max mine packs alive (0 = never buy mines; the arena caps 3 mines)' },
  mineByT:       { def: 45, min: 0,  max: 120, step: 15, why: 'one mine pack laid in the hold zone from this T, after the medic (0 = off)' },
  sdRepMin:      { def: 0,  min: 0,  max: 4,   step: 1,  why: 'max scout trio + drone pack buys per 60 s (0 = no limit)' },
  tankFloor:     { def: 2,  min: 0,  max: 3,   step: 1,  why: 'tanks the buy list tops up to first' },
};
/** Buy-list caps (own units alive) from the tunables. */
const caps = K => ({ R: K.capRifle, T: K.capTank, S: 3 * K.capScoutTrios, O: K.capMortar, M: K.capMedic, D: 3 * K.capDronePacks, L: 3 * K.capMinePacks });
const file = () => process.env.GBW_LESSONS || path.join(ROOT, 'state', 'lessons.json');
const logFile = () => process.env.GBW_LESSONS_LOG || path.join(path.dirname(file()), 'lessons.log');
const clamp = (k, v) => { const t = TUNABLES[k]; v = Math.round(+v); if (!Number.isFinite(v)) return t.def; return Math.min(t.max, Math.max(t.min, v)); };
function defaults() { const o = {}; for (const k in TUNABLES) o[k] = TUNABLES[k].def; return o; }
function normalize(o) { const d = defaults(); for (const k in TUNABLES) if (o && o[k] !== undefined) d[k] = clamp(k, o[k]); return d; }
function load(f = file()) { try { return normalize(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { return defaults(); } }
function save(v, f = file()) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(normalize(v), null, 1) + '\n'); }
module.exports = { caps, TUNABLES, defaults, normalize, load, save, clamp, file, logFile };
