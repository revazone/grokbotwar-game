'use strict';
// Remote rules (docs/RULES-REMOTE.md). The two rules files, units.csv and economy.csv, can be published on the
// public repo (branch `rules`) and are downloaded by the arena before a match, so tuning a number is a repo edit
// and not a new release of the game.
//
// What lives here:
//   KEYS            every number economy.csv may set: default (today's behaviour), sane range, and the old env
//                   variable that still overrides it. The defaults are the numbers the code always had.
//   env()           a view of process.env where each mapped variable falls back to the CSV value instead of undefined.
//                   Code that used to read `process.env.X` with a built-in default reads this and gets: env, else the
//                   ruleset's value. An env variable that is set always wins.
//   boot()          called at every match boot (sync): re-reads the bundled files when they are the source.
//   refresh()       async, called by the arena at start and around match boundaries: download, validate, cache.
//   activeUnitsText()   the units.csv text a downloaded ruleset supplies (null = use the local file as before).
// Order of trust: the VPS relay (vps) -> the public GitHub rules branch (github) -> last good download (cache) -> bundled
// files (local). An explicit RULES_URL replaces the first two with that one URL (source 'remote'). Never throws, never
// blocks a match: every failure ends in the next source down and a log line.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const LOCK = require('./units-lock'); // normalize + hash only
const { parseCsv } = require('./csv');

const ROOT = path.join(__dirname, '..', '..');
const TIMEOUT_MS = 5000;
const MAX_BYTES = 256 * 1024;
const DEFAULT_REF = 'rules';
// The public repo is the published game, revazone/grokbotwar-game (the dev repo revazone/grokbotwar is private: raw.githubusercontent.com answers 404 for it).
const DEFAULT_HOST = 'https://raw.githubusercontent.com/revazone/grokbotwar-game/';
// The live relay serves the same two files under /rules/ (relay/rules/, docs/RULES-REMOTE.md). It is tried before GitHub.
const DEFAULT_VPS = 'https://gbw.srv826418.hstgr.cloud';

// key, default (today's number), min, max, env (the existing override, or null), int
// A key with no env cannot be overridden from the environment; it is a CSV (or code) number only.
const K = (key, def, min, max, env = null, int = false) => ({ key, def, min, max, env, int });
const KEYS = [
  // economy
  K('base_income', 15, 0, 500, 'BASE_INCOME'),
  K('zone_income', 0, 0, 500, 'ZONE_INCOME'),
  K('income_tick_s', 3, 0.5, 60, 'INCOME_TICK_S'),
  K('zone_capture_cr', 0, 0, 1000, 'ZONE_CAPTURE_CR'),
  K('buy_cap', 0, 0, 99, 'BUY_CAP', true),
  K('active_cap', 6, 0, 24, 'ACTIVE_CAP', true),
  K('reserve_cap', 0, 0, 24, 'RESERVE_CAP', true),
  K('damage_scale', 0.7, 0.05, 5, 'DAMAGE_SCALE'),
  K('territory_cap', 3, 0, 8, 'TERRITORY_CAP', true),
  K('territory_diminish', 1, 0.05, 1, 'TERRITORY_DIMINISH'),
  K('catchup_income', 0, 0, 100, 'CATCHUP_INCOME'),
  K('breaker_discount', 0, 0, 0.95, 'BREAKER_DISCOUNT'),
  K('bank_decay', 0, 0, 1, 'BANK_DECAY'),
  // match end
  K('time_limit_s', 360, 30, 3600, 'TIME_LIMIT_S'),
  K('match_cap_s', 480, 30, 3600),
  // base turret
  K('turret_hp', 120, 0, 5000, 'TURRET_HP'),
  K('turret_range', 110, 20, 400),
  K('turret_dmg', 10, 0, 500),
  K('turret_cool', 1, 0.1, 30),
  K('turret_first_shot', 0.5, 0, 10),
  // team HP
  K('team_hp_floor', 20, 0, 100, 'TEAM_HP_FLOOR'),
  // Team HP as a pool (range, launch flow): starting HP and how much Team HP one point of damage to a structure costs its owner (docs/TEAM-HP.md)
  K('team_hp', 100, 10, 1000), K('no_clock', 0, 0, 1, 'NO_CLOCK'), K('draft_carry', 1, 0, 1, 'DRAFT_CARRY'),
  K('hp_per_dmg_base', 1, 0, 10, 'HP_PER_DMG_BASE'), K('hp_per_dmg_turret', 0.1, 0, 10, 'HP_PER_DMG_TURRET'), K('hp_per_dmg_gun', 0.08, 0, 10, 'HP_PER_DMG_GUN'),
  K('hp_per_dmg_hospital', 0.07, 0, 10, 'HP_PER_DMG_HOSPITAL'), K('hp_per_dmg_depot', 0.125, 0, 10, 'HP_PER_DMG_DEPOT'),
  // forward post (range launch flow, docs/FORWARD-POST.md)
  K('post_on', 1, 0, 1, 'POST_ON'), K('post_a_zone', 2, 1, 4, null, true), K('post_b_zone', 4, 1, 4, null, true), K('post_build_s', 12, 0, 120), K('post_unlock_offset', 1, 0, 3), K('post_hp', 100, 1, 5000),
  K('post_rebuild_s', 20, 0, 600), K('spawn_safe_radius', 160, 0, 2000), K('spawn_safe_hit_s', 3, 0, 60), K('scout_capture_mult', 2, 1, 10), K('scout_post_build_s', 6, 0, 120), K('scout_dive_range', 260, 0, 2000), K('hp_per_dmg_post', 0.08, 0, 10, 'HP_PER_DMG_POST'),
  K('comeback_below', 40, 0, 100, 'COMEBACK_BELOW'),
  K('comeback_mult', 0.5, 0, 1, 'COMEBACK_MULT'),
  K('zone_loss_hp', 1, 0, 10, 'ZONE_LOSS_HP'),
  K('zone_hold_s', 10, 0, 120, 'ZONE_HOLD_S'),
  K('zone_loss_cooldown_s', 30, 0, 300, 'ZONE_LOSS_COOLDOWN_S'),
  K('siege_drain', 0.1, 0, 5, 'SIEGE_DRAIN'),
  K('siege_max', 0.2, 0, 5, 'SIEGE_MAX'),
  K('zone_weight_1', 5, 0, 50), K('zone_weight_2', 4, 0, 50), K('zone_weight_3', 3, 0, 50), K('zone_weight_4', 2, 0, 50),
  K('zone_weight_5', 2, 0, 50), K('zone_weight_6', 1, 0, 50), K('zone_weight_7', 1, 0, 50), K('zone_weight_8', 1, 0, 50),
  // tie-break points per tower taken
  K('points_gun', 2, 0, 20), K('points_hospital', 1, 0, 20), K('points_depot', 3, 0, 20),
  // field hospital
  K('hospital_hp', 120, 1, 5000),
  K('hospital_armor', 0, 0, 0.95),
  K('hospital_heal', 14, 0, 200),
  K('hospital_heal_to', 0.8, 0.1, 1),
  K('hospital_slots', 2, 0, 10, null, true),
  K('hospital_retreat', 0.4, 0, 1),
  K('hospital_quiet_s', 3, 0, 60),
  K('hospital_rebuild_s', 60, 0, 600),
  K('hospital_rebuild_cr', 40, 0, 1000),
  K('hospital_regen_s', 15, 0, 600, 'HOSP_REGEN_S'),
  K('hospital_regen_min', 50, 0, 100, 'HOSP_REGEN_MIN'),
  K('hospital_regen_max', 90, 0, 100, 'HOSP_REGEN_MAX'),
  K('hospital_hp_cost', 0, 0, 100, 'HOSP_HP_COST'),
  K('hospital_cr_bonus', 20, 0, 1000, 'HOSP_CR_BONUS'),
  // gun tower
  K('gun_hp', 100, 1, 5000, 'GUN_HP'),
  K('gun_dmg', 6, 0, 500, 'GUN_DMG'),
  K('gun_cool', 1, 0.1, 30, 'GUN_COOL'),
  K('gun_range', 105, 20, 400, 'GUN_RANGE'),
  K('gun_hp_cost', 0, 0, 100, 'GUN_HP_COST'),
  K('gun_cr_bonus', 25, 0, 1000, 'GUN_CR_BONUS'),
  // depot
  K('depot_hp', 160, 1, 5000, 'DEPOT_HP'),
  K('depot_shield', 0.6, 0.05, 1, 'DEPOT_SHIELD'),
  K('depot_rebuild_s', 60, 0, 600, 'DEPOT_REBUILD_S'),
  K('depot_rebuild_cr', 40, 0, 1000, 'DEPOT_REBUILD_CR'),
  K('depot_hp_cost', 0, 0, 100, 'DEPOT_HP_COST'),
  K('depot_cr_bonus', 40, 0, 1000, 'DEPOT_CR_BONUS'),
  K('depot_income', 0, 0, 500, 'DEPOT_INCOME'),
  // BUY RANGE prototype (docs/BUY-RANGE.md): a range boost counted in rounds. range_buy 0 = off (the order is `unknown unit RANGE`).
  K('range_buy', 0, 0, 1, 'BUY_RANGE', true),
  K('range_buy_cr', 60, 0, 1000, 'RANGE_BUY_CR'),
  K('range_buy_pct', 40, 0, 300, 'RANGE_BUY_PCT'),
  K('range_buy_s', 30, 1, 300, 'RANGE_BUY_S'),
  K('range_buy_rounds_gun', 0, 0, 500, 'RANGE_BUY_ROUNDS_GUN', true),
  K('range_buy_rounds_turret', 0, 0, 500, 'RANGE_BUY_ROUNDS_TURRET', true),
  K('range_buy_cool_s', 0, 0, 300, 'RANGE_BUY_COOL_S'),
  K('range_buy_max', 3, 0, 20, 'RANGE_BUY_MAX', true),
];
const BY_KEY = Object.fromEntries(KEYS.map(k => [k.key, k]));
const BY_ENV = Object.fromEntries(KEYS.filter(k => k.env).map(k => [k.env, k]));
const DEFAULTS = Object.freeze(Object.fromEntries(KEYS.map(k => [k.key, k.def])));

let logger = msg => console.log(msg);
function setLogger(fn) { logger = typeof fn === 'function' ? fn : logger; }

// ---- paths ----
const localUnitsPath = () => path.resolve(process.env.UNITS_CSV || path.join(ROOT, 'units.csv'));
const bundledUnitsPath = () => path.join(ROOT, 'units.csv');
const localEconomyPath = () => path.resolve(process.env.ECONOMY_CSV || path.join(ROOT, 'economy.csv'));
const cacheDir = () => path.resolve(process.env.RULES_CACHE_DIR || path.join(ROOT, 'state', 'rules-cache'));
const remoteOn = () => !['0', 'off', 'false', 'no', 'none'].includes(String(process.env.RULES_REMOTE == null ? '' : process.env.RULES_REMOTE).trim().toLowerCase());
const slash = u => (u.endsWith('/') ? u : u + '/');
/** The GitHub rules-branch base (RULES_URL overrides it: then that is the only download source). */
function baseUrl() {
  let u = String(process.env.RULES_URL || '').trim();
  if (!u) {
    const ref = String(process.env.RULES_REF || '').trim() || DEFAULT_REF;
    u = DEFAULT_HOST + encodeURIComponent(ref) + '/';
  }
  return slash(u);
}
const vpsOn = () => !['0', 'off', 'false', 'no', 'none'].includes(String(process.env.RULES_VPS == null ? '' : process.env.RULES_VPS).trim().toLowerCase());
/** The relay's rules base: RULES_VPS_URL, else the arena's own RELAY_URL (http(s) only), else the default relay. Always ends in /rules/. */
function vpsBase() {
  let u = String(process.env.RULES_VPS_URL || '').trim() || String(process.env.RELAY_URL || '').trim() || DEFAULT_VPS;
  u = u.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/+$/, '');
  return u + '/rules/';
}
/** Download sources in order of trust. An explicit RULES_URL (or refresh({url})) is the only one, named 'remote'. */
function sources(opts = {}) {
  if (opts.url) return [{ name: 'remote', base: slash(opts.url) }];
  if (String(process.env.RULES_URL || '').trim()) return [{ name: 'remote', base: baseUrl() }];
  const list = [];
  if (vpsOn()) list.push({ name: 'vps', base: vpsBase(), key: String(process.env.RULES_KEY || '').trim() });
  list.push({ name: 'github', base: String(process.env.RULES_GITHUB_URL || '').trim() ? slash(String(process.env.RULES_GITHUB_URL).trim()) : baseUrl() });
  return list;
}

// ---- economy.csv ----
const ECON_HEADER = ['key', 'value', 'description'];

/** Parse and validate economy.csv text. Returns { values (every key, defaults filled), missing: [keys] }. Throws one Error. */
function parseEconomy(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('economy.csv is empty');
  const header = rows[0].cells.map(c => c.trim().toLowerCase());
  const miss = ECON_HEADER.filter(c => !header.includes(c));
  if (miss.length) throw new Error(`economy.csv header is missing column${miss.length > 1 ? 's' : ''}: ${miss.join(', ')}`);
  const ik = header.indexOf('key'), iv = header.indexOf('value');
  const values = {};
  for (const row of rows.slice(1)) {
    const at = `economy.csv line ${row.line}`;
    const key = (row.cells[ik] || '').trim();
    const raw = (row.cells[iv] == null ? '' : row.cells[iv]).trim();
    const k = BY_KEY[key];
    if (!k) throw new Error(`${at}: unknown key "${key}"`);
    if (key in values) throw new Error(`${at}: key ${key} appears twice`);
    if (raw === '' || !/^-?\d+(\.\d+)?$/.test(raw)) throw new Error(`${at}: ${key} must be a number (got "${raw}")`);
    const n = Number(raw);
    if (n < 0) throw new Error(`${at}: ${key} must not be negative (got ${raw})`);
    if (k.int && !Number.isInteger(n)) throw new Error(`${at}: ${key} must be a whole number (got ${raw})`);
    if (n < k.min || n > k.max) throw new Error(`${at}: ${key} must be between ${k.min} and ${k.max} (got ${raw})`);
    values[key] = n;
  }
  const missing = KEYS.filter(k => !(k.key in values)).map(k => k.key);
  for (const k of missing) values[k] = DEFAULTS[k];
  return { values, missing };
}

// Sane ceilings for a downloaded unit table, on top of units.js parseUnits (which checks shape, types and signs).
const UNIT_LIMITS = { draft_cost: 1000, live_cost: 1000, hp: 10000, damage: 1000, range: 2000, speed: 500, cooldown_s: 60, heal: 200, heal_range: 400 };

/**
 * Validate a downloaded units.csv: it must parse like any unit table, carry exactly the unit ids and codes of the
 * local (bundled) table, and stay inside sane ceilings. Returns nothing; throws one Error.
 */
function validateUnits(text, localText) {
  const U = require('./units');
  const list = U.parseUnits(text);
  let local = null;
  try { local = U.parseUnits(localText); } catch { /* a broken local table cannot be compared against */ }
  if (local) {
    const key = l => l.map(u => `${u.id}:${u.code}`).join(',');
    if (key(list) !== key(local)) throw new Error(`units.csv must keep the same unit ids and codes as this build (${key(local)}), got ${key(list)}`);
  }
  for (const u of list) {
    const lim = { draft_cost: u.cost, live_cost: u.live, hp: u.hp, damage: u.dmg, range: u.range, speed: u.speed, cooldown_s: u.cool, heal: u.heal, heal_range: u.healRange };
    for (const [c, v] of Object.entries(lim)) {
      if (!(v >= 0)) throw new Error(`${u.id}: ${c} must not be negative`);
      if (v > UNIT_LIMITS[c]) throw new Error(`${u.id}: ${c} ${v} is above the sane limit ${UNIT_LIMITS[c]}`);
    }
  }
}

/** Short ruleset version: first 8 hex of sha256 over both files (normalized). */
function versionOf(unitsText, econText) {
  const h = crypto.createHash('sha256');
  h.update(LOCK.normalize(unitsText || '')); h.update('\n--economy--\n'); h.update(LOCK.normalize(econText || ''));
  return h.digest('hex');
}

// ---- state ----
// current: the ruleset in play. source 'local' | 'cache' | 'remote'.
const empty = () => ({ source: 'local', values: { ...DEFAULTS }, unitsText: null, econText: null, version: '', hash: '', note: '' });
let current = empty();
let sigCache = null;
const state = { lastRefresh: null, lastError: '', lastNotice: '', logged: '' };

function readFileOrNull(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } }

/** Re-read the bundled economy.csv (and units text for the version). Used while the source is local. */
function loadLocal() {
  const econText = readFileOrNull(localEconomyPath());
  const unitsText = readFileOrNull(localUnitsPath());
  let values = { ...DEFAULTS }, note = '';
  if (econText == null) note = 'economy.csv not found, using the built-in numbers';
  else {
    try {
      const p = parseEconomy(econText);
      values = p.values;
      if (p.missing.length) note = `economy.csv lacks ${p.missing.length} key(s), built-in numbers used for: ${p.missing.join(', ')}`;
    } catch (e) {
      // Keep the last good local numbers (or the built-ins) and say so once.
      note = `economy.csv rejected: ${e.message}. Keeping the previous numbers.`;
      values = current.source === 'local' ? current.values : { ...DEFAULTS };
    }
  }
  if (note && note !== state.logged) { state.logged = note; logger(`[rules] ${note}`); }
  setCurrent({ source: 'local', values, unitsText: null, econText, note }, unitsText);
}

function setCurrent(c, localUnitsText) {
  const unitsForVersion = c.unitsText != null ? c.unitsText : (localUnitsText != null ? localUnitsText : readFileOrNull(localUnitsPath()));
  const hash = versionOf(unitsForVersion, c.econText);
  current = { ...c, hash, version: hash.slice(0, 8) };
  sigCache = null;
}

/** Called at every match boot (sync). Local source: pick up edits to the bundled files. Remote/cache: unchanged. */
function boot() {
  if (current.source === 'local') loadLocal();
  return status();
}

/** units.csv text supplied by a downloaded (remote or cache) ruleset. null = read the local file as before (also when UNITS_CSV is set). */
function activeUnitsText() {
  if (process.env.UNITS_CSV) return null;
  return current.source === 'local' ? null : current.unitsText;
}

function status() {
  return { source: current.source, version: current.version, hash: current.hash, note: current.note, lastRefresh: state.lastRefresh, lastError: state.lastError, notice: state.lastNotice };
}
/** Short label for the match record and the watch page: "a1b2c3d4 remote". */
function label() { return `${current.version} ${current.source}`; }

// ---- env view ----
const fmt = n => String(n);
const envView = new Proxy({}, {
  get(_, name) {
    if (typeof name !== 'string') return undefined;
    const k = BY_ENV[name];
    if (k) {
      const raw = process.env[name];
      if (raw != null && String(raw).trim() !== '') return raw;
      return fmt(current.values[k.key]);
    }
    return process.env[name];
  },
  has(_, name) { return typeof name === 'string' && (name in BY_ENV || name in process.env); },
});
/** process.env, except each variable that has a rules key reads the ruleset's value when it is unset. */
function env() { return envView; }

/** One resolved number: the env override if set and valid, else the ruleset (CSV) value. */
function value(key) {
  const k = BY_KEY[key];
  if (!k) throw new Error(`unknown rules key ${key}`);
  if (k.env) {
    const raw = process.env[k.env];
    if (raw != null && String(raw).trim() !== '') { const n = Number(raw); if (Number.isFinite(n) && n >= k.min && n <= k.max) return n; }
  }
  return current.values[key];
}

/** A string that changes when any resolved rules number changes (env overrides included). Modules re-apply on a change only. */
function signature() {
  if (sigCache && sigCache.src === current && sigCache.env === envKey()) return sigCache.sig;
  const sig = crypto.createHash('sha1').update(JSON.stringify(KEYS.map(k => [k.key, value(k.key), k.env ? process.env[k.env] || '' : '']))).digest('hex');
  sigCache = { src: current, env: envKey(), sig };
  return sig;
}
function envKey() { return KEYS.map(k => (k.env ? process.env[k.env] || '' : '')).join('|'); }

// ---- download ----
function get(url, timeoutMs, extraHeaders) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error(`bad url ${url}`)); }
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) return reject(new Error(`unsupported protocol ${u.protocol}`));
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); err ? reject(err) : resolve(val); };
    const req = mod.get(u, { headers: { 'User-Agent': 'grokbotwar-rules', Accept: 'text/csv,text/plain,*/*', ...(extraHeaders || {}) } }, res => {
      if (res.statusCode !== 200) { res.resume(); return finish(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = []; let n = 0;
      res.on('data', c => { n += c.length; if (n > MAX_BYTES) { req.destroy(); finish(new Error('file too large')); } else chunks.push(c); });
      res.on('end', () => finish(null, { text: Buffer.concat(chunks).toString('utf8'), version: String(res.headers['x-rules-version'] || '') }));
      res.on('error', e => finish(e));
    });
    const timer = setTimeout(() => { req.destroy(); finish(new Error(`timeout after ${timeoutMs} ms`)); }, timeoutMs);
    req.on('error', e => finish(e));
  });
}

function validatePair(unitsText, econText) {
  const localUnits = readFileOrNull(bundledUnitsPath());
  validateUnits(unitsText, localUnits || '');
  const e = parseEconomy(econText);
  return e;
}

function writeCache(unitsText, econText, from) {
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const put = (name, text) => { const tmp = path.join(dir, `.${name}.${process.pid}.tmp`); fs.writeFileSync(tmp, text); fs.renameSync(tmp, path.join(dir, name)); };
  put('units.csv', unitsText); put('economy.csv', econText);
  put('meta.json', JSON.stringify({ savedAt: new Date().toISOString(), from, version: versionOf(unitsText, econText).slice(0, 8) }, null, 2) + '\n');
}
function readCache() {
  const dir = cacheDir();
  const u = readFileOrNull(path.join(dir, 'units.csv')), e = readFileOrNull(path.join(dir, 'economy.csv'));
  return u != null && e != null ? { unitsText: u, econText: e } : null;
}

function install(source, unitsText, econText, parsed, note = '') {
  const before = current.version;
  const hadSource = current.source;
  setCurrent({ source, values: parsed.values, unitsText, econText, note });
  if (before !== current.version || hadSource !== source) logger(`[rules] using ${source} ruleset ${current.version} (units + economy)${before && before !== current.version ? `, was ${before}` : ''}`);
}

let inflight = null;
/**
 * Download units.csv and economy.csv, validate, cache, and make them the ruleset for the next match. Never throws.
 * Resolves to status(). Concurrent calls share one download. RULES_REMOTE=0 skips the network entirely.
 * opts: { url, timeoutMs }
 */
function refresh(opts = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    try { await doRefresh(opts); } catch (e) { logger(`[rules] refresh failed unexpectedly: ${e && e.message || e}`); }
    finally { inflight = null; }
    return status();
  })();
  return inflight;
}

async function doRefresh(opts) {
  state.lastRefresh = new Date().toISOString();
  if (!remoteOn()) {
    if (state.logged !== 'off') { state.logged = 'off'; logger('[rules] RULES_REMOTE=0: no download, using the local files'); }
    loadLocal();
    return;
  }
  const total = opts.timeoutMs || TIMEOUT_MS;
  const deadline = Date.now() + total;
  const whys = [];
  const list = sources(opts);
  for (let i = 0; i < list.length; i++) {
    const src = list[i];
    // One shared budget for the whole chain (default 5 s): the relay gets at most 60% of it so GitHub still has time left.
    const floor = Math.min(total, 300), left = Math.max(floor, deadline - Date.now());
    const timeoutMs = i < list.length - 1 ? Math.max(floor, Math.floor(left * 0.6)) : left;
    try {
      const hdr = src.key ? { 'X-Rules-Key': src.key } : undefined;
      const [u, e] = await Promise.all([get(src.base + 'units.csv', timeoutMs, hdr), get(src.base + 'economy.csv', timeoutMs, hdr)]);
      const unitsText = u.text, econText = e.text;
      if (u.version && e.version && u.version !== e.version) throw Object.assign(new Error(`${src.name} served units.csv and economy.csv from different rules versions (${u.version} vs ${e.version})`), { rejected: true });
      const got = versionOf(unitsText, econText).slice(0, 8);
      if (u.version && u.version !== got) throw Object.assign(new Error(`${src.name} rules arrived damaged (served ${u.version}, got ${got})`), { rejected: true });
      let parsed;
      try { parsed = validatePair(unitsText, econText); }
      catch (err) { throw Object.assign(new Error(`downloaded rules rejected: ${err.message}`), { rejected: true }); }
      try { writeCache(unitsText, econText, `${src.name}:${src.base}`); } catch (err) { logger(`[rules] could not write the cache: ${err.code || err.message}`); }
      state.lastError = whys.join('; ');
      noticeIfChanged(unitsText);
      install(src.name, unitsText, econText, parsed);
      return;
    } catch (err) {
      const w = err.rejected ? err.message : `download from ${src.name} (${src.base}) failed: ${err.message}`;
      whys.push(w);
      if (i < list.length - 1) logger(`[rules] ${w}. Trying ${list[i + 1].name}.`);
    }
  }
  const why = whys.join('; ');
  state.lastError = why;
  const c = readCache();
  if (c) {
    try {
      const parsed = validatePair(c.unitsText, c.econText);
      logger(`[rules] ${why}. Using the cached copy.`);
      noticeIfChanged(c.unitsText);
      install('cache', c.unitsText, c.econText, parsed, why);
      return;
    } catch (err) { logger(`[rules] cached copy is not usable (${err.message})`); }
  }
  logger(`[rules] ${why}. Using the bundled local files.`);
  loadLocal();
  if (current.source === 'local') current.note = why;
}

/** Log (once per change) that the ruleset in use differs from the bundled units.lock.json fingerprint. */
function noticeIfChanged(unitsText) {
  try {
    const lock = LOCK.readLock();
    const now = LOCK.hashText(unitsText);
    if (lock.hash && now !== lock.hash) {
      const msg = `notice: units.csv from the ruleset (${now.slice(0, 12)}) differs from the bundled lock (${lock.hash.slice(0, 12)}); using it`;
      if (msg !== state.lastNotice) { state.lastNotice = msg; logger(`[rules] ${msg}`); }
    } else state.lastNotice = '';
  } catch { /* information only */ }
}

module.exports = {
  KEYS, BY_KEY, BY_ENV, DEFAULTS, TIMEOUT_MS, DEFAULT_REF,
  parseEconomy, validateUnits, versionOf, env, value, signature, boot, refresh, status, label, activeUnitsText, baseUrl, vpsBase, sources, remoteOn, setLogger,
  cacheDir, localEconomyPath, loadLocal,
  _reset: () => { current = empty(); sigCache = null; state.lastError = ''; state.lastNotice = ''; state.logged = ''; inflight = null; },
};
// The bundled files are the first ruleset: constants.js and friends read it at load time.
loadLocal();
