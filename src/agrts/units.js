'use strict';
// Unit table, read from units.csv at run time (repo root, or the path in UNITS_CSV).
// docs/SPEC.md "Unit table (units.csv)" lists the columns.
//
// The table is process-wide and is swapped in place, so modules that hold TYPES, TYPE_IDS,
// FIELD_COST, CODE_BY_TYPE or TYPE_BY_CODE always see the current rows. reload() is called
// by the match at the start of every match (AgrtsMatch._boot), never mid-match, so an edit
// takes effect on the next match with no server restart. A bad file is rejected as a whole:
// the last good table stays, and the error is logged once per bad version of the file.

const fs = require('fs');
const path = require('path');
const LOCK = require('./units-lock');
const RULES = require('./rules');
const { parseCsv } = require('./csv');

const ROLES = ['fast', 'ranged', 'armor', 'healer', 'kamikaze', 'mortar', 'mine'];   // mine: docs/MINES.md (static, hidden, never in match.units)
const SHAPES = ['arrow', 'diamond', 'hex', 'disc', 'circle', 'cross', 'tube'];
const COLUMNS = ['id', 'code', 'name', 'draft_cost', 'live_cost', 'hp', 'damage', 'range', 'speed', 'cooldown_s',
  'radius', 'color', 'glyph', 'description', 'heal', 'heal_range', 'role', 'shape'];
// Optional columns. A file without them, or a blank cell, gets the default, so a row that leaves
// them blank plays exactly as before they existed. docs/SPEC.md §5.4 explains each one.
//   splash_radius     px, blast radius of a kamikaze hit (0 = no splash)
//   splash_falloff    0..1, share of the center damage lost at the edge of the blast
//   base_mult         0..1, damage multiplier against a base (1 = full)
//   friendly_fire     yes/no (1/0), the blast also hurts our own units
//   death_blast_mult  0..1, blast size and damage when it is shot down (0 = no blast)
//   flying            yes/no, ignores walls and rough ground, never captures or contests a zone
//   max_alive         per side, on the field plus in reserve (0 = no cap)
//   max_per_buy       how many one orders post may buy (0 = no cap)
//   buy_cooldown_s    match seconds between posts that buy this unit (0 = none)
//   bonus_vs          CODE:mult[;CODE:mult], damage multiplier against those codes; a unit with
//                     a bonus also treats those targets as that much closer when it picks one
//   blast_resist      0..1, share of splash damage this unit ignores
//   plane             ground, air, or any other lowercase word: the layer the unit moves in. Units
//                     are solid (a circle of their radius) only to units on the same plane, so an
//                     air unit passes over every ground unit. Blank = air when flying, else ground.
//   min_range         px. The gun cannot fire at anything closer than this (0 = no dead zone).
//   indirect          yes/no. The shot ignores walls (line of sight). Blank = no.
//   support           CR this unit costs its side every income tick while it is on the field (upkeep,
//                     about 4% of live_cost). The bank floors at 0. Blank = 0.
//   spawn_count       units one buy fields (one price; max_alive still counts each one, a pack spawns as many as fit). Blank = 1.
//                     Drones keep their own pack (DRONE_PACK).
const OPTIONAL = ['splash_radius', 'splash_falloff', 'base_mult', 'friendly_fire', 'death_blast_mult', 'flying',
  'max_alive', 'max_per_buy', 'buy_cooldown_s', 'bonus_vs', 'blast_resist', 'plane', 'min_range', 'indirect', 'support', 'spawn_count'];
const DEFAULTS = Object.freeze({ splash: 0, falloff: 0, baseMult: 1, friendlyFire: false, deathBlast: 0, flying: false,
  maxAlive: 0, maxPerBuy: 0, buyCooldown: 0, bonusVs: Object.freeze({}), blastResist: 0, plane: 'ground',
  minRange: 0, indirect: false, support: 0, spawnCount: 1 });
const MAX_UNITS = 26;

// Used only when the file is missing or bad at startup. Same numbers as units.csv in the repo.
const BUILTIN = [
  { id: 'scout', code: 'S', name: 'Scout', cost: 12, live: 28, hp: 25, dmg: 5, range: 38, speed: 37, cool: 0.9, r: 9, color: '#bafc82', glyph: '›', desc: 'Fast, cheap, quick to field.', heal: 0, healRange: 0, role: 'fast', shape: 'arrow' },
  { id: 'rifle', code: 'R', name: 'Rifle', cost: 20, live: 40, hp: 40, dmg: 8, range: 100, speed: 23, cool: 1.25, r: 11, color: '#8ee5c1', glyph: '✦', desc: 'Reliable ranged support.', heal: 0, healRange: 0, role: 'ranged', shape: 'diamond' },
  { id: 'tank', code: 'T', name: 'Breaker', cost: 34, live: 52, hp: 92, dmg: 18, range: 40, speed: 14, cool: 1.9, r: 14, color: '#efbd68', glyph: '⬟', desc: 'Slow armor, heavy base damage.', heal: 0, healRange: 0, role: 'armor', shape: 'hex' },
  { id: 'medic', code: 'M', name: 'Medic', cost: 24, live: 36, hp: 34, dmg: 3, range: 58, speed: 24, cool: 1.4, r: 10, color: '#a9c7ff', glyph: '+', desc: 'Light support with staying power.', heal: 6, healRange: 42, role: 'healer', shape: 'disc' },
].map(u => ({ ...DEFAULTS, ...u }));

// Live objects. Never reassigned; reload() clears and refills them.
const TYPES = {};
const TYPE_IDS = [];
const FIELD_COST = {};
const CODE_BY_TYPE = {};
const TYPE_BY_CODE = {};

const status = { path: '', rules: '', source: 'builtin', loadedAt: null, error: '', version: 0, text: null, badText: null };
let logger = msg => console.log(msg);
// Locked unit table (src/agrts/units-lock.js): is the table in play the official one? Checked at
// every reload, on the text actually installed (the last good file), never changes play.
let lock = { mode: 'warn', hash: '', official: false, pvp: true, error: '' };
let lockWarned = '';
function checkLock() {
  lock = LOCK.check(status.source === 'builtin' ? null : status.text);
  // A table that came from the published ruleset (rules.js) passed validation there: it is the official table
  // by definition, even when it differs from the bundled units.lock.json. rules.js logs the old and new hash once.
  if (status.rules && lock.hash && lock.official === false) { lock = { ...lock, official: true, pvp: true, error: '' }; lockWarned = ''; return; }
  if (lock.official !== false) { lockWarned = ''; return; }
  const key = `${lock.mode}:${lock.hash}:${lock.error}`;
  if (key === lockWarned) return;
  lockWarned = key;
  const what = lock.hash ? `sha256 ${lock.hash.slice(0, 12)}` : 'built-in table';
  const why = lock.error && lock.hash ? `; ${lock.error}` : '';
  const then = lock.mode === 'enforce' ? 'local play continues, PvP refused' : 'playing it anyway';
  logger(`[units] warning: unit table is not the official one (${what}${why}); ${then} (UNITS_LOCK=${lock.mode}, docs/SPEC.md 5.4)`);
}

function csvPath() {
  return path.resolve(process.env.UNITS_CSV || path.join(__dirname, '..', '..', 'units.csv'));
}

/** Parse and validate the whole file. Throws one Error naming the line and column on the first problem. */
function parseUnits(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('file is empty');
  const header = rows[0].cells.map(c => c.trim().toLowerCase());
  const missing = COLUMNS.filter(c => !header.includes(c));
  if (missing.length) throw new Error(`header is missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
  const dup = header.find((c, i) => c && header.indexOf(c) !== i);
  const unknown = header.find(c => c && !COLUMNS.includes(c) && !OPTIONAL.includes(c));
  if (unknown) throw new Error(`header has an unknown column: ${unknown} (optional columns: ${OPTIONAL.join(', ')})`);
  if (dup) throw new Error(`header lists ${dup} twice`);
  const body = rows.slice(1);
  if (!body.length) throw new Error('no unit rows');
  if (body.length > MAX_UNITS) throw new Error(`at most ${MAX_UNITS} units (one per code letter)`);
  const out = [];
  const ids = new Map(), codes = new Map();
  for (const row of body) {
    const at = `line ${row.line}`;
    const get = c => (header.indexOf(c) < 0 ? '' : String(row.cells[header.indexOf(c)] == null ? '' : row.cells[header.indexOf(c)]).trim());
    const num = (c, { min = 0, gt = false, int = false, blank0 = false, blank, max } = {}) => {
      const raw = get(c);
      if (raw === '' && blank !== undefined) return blank;
      if (raw === '' && blank0) return 0;
      const n = Number(raw);
      if (raw === '' || !Number.isFinite(n)) throw new Error(`${at}: ${c} must be a number (got "${raw}")`);
      if (int && !Number.isInteger(n)) throw new Error(`${at}: ${c} must be a whole number (got ${raw})`);
      if (gt ? !(n > min) : !(n >= min)) throw new Error(`${at}: ${c} must be ${gt ? 'more than' : 'at least'} ${min} (got ${raw})`);
      if (max != null && n > max) throw new Error(`${at}: ${c} must be ${max} or less (got ${raw})`);
      return n;
    };
    const flag = c => {
      const raw = get(c).toLowerCase();
      if (raw === '' || raw === '0' || raw === 'no' || raw === 'false') return false;
      if (raw === '1' || raw === 'yes' || raw === 'true') return true;
      throw new Error(`${at}: ${c} must be yes or no (got "${get(c)}")`);
    };
    const id = get('id');
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(id)) throw new Error(`${at}: id must be lowercase letters, digits or _, starting with a letter (got "${id}")`);
    if (ids.has(id)) throw new Error(`${at}: id ${id} is already used on line ${ids.get(id)}`);
    ids.set(id, row.line);
    const code = get('code').toUpperCase();
    if (!/^[A-Z]$/.test(code)) throw new Error(`${at}: code must be one letter A-Z (got "${get('code')}")`);
    if (codes.has(code)) throw new Error(`${at}: code ${code} is already used by ${codes.get(code)}`);
    codes.set(code, id);
    const name = get('name');
    if (!name || name.length > 24) throw new Error(`${at}: name must be 1 to 24 characters`);
    const role = get('role').toLowerCase();
    if (!ROLES.includes(role)) throw new Error(`${at}: role must be one of ${ROLES.join(', ')} (got "${get('role')}")`);
    const shape = get('shape').toLowerCase() || 'circle';
    if (!SHAPES.includes(shape)) throw new Error(`${at}: shape must be one of ${SHAPES.join(', ')} (got "${get('shape')}")`);
    const color = get('color');
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error(`${at}: color must look like #a1b2c3 (got "${color}")`);
    const glyph = get('glyph');
    if (!glyph || [...glyph].length > 2) throw new Error(`${at}: glyph must be 1 or 2 characters`);
    const unit = {
      id, code, name, role, shape, color, glyph,
      cost: num('draft_cost', { min: 1, int: true }),
      live: num('live_cost', { min: 1, int: true }),
      hp: num('hp', { min: 0, gt: true }),
      dmg: num('damage'),
      range: num('range', { min: 0, gt: true }),
      speed: num('speed'),
      // A kamikaze unit never fires (it explodes), so its cooldown may be 0.
      cool: num('cooldown_s', { min: 0, gt: role !== 'kamikaze' }),
      r: num('radius', { min: 0, gt: true }),
      desc: get('description'),
      heal: num('heal', { blank0: true }),
      healRange: num('heal_range', { blank0: true }),
      splash: num('splash_radius', { blank: DEFAULTS.splash, max: 200 }),
      falloff: num('splash_falloff', { blank: DEFAULTS.falloff, max: 1 }),
      baseMult: num('base_mult', { blank: DEFAULTS.baseMult, max: 10 }),
      friendlyFire: flag('friendly_fire'),
      deathBlast: num('death_blast_mult', { blank: DEFAULTS.deathBlast, max: 1 }),
      flying: flag('flying'),
      maxAlive: num('max_alive', { blank: DEFAULTS.maxAlive, int: true, max: 24 }),
      maxPerBuy: num('max_per_buy', { blank: DEFAULTS.maxPerBuy, int: true, max: 24 }),
      buyCooldown: num('buy_cooldown_s', { blank: DEFAULTS.buyCooldown, max: 600 }),
      bonusVs: {},
      blastResist: num('blast_resist', { blank: DEFAULTS.blastResist, max: 1 }),
      plane: '',
      minRange: num('min_range', { blank: DEFAULTS.minRange, max: 400 }),
      indirect: flag('indirect'),
      support: num('support', { blank: DEFAULTS.support, int: true, max: 50 }),
      spawnCount: num('spawn_count', { blank: DEFAULTS.spawnCount, int: true, max: 6 }),
    };
    const plane = get('plane').toLowerCase();
    if (plane && !/^[a-z]{1,12}$/.test(plane)) throw new Error(`${at}: plane must be one lowercase word such as ground or air (got "${get('plane')}")`);
    unit.plane = plane || (unit.flying ? 'air' : 'ground');
    const bonus = get('bonus_vs');
    if (bonus) {
      for (const part of bonus.split(/[;\s]+/).filter(Boolean)) {
        const m = /^([A-Za-z]):(\d+(?:\.\d+)?)$/.exec(part);
        if (!m || !(+m[2] > 0) || +m[2] > 10) throw new Error(`${at}: bonus_vs must look like D:1.5 or D:1.5;S:1.2 (got "${bonus}")`);
        unit.bonusVs[m[1].toUpperCase()] = +m[2];
      }
    }
    if (role === 'kamikaze' && !(unit.dmg > 0)) throw new Error(`${at}: a kamikaze unit needs damage above 0 (its blast)`);
    if (role === 'mortar') {
      if (!(unit.minRange > 0)) throw new Error(`${at}: a mortar needs min_range above 0`);
      if (!(unit.minRange < unit.range)) throw new Error(`${at}: min_range must be inside range`);
      if (!(unit.splash > 0)) throw new Error(`${at}: a mortar needs splash_radius above 0`);
      if (!unit.indirect) throw new Error(`${at}: a mortar fires indirectly (indirect yes)`);
    }
    if (unit.r > 30) throw new Error(`${at}: radius must be 30 or less`);
    if (role === 'healer' && !(unit.heal > 0 && unit.healRange > 0)) throw new Error(`${at}: a healer needs heal and heal_range above 0`);
    if (role !== 'healer' && (unit.heal > 0 || unit.healRange > 0)) throw new Error(`${at}: heal and heal_range only work with role healer; set them to 0`);
    out.push(unit);
  }
  // bonus_vs names codes, which are only all known once every row is read.
  for (const u of out) {
    for (const c of Object.keys(u.bonusVs)) {
      if (!codes.has(c)) throw new Error(`${u.id}: bonus_vs names code ${c}, which no unit uses`);
    }
  }
  return out;
}

function install(list, source) {
  for (const k of Object.keys(TYPES)) delete TYPES[k];
  for (const k of Object.keys(FIELD_COST)) delete FIELD_COST[k];
  for (const k of Object.keys(CODE_BY_TYPE)) delete CODE_BY_TYPE[k];
  for (const k of Object.keys(TYPE_BY_CODE)) delete TYPE_BY_CODE[k];
  TYPE_IDS.length = 0;
  for (const u of list) {
    // Field names match the old hardcoded table, so the sim code reads TYPES[k].cost / .dmg / .cool / .r as before.
    TYPES[u.id] = {
      name: u.name, glyph: u.glyph, cost: u.cost, hp: u.hp, dmg: u.dmg, range: u.range, speed: u.speed, cool: u.cool,
      r: u.r, color: u.color, desc: u.desc, code: u.code, live: u.live, heal: u.heal, healRange: u.healRange,
      role: u.role, shape: u.shape,
      splash: u.splash, falloff: u.falloff, baseMult: u.baseMult, friendlyFire: !!u.friendlyFire, deathBlast: u.deathBlast,
      flying: !!u.flying, maxAlive: u.maxAlive, maxPerBuy: u.maxPerBuy, buyCooldown: u.buyCooldown,
      bonusVs: { ...(u.bonusVs || {}) }, blastResist: u.blastResist,
      plane: u.plane || (u.flying ? 'air' : 'ground'),
      minRange: u.minRange || 0, indirect: !!u.indirect, support: u.support || 0, spawnCount: u.spawnCount || 1,
    };
    TYPE_IDS.push(u.id);
    FIELD_COST[u.id] = u.live;
    CODE_BY_TYPE[u.id] = u.code;
    TYPE_BY_CODE[u.code] = u.id;
  }
  status.source = source;
  status.loadedAt = new Date().toISOString();
  status.version++;
}

/**
 * Re-read units.csv. Unchanged text is a no-op. A good file replaces the table; a bad one is
 * logged (once per bad text) and the current table stays. Returns { changed, error }.
 * Only call this between matches.
 */
function reload() {
  // A downloaded ruleset (rules.js: remote or cache) supplies the text; otherwise the local file, as before.
  RULES.boot();
  const supplied = RULES.activeUnitsText();
  status.rules = supplied != null ? RULES.status().source : '';
  const file = supplied != null ? `rules:${status.rules}` : csvPath();
  status.path = file;
  let text;
  try { if (supplied != null) text = supplied; else text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    const msg = `cannot read ${file}: ${e.code || e.message}`;
    if (status.error !== msg) logger(`[units] ${msg}; keeping the current table (${TYPE_IDS.join(', ')})`);
    status.error = msg;
    checkLock();
    return { changed: false, error: msg };
  }
  if (text === status.text) { checkLock(); return { changed: false, error: '' }; }
  if (text === status.badText) { checkLock(); return { changed: false, error: status.error }; }
  let list;
  try { list = parseUnits(text); }
  catch (e) {
    status.badText = text;
    status.error = `${path.basename(file)} rejected: ${e.message}`;
    logger(`[units] ${status.error}. Keeping the last good table (${TYPE_IDS.join(', ')}).`);
    checkLock();
    return { changed: false, error: status.error };
  }
  const before = JSON.stringify(TYPE_IDS.map(k => TYPES[k]));
  install(list, file);
  status.text = text; status.badText = null; status.error = '';
  const changed = before !== JSON.stringify(TYPE_IDS.map(k => TYPES[k]));
  if (changed && status.version > 1) logger(`[units] loaded ${TYPE_IDS.length} units from ${file}: ${TYPE_IDS.map(k => `${k}(${CODE_BY_TYPE[k]})`).join(' ')}`);
  checkLock();
  return { changed, error: '' };
}

/** Viewer copy: what a watch page needs to draw and label a unit. Sent in every state frame. */
function viewerTable() {
  return TYPE_IDS.map(k => {
    const t = TYPES[k];
    return { type: k, code: t.code, name: t.name, role: t.role, shape: t.shape, color: t.color, glyph: t.glyph, r: t.r, flying: !!t.flying };
  });
}

/** Types with that role, in table order. */
function idsWithRole(role) { return TYPE_IDS.filter(k => TYPES[k].role === role); }
function roleOf(type) { return TYPES[type] ? TYPES[type].role : ''; }
function isHealer(type) { return roleOf(type) === 'healer'; }
function isKamikaze(type) { return roleOf(type) === 'kamikaze'; }
function isMine(type) { return roleOf(type) === 'mine'; }
function isFlying(type) { return !!(TYPES[type] && TYPES[type].flying); }
/** The unit's collision plane (units.csv plane): units only bump into units on the same plane. */
function planeOf(type) { return TYPES[type] ? TYPES[type].plane : 'ground'; }
/** Report code for healers (the `E +1M` delta). The first healer's code, M today. */
function healerCode() { const k = idsWithRole('healer')[0]; return k ? CODE_BY_TYPE[k] : 'M'; }

function setLogger(fn) { logger = typeof fn === 'function' ? fn : logger; }

/** Locked-table check for the table in play: { hash, official, mode, pvp }. healthz and the relay frame show it. */
function lockStatus() { return { hash: lock.hash, official: lock.official, mode: lock.mode, pvp: lock.pvp }; }

install(BUILTIN, 'builtin');
status.version = 0;
reload();
if (status.error) logger(`[units] using the built-in table until units.csv loads`);

module.exports = {
  isMine, TYPES, TYPE_IDS, FIELD_COST, CODE_BY_TYPE, TYPE_BY_CODE, ROLES, SHAPES, COLUMNS, OPTIONAL, DEFAULTS, BUILTIN,
  reload, lockStatus, parseUnits, parseCsv, viewerTable, idsWithRole, roleOf, isHealer, isKamikaze, isFlying, planeOf, healerCode, csvPath, setLogger,
  status: () => ({ path: status.path, source: status.source, loadedAt: status.loadedAt, error: status.error, ids: TYPE_IDS.slice(), lock: { ...lock } }),
};
