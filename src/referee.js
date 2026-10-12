'use strict';
// The Referee owns the authoritative world and runs the fixed tick loop.
//
// Two modes (cfg.mode):
//   classic   - each of the 4 teams fields exactly one unit (base stats); last team standing / most health.
//   commander - each team starts with its HERO; an energy budget refills over time and buys reinforcements
//               (hero or drone types from the team's roster), which appear at the team's home corner after a
//               short delay. Orders come from the team's optional battle plan script (standing orders, every 13 ticks, ~4 s)
//               and/or
//               live orders via the join-code API (POST /api/seat/order, applied at the next tick).
//               Arsenal (SPEC 5.1): if any seat declares one, every team gets commander.arsenalBudget before the
//               match, pre-buys drones (they launch on tick 1 up to the cap; extras wait as free reserve drones)
//               and starts with the rest as energy. Otherwise teams start with commander.energyStart (old behavior).
//
// Tick order (all units resolved simultaneously):
//   0. (commander) energy refill; apply queued API orders; run each team's battle plan when due; spawn ready reinforcements
//   1. build a SENSE snapshot per unit (includes the result of the scan it requested last tick)
//   2. ask all live controllers in parallel; late / thrown / invalid replies => STAND STILL
//   3. apply turns, then moves; clamp at walls (wall damage); undo moves of units that collide
//   4. spawn shells for units that fired and are not overheated
//   5. advance all shells (swept collision vs units), apply damage
//   6. cool heat, run each unit's requested scan (result goes into next tick's sense)
//   7. eliminations / win check
const EventEmitter = require('events');
const { DEG, norm360, angDiff, bearing, dist, clamp, segCircle } = require('./geom');
const { validateCommand, limitsFor } = require('./validate');
const defaults = require('./config');
const { fitArsenal } = require('./arsenal');

// small seeded PRNG (mulberry32) so a match is reproducible from its seed
function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r1 = v => Math.round(v * 10) / 10;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// accept deprecated config key names (e.g. commanderEveryTicks -> battlePlanEveryTicks) unless the new one is set
function renameKeys(o, map) {
  const out = { ...o };
  for (const [from, to] of Object.entries(map)) if (from in out) { if (!(to in out)) out[to] = out[from]; delete out[from]; }
  return out;
}

/** per-team handicap fields from a roster entry's handicap ({energyRate, planEveryTicks} or null) */
function teamHandicap(h, cc) {
  const rate = h && Number.isFinite(h.energyRate) ? Math.min(1, Math.max(0, h.energyRate)) : 1;
  const every = h && Number.isInteger(h.planEveryTicks) && h.planEveryTicks >= 1 ? h.planEveryTicks : cc.battlePlanEveryTicks;
  return { energyRate: rate, planEveryTicks: every, soft: !!h, handicap: h ? { energyRate: rate, planEveryTicks: every } : null };
}

class Referee extends EventEmitter {
  /**
   * @param {Array<TeamEntry|{name,color,make}>} roster  see roster.js; make(ctx) returns async (sense)=>command
   * @param {object} opts overrides of config.js
   */
  constructor(roster, opts = {}) {
    super();
    opts = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
    this.cfg = { ...defaults, ...opts, arena: { ...defaults.arena, ...(opts.arena || {}) },
      commander: { ...defaults.commander, ...renameKeys(opts.commander || {}, { commanderEveryTicks: 'battlePlanEveryTicks', commanderMaxFaults: 'battlePlanMaxFaults' }) },
      unitTypes: { ...defaults.unitTypes, ...(opts.unitTypes || {}) } };
    if (this.cfg.mode === 'commander' && opts.maxTicks === undefined) this.cfg.maxTicks = this.cfg.commander.maxTicks;
    this.roster = roster;
    this.paused = false;
    this.holdNext = false; // one-shot "pause after the current match" (POST /api/seat/pause)
    this.matchNo = 0;
    this._timer = null;
    this._restartTimer = null;
    this._ticking = false;
    this.orderQueue = [];
    if (typeof opts.beforeFirstMatch === 'function') opts.beforeFirstMatch(this); // e.g. attach a recorder
    this.newMatch();
  }

  get commanderMode() { return this.cfg.mode === 'commander'; }

  /** stats of a unit kind in the current mode */
  spec(kind) {
    const c = this.cfg;
    if (!this.commanderMode) return { ...c.unitTypes.classic, radius: c.robotRadius, maxMove: c.maxMove, maxTurn: c.maxTurn, damagePerPower: c.damagePerPower, heatPerPower: c.heatPerPower, maxHeat: c.maxHeat, coolPerTick: c.coolPerTick, shellSpeed: c.shellSpeed, scanMaxWidth: c.scanMaxWidth };
    return { ...c.unitTypes[kind === 'drone' ? 'drone' : 'hero'] };
  }

  // ---------- match lifecycle ----------
  newMatch(seed) {
    clearTimeout(this._restartTimer); this._restartTimer = null;
    if (this.robots) for (const r of this.robots) if (r.controller && r.controller.dispose) r.controller.dispose();
    if (this.teams) for (const t of this.teams) if (t.battlePlan && t.battlePlan.dispose) t.battlePlan.dispose();
    this.seed = (seed !== undefined ? seed : this.cfg.seed !== undefined && this.matchNo === 0 ? this.cfg.seed : Math.floor(Math.random() * 2 ** 32)) >>> 0;
    const rng = this.rng = mulberry32(this.seed);
    const { w, h } = this.cfg.arena;
    const m = 150;
    const spots = [[m, m], [w - m, m], [w - m, h - m], [m, h - m]];
    for (let i = spots.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [spots[i], spots[j]] = [spots[j], spots[i]]; }
    this.matchNo++;
    this.tick = 0;
    this.status = 'running'; // running | over
    this.winner = null;
    this.shells = [];
    this.events = [];
    this.orderQueue = [];
    this._shellSeq = 0;
    this.robots = [];
    this.deathOrder = [];
    this.timeline = [];
    const cc = this.cfg.commander;
    for (const r of this.roster) if (typeof r.beginMatch === 'function') r.beginMatch();
    this.teams = this.roster.map((r, i) => {
      const [sx, sy] = spots[i % spots.length];
      // home = the team's corner (reinforcements appear here)
      const hx = sx < w / 2 ? 70 : w - 70, hy = sy < h / 2 ? 70 : h - 70;
      // handicap (e.g. "soft" NPCs in a player's first match): slower energy refill and battle plan cadence
      // (cfg.softMatches: handicaps apply only to the first N matches since start, e.g. 1 = soft first fight)
      const hc = teamHandicap(this.cfg.softMatches == null || this.matchNo <= this.cfg.softMatches ? r.handicap : null, cc);
      return {
        id: i, name: r.name, color: r.color, seat: r.seat || r.name,
        home: { x: hx, y: hy },
        droneTypes: this.commanderMode && typeof r.droneTypes === 'function' ? (r.matchDroneTypes || r.droneTypes()) : [],
        energy: this.commanderMode ? cc.energyStart : 0, energyStart: this.commanderMode ? cc.energyStart : 0, energyGained: 0, energySpent: 0, arsenal: null,
        pending: [], orders: [], ordersApi: 0, ordersScript: 0, battlePlanRuns: 0, deployed: { hero: 0, drone: 0 }, byType: {},
        battlePlan: null, battlePlanMemory: null, battlePlanThought: '', battlePlanMeta: null, battlePlanDisabled: null,
        seen: new Map(), log: [], emptySince: null, damageDealt: 0, friendlyDamage: 0, eliminated: false, eliminatedTick: null, seq: {},
        ...hc,
      };
    });
    this._setupArsenals();
    this.teams.forEach((t, i) => {
      const [sx, sy] = spots[i % spots.length];
      this._createUnit(t, 'hero', sx + (rng() - 0.5) * 80, sy + (rng() - 0.5) * 80, Math.floor(rng() * 360), true);
      const re = this.roster[i];
      if (this.commanderMode && typeof re.battlePlanFactory === 'function') {
        const f = re.battlePlanFactory();
        if (f) { t.battlePlan = f({ robotId: `cmd${i}`, name: `${t.name}-battle-plan`, team: i, matchNo: this.matchNo, seed: (this.seed ^ Math.imul(i + 101, 0x9E3779B1)) >>> 0 }); t.battlePlanMeta = t.battlePlan.meta || null; t.battlePlanThought = 'Battle plan: standing orders loaded'; }
      }
    });
    for (const r of this.robots) this._doScan(r);
    this.emit('matchStart', { matchNo: this.matchNo, seed: this.seed, cfg: this.cfg, mode: this.cfg.mode,
      teams: this.teams.map((t, i) => ({ id: t.id, name: t.name, home: t.home, droneTypes: t.droneTypes, hasBattlePlan: !!t.battlePlan, handicap: t.handicap, arsenal: this.roster[i].matchArsenal || null, arsenalUsed: this._arsenalPublic(t) })),
      robots: this.robots.map(r => ({ id: r.id, name: r.name, color: r.color, driver: r.driver, x: r.x, y: r.y, heading: r.heading, meta: this._meta(r) })) });
    this._emit();
  }

  /** create a unit for team t. type = 'hero' or a drone type. Returns the unit (or null if no script). */
  _createUnit(t, type, x, y, heading, initial = false) {
    const kind = type === 'hero' ? 'hero' : 'drone';
    const re = this.roster[t.id];
    const factory = typeof re.unitFactory === 'function' ? re.unitFactory(type) : (type === 'hero' ? re.make : null);
    if (!factory) return null;
    const spec = this.spec(kind);
    const id = this.robots.length;
    t.seq[type] = (t.seq[type] || 0) + 1;
    const name = type === 'hero' ? (t.seq.hero === 1 ? t.name : `${t.name}-hero${t.seq.hero}`) : `${t.name}-${type}${t.seq[type]}`;
    const r = {
      id, name, color: t.color, team: t.id, teamName: t.name, kind, type, spec, spawnTick: this.tick,
      controller: factory({ robotId: id, name, color: t.color, team: t.id, kind, type, spec, matchNo: this.matchNo, seed: (this.seed ^ Math.imul(id + 1, 0x9E3779B1)) >>> 0 }),
      driver: re.driver || 'script', memory: '', thinking: false, thinkStart: 0,
      x: clamp(x, spec.radius, this.cfg.arena.w - spec.radius), y: clamp(y, spec.radius, this.cfg.arena.h - spec.radius),
      heading: norm360(heading), health: spec.health, heat: 0, alive: true,
      scan: { dir: initial ? Math.floor(this.rng() * 360) : norm360(heading), width: 45 }, scanResult: null,
      thought: initial ? '(booting)' : '(deployed)', lastCmd: null, lastStatus: 'ok', lastError: null, lastLatencyMs: 0,
      damageTaken: 0, hitWall: false, kills: 0, shotsFired: 0, shotsHit: 0, lastSense: null,
      stats: { damageDealt: 0, damageTaken: 0, friendlyDamage: 0, wallBumps: 0, rams: 0, overheats: 0, faults: 0, ticksAlive: 0, closestCall: null,
               deathTick: null, deathPos: null, killedBy: null, deathCause: null, hitsBy: {}, hitsOn: {} },
    };
    this.robots.push(r);
    t.deployed[kind]++; t.byType[type] = (t.byType[type] || 0) + 1;
    if (!initial) {
      this._doScan(r);
      this.timeline.push({ tick: this.tick, type: 'spawn', text: `${t.name} deployed ${name}` });
      this.events.push({ type: 'spawn', id, team: t.id, kind, x: r.x, y: r.y });
      this._teamLog(t, `${name} deployed`);
    }
    return r;
  }

  // ---------- arsenal (SPEC 5.1) ----------
  /** apply each team's pre-match arsenal: pay from the budget, queue launches for tick 1, the rest = energy */
  _setupArsenals() {
    if (!this.commanderMode) return;
    const cc = this.cfg.commander;
    this.arsenalsOn = this.roster.some(r => r && r.matchArsenal);
    for (const t of this.teams) {
      t.pending = t.pending.filter(p => !p.prepaid);
      if (!this.arsenalsOn) { t.arsenal = null; t.energy = t.energyStart = cc.energyStart; continue; }
      const re = this.roster[t.id];
      const cost = this.spec('drone').cost;
      const budget = t.soft ? Math.floor(cc.arsenalBudget * t.energyRate) : cc.arsenalBudget;
      const fit = fitArsenal(re.matchArsenal || {}, { droneTypes: t.droneTypes, budget, cost });
      const left = budget - fit.cost;
      const a = t.arsenal = { budget, bought: { ...fit.arsenal }, spent: fit.cost, reserveEnergy: Math.min(cc.energyMax, left), reserve: { ...fit.arsenal }, launchedAtStart: {}, fromReserve: {}, notes: fit.notes };
      t.energy = t.energyStart = a.reserveEnergy;
      for (const [type, n] of Object.entries(fit.arsenal)) for (let k = 0; k < n; k++) {
        if (t.pending.length >= cc.droneCap) break; // only drones are pending at match start
        t.pending.push({ type, kind: 'drone', readyTick: 1, orderedTick: 0, prepaid: true });
        a.reserve[type]--; a.launchedAtStart[type] = (a.launchedAtStart[type] || 0) + 1;
      }
      for (const k of Object.keys(a.reserve)) if (!a.reserve[k]) delete a.reserve[k];
      if (fit.notes.length) this._teamLog(t, 'arsenal: ' + fit.notes.join('; '));
    }
  }

  /** the match has not started yet (tick 0): re-read every seat's arsenal (POST /api/seat/arsenal while paused) */
  rearmArsenals() {
    if (!this.commanderMode || this.tick !== 0 || this.status !== 'running') return false;
    for (const r of this.roster) if (typeof r.refreshMatchArsenal === 'function') r.refreshMatchArsenal();
    this._setupArsenals();
    this.emit('rearm', { matchNo: this.matchNo, teams: this.teams.map((t, i) => ({ id: t.id, arsenal: this.roster[i].matchArsenal || null })) });
    this._emit();
    return true;
  }

  _arsenalPublic(t) {
    const a = t.arsenal; if (!a) return null;
    const launched = { ...a.launchedAtStart };
    for (const [k, v] of Object.entries(a.fromReserve)) launched[k] = (launched[k] || 0) + v;
    return { budget: a.budget, bought: { ...a.bought }, spent: a.spent, reserveEnergy: a.reserveEnergy, launched, reserve: { ...a.reserve } };
  }

  start() { this._schedule(0); }
  // pause: freeze now (mid-match), or between matches: cancel the pending auto-start (the next match then begins
  // on resume, so scripts/arsenals changed while paused land in it).
  pause() { this.paused = true; clearTimeout(this._timer); this._timer = null; if (this.status === 'over') { clearTimeout(this._restartTimer); this._restartTimer = null; this._restartAt = null; } this._emit(); }
  resume() { if (!this.paused) return; this.paused = false; if (this.status === 'over') this.restart(); else this._schedule(0); this._emit(); }
  /** hold the arena after the current match (no auto-start until resume). Between matches it holds right away. */
  holdAfterMatch() { if (this.status === 'over') { this.pause(); return 'now'; } this.holdNext = true; this._emit(); return 'after-match'; }
  setPauseAfterMatch(on) { this.cfg.pauseAfterMatch = !!on; this._emit(); }
  /** warrior name of team t (the seat's identity name, else its style name, else the seat) */
  displayName(t) { const re = t && this.roster[t.id]; const d = re && typeof re.displayName === 'function' ? re.displayName() : null; return d || (t ? t.name : null); }
  async step() { if (!this.paused) this.pause(); if (this.status === 'running') await this.runTick(); }
  restart() { this.newMatch(); if (!this.paused) this._schedule(this.cfg.tickMs); }
  setTickMs(ms) { this.cfg.tickMs = clamp(Math.round(ms), 50, 60000); this._emit(); }
  setAutoRestart(on) { this.cfg.autoRestart = !!on; this._emit(); }

  _schedule(delay) {
    clearTimeout(this._timer);
    if (this.paused || this.status !== 'running') return;
    this._timer = setTimeout(async () => {
      const t0 = Date.now();
      await this.runTick();
      this._schedule(Math.max(0, this.cfg.tickMs - (Date.now() - t0)));
    }, delay);
  }

  // ---------- commander mode: orders (battle plan + live API), energy, spawns ----------
  /** Queue an order from outside (API). Applied at the start of the next tick. */
  queueOrder(teamId, type, count, source = 'api') {
    if (!this.commanderMode) return { ok: false, error: 'arena is not in commander mode' };
    if (this.status !== 'running') return { ok: false, error: 'no match running' };
    const t = this.teams[teamId]; if (!t) return { ok: false, error: 'unknown team' };
    this.orderQueue.push({ team: teamId, type, count, source, matchNo: this.matchNo });
    return { ok: true, appliesAtTick: this.tick + 1, matchNo: this.matchNo };
  }

  _teamLog(t, text) { t.log.push({ tick: this.tick, text }); if (t.log.length > 40) t.log.shift(); }

  _applyOrder(t, type, count, source, thought) {
    const cc = this.cfg.commander;
    const rec = { tick: this.tick, source, type, count, deployed: 0, reason: null };
    if (t.eliminated) rec.reason = 'team eliminated';
    else if (type !== 'hero' && !t.droneTypes.includes(type)) rec.reason = `unknown unit type "${type}" (roster: hero${t.droneTypes.map(x => ', ' + x).join('')})`;
    else {
      const kind = type === 'hero' ? 'hero' : 'drone';
      const cost = this.spec(kind).cost;
      const cap = kind === 'hero' ? cc.heroCap : cc.droneCap;
      for (let i = 0; i < count; i++) {
        const have = this.robots.filter(r => r.alive && r.team === t.id && r.kind === kind).length + t.pending.filter(p => p.kind === kind).length;
        if (have >= cap) { rec.reason = `${kind} cap ${cap} reached`; break; }
        const a = t.arsenal;
        if (kind === 'drone' && a && a.reserve[type] > 0) { // a pre-paid reserve drone: free
          if (!--a.reserve[type]) delete a.reserve[type];
          a.fromReserve[type] = (a.fromReserve[type] || 0) + 1;
          t.pending.push({ type, kind, readyTick: this.tick + cc.spawnDelayTicks, orderedTick: this.tick, prepaid: true });
          rec.deployed++; rec.fromArsenal = (rec.fromArsenal || 0) + 1;
          continue;
        }
        if (t.energy < cost) { rec.reason = `not enough energy (${Math.floor(t.energy)}/${cost})`; break; }
        t.energy -= cost; t.energySpent += cost;
        t.pending.push({ type, kind, readyTick: this.tick + cc.spawnDelayTicks, orderedTick: this.tick });
        rec.deployed++;
      }
    }
    if (source === 'api') t.ordersApi++; else t.ordersScript++;
    const who = source === 'api' ? 'Live order' : 'Battle plan';
    const label = rec.deployed ? `${who}: deploying ${plural(rec.deployed, type === 'hero' ? 'hero' : type === 'drone' ? 'drone' : type + ' drone')}${rec.fromArsenal ? ` (${rec.fromArsenal === rec.deployed ? '' : rec.fromArsenal + ' '}from arsenal)` : ''}` : null;
    if (rec.deployed || source === 'api') {
      t.orders.push(rec); if (t.orders.length > 300) t.orders.shift();
      const txt = label ? label + (rec.deployed < count ? ` (${count - rec.deployed} refused: ${rec.reason})` : '') : `${who}: ${type} x${count} refused (${rec.reason})`;
      t.battlePlanThought = (thought ? thought + ' | ' : '') + txt;
      if (source === 'api') t.thoughtStickyUntil = this.tick + 40; // keep live orders visible for ~6 s
      this.events.push({ type: 'order', team: t.id, source, unitType: type, count, deployed: rec.deployed, reason: rec.reason });
      this._teamLog(t, txt.replace(/^Battle plan: /, '').replace(/^Live order: (.*)$/, '$1 (live order)'));
      this.emit('order', { matchNo: this.matchNo, tick: this.tick, team: t.id, source, type, count, deployed: rec.deployed, reason: rec.reason });
    } else if (thought && !(this.tick < (t.thoughtStickyUntil || 0))) t.battlePlanThought = 'Battle plan: ' + thought;
    return rec;
  }

  _spawnReady(t) {
    const { w, h } = this.cfg.arena;
    const still = [];
    for (const p of t.pending) {
      if (p.readyTick > this.tick) { still.push(p); continue; }
      const spec = this.spec(p.kind);
      const cands = [[0, 0]];
      for (let ring = 1; ring <= 3; ring++) for (let k = 0; k < 8; k++) { const a = (k * 45 + ring * 20) * DEG; cands.push([Math.cos(a) * ring * 38, Math.sin(a) * ring * 38]); }
      let pos = null;
      for (const [dx, dy] of cands) {
        const x = clamp(t.home.x + dx, spec.radius + 2, w - spec.radius - 2), y = clamp(t.home.y + dy, spec.radius + 2, h - spec.radius - 2);
        if (this.robots.every(o => !o.alive || dist(x, y, o.x, o.y) >= o.spec.radius + spec.radius + 4)) { pos = [x, y]; break; }
      }
      if (!pos) { still.push(p); continue; } // home corner blocked: try again next tick
      const u = this._createUnit(t, p.type, pos[0], pos[1], bearing(pos[0], pos[1], w / 2, h / 2));
      if (u && p.prepaid) u.prepaid = true; // paid from the pre-match arsenal, not from match energy
      if (!u && p.prepaid && t.arsenal) { this._teamLog(t, `no script for ${p.type}; back to the arsenal reserve`); t.arsenal.reserve[p.type] = (t.arsenal.reserve[p.type] || 0) + 1; }
      else if (!u) this._teamLog(t, `no script for ${p.type}; refund`), t.energy += spec.cost, t.energySpent -= spec.cost;
    }
    t.pending = still;
  }

  /** What a team's battle plan (command(status)) or the bot via GET /api/seat/status knows about its team. */
  teamStatus(teamId) {
    const t = this.teams[teamId]; if (!t) return null;
    const cc = this.cfg.commander;
    const mine = this.robots.filter(r => r.alive && r.team === t.id);
    const seen = [];
    for (const s of t.seen.values()) if (this.tick - s.tick <= 40) seen.push({ ...s });
    seen.sort((a, b) => b.tick - a.tick);
    return JSON.parse(JSON.stringify({
      tick: this.tick, ticksLeft: this.cfg.maxTicks - this.tick, mode: this.cfg.mode, matchNo: this.matchNo, status: this.status,
      arena: { w: this.cfg.arena.w, h: this.cfg.arena.h },
      team: { id: t.id, name: t.name, seat: t.seat, displayName: this.displayName(t) },
      energy: r1(t.energy), energyMax: cc.energyMax, energyPerTick: +(cc.energyPerTick * t.energyRate).toFixed(4), energySpent: t.energySpent, soft: t.soft,
      costs: { hero: this.cfg.unitTypes.hero.cost, drone: this.cfg.unitTypes.drone.cost },
      caps: { hero: cc.heroCap, drone: cc.droneCap }, spawnDelayTicks: cc.spawnDelayTicks,
      roster: { hero: 'hero', drones: t.droneTypes },
      arsenal: this._arsenalPublic(t),   // null when the arena does not use arsenals
      units: mine.map(r => ({ id: r.id, name: r.name, type: r.type, kind: r.kind, x: r1(r.x), y: r1(r.y), heading: r1(r.heading), health: r.health, maxHealth: r.spec.health, heat: r1(r.heat) })),
      counts: { hero: mine.filter(r => r.kind === 'hero').length, drone: mine.filter(r => r.kind === 'drone').length,
                pendingHero: t.pending.filter(p => p.kind === 'hero').length, pendingDrone: t.pending.filter(p => p.kind === 'drone').length },
      pending: t.pending.map(p => ({ type: p.type, kind: p.kind, readyTick: p.readyTick })),
      enemiesSeen: seen.slice(0, 12),
      teams: this.teams.map(o => { const u = this.robots.filter(r => r.alive && r.team === o.id); return { id: o.id, name: o.name, displayName: this.displayName(o), units: u.length, heroes: u.filter(r => r.kind === 'hero').length, drones: u.filter(r => r.kind === 'drone').length, health: u.reduce((s, r) => s + r.health, 0), eliminated: o.eliminated }; }),
      recentEvents: t.log.slice(-10),
      lastOrders: t.orders.slice(-5),
    }));
  }

  async _runBattlePlan(t) {
    const st = this.teamStatus(t.id);
    t.battlePlanRuns++;
    const rep = await this._ask({ controller: (s) => t.battlePlan(s), name: t.name + '-battle-plan', driver: 'script' }, st);
    const meta = t.battlePlan.meta;
    if (meta && meta.disqualified) {
      t.battlePlanDisabled = meta.disqualifyReason; t.battlePlanThought = `Battle plan disabled: ${meta.disqualifyReason}`;
      this._teamLog(t, 'battle plan disabled: ' + meta.disqualifyReason); t.battlePlan.dispose && t.battlePlan.dispose(); t.battlePlan = null;
      return;
    }
    if (rep.status !== 'ok') { t.battlePlanFaults = (t.battlePlanFaults || 0) + 1; t.battlePlanThought = `Battle plan: [${rep.status}] ${rep.error || ''}`.slice(0, 160); return; }
    const o = rep.value;
    if (!o.deploy.length) { if (o.thought && !(this.tick < (t.thoughtStickyUntil || 0))) t.battlePlanThought = 'Battle plan: ' + o.thought; return; }
    for (const d of o.deploy) this._applyOrder(t, d.type, d.count, 'battle-plan', o.thought);
  }

  // ---------- one tick ----------
  async runTick() {
    if (this._ticking || this.status !== 'running') return;
    this._ticking = true;
    try { await this._tick(); } catch (e) { console.error('[referee] tick error', e); }
    finally { this._ticking = false; }
  }

  async _tick() {
    const cfg = this.cfg;
    const myMatch = this.matchNo;
    this.tick++;
    this.events = [];

    // 0. commander phase
    if (this.commanderMode) {
      const cc = cfg.commander;
      for (const t of this.teams) {
        if (t.eliminated) continue;
        const before = t.energy;
        t.energy = Math.min(cc.energyMax, t.energy + cc.energyPerTick * t.energyRate);
        t.energyGained += t.energy - before;
      }
      const q = this.orderQueue.filter(o => o.matchNo === this.matchNo); this.orderQueue = [];
      for (const o of q) this._applyOrder(this.teams[o.team], o.type, o.count, o.source);
      const due = this.teams.filter(t => t.battlePlan && !t.eliminated && (this.tick - 1) % t.planEveryTicks === 0);
      if (due.length) {
        await Promise.all(due.map(t => this._runBattlePlan(t)));
        if (this.matchNo !== myMatch) return;
      }
      for (const t of this.teams) if (!t.eliminated) this._spawnReady(t);
    }

    const live = this.robots.filter(r => r.alive);
    // 1+2. senses and commands, in parallel, with timeout
    const t0 = Date.now();
    for (const r of live) { r.thinking = true; r.thinkStart = t0; }
    const asks = live.map(r => {
      const sense = this._buildSense(r);
      r.lastSense = sense;
      return this._ask(r, sense).then(rep => { r.thinking = false; return rep; });
    });
    this._emitThinking();
    const replies = await Promise.all(asks);
    if (this.matchNo !== myMatch) return; // match was restarted while we waited for controllers
    for (const r of live) {
      const meta = this._meta(r);
      if (meta && meta.disqualified && r.alive) {
        r.alive = false; r.health = 0; r.thought = `DISQUALIFIED: ${meta.disqualifyReason || 'too many faults'}`;
        this._recordDeath(r, null, 'disqualified');
        this.events.push({ type: 'death', id: r.id, by: null, cause: 'disqualified', x: r.x, y: r.y });
      }
    }
    live.forEach((r, i) => {
      const rep = replies[i];
      r.lastLatencyMs = rep.ms;
      if (rep.status !== 'ok') {
        r.lastStatus = rep.status; r.lastError = rep.error; r.lastCmd = null; r.stats.faults++;
        r.thought = `[${rep.status}] standing still${rep.error ? ': ' + rep.error : ''}`;
        return;
      }
      const v = validateCommand(rep.value, limitsFor(r.spec, cfg));
      if (!v.ok) {
        r.lastStatus = 'invalid'; r.lastError = v.error; r.lastCmd = null; r.stats.faults++;
        r.thought = `[invalid] standing still: ${v.error}`;
        return;
      }
      r.lastStatus = 'ok'; r.lastError = null; r.lastCmd = v.cmd;
      r.thought = v.cmd.thought || '';
      if (v.cmd.scan) r.scan = v.cmd.scan;
      if (v.cmd.memory !== undefined) r.memory = v.cmd.memory;
    });
    for (const r of this.robots) { r.damageTaken = 0; r.hitWall = false; }

    // 3. movement (simultaneous)
    const { w, h } = cfg.arena;
    const old = new Map();
    for (const r of live) {
      old.set(r, { x: r.x, y: r.y });
      const c = r.lastCmd; if (!c || !r.alive) continue;
      const R = r.spec.radius;
      r.heading = norm360(r.heading + c.turn);
      const nx = r.x + Math.cos(r.heading * DEG) * c.move;
      const ny = r.y + Math.sin(r.heading * DEG) * c.move;
      const cx = clamp(nx, R, w - R), cy = clamp(ny, R, h - R);
      if (cx !== nx || cy !== ny) { r.hitWall = true; this._damage(r, cfg.wallDamage, null, 'wall'); this.events.push({ type: 'wall', id: r.id, x: cx, y: cy }); }
      r.x = cx; r.y = cy;
    }
    // unit-unit collisions: revert both to old positions (iterate until stable)
    const movers = live.filter(r => r.alive);
    for (let pass = 0; pass < 4; pass++) {
      let any = false;
      for (let i = 0; i < movers.length; i++) for (let j = i + 1; j < movers.length; j++) {
        const a = movers[i], b = movers[j];
        if (dist(a.x, a.y, b.x, b.y) < a.spec.radius + b.spec.radius) {
          const oa = old.get(a), ob = old.get(b);
          const moved = (a.x !== oa.x || a.y !== oa.y || b.x !== ob.x || b.y !== ob.y);
          a.x = oa.x; a.y = oa.y; b.x = ob.x; b.y = ob.y;
          if (moved) {
            any = true;
            if (pass === 0) {
              this._damage(a, cfg.ramDamage, b, 'ram'); this._damage(b, cfg.ramDamage, a, 'ram');
              this.events.push({ type: 'ram', a: a.id, b: b.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
            }
          }
        }
      }
      if (!any) break;
    }

    // 4. firing
    for (const r of live) {
      const c = r.lastCmd; if (!c || !c.fire || !r.alive) continue;
      const sp = r.spec;
      const cost = c.fire.power * sp.heatPerPower;
      if (r.heat + cost > sp.maxHeat) { r.stats.overheats++; this.events.push({ type: 'overheat', id: r.id }); r.thought += ' [overheated: shot blocked]'; continue; }
      r.heat += cost;
      r.shotsFired++;
      const a = c.fire.angle * DEG;
      const s = {
        id: ++this._shellSeq, owner: r.id, power: c.fire.power, damage: c.fire.power * sp.damagePerPower,
        x: r.x + Math.cos(a) * (sp.radius + 2), y: r.y + Math.sin(a) * (sp.radius + 2),
        vx: Math.cos(a) * sp.shellSpeed, vy: Math.sin(a) * sp.shellSpeed,
        born: this.tick, small: r.kind === 'drone',
      };
      s.ox = s.x; s.oy = s.y;
      this.shells.push(s);
      this.events.push({ type: 'fire', id: r.id, shell: s.id, x: s.x, y: s.y, angle: c.fire.angle, power: s.power });
    }

    // 5. shells
    const keep = [];
    for (const s of this.shells) {
      const x0 = s.x, y0 = s.y, x1 = s.x + s.vx, y1 = s.y + s.vy;
      let best = null, bestT = 2;
      for (const r of this.robots) {
        if (!r.alive || r.id === s.owner) continue;
        const t = segCircle(x0, y0, x1, y1, r.x, r.y, r.spec.radius);
        if (t !== null && t < bestT) { bestT = t; best = r; }
      }
      if (best) {
        const hx = x0 + (x1 - x0) * bestT, hy = y0 + (y1 - y0) * bestT;
        const owner = this.robots[s.owner];
        owner.shotsHit++;
        this._damage(best, s.damage, owner, 'shell');
        this.events.push({ type: 'hit', shell: s.id, owner: s.owner, target: best.id, x: hx, y: hy, damage: s.damage, power: s.power });
        continue;
      }
      if (x1 < 0 || x1 > w || y1 < 0 || y1 > h) {
        let t = 1;
        if (x1 < 0) t = Math.min(t, x0 / (x0 - x1));
        if (x1 > w) t = Math.min(t, (w - x0) / (x1 - x0));
        if (y1 < 0) t = Math.min(t, y0 / (y0 - y1));
        if (y1 > h) t = Math.min(t, (h - y0) / (y1 - y0));
        this.events.push({ type: 'miss', shell: s.id, x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, power: s.power });
        continue;
      }
      s.x = x1; s.y = y1;
      keep.push(s);
    }
    this.shells = keep;

    // 6. cooling + scans (results delivered in next sense)
    for (const r of this.robots) {
      if (!r.alive) continue;
      r.heat = Math.max(0, r.heat - r.spec.coolPerTick);
      this._doScan(r);
    }

    for (const r of this.robots) if (r.alive) {
      r.stats.ticksAlive = this.tick - r.spawnTick;
      if (r.kind === 'hero' && r.health > 0 && r.health <= 15 && !r.stats.closestCall) { r.stats.closestCall = this.tick; this.timeline.push({ tick: this.tick, type: 'low_health', text: `${r.name} dropped to ${Math.round(r.health)} health` }); }
    }

    // 7. eliminations + win check (per TEAM; a team is out when it has no units alive and none on the way)
    for (const t of this.teams) {
      if (t.eliminated) continue;
      const empty = !this.robots.some(r => r.alive && r.team === t.id) && !t.pending.length;
      if (!empty) { t.emptySince = null; continue; }
      if (t.emptySince == null) { t.emptySince = this.tick; if (this.commanderMode) this._teamLog(t, 'no units left: last stand - deploy within ' + cfg.commander.lastStandTicks + ' ticks or be eliminated'); }
      if (!this.commanderMode || this.tick - t.emptySince >= cfg.commander.lastStandTicks) {
        t.eliminated = true; t.eliminatedTick = this.tick;
        if (t.battlePlan && t.battlePlan.dispose) { t.battlePlan.dispose(); t.battlePlan = null; }
        this.timeline.push({ tick: this.tick, type: 'eliminated', text: `Team ${this.displayName(t) !== t.name ? `${this.displayName(t)} (${t.name})` : t.name} eliminated` });
        this.events.push({ type: 'eliminated', team: t.id });
      }
    }
    this.emit('tickRecord', {
      tick: this.tick,
      robots: this.robots.map(r => ({ id: r.id, x: +r.x.toFixed(2), y: +r.y.toFixed(2), h: +r.heading.toFixed(2), hp: r.health, heat: +r.heat.toFixed(1), alive: r.alive, st: live.includes(r) ? r.lastStatus : r.alive ? 'new' : 'dead', cmd: live.includes(r) ? r.lastCmd : null, err: live.includes(r) && r.lastStatus !== 'ok' ? r.lastError : undefined })),
      teams: this.commanderMode ? this.teams.map(t => ({ e: +t.energy.toFixed(2), sp: t.energySpent, p: t.pending.length })) : undefined,
      events: this.events.filter(e => e.type !== 'gameover'),
    });
    const active = this.teams.filter(t => !t.eliminated);
    const firstUnit = t => this.robots.find(r => r.alive && r.team === t.id) || null;
    if (active.length <= 1) {
      const t = active[0] || null;
      this._end(t, firstUnit(t || {}), t ? 'last team standing' : 'mutual destruction');
    } else if (this.tick >= cfg.maxTicks) {
      const sc = active.map(t => ({ t, s: this.teamScore(t) })).sort((a, b) => b.s - a.s);
      const tie = Math.abs(sc[0].s - sc[1].s) < 1e-9;
      const what = this.commanderMode ? 'score' : 'health';
      this._end(tie ? null : sc[0].t, tie ? null : firstUnit(sc[0].t), tie ? `time limit - tie at ${Math.round(sc[0].s)} ${what}` : `time limit - best ${what} (${Math.round(sc[0].s)})`);
    }
    this._emit();
  }

  /** remaining unit health (+ commander mode: timerDamageWeight * damage dealt to enemies) */
  teamScore(t) {
    const hp = this.robots.filter(r => r.alive && r.team === t.id).reduce((s, r) => s + r.health, 0);
    return this.commanderMode ? r1(hp + this.cfg.commander.timerDamageWeight * t.damageDealt) : hp;
  }

  _end(team, unit, reason) {
    this.status = 'over';
    this.winner = { id: unit ? unit.id : null, team: team ? team.id : null, name: team ? team.name : 'nobody', displayName: team ? this.displayName(team) : 'nobody', reason };
    this.events.push({ type: 'gameover', winner: this.winner });
    this.emit('matchEnd', this.matchSummary());
    clearTimeout(this._timer); this._timer = null;
    console.log(`[referee] match ${this.matchNo} over at tick ${this.tick}: ${this.winner.name} (${reason})`);
    const hold = this.holdNext || !!this.cfg.pauseAfterMatch;
    this.holdNext = false;
    if (hold) { this.paused = true; this._restartAt = null; console.log(`[referee] holding after match ${this.matchNo} (paused until resume / fight)`); }
    else if (this.cfg.autoRestart) {
      this._restartAt = Date.now() + this.cfg.autoRestartDelayMs;
      this._restartTimer = setTimeout(() => { if (this.cfg.autoRestart && this.status === 'over') this.restart(); }, this.cfg.autoRestartDelayMs);
    }
  }

  _damage(r, amount, by, cause) {
    if (!r.alive || amount <= 0) return;
    const real = Math.min(r.health, amount);
    r.health = Math.max(0, r.health - amount);
    r.damageTaken += amount;
    r.stats.damageTaken += real;
    if (cause === 'wall') r.stats.wallBumps++;
    if (cause === 'ram') r.stats.rams++;
    if (by && by !== r) {
      if (by.team === r.team) { by.stats.friendlyDamage += real; this.teams[by.team].friendlyDamage += real; }
      else { by.stats.damageDealt += real; this.teams[by.team].damageDealt += real; }
      if (cause === 'shell') { by.stats.hitsOn[r.name] = (by.stats.hitsOn[r.name] || 0) + 1; r.stats.hitsBy[by.name] = (r.stats.hitsBy[by.name] || 0) + 1; }
      if (cause === 'shell' && by.team !== r.team && !this.timeline.some(e => e.type === 'first_blood')) this.timeline.push({ tick: this.tick, type: 'first_blood', text: `${by.name} drew first blood on ${r.name} (${real} dmg)` });
      if (cause === 'shell' && real >= 24) this.timeline.push({ tick: this.tick, type: 'big_hit', text: `${by.name} hit ${r.name} for ${real}` });
    }
    if (r.health <= 0) {
      r.alive = false;
      r.thought = `destroyed by ${by ? by.name : cause}`;
      if (by && by !== r && by.team !== r.team) by.kills++;
      this._recordDeath(r, by, cause);
      this.events.push({ type: 'death', id: r.id, by: by ? by.id : null, cause, x: r.x, y: r.y });
    }
  }

  _recordDeath(r, by, cause) {
    r.stats.deathTick = this.tick; r.stats.deathPos = { x: Math.round(r.x), y: Math.round(r.y) };
    r.stats.killedBy = by ? by.name : null; r.stats.deathCause = cause;
    this.deathOrder.push(r.id);
    // free the dead unit's sandbox now (its controller is never called again): keeps the team worker small and
    // a respawn after a kill only reloads units that are still alive. newMatch() disposing it again is a no-op.
    if (r.controller && r.controller.dispose) r.controller.dispose();
    const text = `${r.name} ${cause === 'disqualified' ? 'was disqualified' : 'was destroyed by ' + (by ? by.name : cause)} at (${Math.round(r.x)},${Math.round(r.y)})`;
    if (r.kind === 'hero' || !this.commanderMode) this.timeline.push({ tick: this.tick, type: 'death', text });
    else this.timeline.push({ tick: this.tick, type: 'drone_death', text });
    if (this.teams) {
      this._teamLog(this.teams[r.team], text);
      if (by && by.team !== r.team) this._teamLog(this.teams[by.team], `${by.name} destroyed ${r.name}`);
    }
  }

  _meta(r) { return r.controller && r.controller.meta ? r.controller.meta : null; }

  /** Add a unit mid-match directly (tests/tools). Prefer orders in commander mode. */
  spawnUnit(team, u) {
    const t = this.teams[team]; if (!t) throw new Error('unknown team ' + team);
    const r = this._createUnit(t, u.type || 'hero', u.x, u.y, u.heading || 0);
    return r;
  }

  _doScan(r) {
    let best = null;
    for (const o of this.robots) {
      if (o === r || !o.alive) continue;
      const d = dist(r.x, r.y, o.x, o.y);
      const b = bearing(r.x, r.y, o.x, o.y);
      const angularRadius = Math.asin(Math.min(1, o.spec.radius / Math.max(d, 1e-6))) / DEG;
      if (Math.abs(angDiff(r.scan.dir, b)) <= r.scan.width / 2 + angularRadius) {
        if (!best || d < best.distance) best = { bearing: +b.toFixed(1), distance: +d.toFixed(1), targetId: o.id, team: o.team, friendly: o.team === r.team, kind: o.kind };
      }
    }
    r.scanResult = best;
    // team intel for the battle plan / status API: enemies any unit of the team has scanned recently
    if (best && !best.friendly && this.teams) {
      const o = this.robots[best.targetId];
      this.teams[r.team].seen.set(o.id, { id: o.id, team: o.team, kind: o.kind, x: Math.round(o.x), y: Math.round(o.y), tick: this.tick, by: r.name });
    }
  }

  async _ask(r, sense) {
    const t0 = Date.now();
    let timer;
    const timeout = new Promise(res => { timer = setTimeout(() => res({ status: 'late', error: `no reply within ${this.cfg.controllerTimeoutMs}ms` }), this.cfg.controllerTimeoutMs); });
    const call = Promise.resolve()
      .then(() => r.controller(sense))
      .then(value => ({ status: 'ok', value }), err => ({ status: 'error', error: String(err && err.message || err) }));
    const out = await Promise.race([call, timeout]);
    clearTimeout(timer);
    out.ms = Date.now() - t0;
    this.emit('reply', { matchNo: this.matchNo, tick: this.tick, robot: r.name, driver: r.driver, status: out.status, ms: out.ms, error: out.error || null });
    return out;
  }

  // What a unit is allowed to know. Deep-copied so controllers cannot mutate the world.
  _buildSense(r) {
    const cfg = this.cfg, sp = r.spec;
    const res = r.scanResult;
    const t = this.teams[r.team];
    const mates = this.robots.filter(o => o.alive && o.team === r.team && o !== r);
    return JSON.parse(JSON.stringify({
      tick: this.tick,
      ticksLeft: cfg.maxTicks - this.tick,
      arena: cfg.arena,
      limits: { maxMove: sp.maxMove, maxTurn: sp.maxTurn, scanWidth: [cfg.scanMinWidth, sp.scanMaxWidth], power: [1, sp.maxPower], maxHeat: sp.maxHeat, shellSpeed: sp.shellSpeed, heatPerPower: sp.heatPerPower, coolPerTick: sp.coolPerTick, arena: { w: cfg.arena.w, h: cfg.arena.h } },
      self: {
        id: r.id, name: r.name, team: r.team, kind: r.kind, type: r.type, radius: sp.radius, maxHealth: sp.health,
        x: +r.x.toFixed(1), y: +r.y.toFixed(1), heading: +r.heading.toFixed(1),
        health: r.health, heat: +r.heat.toFixed(1),
        canFire: r.heat + sp.heatPerPower <= sp.maxHeat,
        damageTakenLastTick: r.damageTaken, hitWallLastTick: r.hitWall,
      },
      scan: {
        dir: +r.scan.dir.toFixed(1), width: r.scan.width,
        // nearest unit inside the arc requested last tick (or null). bearing is absolute degrees.
        result: res ? { bearing: res.bearing, distance: res.distance, relBearing: +angDiff(r.heading, res.bearing).toFixed(1), team: res.team, friendly: res.friendly, kind: res.kind } : null,
      },
      team: { energy: Math.floor(t.energy), unitsAlive: mates.length + 1 },
      allies: mates.map(o => ({ id: o.id, type: o.type, kind: o.kind, radius: o.spec.radius, x: +o.x.toFixed(1), y: +o.y.toFixed(1), heading: +o.heading.toFixed(1), health: o.health })),
      unitsAlive: this.robots.filter(o => o.alive).length,
      teamsAlive: this.teams.filter(o => !o.eliminated).length,
    }));
  }

  // ---------- end-of-match summary (feeds the between-round report) ----------
  matchSummary() {
    const alive = this.robots.filter(r => r.alive).sort((a, b) => b.health - a.health);
    const dead = [...this.deathOrder].reverse().map(id => this.robots[id]);
    const order = [...alive, ...dead];
    // team placement: winner first, then surviving teams by score, then eliminated teams (latest first)
    const tOrder = [...this.teams].sort((a, b) => {
      if (this.winner && this.winner.team === a.id) return -1; if (this.winner && this.winner.team === b.id) return 1;
      if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
      if (a.eliminated) return b.eliminatedTick - a.eliminatedTick;
      return this.teamScore(b) - this.teamScore(a);
    });
    return {
      matchNo: this.matchNo, seed: this.seed, mode: this.cfg.mode, ticks: this.tick, maxTicks: this.cfg.maxTicks, winner: this.winner,
      teams: this.teams.map(t => ({
        id: t.id, name: t.name, displayName: this.displayName(t), color: t.color, seat: t.seat, placement: tOrder.indexOf(t) + 1,
        eliminated: t.eliminated, eliminatedTick: t.eliminatedTick, score: this.teamScore(t),
        unitsAlive: this.robots.filter(r => r.alive && r.team === t.id).length,
        damageDealt: t.damageDealt, friendlyDamage: t.friendlyDamage,
        energyStart: t.energyStart, energyGained: r1(t.energyGained), energySpent: t.energySpent, energyLeft: r1(t.energy),
        deployed: { ...t.deployed }, byType: { ...t.byType }, droneTypes: t.droneTypes,
        arsenal: t.arsenal ? { budget: t.arsenal.budget, bought: { ...t.arsenal.bought }, spent: t.arsenal.spent, reserveEnergy: t.arsenal.reserveEnergy, launchedAtStart: { ...t.arsenal.launchedAtStart }, fromReserve: { ...t.arsenal.fromReserve }, unused: { ...t.arsenal.reserve }, notes: t.arsenal.notes.slice() } : null,
        ordersApi: t.ordersApi, ordersScript: t.ordersScript, battlePlanRuns: t.battlePlanRuns, orders: t.orders.slice(-60), handicap: t.handicap,
        battlePlan: t.battlePlanMeta ? { ...t.battlePlanMeta, disabled: t.battlePlanDisabled } : null,
        commanderRuns: t.battlePlanRuns, commander: t.battlePlanMeta ? { ...t.battlePlanMeta, disabled: t.battlePlanDisabled } : null, // deprecated aliases (API < 4.2)
      })),
      robots: this.robots.map(r => ({
        id: r.id, name: r.name, team: r.team, kind: r.kind, type: r.type, spawnTick: r.spawnTick, driver: r.driver, meta: this._meta(r) ? { ...this._meta(r) } : null,
        placement: order.indexOf(r) + 1, alive: r.alive, health: Math.round(r.health), maxHealth: r.spec.health,
        shotsFired: r.shotsFired, shotsHit: r.shotsHit, kills: r.kills,
        ...r.stats,
      })),
      timeline: this.timeline,
    };
  }

  // ---------- spectator view ----------
  publicState() {
    const cc = this.cfg.commander;
    return {
      matchNo: this.matchNo, seed: this.seed, tick: this.tick, maxTicks: this.cfg.maxTicks, status: this.status, mode: this.cfg.mode,
      teams: (this.teams || []).map((t, i) => {
        const re = this.roster[i] || {};
        const u = this.robots.filter(r => r.alive && r.team === t.id);
        return {
          id: t.id, name: t.name, color: t.color, seat: t.seat, home: t.home,
          avatar: typeof re.avatar === 'function' ? re.avatar() : null, avatarKind: typeof re.avatarKind === 'function' ? re.avatarKind() : 'none',
          displayName: this.displayName(t),
          energy: r1(t.energy), energyMax: cc.energyMax, energySpent: t.energySpent,
          heroes: u.filter(r => r.kind === 'hero').length, drones: u.filter(r => r.kind === 'drone').length,
          pending: t.pending.map(p => ({ type: p.type, kind: p.kind, readyTick: p.readyTick })),
          deployed: t.deployed, droneTypes: t.droneTypes, arsenal: this._arsenalPublic(t), hasBattlePlan: !!t.battlePlan || !!t.battlePlanMeta, battlePlanThought: t.battlePlanThought,
          hasCommander: !!t.battlePlan || !!t.battlePlanMeta, commanderThought: t.battlePlanThought, // deprecated aliases (API < 4.2)
          eliminated: t.eliminated, score: this.teamScore(t), damageDealt: t.damageDealt,
        };
      }),
      paused: this.paused, tickMs: this.cfg.tickMs, autoRestart: this.cfg.autoRestart,
      pauseAfterMatch: !!this.cfg.pauseAfterMatch, holdAfterMatch: this.holdNext, held: this.status === 'over' && this.paused,
      restartInMs: this.status === 'over' && !this.paused && this.cfg.autoRestart && this._restartAt ? Math.max(0, this._restartAt - Date.now()) : null,
      arena: this.cfg.arena, robotRadius: this.cfg.robotRadius, winner: this.winner,
      robots: this.robots.map(r => ({
        id: r.id, name: r.name, color: r.color, team: r.team, kind: r.kind, type: r.type, radius: r.spec.radius, maxHealth: r.spec.health, spawnTick: r.spawnTick,
        x: r.x, y: r.y, heading: r.heading,
        health: r.health, heat: r.heat, alive: r.alive, thought: r.thought,
        scan: r.scan, scanResult: r.scanResult, lastCmd: r.lastCmd, lastStatus: r.lastStatus,
        lastError: r.lastError, lastLatencyMs: r.lastLatencyMs, lastSense: r.alive ? r.lastSense : null,
        kills: r.kills, shotsFired: r.shotsFired, shotsHit: r.shotsHit,
        driver: r.driver, memory: r.memory, thinking: r.thinking, thinkStart: r.thinkStart, meta: this._meta(r),
      })),
      shells: this.shells.map(s => ({ id: s.id, owner: s.owner, power: s.power, small: s.small, x: s.x, y: s.y, vx: s.vx, vy: s.vy })),
      events: this.events,
    };
  }

  _emit() { this.emit('state', this.publicState()); }
  _emitThinking() {
    this.emit('thinking', { matchNo: this.matchNo, tick: this.tick, now: Date.now(), robots: this.robots.map(r => ({ id: r.id, thinking: r.thinking, since: r.thinkStart })) });
  }
}

module.exports = { Referee, mulberry32 };
