'use strict';
// Build the 4-team roster from bots.json (optional). Every unit runs a SCRIPT in the sandbox.
//   bots.json: { "mode": "commander"|"classic", "tickMs":300, "maxTicks":..., "seed":123, "autoRestart":true,
//     "seats": { "Turtle": { "hero": "scripts/turtle-hero.js",              // ("script" is accepted as an alias)
//                            "drones": { "scout": "scripts/drones/scout.js" }, // up to 3 drone types (commander mode)
//                            "battlePlan": "scripts/battle-plans/basic.js",   // optional battle plan (standing orders;
//                                                                              //   "commander" is a deprecated alias)
//                            "color": "#39ff14", "avatar": "optional image", "identity": {name, avatarShape, avatarColor},
//                            "joinToken": "optional",
//                            "arsenal": {"guard": 3},  // optional pre-match drones (SPEC 5.1); the seat API can override it
//                            "soft": false,     // true = handicapped NPC (config.commander.softHandicap), or
//                            "handicap": {energyRate, planEveryTicks} }, ... } }
// Scripts are keyed in the ScriptStore as "<seat>:hero", "<seat>:drone:<type>", "<seat>:battle-plan".
// Role names: 'hero', 'drone', 'battle-plan'. normRole() maps the deprecated 'commander' (and battlePlan /
// battle_plan / battleplan spellings) to 'battle-plan'.
// All of a team's scripts are snapshotted at match start (hot-swap between matches, never mid-match).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ScriptStore } = require('./scriptstore');
const { makeScriptFactory } = require('./controllers/script');
const { TeamWorker } = require('./workerhost');
const config = require('./config');
const A = require('./arsenal');

const DEFAULT_SEATS = {
  Turtle: { hero: 'scripts/turtle.js', color: '#39ff14' },
  Hunter: { hero: 'scripts/hunter.js', color: '#ff4d4d' },
  Sniper: { hero: 'scripts/sniper.js', color: '#00e5ff' },
  Chaos: { hero: 'scripts/chaos.js', color: '#ffb000' },
};
const COLORS = ['#39ff14', '#ff4d4d', '#00e5ff', '#ffb000'];
const TYPE_RE = /^[a-z][a-z0-9_-]{0,15}$/;
const BATTLE_PLAN_ALIASES = ['battle-plan', 'battleplan', 'battle_plan', 'battle plan', 'commander'];
/** canonical role name: 'hero' | 'drone' | 'battle-plan' (deprecated alias: 'commander'); other strings unchanged */
function normRole(role) {
  const r = String(role == null ? '' : role).trim();
  return BATTLE_PLAN_ALIASES.includes(r.toLowerCase()) ? 'battle-plan' : r;
}
/** a seat config's / saved roster's battle plan entry ("battlePlan", or the deprecated "commander" key) */
function battlePlanOf(o) {
  if (!o) return undefined;
  for (const k of ['battlePlan', 'battle-plan', 'battle_plan']) if (k in o) return o[k];
  return o.commander;
}

function loadConfig(baseDir, file) {
  const p = file ? path.resolve(baseDir, file) : path.join(baseDir, 'bots.json');
  if (!fs.existsSync(p)) return { path: null, cfg: {} };
  return { path: p, cfg: JSON.parse(fs.readFileSync(p, 'utf8')) };
}

class TeamEntry {
  constructor(seat, i, sc, store, cfg, avatars) {
    this.name = seat; this.seat = seat; this.driver = 'script';
    this.color = sc.color || COLORS[i];
    this.store = store; this.limits = cfg.limits;
    this.worker = new TeamWorker(seat);
    this.factories = new Map();
    this.snap = {};
    this.avatars = avatars;
    this.avatar = avatars ? () => avatars.url(seat) : null;
    this.avatarKind = avatars ? () => avatars.avatarSource(seat) : () => 'none';
    this.identity = avatars ? () => avatars.identity(seat) : () => null;
    // handicap: explicit {energyRate, planEveryTicks}, or "soft": true -> config.commander.softHandicap
    this.handicap = sc.handicap && typeof sc.handicap === 'object' ? { ...sc.handicap } : sc.soft ? { ...config.commander.softHandicap } : null;
    // arsenal (SPEC 5.1): config default (bots.json "arsenal"), overridden by the seat's own (POST /api/seat/arsenal)
    this.budget = A.budgetOf({ ...config.commander, ...(cfg.commander || {}) });
    this.droneCost = A.droneCostOf({ ...config.unitTypes, ...(cfg.unitTypes || {}) });
    this.cfgArsenal = sc.arsenal && typeof sc.arsenal === 'object' && !Array.isArray(sc.arsenal) ? { ...sc.arsenal } : null;
    this.seatArsenal = undefined; // undefined = not set by the seat; else {type: count}
    const heroFile = sc.hero || sc.script;
    store.addSeat(`${seat}:hero`, { file: heroFile });
    if (!store.get(`${seat}:hero`)) throw new Error(`seat ${seat}: hero script not found (${heroFile})`);
    this.droneTypeList = [];
    for (const [type, file] of Object.entries(sc.drones || {}).slice(0, config.commander.rosterMaxDrones)) {
      if (!TYPE_RE.test(type) || type === 'hero') throw new Error(`seat ${seat}: bad drone type name "${type}"`);
      store.addSeat(`${seat}:drone:${type}`, { file });
      if (!store.get(`${seat}:drone:${type}`)) throw new Error(`seat ${seat}: drone script not found (${file})`);
      this.droneTypeList.push(type);
    }
    const planFile = battlePlanOf(sc);
    if (planFile) {
      store.addSeat(this.key('battle-plan'), { file: planFile });
      if (!store.get(this.key('battle-plan'))) throw new Error(`seat ${seat}: battle plan script not found (${planFile})`);
    }
    // API submissions/removals survive arena restarts (state/rosters.json), unless bots.json's entry for this seat
    // changed since they were made (then the operator's config wins).
    // (the hash input keeps its historical "commander" key so hashes of existing state/rosters.json entries still match)
    this.cfgHash = crypto.createHash('sha1').update(JSON.stringify({ hero: heroFile, drones: sc.drones || {}, commander: planFile || null })).digest('hex').slice(0, 12);
    this.stateFile = path.join(store.baseDir, 'state', 'rosters.json');
    try { this._restore(); } catch (e) { console.warn(`[roster] ${seat}: could not restore submitted scripts: ${e.message}`); }
    this.beginMatch();
    // classic-mode compatibility: make = hero factory
    this.make = (ctx) => this.unitFactory('hero')(ctx);
  }
  key(role, type) { role = normRole(role); return role === 'hero' ? `${this.seat}:hero` : role === 'battle-plan' ? `${this.seat}:battle-plan` : `${this.seat}:drone:${type}`; }
  droneTypes() { return this.droneTypeList.slice(); }
  hasBattlePlan() { return this.store.has(this.key('battle-plan')); }
  /** freeze the current scripts for the next match */
  beginMatch() {
    this.snap = {};
    for (const k of [this.key('hero'), ...this.droneTypeList.map(t => this.key('drone', t)), this.key('battle-plan')]) if (this.store.has(k)) this.snap[k] = this.store.get(k);
    this.matchDroneTypes = this.droneTypeList.filter(t => this.snap[this.key('drone', t)]);
    this.matchHasBattlePlan = !!this.snap[this.key('battle-plan')];
    const a = this.arsenalInfo().arsenal;
    this.matchArsenal = a ? { ...a } : null;
  }
  // ---- arsenal ----
  arsenalRules() { return { droneTypes: this.droneTypeList.slice(), budget: this.budget, cost: this.droneCost }; }
  /** effective arsenal for the next match: {arsenal|null, source: 'seat'|'config'|'none'} */
  arsenalInfo() {
    if (this.seatArsenal !== undefined) return { arsenal: this.seatArsenal, source: 'seat' };
    if (this.cfgArsenal) return { arsenal: this.cfgArsenal, source: 'config' };
    return { arsenal: null, source: 'none' };
  }
  /** set the seat's own arsenal (validated against roster + budget). Throws with a plain message. */
  setArsenal(a) {
    const v = A.validateArsenal(a, this.arsenalRules());
    if (!v.ok) throw new Error(v.error);
    this.seatArsenal = v.arsenal; this._persist();
    return v;
  }
  resetArsenal() { this.seatArsenal = undefined; this._persist(); return this.arsenalInfo(); }
  /** re-read the arsenal for a match that has not started yet (tick 0) */
  refreshMatchArsenal() { const a = this.arsenalInfo().arsenal; this.matchArsenal = a ? { ...a } : null; }
  _factory(key, entry) {
    if (!this.factories.has(key)) this.factories.set(key, makeScriptFactory(() => this.snap[key], { limits: this.limits, worker: this.worker, entry }));
    return this.factories.get(key);
  }
  /** factory for a unit type ('hero' or a drone type) using this match's snapshot, or null */
  unitFactory(type) {
    const key = type === 'hero' ? this.key('hero') : this.key('drone', type);
    if (!this.snap[key]) return null;
    return this._factory(key, 'tick');
  }
  battlePlanFactory() { return this.matchHasBattlePlan ? this._factory(this.key('battle-plan'), 'command') : null; }
  /** current (not snapshotted) script info per role, for the API */
  scripts() {
    const i = k => this.store.info(k);
    const drones = {}; for (const t of this.droneTypeList) drones[t] = i(this.key('drone', t));
    const battlePlan = this.store.has(this.key('battle-plan')) ? i(this.key('battle-plan')) : null;
    return { hero: i(this.key('hero')), drones, battlePlan, commander: battlePlan }; // "commander": deprecated alias of battlePlan
  }
  /** submit a script for a role. type = drone type name (role 'drone'). Returns script info. */
  submit(role, type, name, source) {
    role = normRole(role);
    if (role === 'drone') {
      if (!TYPE_RE.test(type || '') || type === 'hero') throw new Error('unitType must match ^[a-z][a-z0-9_-]{0,15}$ (and not "hero")');
      if (!this.droneTypeList.includes(type)) {
        if (this.droneTypeList.length >= config.commander.rosterMaxDrones) throw new Error(`roster full: at most ${config.commander.rosterMaxDrones} drone types (remove one first)`);
        this.store.addSeat(this.key('drone', type), {});
        this.droneTypeList.push(type);
      }
    } else if (role === 'battle-plan' && !this.store.seats.has(this.key('battle-plan'))) this.store.addSeat(this.key('battle-plan'), {});
    const cur = this.store.submit(this.key(role, type), name, source);
    this._persist();
    return cur;
  }
  removeDrone(type) {
    const i = this.droneTypeList.indexOf(type); if (i < 0) return false;
    this.droneTypeList.splice(i, 1); this.store.remove(this.key('drone', type));
    if (this.seatArsenal && type in this.seatArsenal) { this.seatArsenal = { ...this.seatArsenal }; delete this.seatArsenal[type]; }
    this._persist(); return true;
  }
  removeBattlePlan() { if (!this.store.seats.has(this.key('battle-plan'))) return false; this.store.remove(this.key('battle-plan')); this._persist(); return true; }
  _readState() { try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return {}; } }
  _persist() {
    if (this._restoring) return;
    const cur = k => { const s = this.store.seats.get(k); const c = s && s.current; return c ? (c.origin === 'submitted' && c.file ? { name: c.name, file: c.file, version: c.version, at: c.at } : { config: true }) : null; };
    const st = this._readState();
    const drones = {}; for (const t of this.droneTypeList) drones[t] = cur(this.key('drone', t));
    st[this.seat] = { cfgHash: this.cfgHash, hero: cur(this.key('hero')), drones, battlePlan: cur(this.key('battle-plan')), ...(this.seatArsenal !== undefined ? { arsenal: this.seatArsenal } : {}), savedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile + '.tmp', JSON.stringify(st, null, 1)); fs.renameSync(this.stateFile + '.tmp', this.stateFile);
  }
  _restore() {
    const p = this._readState()[this.seat];
    if (!p) return;
    this._restoring = true;
    try { this._restoreInner(p); } finally { this._restoring = false; }
  }
  _restoreInner(p) {
    if (p.cfgHash !== this.cfgHash) { console.log(`[roster] ${this.seat}: bots.json entry changed since the last API submission; using bots.json`); return; }
    const put = (k, v) => { if (v && v.file) this.store.restore(k, v); };
    put(this.key('hero'), p.hero);
    for (const t of this.droneTypeList.slice()) if (!(t in (p.drones || {}))) this.removeDrone(t);
    for (const [t, v] of Object.entries(p.drones || {})) {
      if (!this.droneTypeList.includes(t)) { if (!v || !v.file || this.droneTypeList.length >= config.commander.rosterMaxDrones) continue; this.store.addSeat(this.key('drone', t), {}); this.droneTypeList.push(t); }
      put(this.key('drone', t), v);
    }
    if (p.arsenal && typeof p.arsenal === 'object') { const v = A.validateArsenal(p.arsenal, this.arsenalRules()); if (v.ok) this.seatArsenal = v.arsenal; }
    const plan = battlePlanOf(p); // older state files saved it as "commander"
    if (plan === null) this.removeBattlePlan();
    else if (plan && plan.file) { if (!this.store.seats.has(this.key('battle-plan'))) this.store.addSeat(this.key('battle-plan'), {}); put(this.key('battle-plan'), plan); }
    console.log(`[roster] ${this.seat}: restored API-submitted scripts from ${path.relative(this.store.baseDir, this.stateFile)}`);
  }
}

function buildRoster(baseDir, cfg, avatars) {
  const seatsCfg = cfg.seats && Object.keys(cfg.seats).length ? cfg.seats : DEFAULT_SEATS;
  const names = Object.keys(seatsCfg).slice(0, 4);
  if (names.length !== 4) throw new Error('bots.json "seats" must define exactly 4 seats');
  const store = new ScriptStore(baseDir);
  const joinCodes = {};
  const roster = names.map((name, i) => {
    const sc = seatsCfg[name];
    const e = new TeamEntry(name, i, sc, store, cfg, avatars);
    joinCodes[name] = sc.joinToken || 'rw_' + crypto.randomBytes(12).toString('hex');
    if (avatars) avatars._pending = (avatars._pending || []).concat(avatars.addSeat(name, sc.avatar, sc.identity, e.color));
    return e;
  });
  return { roster, store, joinCodes };
}

module.exports = { loadConfig, buildRoster, DEFAULT_SEATS, TYPE_RE, normRole, battlePlanOf };
