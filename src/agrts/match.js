'use strict';
// Authoritative Iteration 11 match. Fixed 800×380 field, 50ms steps at 1.2×.
// Team decisions come from this.decisions (src/agrts/team-decisions.js) while a side's
// driver is simulated. A warrior driver takes its opening, buy queue, deploy and spend
// from the seat. Orders already queued survive match boot, so a wave posted while the
// match is held still deploys on the next one. An empty queue holds. After one
// open-field cadence we may fall back to considerDeploy (warriorAutopilot), unless
// that seat has fetched a report or posted an order inside its active window. The wire
// protocol (src/agrts/protocol.js) writes one report outbox per seat, from that seat's
// view, and applies DEPLOY, HOLD, BUY, BANK, FOCUS and AUTOBUY to the seat that posted them.
// Movement, pathing, shots and healing stay automatic. FOCUS only re-orders target choice;
// AUTOBUY is a standing BUY + DEPLOY rule. Both last until cleared or the match ends.

const { EventEmitter } = require('events');
const C = require('./constants');
const D = require('./team-decisions');
const P = require('./protocol');
const U = require('./units');
const V = require('./version');
const { Availability } = require('./availability');
const K = require('./commander');

const { TYPES, TYPE_IDS, FIELD_COST, MAX_BUYS, FIELD_W: W, FIELD_H: H, MATCH_CAP, STEP, SPEED, TEAM, cloneCounts, total } = C;

/** True when x is inside that side's home zone. The same cut considerDeploy uses for base threat. */
function inHomeZone(side, x) {
  return side === 0 ? x < W * 0.29 : x > W * 0.71;
}

function emptyCounts() {
  return C.emptyCounts();
}

/** Per-observer counts since that seat's last report: losses, buys, focus kills (by the killer side), autobuys. */
function emptyWire() {
  return { loss: [emptyCounts(), emptyCounts()], buy: [emptyCounts(), emptyCounts()], focus: [emptyCounts(), emptyCounts()], auto: [emptyCounts(), emptyCounts()], hits: [[], []] };
}

/** Units on the ground: they capture, contest and count in fights. A flying unit (units.csv flying) does not. */
function grounded(u) { return !U.isFlying(u.type); }
// Drones are launch and forget (docs/DRONE.md): on its first step a kamikaze unit picks one enemy
// (see _droneLaunchPick), locks that unit's id and flies at it until it hits or dies. It never holds,
// hovers or waits, and later MOVE / FOCUS orders do not retarget it; only the target's death does.
// An engaged enemy fired or was hit in the last ENGAGED_S seconds and stands within ENGAGED_NEAR px
// of one of our ground units. The commander (src/agrts/commander.js) keeps its Drones in reserve and
// launches them only while such a stack exists.
const ENGAGED_S = 2;
const ENGAGED_NEAR = 130;
// Solid units (docs/SPEC.md §5.6). Each unit is a circle of its units.csv radius and bumps only into
// units on its own plane (units.csv plane: ground, air, ...). After every step, overlapping pairs are
// pushed apart (SEP_PASSES relaxation passes, heavier units move less). A unit walking into a friend
// slides sideways round it (STEER_LOOK px of lookahead past contact).
const SEP_CELL = 64;
const SEP_PASSES = 3;
const STEER_LOOK = 16;
// MOVE slots: up to SLOT_LANES lanes across the field, SLOT_GAP px apart, rows SLOT_DEPTH px deep.
const SLOT_LANES = 7;
const SLOT_GAP = 32;
const SLOT_DEPTH = 32;
// MOVE pace: a ranged unit or healer on its way to a MOVE zone stays no more than PACE_FREE px ahead
// of the group's most forward front-liner (armor, else fast), and PACE_GAP px behind it once an enemy
// ground unit is within PACE_NEAR px, so the tough units meet the enemy first. When it is already
// PACE_MAX px or more ahead (a late MOVE, a stuck front-liner), it does not wait.
const PACE_GAP = 24;
const PACE_MAX = 150;
const PACE_NEAR = 160;
const PACE_FREE = 60;
// Pace is a speed match, not a stop: within PACE_EASE px of the pace line a follower slows from its
// own speed to the lead's, and past the line it slows to 0 over PACE_RAMP px. No stop-and-go.
const PACE_EASE = 20;
const PACE_RAMP = 16;
// Steering round a friend keeps its side (and that friend) for STEER_KEEP_S seconds, so a unit
// does not flip left/right every step.
const STEER_KEEP_S = 0.6;
// A MOVE slot counts as reached within SLOT_ARRIVE px, within SLOT_PRESSED px while pressed by
// other units, or after SLOT_STALL_S seconds without getting closer while within SLOT_STALL_NEAR px.
const SLOT_ARRIVE = 6;
const SLOT_PRESSED = 24;
const SLOT_STALL_S = 1;
const SLOT_STALL_NEAR = 64;
// A unit on MOVE engages a ground enemy within its range + ENGAGE_EXTRA px in its zone, its goal
// zone, the zones between, or one zone beyond either, instead of walking past it to its slot.
const ENGAGE_EXTRA = 60;
/** Slot row for a role: front-liners (armor, fast) 0, ranged and others 1, healers 2. */
function slotRank(type) {
  const r = U.roleOf(type);
  return r === 'armor' || r === 'fast' ? 0 : r === 'healer' ? 2 : 1;
}
function planeOfUnit(u) { return U.planeOf(u.type); }
/** Distance a unit closes to before it stops and shoots: 55% of its range, never inside the target's hull. */
function standoffOf(a, u, v) {
  const base = a.range * 0.55;
  if (!v || planeOfUnit(u) !== planeOfUnit(v)) return base;
  return Math.min(a.range * 0.95, Math.max(base, a.r + TYPES[v.type].r + 3));
}

function expandReserve(rem) {
  const types = [];
  for (const k of TYPE_IDS) for (let i = 0; i < (rem[k] || 0); i++) types.push(k);
  return types;
}

/**
 * The units a DEPLOY ALL fields when only `room` active slots are free: one of each ground type in
 * table order, round and round (so 1S 3R 3T 1M into 6 slots is 1S 2R 2T 1M), then flying units
 * (Drones are launch and forget, so DEPLOY ALL never spends the last slots on them first).
 * Everything when it fits.
 */
function capPick(rem, room) {
  const all = expandReserve(rem);
  if (!(room < all.length)) return all;
  const left = cloneCounts(rem);
  const out = [];
  const tiers = [TYPE_IDS.filter(k => !U.isFlying(k)), TYPE_IDS.filter(k => U.isFlying(k))];
  for (const tier of tiers) {
    let more = true;
    while (out.length < room && more) {
      more = false;
      for (const k of tier) {
        if (out.length >= room) break;
        if (left[k] > 0) { out.push(k); left[k]--; more = true; }
      }
    }
  }
  return out;
}

function addCounts(dst, src) {
  for (const k of TYPE_IDS) dst[k] = (dst[k] || 0) + (src[k] || 0);
}

class AgrtsMatch extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.baseSeed = Number.isInteger(opts.seed) ? (opts.seed >>> 0) : Math.floor(Math.random() * 0x7fffffff);
    this.labels = opts.labels || TEAM.map(t => ({ ...t }));
    this.styleOverride = [null, null];
    if (opts.styles) opts.styles.forEach((s, i) => { if (s) this.styleOverride[i] = D.normalizeStyle(s); });
    this.decisions = D.createDecisionSource(opts.decisions || {});
    this.decisionQueue = [[], []]; // live deploy orders; kept across boot so a held post still deploys
    this.drivers = ['simulated', 'simulated']; // survives boot; a claimed seat is 'warrior'
    this.warriorOrders = [null, null]; // opening arsenal + buy queue; survives boot
    this.warriorQuietSince = [0, 0]; // sim time of the last warrior order or wave; boot resets it
    this.warriorAutopilot = opts.warriorAutopilot !== false; // empty queue falls back to considerDeploy
    // Match seconds. A live report fetch or an order post keeps autopilot and auto-buy off.
    this.warriorActiveS = Number.isFinite(opts.warriorActiveS) && opts.warriorActiveS >= 0 ? opts.warriorActiveS : P.readEnvNumber('WARRIOR_ACTIVE_S', 20);
    // Ember's command layer (deploy, buy, decision title). 0 disables the throttle.
    // The first call is allowed at T0. Movement and combat are not gated.
    this.npcDecisionS = Number.isFinite(opts.npcDecisionS) && opts.npcDecisionS >= 0 ? opts.npcDecisionS : P.readEnvNumber('NPC_DECISION_S', 4.4);
    this.warriorSeenAt = [null, null];
    this.warriorPolls = [0, 0]; // live report requests in flight; a long-poll stays "talking"
    this.relayPolls = [0, 0]; // the same, for long-polls held open on the relay
    this.protocolAutopilotNote = [false, false];
    this.bankHold = [false, false]; // BANK skips auto-buy until BUY, or until an opening or a plan
    this.warriorWired = [false, false]; // any wire order this match: live BUY only, no auto-spend
    // Standing warrior orders. Kept across a pre-start reboot (an opening posted on READY);
    // cleared when the match ends and on restart.
    this.focus = [null, null]; // FOCUS: unit type our units shoot first when one is in range
    this.focusScope = [null, null]; // scoped FOCUS: { units: Set|null, zone: 0..7|null }; null = every unit, everywhere
    this.radioT0 = [[], []]; // radio orders (and scoped FOCUS) posted on READY, applied at T0 in order
    this.autobuy = [null, null]; // AUTOBUY: { type, reserve, why } bought and fielded when the bank covers it
    this.liveBuys = [0, 0]; // live BUYs + autobuys this match (the auto queue counts in reinf)
    // The NPC commander: a simulated side posts MOVE/ASSIST/FOCUS/AUTOBUY/FALLBACK/CLEAR through
    // applyProtocolOrders, once per NPC decision window (src/agrts/commander.js). On for Ember by
    // default; EMBER_COMMANDER=0 (or opts.emberCommander:false) brings back the old wave brain.
    const emberCmd = opts.emberCommander != null ? opts.emberCommander !== false : P.readEnvNumber('EMBER_COMMANDER', 1) !== 0;
    this.npcCommander = [false, emberCmd];
    this.commanderMem = [null, null];
    // The commander drafts and buys Drones (kamikaze role) unless this is off (opts.npcDrones:false or NPC_DRONES=0).
    // Remote Ember seat (PvP step 4, docs/SPEC.md §5.4 "Remote Ember seat"). Off (0) unless the host runs two seats:
    // then a seated Ember warrior silent for this many match seconds (no report fetch, no order, no open poll) is
    // played by the built-in commander until it posts or polls again. Green never uses it.
    this.emberTakeoverS = Number.isFinite(opts.emberTakeoverS) && opts.emberTakeoverS > 0 ? opts.emberTakeoverS : 0;
    this.takeover = [false, false];
    this.npcDrones = opts.npcDrones != null ? opts.npcDrones !== false : P.readEnvNumber('NPC_DRONES', 1) !== 0;
    // Base income (credits per income tick from each base) and the active-unit cap (docs/SPEC.md §5.4, §5.5).
    // Defaults come from constants.js (env BASE_INCOME, ACTIVE_CAP); a match may pass its own.
    this.baseIncome = Number.isFinite(opts.baseIncome) && opts.baseIncome >= 0 ? opts.baseIncome : C.BASE_INCOME;
    this.activeCap = Number.isFinite(opts.activeCap) && opts.activeCap >= 0 ? Math.floor(opts.activeCap) : C.ACTIVE_CAP;
    // Default assist radius in zones (C.ASSIST_RADIUS_DEFAULT). 0 turns default assist off.
    this.assistRadius = Number.isInteger(opts.assistRadius) && opts.assistRadius >= 0 ? opts.assistRadius : C.ASSIST_RADIUS_DEFAULT;
    // One outbox per side. Index 0 is the left seat (Green), 1 is the right (Ember).
    this.protocolReports = [[], []];
    this.protocolSeq = [0, 0];
    this.protocolPending = [null, null];
    this.protocolLastAt = [0, 0];
    this.protocolCreditOpen = [false, false]; // true after we have announced that this side's bank covers its next buy
    this.protocolSnap = [null, null]; // land at this seat's previous report, for the v2 delta
    this.wirePending = [0, 1].map(() => emptyWire());
    this.queueSource = ['simulated', 'simulated'];
    this.matchNo = opts.matchNo || 1;
    this.holdNext = false;
    this.pauseAfterMatch = opts.pauseAfterMatch !== false;
    // The arena host turns this on. Headless unit tests leave it off and call update() directly.
    this.awaitViewer = opts.awaitViewer === true;
    // Wall-clock speed of the live loop (tests only: SIM_REALTIME_X on the host). Steps are the same, just more per tick.
    this.realtimeX = Number.isFinite(opts.realtimeX) && opts.realtimeX >= 1 ? Math.min(20, Math.floor(opts.realtimeX)) : 1;
    this.phase = 'live'; // waiting | countdown | live. Only live steps the sim clock.
    // Availability (availability.js, docs/SPEC.md §5.4 "Availability", PvP step 3): free | busy | reserved. Information only:
    // nothing in the sim reads it. A reservation change or expiry re-emits state so healthz and the relay frame show it.
    this.availability = new Availability({ onChange: () => this._emit() });
    this.countdown = null;
    this.viewers = 0;
    this.relayViewers = 0;
    this.localViewers = 0;
    this._countdownUntil = 0;
    this._timer = null;
    this._endEmitted = false;
    this._boot();
  }

  useDecisions(source) {
    this.decisions = D.createDecisionSource(source || {});
    return this.decisions.id;
  }

  /** Queue one deploy or hold for a side. A warrior seat treats this as its deploy brain. */
  pushDecision(side, item) {
    const q = this.decisionQueue[side];
    if (!q || q.length >= 8) return false;
    q.push(item);
    return true;
  }

  setDriver(side, driver) {
    if (side !== 0 && side !== 1) return null;
    const next = driver === 'warrior' ? 'warrior' : 'simulated';
    this.drivers[side] = next;
    this.sayState[side] = '';
    this.warriorQuietSince[side] = this.elapsed;
    if (next === 'warrior' && !this.over) {
      this._say(side, 'AWAITING WARRIOR', 'This side waits for a seat decision. Post one with warrior-seat.js decision.');
    } else if (!this.over) {
      this._say(side, 'Reading the field…', 'Seat released. The simulated brain takes the next order.');
    }
    this._emit();
    return next;
  }

  /** Opening arsenal and buy queue for a warrior side. Applies now only before the first step. */
  setOpening(side, order) {
    if (side !== 0 && side !== 1) return null;
    // An opening is a fresh stance: BANK does not carry into it.
    this.bankHold[side] = false;
    this.warriorOrders[side] = {
      arsenal: cloneCounts(order.arsenal || {}),
      queue: (order.queue || []).filter(k => TYPES[k]).slice(0, MAX_BUYS),
      spend: order.spend === true,
    };
    if (this.elapsed === 0 && this.steps === 0 && !this.over) {
      const hold = this.paused;
      this._boot();
      this.paused = hold;
      this._emit();
      return 'this match';
    }
    return 'next match';
  }

  setStyle(side, style) {
    this.styleOverride[side] = D.normalizeStyle(style);
    // A plan is the stance. It clears BANK the same way an opening does.
    if (side === 0 || side === 1) this.bankHold[side] = false;
    const fresh = this.elapsed === 0 && this.steps === 0 && !this.over;
    // A warrior arsenal is explicit. Restyling must not roll a simulated draft.
    if (this.drivers[side] === 'warrior') {
      if (fresh) this.plans[side] = this.styleOverride[side];
      this._emit();
      return fresh ? 'this match' : 'next match';
    }
    if (fresh) {
      const hold = this.paused;
      this._boot();
      this.paused = hold;
      this._emit();
      return 'this match';
    }
    return 'next match';
  }

  start() {
    this._emit();
    if (this._timer) return;
    let acc = 0;
    this._timer = setInterval(() => {
      try {
        if (this.phase !== 'live') {
          this._gateTick();
          return;
        }
        if (this.paused || this.over) return;
        const x = this.realtimeX || 1;
        acc += STEP * SPEED * x;
        let n = 0;
        while (acc >= STEP && n < 2 * x) { this.update(STEP); acc -= STEP; n++; }
        if (n === 2 * x && acc >= STEP) acc = STEP - 0.001;
        this._emit();
      } catch (e) {
        this.error = String(e && e.stack || e).split('\n')[0].slice(0, 180);
        this._emit();
      }
    }, 50);
    if (this._timer.unref) this._timer.unref();
  }

  stop() { clearInterval(this._timer); this._timer = null; if (this.availability) this.availability.stop(); }

  pause() { this.paused = true; this._emit(); }
  /** Re-arm a match that has not stepped yet (a driver change on a held match, e.g. a PvP Ember seat): new READY, same hold. */
  rearm() {
    if (this.elapsed !== 0 || this.steps !== 0 || this.over) return false;
    const hold = this.paused;
    this._boot();
    this.paused = hold;
    this._emit();
    return true;
  }
  resume() {
    if (this.over) { this.restart(); return; }
    this.paused = false;
    this.holdNext = false;
    this._emit();
  }
  restart() {
    this._clearStanding();
    this.matchNo++;
    this._endEmitted = false;
    this._boot();
    this.paused = false;
    this._emit();
  }

  _boot() {
    // units.csv is re-read here, at the start of every match and never mid-match. A bad file
    // keeps the last good table (src/agrts/units.js logs why); the error shows in unitsError.
    const units = U.reload();
    this.unitsError = units.error || '';
    // Locked unit table (units-lock.js): is this match's table the official one? Information only.
    this.unitsLock = U.lockStatus();
    this.rng = C.mulberry32((this.baseSeed + this.matchNo * 997) >>> 0);
    const roll = () => C.OPENING_STYLES[Math.floor(this.rng() * C.OPENING_STYLES.length)];
    this.plans = [0, 1].map(s => this.styleOverride[s] || roll());
    const rosters = [0, 1].map(s => this._draftSide(s));
    this.rosters = rosters.map(cloneCounts);
    this.queue = [0, 1].map(s => this._queueSide(s));
    this.queueSource = [0, 1].map(s => (this.drivers[s] === 'warrior' ? 'warrior' : 'simulated'));
    this.reserve = this.rosters.map(cloneCounts);
    this.units = [];
    this.shots = []; this.sparks = []; this.combatFx = []; this.spawnFx = [];
    this.capturePulses = []; this.spendPulses = []; this.healPopups = []; this.notices = [];
    this.hp = [100, 100];
    this.elapsed = 0; this.steps = 0; this.cameraShake = 0;
    this.paused = false; this.over = false; this.winner = null; this.error = '';
    this.logs = [];
    this.lastDeployAt = [-8, -7];
    this.land = Array(8).fill(0);
    this.fieldCredits = [0, 0];
    this.incomeClock = 0;
    this.incomeTotal = [0, 0]; // zone + base income paid this match
    this.baseIncomeTotal = [0, 0]; // of which base income
    this.reinf = [0, 0];
    this.sayState = ['', ''];
    // The commander's memory is seeded per match and side (its own rng: this.rng is not drawn),
    // so its temperament and window dice replay with the match seed. Made before the opening line,
    // which names the temperament.
    this.commanderMem = [0, 1].map(s => K.newMemory(this._commanderSeed(s)));
    this.decisionsText = [0, 1].map(s => this._openingLine(s));
    this.warriorQuietSince = [0, 0];
    this.takeover = [false, false]; // a new match starts with the seated warrior in charge
    this.warriorSeenAt = [null, null];
    this.protocolAutopilotNote = [false, false];
    this.npcNextAt = [0, 0];
    this.t0Out = [emptyCounts(), emptyCounts()];
    this.t0Miss = [emptyCounts(), emptyCounts()];
    this.capHeld = [0, 0]; // deploys the active cap kept in reserve this match
    this.decideLog = [[], []];
    this.warriorWired = [false, false];
    this.liveBuys = [0, 0];
    this.panelFeed = [[], []];
    this.protocolSnap = [null, null];
    this.wirePending = [0, 1].map(() => emptyWire());
    this.nextId = 1; this.noticeId = 1;
    this.unitSerial = [{}, {}]; // per side, per type: last number handed out (R1, R2, ...); never reused
    this.lastBuyAt = [{}, {}]; // per side, per type: match time of the last post (or autobuy) that bought it (buy_cooldown_s)
    this.baseDamage = [{ kamikaze: 0, other: 0 }, { kamikaze: 0, other: 0 }]; // damage each base took, by attacker role (sweeps read it)
    this.droneHits = [[], []]; // per side: { t, zone (0..7), k (enemy units hit), kills, shot, by } for each blast
    // MOVE inheritance (docs/SPEC.md §5.4): per side, the latest MOVE ALL and MOVE <code> (no count,
    // no ID) and the latest CLEAR ALL / CLEAR <code>, each with a sequence number. A unit fielded
    // live takes the newest of these that applies to its type (a CLEAR means no order).
    this.moveSeq = 0;
    this.moveMemory = [0, 1].map(() => ({ all: null, types: {}, clearAll: 0, clearTypes: {} }));
    // decisionQueue is intentionally kept. A wave posted while this match was held
    // is the next sim step's order, including the first step after boot.
    this._randomizeTerrain();
    this._log(`${this.awaitViewer ? 'Match armed' : 'Match started'} · GREEN ${this._sourceLabel(0)} · EMBER ${this._sourceLabel(1)}`);
    this._log(`GREEN arsenal · ${this.summary(this.rosters[0]) || 'empty'}`, 0);
    this._log(`EMBER arsenal · ${this.summary(this.rosters[1]) || 'empty'}`, 1);
    // New match clock. A pending credit edge from the previous match must not leak.
    // With the viewer gate, READY is the armed line and START waits until T0.
    // Without it, START is written now. A reboot before the first step rewrites that START.
    this.phase = this.awaitViewer ? 'waiting' : 'live';
    this.countdown = null;
    this._countdownUntil = 0;
    this.protocolPending = [null, null];
    this.protocolCreditOpen = [false, false];
    if (this.awaitViewer) {
      // A reboot before T0 (opening, plan or driver change on a held match) replaces this match's READY.
      // The old one described a draft that will not play: at arena start, Green's READY was written with a
      // simulated roll before its saved opening applied, and the warrior read that roster as its own.
      // Ids stay monotonic: the new READY gets the next id, so a warrior holding the old id sees it as fresh.
      let dropped = false;
      for (let side = 0; side < 2; side++) {
        const list = this.protocolReports[side];
        const keep = list.filter(r => !(r.match === this.matchNo && r.event === 'READY'));
        if (keep.length !== list.length) { this.protocolReports[side] = keep; dropped = true; }
      }
      if (dropped) this.emit('protocolReset');
      this._pushReport(0, 'READY');
      this._pushReport(1, 'READY');
    } else {
      this._pushReport(0, 'START');
      this._pushReport(1, 'START');
    }
  }

  /**
   * Wall clock before the sim. Waiting until a browser is watching, then 5 seconds,
   * then START at elapsed 0. A viewer who leaves after that does not pause the match.
   */
  _gateTick() {
    if (this.over || this.paused) return;
    if (this.phase === 'waiting') {
      if ((this.viewers || 0) >= 1) this._beginCountdown();
      return;
    }
    if (this.phase !== 'countdown') return;
    const left = this._countdownUntil - Date.now();
    if (left <= 0) { this._goLive(); return; }
    const sec = Math.max(1, Math.ceil(left / 1000));
    if (sec !== this.countdown) {
      this.countdown = sec;
      this._emit();
    }
  }

  _beginCountdown() {
    if (this.phase !== 'waiting' || this.paused || this.over) return;
    this.phase = 'countdown';
    this.countdown = 5;
    this._countdownUntil = Date.now() + 5000;
    // The watch page reads phase. The seat outbox does not get a COUNTDOWN record:
    // READY is enough, and a pre-start DEPLOY is already queued for T0.
    this._emit();
  }

  _goLive() {
    if (this.phase === 'live') return;
    this.phase = 'live';
    this.countdown = null;
    this._countdownUntil = 0;
    this._drainT0(0);
    this._drainT0(1);
    this._drainRadioT0(0);
    this._drainRadioT0(1);
    this._pushReport(0, 'START');
    this._pushReport(1, 'START');
    this._emit();
  }

  setRelayViewers(n) {
    this.relayViewers = Math.max(0, n | 0);
    this._syncViewers();
  }

  setLocalViewers(n) {
    this.localViewers = Math.max(0, n | 0);
    this._syncViewers();
  }

  _syncViewers() {
    const n = (this.relayViewers || 0) + (this.localViewers || 0);
    const changed = n !== this.viewers;
    this.viewers = n;
    if (this.phase === 'waiting' && n >= 1 && !this.paused && !this.over) {
      this._beginCountdown();
      return;
    }
    if (changed) this._emit();
  }

  /** A long-poll stops on a real pause or after the match. Waiting and countdown stay open. */
  reportStop() {
    if (this.over) return true;
    if (this.phase !== 'live') return false;
    return !!this.paused;
  }

  _draftSide(s) {
    if (this.drivers[s] === 'warrior') {
      const order = this.warriorOrders[s];
      return order && order.arsenal ? cloneCounts(order.arsenal) : emptyCounts();
    }
    const draft = this.decisions.draftArsenal({ side: s, style: this.plans[s], rng: this.rng });
    // The commander swaps a few units for Drones with its own seeded dice (this.rng is not drawn).
    if (this._commanderOn(s) && this.npcDrones) return K.draftDrones(cloneCounts(draft), this._commanderSeed(s), this.plans[s]);
    return draft;
  }

  _queueSide(s) {
    if (this.drivers[s] === 'warrior') {
      const order = this.warriorOrders[s];
      return order && order.queue ? order.queue.filter(k => TYPES[k]).slice(0, MAX_BUYS) : [];
    }
    return this.decisions.reinforcementQueue({
      side: s, ours: this.rosters[s], theirs: this.rosters[1 - s], style: this.plans[s], rng: this.rng,
    });
  }

  _sourceLabel(s) {
    if (this.drivers[s] !== 'warrior') return 'simulated agent';
    return this.warriorOrders[s] && this.warriorOrders[s].arsenal ? 'seated warrior' : 'seated warrior, no opening yet';
  }

  _openingLine(s) {
    if (this.drivers[s] === 'warrior') {
      const order = this.warriorOrders[s];
      if (order && order.arsenal) {
        const buys = this.queue[s].length ? this.queue[s].map(k => TYPES[k].name).join(' → ') : 'none';
        return {
          title: 'WARRIOR OPENING',
          detail: `Opening ${this.summary(this.rosters[s]) || 'empty'}. ${this.plans[s]} plan · buys ${buys}.`,
        };
      }
      return {
        title: 'AWAITING WARRIOR',
        detail: 'No opening for this match. Post one for the next match, and post a decision to deploy from the current reserve.',
      };
    }
    if (this._commanderOn(s)) {
      const main = K.mainBuy(this.queue[s]);
      return {
        title: 'Reading the field…',
        detail: `Auto-drafted ${this.summary(this.rosters[s])}. ${this.plans[s]} plan · one army: ${K.describeStyle(this.commanderMem && this.commanderMem[s], s)}${main ? ` · autobuy ${TYPES[main].name}` : ''}.`,
      };
    }
    return {
      title: 'Reading the field…',
      detail: `Auto-drafted ${this.summary(this.rosters[s])}. ${this.plans[s]} plan · spending ${this.queue[s].map(k => TYPES[k].name).join(' → ')}.`,
    };
  }

  summary(o) {
    return TYPE_IDS.filter(k => o[k] > 0).map(k => `${o[k]} ${TYPES[k].name}${o[k] === 1 ? '' : 's'}`).join(' · ');
  }

  update(dt) {
    if (this.paused || this.over) return;
    this.elapsed += dt;
    this.steps++;
    if (this.emberTakeoverS > 0) this._takeoverCheck(1);
    this._emberWindow = this._emberDue();
    this.cameraShake = Math.max(0, this.cameraShake - dt);
    if (this.phase === 'live' && this._emberWindow && this._commanderOn(1)) this._commanderStep(1);
    this._decide();
    // Ember spends its banked credits on each NPC decision window. Territory
    // credit events alone almost never land on that one-step window, so without
    // this call Ember banks forever and never reinforces (see tools/test-ember-buys.js).
    if (this._emberWindow && !this._seated(1)) this._spend(1);
    this._territory(dt);
    if (this.autobuy[0]) this._autobuyStep(0);
    if (this.autobuy[1]) this._autobuyStep(1);
    const sideUnits = [this.units.filter(u => u.side === 0), this.units.filter(u => u.side === 1)];
    const zoneCounts = Array.from({ length: 8 }, () => [0, 0]);
    for (const v of this.units) if (grounded(v)) zoneCounts[Math.min(7, Math.max(0, Math.floor(v.x / (W / 8))))][v.side]++;
    this._buildGrid();
    for (const u of this.units) this._stepUnit(u, dt, sideUnits, zoneCounts);
    this._separate();
    // A kamikaze unit shot down explodes where it falls (death_blast_mult). A blast can down another.
    for (let pass = 0; pass < 6; pass++) {
      let any = false;
      for (const u of this.units) {
        if (u.hp > 0 || u.detonated || !U.isKamikaze(u.type)) continue;
        u.detonated = true; any = true;
        const m = TYPES[u.type].deathBlast;
        if (m > 0) this._detonate(u, m, true);
      }
      if (!any) break;
    }
    this.units = this.units.filter(u => {
      if (u.hp <= 0) {
        this._noteWire('loss', u.side, u.type);
        if (u.focusKill) this._noteWire('focus', 1 - u.side, u.type);
        this._sparks(u.x, u.y, u.side === 0 ? '#bafc82' : '#ff7768', 9);
        return false;
      }
      return true;
    });
    this._protocolTick();
    for (const p of this.sparks) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.94; p.vy *= 0.94; p.life -= dt; }
    this.sparks = this.sparks.filter(p => p.life > 0);
    for (const p of this.spendPulses) p.t += dt;
    this.spendPulses = this.spendPulses.filter(p => p.t < 1.4);
    for (const p of this.healPopups) p.t += dt;
    this.healPopups = this.healPopups.filter(p => p.t < 0.9);
    this.shots = this.shots.filter(s => (s.life -= dt) > 0);
    for (const e of this.combatFx) e.t += dt;
    this.combatFx = this.combatFx.filter(e => e.t < e.life);
    for (const e of this.spawnFx) e.t += dt;
    this.spawnFx = this.spawnFx.filter(e => e.t < e.life);
    for (const p of this.capturePulses) p.t += dt;
    this.capturePulses = this.capturePulses.filter(p => p.t < p.life);
    if (this.phase === 'live' && !this._seated(1) && this.npcDecisionS > 0 && this._emberWindow) {
      this.npcNextAt[1] = this.elapsed + this.npcDecisionS;
    }
    if (this.hp.some(v => v <= 0)) this._end(this.hp[0] <= 0 ? 1 : 0, 'enemy base destroyed');
    else if (this.elapsed >= MATCH_CAP) {
      if (this.hp[0] === this.hp[1]) this._end(null, 'time limit');
      else this._end(this.hp[0] > this.hp[1] ? 0 : 1, 'time limit');
    }
  }

  /** True when this side is simulated and played by the NPC commander (src/agrts/commander.js). */
  _commanderOn(side) {
    // A swapped brain (useDecisions / opts.decisions) owns its side: the commander stays off.
    return !!(this.npcCommander && this.npcCommander[side]) && !this._seated(side) && this.decisions.id === 'simulated';
  }

  /** A warrior drives this side now: claimed, and not handed to the built-in commander (Ember takeover). */
  _seated(side) {
    return this.drivers[side] === 'warrior' && !this.takeover[side];
  }

  /**
   * Remote Ember takeover (emberTakeoverS > 0 only). A seated Ember warrior silent for emberTakeoverS match
   * seconds hands its side to the built-in commander (or the wave brain with EMBER_COMMANDER=0), with a
   * decision-feed note. Any report fetch, order or open poll from the warrior hands it back.
   */
  _takeoverCheck(side) {
    if (this.drivers[side] !== 'warrior' || this.phase !== 'live' || this.over) {
      this.takeover[side] = false;
      return;
    }
    const talking = this._warriorTalking(side);
    if (!this.takeover[side]) {
      const seen = this.warriorSeenAt[side];
      const quiet = this.elapsed - (seen == null ? 0 : seen);
      if (talking || quiet < this.emberTakeoverS) return;
      this.takeover[side] = true;
      this.npcNextAt[side] = this.elapsed; // the commander's first window is now
      this._say(side, 'COMMANDER TAKES OVER', `No word from the ${TEAM[side].log} warrior for ${Math.round(quiet)} s. The built-in commander plays until it posts or polls again.`);
      this._log(`${TEAM[side].log} warrior silent ${Math.round(quiet)} s · built-in commander takes over`, side);
      this._pushPanel(side, { kind: 'hold', verb: 'COMMANDER TAKES OVER', detail: `warrior silent ${Math.round(quiet)} s`, auto: true });
      return;
    }
    if (!talking) return;
    this.takeover[side] = false;
    this.warriorQuietSince[side] = this.elapsed;
    this._say(side, 'WARRIOR BACK', `The ${TEAM[side].log} warrior is back. Standing orders the commander set stay until it changes them.`);
    this._log(`${TEAM[side].log} warrior back · commander hands over`, side);
    this._pushPanel(side, { kind: 'hold', verb: 'WARRIOR BACK', detail: 'commander hands over', auto: false });
  }

  /**
   * One commander window: build its plain-data view, ask commander.js for up to 3 orders and a
   * WHY, and post them through applyProtocolOrders, the same path a warrior seat uses.
   */
  _commanderStep(side) {
    // A decision already queued for this side (pushDecision) takes this window, as it does for the wave brain.
    if ((this.decisionQueue[side] || []).length) return;
    const mem = this.commanderMem[side] || (this.commanderMem[side] = K.newMemory(this._commanderSeed(side)));
    const price = {};
    for (const k of TYPE_IDS) price[k] = this._livePrice(side, k);
    const view = {
      side, elapsed: this.elapsed,
      units: this.units.map(u => ({ side: u.side, tag: this._tagOf(u), type: u.type, x: u.x, y: u.y, hp: u.hp, max: u.max, radio: u.radio ? { kind: u.radio.kind, zone: u.radio.zone, phase: u.radio.phase } : null })),
      reserve: cloneCounts(this.reserve[side]), bank: Math.floor(this.fieldCredits[side]), price,
      focus: this.focus[side], autobuy: this.autobuy[side] ? this.autobuy[side].type : null,
      buyCapped: this._autobuyCapped(side), queue: this.queue[side].slice(),
      activeCap: this.activeCap,
    };
    const drone = this.npcDrones ? U.idsWithRole('kamikaze')[0] : null;
    if (drone) {
      view.drone = drone; view.droneRoom = this._buyCapReason(side, drone) ? 0 : this._buyCapRoom(side, drone);
      // The biggest stack of their ground units already fighting ours (_engagedEnemy), counted the way
      // a blast would catch it: our Drones stay in reserve until there is one (launch and forget).
      const theirGround = this.units.filter(v => v.side !== side && v.hp > 0 && grounded(v));
      const engaged = new Set(theirGround.filter(v => this._engagedEnemy(v, side)));
      const c = engaged.size ? this._clusterPick(theirGround, TYPES[drone].splash, side === 0 ? 0 : W, H / 2, v => engaged.has(v)) : null;
      view.engagedStack = c ? c.n : 0;
    }
    let plan;
    try { plan = K.commanderOrders(view, mem); } catch (e) { this.error = `commander side ${side}: ${e.message || e}`; return; }
    if (plan.lines && plan.lines.length) {
      const res = this.applyProtocolOrders(side, plan.why ? [...plan.lines, `WHY ${plan.why}`] : plan.lines, { npc: true });
      this.commanderLast = this.commanderLast || [null, null];
      this.commanderLast[side] = { t: this.elapsed, lines: plan.lines.slice(), results: (res && res.results) || [] };
      // The autobuy rows say what the rule is for, not the WHY of the window that installed it.
      const rule = this.autobuy[side];
      if (rule && plan.lines.some(l => /^AUTOBUY /.test(l))) rule.why = rule.reserve ? `keeps ${rule.reserve} CR for a medic` : 'autobuy';
    }
    if (plan.title) this._say(side, plan.title, plan.detail || '');
  }

  /** The commander's seed for this match and side: the match seed, mixed so it is not this.rng's stream. */
  _commanderSeed(side) {
    return ((this.baseSeed + this.matchNo * 997) ^ Math.imul(0x2c1b3c6d, side + 1)) >>> 0;
  }

  /** The 6-buy cap (live BUYs + autobuys + queue buys) or the 24-unit roster is reached. */
  _autobuyCapped(side) {
    return this.reinf[side] + this.liveBuys[side] >= MAX_BUYS || total(this.rosters[side]) >= C.ROSTER_LIMIT;
  }

  /** Ember's simulated command layer. The first window is open at T0. A seated Ember is not gated. */
  _emberDue() {
    if (this._seated(1)) return true;
    if (!(this.npcDecisionS > 0)) return true;
    return this.elapsed + 1e-9 >= (this.npcNextAt[1] || 0);
  }

  _decide() {
    for (let s = 0; s < 2; s++) {
      const view = {
        side: s, style: this.plans[s], elapsed: this.elapsed, lastDeployAt: this.lastDeployAt[s],
        width: W, height: H, reserve: cloneCounts(this.reserve[s]),
        units: this.units.map(u => ({ side: u.side, type: u.type, x: u.x, y: u.y, hp: u.hp, max: u.max })),
        hp: this.hp.slice(), rng: this.rng,
      };
      const warrior = this._seated(s);
      let d = null;
      const queued = this.decisionQueue[s].shift();
      if (queued) {
        d = this._applyQueued(queued, view);
        if (d) this.warriorQuietSince[s] = this.elapsed;
      }
      if (!d) {
        // Waiting and countdown do not field. A wave already queued still deploys on the first live step.
        if (this.phase !== 'live') d = { deploy: null };
        else if (warrior) d = this._warriorIdle(s, view, !!queued);
        else if (s === 1 && this._emberWindow === false) d = { deploy: null };
        else if (this._commanderOn(s)) d = { deploy: null }; // the commander deploys with DEPLOY ALL
        else {
          try { d = this.decisions.considerDeploy(view) || { deploy: null }; }
          catch (e) { this.error = `decision side ${s}: ${e.message || e}`; d = { deploy: null }; }
        }
      }
      if (d.title) this._say(s, d.title, d.detail || '');
      const dep = d.deploy;
      if (!dep || !dep.types || !dep.types.length) {
        if (!(queued && queued.noted)) this._panelHold(s, d);
        continue;
      }
      const before = this.units.length;
      this._releaseWave(s, dep.types, !!dep.guard, !!dep.medicUrgent);
      if (this.units.length > before) this._panelDeploy(s, d);
      if (d.autopilot && this.units.length > before) this.protocolAutopilotNote[s] = true;
      this.lastDeployAt[s] = this.elapsed;
      this.warriorQuietSince[s] = this.elapsed;
    }
  }

  /**
   * No usable warrior order this step. A wave that was not in reserve holds at once.
   * An empty queue keeps the last title until we have gone ~5s without a deploy.
   * With warriorAutopilot, one open-field cadence of silence falls back to considerDeploy,
   * unless this seat is inside its active window (a recent report fetch or order).
   */
  _warriorIdle(side, view, missed) {
    if (missed) {
      return {
        deploy: null,
        title: 'AWAITING WARRIOR',
        detail: 'That wave is not in reserve. Holding until the next order.',
      };
    }
    const quiet = this.elapsed - (this.warriorQuietSince[side] || 0);
    const cadence = D.openFieldWait(side);
    if (this.warriorAutopilot && quiet >= cadence) {
      if (this._warriorTalking(side)) return { deploy: null };
      try {
        const auto = this.decisions.considerDeploy(view) || { deploy: null };
        if (auto.deploy || auto.title) auto.autopilot = true;
        if (auto.deploy || auto.title) return auto;
      } catch (e) {
        this.error = `decision side ${side}: ${e.message || e}`;
      }
      return {
        deploy: null,
        title: 'AWAITING WARRIOR',
        detail: 'No wave is queued, and the simulated fallback has nothing to field.',
      };
    }
    // With the fallback on, considerDeploy owns the next title once the cadence elapses.
    // With it off, we only switch to AWAITING WARRIOR after ~5s without a deploy.
    if (!this.warriorAutopilot && quiet >= 5) {
      return {
        deploy: null,
        title: 'AWAITING WARRIOR',
        detail: 'This side waits for a seat decision. Post one with warrior-seat.js decision.',
      };
    }
    return { deploy: null };
  }

  _applyQueued(item, view) {
    if (item.hold) {
      return {
        deploy: null,
        title: item.title || 'HOLDING RESERVE',
        detail: item.detail || 'The warrior is holding this wave.',
        noted: !!item.noted,
        decideMs: item.decideMs,
        why: item.why || '',
        autopilot: !!item.autopilot,
      };
    }
    let types;
    const room = this._activeRoom(view.side);
    if (item.all) types = capPick(view.reserve, room);
    else {
      // Named units field in the order named, up to the free active slots; the rest stay in reserve.
      const left = cloneCounts(view.reserve);
      types = (item.types || []).filter(k => TYPES[k] && left[k] > 0 && left[k]-- > 0);
      if (types.length > room) { this.capHeld[view.side] += types.length - room; types = types.slice(0, room); }
    }
    types = types.slice(0, C.ROSTER_LIMIT);
    if (!types.length) return null;
    return {
      deploy: { types, guard: !!item.guard, medicUrgent: !!item.medicUrgent },
      title: item.title || 'WARRIOR DEPLOY',
      detail: item.detail || 'Deployed from the seat decision queue.',
      all: !!item.all,
      decideMs: item.decideMs,
      why: item.why || '',
    };
  }

  _waveY(i, n) {
    if (n <= 1) return H / 2;
    if (n === 2) return H / 2 + (i === 0 ? -24 : 24);
    if (n === 3) return H / 2 + [-46, 0, 46][i];
    const top = 28, bot = H - 28;
    return top + ((i + 0.5) * (bot - top)) / n;
  }

  _releaseWave(side, types, guard, medicUrgent) {
    const sent = [];
    types.forEach((k, i) => { if (this._releaseUnit(side, k, guard && i === 0, this._waveY(i, types.length))) sent.push(k); });
    if (!sent.length) return;
    const team = TEAM[side].log;
    const names = sent.map(k => TYPES[k].name).join(' + ');
    if (guard) this._log(`BASE GUARD DEPLOYED · ${TYPES[sent[0]].name}`, side);
    this._log(medicUrgent ? `${team} medic response · ${names}` : `${team} line abreast · ${names}`, side);
  }

  _releaseUnit(side, k, guard, y) {
    if (!TYPES[k] || !(this.reserve[side][k] > 0)) return false;
    // max_alive (units.csv) caps that type on the field; the extra one stays in reserve.
    const cap = TYPES[k].maxAlive | 0;
    if (cap > 0 && this.units.filter(v => v.side === side && v.type === k && v.hp > 0).length >= cap) return false;
    // The active cap (ACTIVE_CAP, drones included): the unit stays in reserve until a slot frees up.
    if (this._activeRoom(side) <= 0) { this.capHeld[side]++; return false; }
    this.reserve[side][k]--;
    const a = TYPES[k];
    const dir = side === 0 ? 1 : -1;
    const x = side === 0 ? 23 : W - 23;
    const u = {
      id: this.nextId++, side, type: k, x, y, hp: a.hp, max: a.hp, cd: 0.35, age: 0, dir, guard,
      formationOffset: y - H / 2, spawnShield: guard ? 1.4 : 0, facingX: dir, facingY: 0,
      hitFlash: 0, healing: false, medicMode: '', medicTargetId: null,
    };
    this._tagOf(u);
    this._inheritMove(u);
    this.units.push(u);
    this.spawnFx.push({ x, y, type: k, side, t: 0, life: 0.78 });
    for (let i = 0; i < 5; i++) this.sparks.push({ x, y, vx: (this.rng() - 0.5) * 42, vy: (this.rng() - 0.5) * 42, life: 0.28, col: side === 0 ? '#bafc82' : '#ff7768' });
    return true;
  }

  /**
   * A unit fielded live joins the side's latest group MOVE that covers its type: MOVE <code> or
   * MOVE ALL, whichever came last, unless a later CLEAR ALL / CLEAR <code> ended it. Its slot is its
   * own spawn row (lane) and its role's row; separation and the slot hysteresis sort out the rest.
   */
  _inheritMove(u) {
    if (this.phase !== 'live' || !this.moveMemory) return;
    const mem = this.moveMemory[u.side];
    let pick = mem.all;
    const t = mem.types[u.type];
    if (t && (!pick || t.seq > pick.seq)) pick = t;
    if (!pick) return;
    const cleared = Math.max(mem.clearAll || 0, mem.clearTypes[u.type] || 0);
    if (cleared > pick.seq) return;
    u.radio = { kind: 'move', zone: pick.zone, gid: pick.gid, inherited: true };
    if (!U.isFlying(u.type) && planeOfUnit(u) === 'ground') {
      // Re-hand out the slots of the whole group with the newcomer in it, so a reinforcement never
      // shares a slot with another unit of its type (they shoved each other for 10 s and more).
      const group = this.units.filter(v => v !== u && v.side === u.side && v.hp > 0 && v.radio
        && v.radio.kind === 'move' && v.radio.gid === pick.gid && v.radio.phase !== 'back');
      group.push(u);
      this._assignSlots(u.side, group);
    }
  }

  _spend(side) {
    if (this.phase !== 'live') return;
    // Ember buys on the same command window as its deploy. Credits stay in the bank between windows.
    if (side === 1 && !this._seated(1) && this.npcDecisionS > 0 && this._emberWindow === false) return;
    // BANK skips the queue buy until a later BUY, or until an opening or a plan clears it.
    // A seat that is talking also keeps the queue: BUY and BANK are the live controls.
    if (this.bankHold[side]) return;
    // The commander buys with AUTOBUY and BUY, like a seat. The pre-match queue only names its main unit.
    if (this._commanderOn(side)) return;
    if (this._seated(side) && this._warriorTalking(side)) return;
    if (this._seated(side)) {
      // A seat that has posted any wire order this match buys only with live BUY.
      // Auto-spend from the opening queue was racing the bot (spend=true + quiet gap).
      if (this.warriorWired[side]) return;
      const order = this.warriorOrders[side];
      // Only the buy list installed from a warrior opening may be purchased. A seat
      // claimed mid-match keeps its credits until the next opening is live.
      if (!order || order.spend !== true || this.queueSource[side] !== 'warrior') return;
    }
    // A queue buy of a capped type (max_alive, cooldown) waits; the queue does not skip it.
    const nextType = this.queue[side][this.reinf[side]];
    if (nextType && TYPES[nextType] && this._buyCapReason(side, nextType)) return;
    const res = this.decisions.spendCredits({
      side, credits: this.fieldCredits[side], queue: this.queue[side], bought: this.reinf[side], maxBuys: MAX_BUYS,
    }) || { types: [], creditsLeft: this.fieldCredits[side], bought: this.reinf[side] };
    const types = (res.types || []).filter(k => TYPES[k]);
    if (!types.length) {
      if (typeof res.creditsLeft === 'number') this.fieldCredits[side] = res.creditsLeft;
      if (typeof res.bought === 'number') this.reinf[side] = res.bought;
      return;
    }
    for (const k of types) {
      this.reserve[side][k] = (this.reserve[side][k] || 0) + 1;
      this.rosters[side][k] = (this.rosters[side][k] || 0) + 1;
      this._noteWire('buy', side, k);
      if (TYPES[k].buyCooldown > 0) this.lastBuyAt[side][k] = this.elapsed;
    }
    this.fieldCredits[side] = typeof res.creditsLeft === 'number' ? res.creditsLeft : this.fieldCredits[side];
    this.reinf[side] = typeof res.bought === 'number' ? res.bought : this.reinf[side] + types.length;
    const spent = types.reduce((sum, k) => sum + FIELD_COST[k], 0);
    const names = types.map(k => TYPES[k].name.toUpperCase()).join(' + ');
    const autoBuy = this._seated(side);
    for (const k of types) this._pushPanel(side, { kind: 'buy', verb: `BUY ${P.CODE_BY_TYPE[k]}`, detail: `${FIELD_COST[k]} CR`, auto: autoBuy });
    this._log(`${TEAM[side].log} spends −${spent} CR · ${names} added to reserve`, side);
    this.notices.push({ id: this.noticeId++, side, amount: spent, names });
    if (this.notices.length > 6) this.notices.shift();
    this.spendPulses.push({ x: side === 0 ? 42 : W - 42, y: H / 2, t: 0, side });
  }

  _territory(dt) {
    const counts = Array.from({ length: 8 }, () => [0, 0]);
    for (const u of this.units) if (grounded(u)) counts[Math.min(7, Math.max(0, Math.floor(u.x / (W / 8))))][u.side]++;
    for (let i = 0; i < this.land.length; i++) {
      const [g, r] = counts[i];
      const wasGreen = this.land[i] > 0.35, wasRed = this.land[i] < -0.35;
      if (g > r) this.land[i] = Math.min(1, this.land[i] + dt * 0.30);
      else if (r > g) this.land[i] = Math.max(-1, this.land[i] - dt * 0.30);
      if (!wasGreen && this.land[i] > 0.35 && i >= 3 && this.reinf[0] < MAX_BUYS) {
        this.fieldCredits[0] += 28;
        this.capturePulses.push({ zone: i, side: 0, t: 0, life: 1.1 });
        this._log('GREEN captures frontier zone · +28 CR', 0);
        this._spend(0);
      }
      if (!wasRed && this.land[i] < -0.35 && i <= 4 && this.reinf[1] < MAX_BUYS) {
        this.fieldCredits[1] += 28;
        this.capturePulses.push({ zone: i, side: 1, t: 0, life: 1.1 });
        this._log('EMBER captures frontier zone · +28 CR', 1);
        this._spend(1);
      }
    }
    this.incomeClock += dt;
    if (this.incomeClock >= C.INCOME_TICK_S) {
      this.incomeClock -= C.INCOME_TICK_S;
      for (let s = 0; s < 2; s++) {
        if (this.reinf[s] >= MAX_BUYS) continue;
        const n = this._incomeZones(s);
        // Each base pays a small steady income (baseIncome) on top of the frontier zones.
        const base = this.baseIncome;
        if (!n && !(base > 0)) continue;
        const pay = n * C.ZONE_INCOME + base;
        this.fieldCredits[s] += pay;
        this.incomeTotal[s] += pay;
        this.baseIncomeTotal[s] += base;
        // The log keeps the zone line; base-only ticks are silent (they come every 4 s).
        if (n) this._log(`${TEAM[s].log} holds ${n} frontier zone${n === 1 ? '' : 's'} · +${n * C.ZONE_INCOME} CR${base > 0 ? ` (+${base} base)` : ''}`, s);
        this._spend(s);
      }
    }
  }

  _stepUnit(u, dt, sideUnits, zoneCounts) {
    u.age += dt;
    u.paceV = null; // set again by _paceHold when this step paces us
    u.cd -= dt;
    u.spawnShield = Math.max(0, (u.spawnShield || 0) - dt);
    const a = TYPES[u.type];
    const terrain = this._terrainAt(u.x, u.y);
    u.hitFlash = Math.max(0, (u.hitFlash || 0) - dt);
    if (u.repath > 0) u.repath -= dt;
    if (u.kx || u.ky) {
      // Knockback: a flying unit is pushed over walls (no wall check), a ground unit is stopped by them.
      if (a.flying || U.isFlying(u.type)) this._nudge(u, u.kx * dt, u.ky * dt, -1);
      else this._move(u, u.kx * dt, u.ky * dt, a.r + 2);
      u.kx *= Math.exp(-9 * dt); u.ky *= Math.exp(-9 * dt);
    }
    const enemies = sideUnits[1 - u.side];
    // A kamikaze unit (the Drone) has its own step: pick a cluster, fly at it, explode on contact.
    if (a.role === 'kamikaze') { this._stepKamikaze(u, a, dt, enemies, terrain); return; }
    const medicPatient = a.role === 'healer' ? this._woundedAlly(u.side, u) : null;
    u.medicMode = medicPatient ? 'RUSHING' : '';
    u.medicTargetId = medicPatient ? medicPatient.id : null;
    // A radio order (MOVE, ASSIST, FALLBACK) replaces the normal pick and movement below.
    if (u.radio && this._stepRadio(u, a, dt, enemies, terrain)) {
      this._zoneHeal(u, dt, zoneCounts);
      return;
    }
    // FOCUS: the nearest enemy of the focus type inside our attack range wins over the
    // normal pick (nearest, or nearest in our home zone). Healers still heal first.
    // A scoped FOCUS applies only to its units, and only to enemies inside its zone.
    const focusType = this.focus[u.side];
    const fsc = focusType ? this.focusScope[u.side] : null;
    const focusOn = !!focusType && (!fsc || !fsc.units || fsc.units.has(u));
    let target = null, bestD = Infinity, bestThreat = null, bestThreatD = Infinity, bestFocus = null, bestFocusD = Infinity;
    const bonus = a.bonusVs;
    for (const v of enemies) {
      if (v.spawnShield > 0 || this._lineBlocked(u.x, u.y, v.x, v.y)) continue;
      const d = Math.hypot(v.x - u.x, v.y - u.y);
      // bonus_vs: a target we have a bonus against counts as that much closer when we pick one.
      const pd = bonus && bonus[TYPES[v.type].code] ? d / bonus[TYPES[v.type].code] : d;
      if (pd < bestD) { target = v; bestD = pd; }
      if (u.side === 0 ? v.x < W * 0.29 : v.x > W * 0.71) { if (d < bestThreatD) { bestThreat = v; bestThreatD = d; } }
      if (focusOn && v.type === focusType && d < a.range && d < bestFocusD && (!fsc || fsc.zone == null || C.zoneOf(v.x) === fsc.zone)) { bestFocus = v; bestFocusD = d; }
    }
    if (bestFocus) target = bestFocus;
    else if (bestThreat) target = bestThreat;
    // Default assist: no enemy inside our own range (not shooting) and a fight within
    // assistRadius zones. We head for the nearest enemy in that fight instead of our normal
    // pick (a farther enemy, a home-zone intruder, or the enemy base). Once anything is in
    // range the normal pick takes over again, and when the fight is clear we simply resume.
    if (this.assistRadius > 0 && !medicPatient && !(target && Math.hypot(target.x - u.x, target.y - u.y) < a.range)) {
      const pick = this._assistPick(u, enemies, zoneCounts, this.assistRadius);
      if (pick) target = pick;
    }
    const enemyBase = u.side === 0 ? W - 16 : 16;
    const attackRange = a.range;
    const tx = medicPatient ? medicPatient.x : target ? target.x : enemyBase;
    const offset = u.repath > 0 ? 0 : (u.formationOffset || 0); // a stalled unit drops its lane for a while
    const ty = medicPatient ? medicPatient.y : target ? this._fieldY(target.y + offset) : H / 2 + offset;
    const dist = Math.hypot(tx - u.x, ty - u.y);
    const targetDistance = target ? Math.hypot(target.x - u.x, target.y - u.y) : dist;
    const shotClear = target && !this._lineBlocked(u.x, u.y, target.x, target.y);
    const inRange = !!(target && targetDistance < attackRange && shotClear);
    const stand = standoffOf(a, u, target);
    const atStandoff = inRange && targetDistance <= stand;
    if (medicPatient && dist < a.healRange) {
      u.medicMode = 'HEALING';
      medicPatient.hp = Math.min(medicPatient.max, medicPatient.hp + a.heal * dt);
      u.medicPopupClock = (u.medicPopupClock || 0) + dt;
      if (u.medicPopupClock >= 1) {
        u.medicPopupClock -= 1;
        this.healPopups.push({ x: medicPatient.x, y: medicPatient.y, t: 0, amount: a.heal, side: u.side });
      }
    } else if (inRange && u.cd <= 0) {
      const wasAlive = target.hp > 0;
      this._fireAt(u, target, a, target.x, target.y);
      if (bestFocus && target === bestFocus && wasAlive && target.hp <= 0) target.focusKill = true;
      u.cd = a.cool;
    } else if (!medicPatient && !target && Math.abs(enemyBase - u.x) < a.range + 8 && !this._lineBlocked(u.x, u.y, enemyBase, u.y)) {
      if (u.cd <= 0) {
        this.hp[1 - u.side] -= a.dmg;
        this.baseDamage[1 - u.side].other += a.dmg;
        this.cameraShake = Math.max(this.cameraShake, 0.28);
        this._fireAt(u, null, a, enemyBase, u.y);
        u.cd = a.cool;
        this.combatFx.push({ x: enemyBase, y: u.y, t: 0, life: 0.38, kind: 'blast', col: '#ffca83', r: 22 });
        this._log(`${a.name.toUpperCase()} damages base · ${Math.max(0, Math.ceil(this.hp[1 - u.side]))} HP`, u.side);
      }
    }
    // Keep closing to 55% of range after the first shot. Stopping at max range
    // left rifles behind a closer body, outside every shorter weapon.
    if (!(medicPatient && dist < a.healRange) && !atStandoff && dist > 0) {
      const holdForBase = !target && Math.abs(enemyBase - u.x) < a.range + 8;
      if (!holdForBase) {
        const speed = a.speed * (u.guard ? 1.12 : 1) * (u.medicMode === 'RUSHING' ? 2.5 : 1) * 1.2 * (terrain === 'rough' ? 0.55 : 1);
        const goalX = target && shotClear && dist > 0 ? u.x + (tx - u.x) * Math.max(0, (dist - stand) / dist) : tx;
        const goalY = target && shotClear && dist > 0 ? u.y + (ty - u.y) * Math.max(0, (dist - stand) / dist) : ty;
        const way = this._pathPoint(u.x, u.y, goalX, goalY, a.r + 2, u.repath > 0 ? u.avoidCell : -1);
        const mx = way.x - u.x, my = way.y - u.y, md = Math.hypot(mx, my);
        const step = Math.min(md, speed * dt);
        const [dx, dy] = this._steer(u, a, md ? mx / md : 0, md ? my / md : 0, step);
        const ox = u.x, oy = u.y;
        this._move(u, dx * step, dy * step, a.r + 2);
        this._watchProgress(u, step, ox, oy, way, dt);
        u.facingX = dx; u.facingY = dy;
      }
    }
    this._zoneHeal(u, dt, zoneCounts);
  }

  /** Slow heal in a zone we fully own with no enemy in it. Every unit, radio order or not. */
  _zoneHeal(u, dt, zoneCounts) {
    const zone = Math.min(7, Math.max(0, Math.floor(u.x / (W / 8))));
    const fullyOwned = u.side === 0 ? this.land[zone] >= 0.98 : this.land[zone] <= -0.98;
    const contested = zoneCounts[zone][1 - u.side] > 0;
    if (fullyOwned && !contested && u.hp < u.max) {
      u.healing = true;
      u.healClock = (u.healClock || 0) + dt;
      while (u.healClock >= 1 && u.hp < u.max) {
        u.healClock -= 1;
        const before = u.hp;
        u.hp = Math.min(u.max, u.hp + 2);
        if (u.hp > before) this.healPopups.push({ x: u.x, y: u.y, t: 0, amount: Math.round(u.hp - before), side: u.side });
      }
    } else { u.healing = false; u.healClock = 0; }
  }

  /**
   * Nearest enemy in a fight zone (units of both sides in it) within `radius` zones of u.
   * Line of sight is not needed: the pathfinder takes us round walls. Null when none.
   */
  _assistPick(u, enemies, zoneCounts, radius) {
    const uz = C.zoneOf(u.x);
    let best = null, bestD = Infinity;
    for (const v of enemies) {
      if (v.spawnShield > 0) continue;
      const vz = C.zoneOf(v.x);
      if (Math.abs(vz - uz) > radius) continue;
      if (!(zoneCounts[vz][u.side] > 0 && zoneCounts[vz][1 - u.side] > 0)) continue;
      const d = Math.hypot(v.x - u.x, v.y - u.y);
      if (d < bestD) { best = v; bestD = d; }
    }
    return best;
  }

  /**
   * The biggest enemy cluster among `ground` (units on the ground), scored by how many enemy units a
   * blast centered there would catch (splash_radius), then by distance from (fx, fy). `inZone(v)`
   * limits which units may be the cluster's anchor. Returns { x, y, n, anchor } or null.
   */
  _clusterPick(ground, radius, fx, fy, inZone) {
    const reach = Math.max(12, radius);
    let best = null, bestScore = -Infinity;
    for (const v of ground) {
      if (v.spawnShield > 0 || (inZone && !inZone(v))) continue;
      let n = 0, sx = 0, sy = 0;
      for (const w of ground) {
        if (Math.hypot(w.x - v.x, w.y - v.y) > reach) continue;
        n++; sx += w.x; sy += w.y;
      }
      const score = n * 1000 - Math.hypot(v.x - fx, v.y - fy);
      if (score > bestScore) { bestScore = score; best = { x: sx / n, y: sy / n, n, anchor: v }; }
    }
    return best;
  }

  /**
   * Where a kamikaze unit flies this step: { x, y, base? }. Launch and forget: the first call (its
   * first step after DEPLOY, so a MOVE in the same post counts) locks a target with _droneLaunchPick;
   * after that the drone follows that unit's position. Only the target's death makes it pick again
   * (same order). MOVE and FOCUS given after launch do not retarget it. With no enemy unit left it
   * goes for their base. It never returns null: a drone never hovers or waits.
   */
  _kamikazeGoal(u, a, ground) {
    const side = u.side;
    const base = () => ({ x: side === 0 ? W - 16 : 16, y: H / 2, base: true });
    if (u.lock && u.lock.id != null) {
      const t = ground.find(v => v.id === u.lock.id);
      if (t) return { x: t.x, y: t.y, id: t.id };
      u.lock = null; // target died (or took off): pick again
    } else if (u.lock && u.lock.base) {
      // Locked on the base: a ground enemy that steps into the drone's own reach still counts (contact).
      return base();
    }
    const pick = this._droneLaunchPick(u, a, ground);
    u.lock = pick ? { id: pick.id, at: this.elapsed } : { base: true, at: this.elapsed };
    if (u.launchedAt == null) u.launchedAt = this.elapsed;
    return pick ? { x: pick.x, y: pick.y, id: pick.id } : base();
  }

  /**
   * A drone's launch target, an enemy ground unit (or null: their base), in this order:
   * 1. the anchor of the biggest engaged stack (enemies already fighting ours, _engagedEnemy);
   * 2. the biggest cluster in its MOVE / ASSIST zone, or within 1 zone of it;
   * 3. the biggest cluster anywhere;
   * 4. the nearest enemy (a cluster of one is already covered by 3; kept for clarity);
   * 5. null: their base.
   * Cluster size counts the enemies a blast centred on the anchor would catch (splash_radius).
   */
  _droneLaunchPick(u, a, ground) {
    const side = u.side;
    const live = ground.filter(v => v.hp > 0 && !(v.spawnShield > 0));
    if (!live.length) return null;
    const engaged = live.filter(v => this._engagedEnemy(v, side));
    if (engaged.length) {
      const set = new Set(engaged);
      const c = this._clusterPick(live, a.splash, u.x, u.y, v => set.has(v));
      if (c) return c.anchor;
    }
    const o = u.radio;
    if (o && (o.kind === 'move' || o.kind === 'assist') && o.zone != null) {
      const z = o.zone;
      const c = this._clusterPick(live, a.splash, u.x, u.y, v => C.zoneOf(v.x) === z)
        || this._clusterPick(live, a.splash, u.x, u.y, v => Math.abs(C.zoneOf(v.x) - z) <= 1);
      if (c) return c.anchor;
    }
    const c = this._clusterPick(live, a.splash, u.x, u.y, null);
    if (c) return c.anchor;
    let best = null, bd = Infinity;
    for (const v of live) { const d = Math.hypot(v.x - u.x, v.y - u.y); if (d < bd) { best = v; bd = d; } }
    return best;
  }

  /** An enemy ground unit that is fighting ours: fired or was hit within ENGAGED_S, near our ground unit. */
  _engagedEnemy(v, side) {
    const now = this.elapsed;
    const busy = now - (v.firedAt == null ? -99 : v.firedAt) < ENGAGED_S || now - (v.hitAt == null ? -99 : v.hitAt) < ENGAGED_S;
    if (!busy || v.spawnShield > 0) return false;
    for (const w of this.units) {
      if (w.side !== side || w.hp <= 0 || !grounded(w)) continue;
      if (Math.hypot(w.x - v.x, w.y - v.y) <= ENGAGED_NEAR) return true;
    }
    return false;
  }

  /**
   * One step of a kamikaze unit. It explodes on contact: an enemy ground unit within range plus that
   * unit's radius, or their base within range + 8 (the reach every unit's base shot uses).
   * A flying unit goes straight over walls and rough ground.
   */
  _stepKamikaze(u, a, dt, enemies, terrain) {
    // Shot down earlier this step: the death blast runs after every unit has stepped (update()).
    if (u.hp <= 0 || u.detonated) return;
    const side = u.side;
    const enemyBase = side === 0 ? W - 16 : 16;
    const ground = enemies.filter(v => v.hp > 0 && grounded(v));
    // Contact: inside trigger range + the target's radius, the last lunge carries the drone onto the
    // target's hull and it detonates there. Checked before and after the move, so a drone that flies
    // into reach this step goes off now instead of waiting a step in a gun's range (which depended on
    // whether its target stepped before or after it).
    const contact = () => {
      for (const v of ground) {
        if (v.spawnShield > 0) continue;
        const d = Math.hypot(v.x - u.x, v.y - u.y);
        if (d <= a.range + TYPES[v.type].r) {
          const k = d > 0 ? (TYPES[v.type].r * 0.5) / d : 0;
          u.x = v.x + (u.x - v.x) * k; u.y = v.y + (u.y - v.y) * k;
          this._detonate(u, 1, false); return true;
        }
      }
      if (Math.abs(enemyBase - u.x) < a.range + 8) { this._detonate(u, 1, false); return true; }
      return false;
    };
    if (contact()) return;
    const goal = this._kamikazeGoal(u, a, ground);
    if (!goal) return;
    if (a.flying) {
      const dx = goal.x - u.x, dy = goal.y - u.y, d = Math.hypot(dx, dy);
      if (d < 0.5) return;
      const step = Math.min(d, a.speed * 1.2 * dt);
      u.x = this._fieldX(u.x + dx / d * step);
      u.y = this._fieldY(u.y + dy / d * step);
      u.facingX = dx / d; u.facingY = dy / d;
      contact();
      return;
    }
    this._radioMove(u, a, dt, goal.x, this._fieldY(goal.y), terrain);
    contact();
  }

  /**
   * A kamikaze blast at u: splash_radius x mult, damage x mult at the center, falling off by
   * splash_falloff toward the edge. Our own units take it when friendly_fire is on; blast_resist cuts
   * what a unit takes. A base inside the blast takes damage x mult x base_mult. `shot` is the death
   * blast (death_blast_mult) of a unit that was shot down.
   */
  _detonate(u, mult, shot) {
    const a = TYPES[u.type];
    const side = u.side;
    const R = a.splash * mult;
    const center = a.dmg * mult;
    u.hp = 0; u.detonated = true;
    let k = 0, kills = 0;
    for (const v of this.units) {
      if (v === u || v.hp <= 0) continue;
      if (v.side === side && !a.friendlyFire) continue;
      const t = TYPES[v.type];
      const d = Math.hypot(v.x - u.x, v.y - u.y);
      if (d > R + t.r * 0.5) continue;
      const frac = R > 0 ? Math.min(1, d / R) : 0;
      const dmg = center * (1 - a.falloff * frac) * (1 - (t.blastResist || 0));
      if (!(dmg > 0)) continue;
      v.hp -= dmg;
      if (U.isKamikaze(v.type)) v.downBy = 'blast'; // caught in another drone's blast
      v.hitAt = this.elapsed; v.hitFlash = 0.22;
      const kd = d || 1;
      v.kx = (v.kx || 0) + (v.x - u.x) / kd * 40;
      v.ky = (v.ky || 0) + (v.y - u.y) / kd * 40;
      if (v.side !== side) { k++; if (v.hp <= 0) kills++; }
    }
    const enemyBase = side === 0 ? W - 16 : 16;
    let baseHit = 0;
    if (Math.abs(enemyBase - u.x) <= Math.max(R, a.range) + 8) {
      baseHit = center * a.baseMult;
      if (baseHit > 0) {
        this.hp[1 - side] -= baseHit;
        this.baseDamage[1 - side].kamikaze += baseHit;
      }
    }
    const zone = C.zoneOf(u.x);
    this.combatFx.push({ x: u.x, y: u.y, t: 0, life: shot ? 0.45 : 0.6, kind: 'detonate', col: a.color, r: Math.max(10, R) });
    this._sparks(u.x, u.y, a.color, shot ? 6 : 12);
    this.cameraShake = Math.max(this.cameraShake, shot ? 0.12 : 0.22);
    const by = shot ? (u.downBy || '') : '';
    this.droneHits[side].push({ t: this.elapsed, zone, k, kills, shot, by, base: Math.round(baseHit) });
    if (this.droneHits[side].length > 40) this.droneHits[side].shift();
    if (this.wirePending) for (const obs of this.wirePending) if (obs.hits) obs.hits[side].push({ zone, k, shot: !!shot, by });
    const what = baseHit > 0 ? `base · ${Math.max(0, Math.ceil(this.hp[1 - side]))} HP` : `z${zone + 1} · ${k} unit${k === 1 ? '' : 's'}`;
    this._log(`${TEAM[side].log} ${a.name.toUpperCase()} ${shot ? `shot down${by ? ' by ' + by : ''}` : 'hits'} ${what}`, side);
  }

  /** Stable report ID: code + number, per side and type, for the unit's life. Never reused in a match. */
  _tagOf(u) {
    if (u.tag) return u.tag;
    const serial = this.unitSerial || (this.unitSerial = [{}, {}]);
    const box = serial[u.side] || (serial[u.side] = {});
    box[u.type] = (box[u.type] || 0) + 1;
    u.tag = `${P.CODE_BY_TYPE[u.type] || '?'}${box[u.type]}`;
    u.serial = box[u.type];
    return u.tag;
  }

  /** Shooting, being shot, or healing within the last 2 s. The report marks it `!`. */
  _inCombat(u) {
    const now = this.elapsed;
    return u.medicMode === 'HEALING' || now - (u.firedAt == null ? -99 : u.firedAt) < 2 || now - (u.hitAt == null ? -99 : u.hitAt) < 2;
  }

  /** Zones with units of both sides right now: [{ zone (0..7), n: [green, ember] }]. */
  _fightZones() {
    const n = Array.from({ length: C.ZONES }, () => [0, 0]);
    for (const u of this.units) if (grounded(u)) n[C.zoneOf(u.x)][u.side]++;
    const out = [];
    n.forEach((c, zone) => { if (c[0] > 0 && c[1] > 0) out.push({ zone, n: c }); });
    return out;
  }

  /**
   * Report suffix for a unit's radio order: `>z5` MOVE or ASSIST heading to (or holding) z5,
   * `<z4` going back to z4 after an ASSIST or a FALLBACK, `>M1` / `>base` on FALLBACK. '' when none.
   */
  _orderToken(u) {
    const o = u.radio;
    if (!o) return '';
    if (o.phase === 'back') return `<z${o.back + 1}`;
    if (o.kind === 'fallback') return `>${o.via || 'base'}`;
    return `>z${o.zone + 1}`;
  }

  _zoneHasEnemy(zone, side) {
    for (const v of this.units) if (v.side !== side && v.hp > 0 && C.zoneOf(v.x) === zone) return true;
    return false;
  }

  /** Nearest friendly healer (not u itself), or null. */
  _nearestHealer(u) {
    let best = null, bestD = Infinity;
    for (const v of this.units) {
      if (v === u || v.side !== u.side || v.hp <= 0 || !U.isHealer(v.type)) continue;
      const d = Math.hypot(v.x - u.x, v.y - u.y);
      if (d < bestD) { best = v; bestD = d; }
    }
    return best;
  }

  /** One movement step toward (gx, gy), with the same speed, pathing and stall watch as the normal move. */
  _radioMove(u, a, dt, gx, gy, terrain) {
    const dist = Math.hypot(gx - u.x, gy - u.y);
    if (dist < 0.5) return;
    const speed = a.speed * (u.guard ? 1.12 : 1) * 1.2 * (terrain === 'rough' ? 0.55 : 1);
    const way = this._pathPoint(u.x, u.y, gx, gy, a.r + 2, u.repath > 0 ? u.avoidCell : -1);
    const mx = way.x - u.x, my = way.y - u.y, md = Math.hypot(mx, my);
    const step = Math.min(md, speed * dt);
    const [dx, dy] = this._steer(u, a, md ? mx / md : 0, md ? my / md : 0, step);
    const ox = u.x, oy = u.y;
    let sx = dx * step, sy = dy * step;
    // Pacing (u.paceV, set by _paceHold this step): cap only the forward part of the step, so a
    // paced unit still walks to its lane and never runs ahead of the front-liners.
    const fwd = u.side === 0 ? 1 : -1;
    if (u.paceV != null && sx * fwd > 0) sx = fwd * Math.min(sx * fwd, u.paceV * (terrain === 'rough' ? 0.55 : 1) * dt);
    this._move(u, sx, sy, a.r + 2);
    this._watchProgress(u, Math.hypot(sx, sy), ox, oy, way, dt);
    u.facingX = dx; u.facingY = dy;
  }

  /**
   * A unit under a radio order. Returns true when it handled the step (always, today).
   * MOVE: walk to the zone, then hold it: chase enemies inside it (never out of it), stand when it is empty.
   *   In the enemy's home zone an empty zone means: walk on into range of their base and shoot it.
   * ASSIST: the same toward the fight zone; once that zone has no enemy, walk back to the zone we came
   *   from, then the order ends (a MOVE it interrupted resumes).
   * FALLBACK: walk to the nearest friendly healer (or our base); at 90% HP walk back, then it ends.
   * On the way and while holding we shoot anything in range (FOCUS applies), preferring the order's zone.
   */
  _stepRadio(u, a, dt, enemies, terrain) {
    let o = u.radio;
    const side = u.side;
    if (o.kind === 'assist' && o.phase === 'go' && !this._zoneHasEnemy(o.zone, side)) o.phase = 'back';
    if (o.kind === 'fallback' && o.phase === 'go' && u.hp >= u.max * 0.9) o.phase = 'back';
    if (o.phase === 'back' && C.zoneOf(u.x) === o.back) {
      u.radio = o.resume || null;
      o = u.radio;
      if (!o) return true; // back: stand this step, the normal pick takes over from the next
    }
    const zw = W / C.ZONES;
    const goalZone = o.phase === 'back' ? o.back : o.kind === 'fallback' ? null : o.zone;
    // Fire: focus pick in range first, then an enemy in the order's zone, then the nearest in range.
    const focusType = this.focus[side];
    const fsc = focusType ? this.focusScope[side] : null;
    const focusOn = !!focusType && (!fsc || !fsc.units || fsc.units.has(u));
    let fire = null, fireScore = Infinity, isFocus = false;
    for (const v of enemies) {
      if (v.spawnShield > 0) continue;
      const d = Math.hypot(v.x - u.x, v.y - u.y);
      if (!(d < a.range) || this._lineBlocked(u.x, u.y, v.x, v.y)) continue;
      const foc = focusOn && v.type === focusType && (!fsc || fsc.zone == null || C.zoneOf(v.x) === fsc.zone);
      const b = a.bonusVs && a.bonusVs[TYPES[v.type].code];
      const score = (b ? d / b : d) - (foc ? 10000 : 0) - (goalZone != null && C.zoneOf(v.x) === goalZone ? 1000 : 0);
      if (score < fireScore) { fire = v; fireScore = score; isFocus = foc; }
    }
    // A healer on a radio order treats the most hurt ally within reach before anything else.
    let patient = null;
    if (a.role === 'healer') {
      let missing = 1;
      for (const v of this.units) {
        if (v === u || v.side !== side) continue;
        const lost = v.max - v.hp;
        if (lost > missing && Math.hypot(v.x - u.x, v.y - u.y) < a.healRange) { patient = v; missing = lost; }
      }
    }
    u.medicMode = patient ? 'HEALING' : '';
    u.medicTargetId = patient ? patient.id : null;
    const enemyBase = side === 0 ? W - 16 : 16;
    if (patient) {
      patient.hp = Math.min(patient.max, patient.hp + a.heal * dt);
      u.medicPopupClock = (u.medicPopupClock || 0) + dt;
      if (u.medicPopupClock >= 1) {
        u.medicPopupClock -= 1;
        this.healPopups.push({ x: patient.x, y: patient.y, t: 0, amount: a.heal, side });
      }
    } else if (fire && u.cd <= 0) {
      const wasAlive = fire.hp > 0;
      this._fireAt(u, fire, a, fire.x, fire.y);
      if (isFocus && wasAlive && fire.hp <= 0) fire.focusKill = true;
      u.cd = a.cool;
    } else if (!fire && o.kind === 'move' && C.zoneOf(u.x) === o.zone && Math.abs(enemyBase - u.x) < a.range + 8 && !this._lineBlocked(u.x, u.y, enemyBase, u.y)) {
      // Holding the enemy's home zone: hit their base like the normal attack does.
      if (u.cd <= 0) {
        this.hp[1 - side] -= a.dmg;
        this.baseDamage[1 - side].other += a.dmg;
        this.cameraShake = Math.max(this.cameraShake, 0.28);
        this._fireAt(u, null, a, enemyBase, u.y);
        u.cd = a.cool;
        this.combatFx.push({ x: enemyBase, y: u.y, t: 0, life: 0.38, kind: 'blast', col: '#ffca83', r: 22 });
        this._log(`${a.name.toUpperCase()} damages base · ${Math.max(0, Math.ceil(this.hp[1 - side]))} HP`, side);
      }
    }
    if (patient) return true; // a healer stands while it treats
    // Movement.
    if (o.kind === 'fallback' && o.phase === 'go') {
      const medic = U.isHealer(u.type) ? null : this._nearestHealer(u);
      o.via = medic ? this._tagOf(medic) : 'base';
      const gx = medic ? medic.x : (side === 0 ? zw / 2 : W - zw / 2);
      const gy = medic ? medic.y : u.y;
      if (Math.hypot(gx - u.x, gy - u.y) > (medic ? 24 : 12)) this._radioMove(u, a, dt, gx, gy, terrain);
      return true;
    }
    const lo = goalZone * zw, hi = lo + zw;
    // A MOVE slot (set when the order was given): walk in our lane, hold our spot in the formation.
    const slot = o.kind === 'move' && o.phase !== 'back' && o.sy != null ? o : null;
    const uz = C.zoneOf(u.x);
    // Engage: an enemy in our zone (holding it), or a ground enemy close by on the way or just past
    // the zone. Without this a short-range unit walked past a fight to its slot and stood there.
    const chase = o.phase === 'back' ? null : this._engagePick(u, a, enemies, goalZone);
    // Pace: on a MOVE, ranged units and healers do not walk ahead of the group's front-liners, on
    // the way or closing on an enemy (they still shoot whatever is in range, above).
    // Pacing is a speed match (u.paceV caps our forward speed in _radioMove), never a stop-and-wait:
    // a follower that stood still in the lane made everyone behind it weave round it.
    u.paceV = null;
    if (o.kind === 'move' && o.phase !== 'back' && (uz !== goalZone || chase) && this._paceHold(u, o)) {
      if (slot) slot.held = false;
    }
    if (uz !== goalZone && !chase) {
      if (slot) slot.held = false;
      this._radioMove(u, a, dt, lo + zw / 2, this._fieldY(slot ? slot.sy : u.y), terrain);
      return true;
    }
    if (o.phase === 'back') return true;
    const chaseD = chase ? Math.hypot(chase.x - u.x, chase.y - u.y) : Infinity;
    if (!chase) {
      // MOVE into their home zone (z8 for Green, z1 for Ember): no enemy left in it, so walk on
      // until the base is inside our own range with a clear shot, the rule a unit with no order
      // uses (range + 8), and stand there. Stopping at the zone edge left everything shorter
      // than a Rifle out of range.
      if (o.kind === 'move' && goalZone === (side === 0 ? C.ZONES - 1 : 0)) this._radioToBase(u, a, dt, enemyBase, terrain);
      else if (slot) this._toSlot(u, a, dt, slot, lo, hi, terrain);
      return true;
    }
    if (slot) slot.held = false;
    const clear = !this._lineBlocked(u.x, u.y, chase.x, chase.y);
    const stand = standoffOf(a, u, chase);
    if (clear && chaseD <= stand) return true;
    let gx = chase.x, gy = chase.y;
    if (clear && chaseD > 0) {
      const k = (chaseD - stand) / chaseD;
      gx = u.x + (chase.x - u.x) * k; gy = u.y + (chase.y - u.y) * k;
    }
    // Holding: chase inside the zone, or up to half a zone past its edge after a close enemy.
    if (uz === goalZone) gx = Math.max(lo + 4 - zw / 2, Math.min(hi - 4 + zw / 2, gx));
    this._radioMove(u, a, dt, gx, gy, terrain);
    return true;
  }

  /**
   * Who a unit on MOVE / ASSIST closes on (or null: keep walking / hold the slot).
   * 1. In the goal zone: the nearest ground enemy in it (an air unit only when no ground one is).
   * 2. Not healers: the nearest ground enemy within range + ENGAGE_EXTRA px whose zone lies between
   *    ours and the goal zone, or one zone beyond either end, so a unit behind the fight joins it.
   */
  _engagePick(u, a, enemies, goalZone) {
    const uz = C.zoneOf(u.x);
    let best = null, bestD = Infinity, air = null, airD = Infinity;
    if (uz === goalZone) {
      for (const v of enemies) {
        if (v.spawnShield > 0 || v.hp <= 0 || C.zoneOf(v.x) !== goalZone) continue;
        const d = Math.hypot(v.x - u.x, v.y - u.y);
        if (grounded(v)) { if (d < bestD) { best = v; bestD = d; } } else if (d < airD) { air = v; airD = d; }
      }
      if (best) return best;
    }
    if (a.role !== 'healer') {
      const zLo = Math.min(uz, goalZone) - 1, zHi = Math.max(uz, goalZone) + 1;
      const reach = a.range + ENGAGE_EXTRA;
      for (const v of enemies) {
        if (v.spawnShield > 0 || v.hp <= 0 || !grounded(v)) continue;
        const vz = C.zoneOf(v.x);
        if (vz < zLo || vz > zHi) continue;
        const d = Math.hypot(v.x - u.x, v.y - u.y);
        if (d < reach && d < bestD) { best = v; bestD = d; }
      }
      if (best) return best;
    }
    return air;
  }

  /**
   * Pacing for a ranged unit or healer on its way to a MOVE zone. The pace line is PACE_FREE px ahead
   * of the group's most forward front-liner (armor, else fast), or PACE_GAP px behind it once an enemy
   * ground unit is within PACE_NEAR px. Within PACE_EASE px of the line we slow from our own speed to
   * the lead's; past it we slow to 0 over PACE_RAMP px, so a follower settles just behind the line and
   * walks at the lead's speed instead of stopping and starting. Already PACE_MAX px or more ahead (a
   * late MOVE, a stuck front-liner): no pacing. Front-liners never pace. Sets u.paceV (px/s cap on our
   * forward speed) and returns true when it caps us below our own speed.
   */
  _paceHold(u, o) {
    u.paceV = null;
    if (o.gid == null || slotRank(u.type) === 0 || !grounded(u)) return false;
    const dir = u.side === 0 ? 1 : -1;
    let armor = null, fast = null;
    for (const v of this.units) {
      if (v === u || v.side !== u.side || v.hp <= 0 || !grounded(v) || !v.radio || v.radio.gid !== o.gid) continue;
      if (slotRank(v.type) !== 0) continue;
      if (U.roleOf(v.type) === 'armor') { if (!armor || (v.x - armor.x) * dir > 0) armor = v; } else if (!fast || (v.x - fast.x) * dir > 0) fast = v;
    }
    const lead = armor || fast;
    if (!lead) return false;
    const ahead = (u.x - lead.x) * dir;
    if (ahead >= PACE_MAX) return false;
    let near = false;
    for (const v of this.units) if (v.side !== u.side && v.hp > 0 && grounded(v) && Math.hypot(v.x - u.x, v.y - u.y) < PACE_NEAR) { near = true; break; }
    const line = near ? -PACE_GAP : PACE_FREE;
    const e = ahead - (line - PACE_RAMP); // 0 = settle point while the lead walks; PACE_RAMP = the line
    if (e <= -PACE_EASE) return false;
    const ta = TYPES[u.type], tl = TYPES[lead.type];
    const own = ta.speed * (u.guard ? 1.12 : 1) * 1.2;
    const leadV = Math.min(own, tl.speed * (lead.guard ? 1.12 : 1) * 1.2 * (this._terrainAt(lead.x, lead.y) === 'rough' ? 0.55 : 1));
    const v = e < 0 ? leadV + (own - leadV) * (-e / PACE_EASE) : leadV * Math.max(0, 1 - e / PACE_RAMP);
    if (v >= own - 1e-6) return false;
    u.paceV = v;
    return true;
  }

  /**
   * MOVE holding the enemy home zone with no enemy in it: head for a point 55% of our range from
   * their base and stop as soon as the base is within range + 8 with a clear line, the reach the
   * base shot checks (so in practice we stop at about range + 8, like a unit with no order). Walls: when our row has no clear line from the standoff
   * point, use the normal lane (field middle plus our formation offset) like a unit with no order.
   */
  _radioToBase(u, a, dt, enemyBase, terrain) {
    if (Math.abs(enemyBase - u.x) < a.range + 8 && !this._lineBlocked(u.x, u.y, enemyBase, u.y)) return;
    const dir = u.side === 0 ? 1 : -1;
    const gx = enemyBase - dir * a.range * 0.55;
    // Fan out along the base: each unit keeps its MOVE lane (or its own row) instead of one point.
    let gy = this._fieldY(u.radio && u.radio.sy != null ? u.radio.sy : u.y);
    if (this._lineBlocked(gx, gy, enemyBase, gy) || this._blockedAt(gx, gy, a.r + 2)) gy = this._fieldY(H / 2 + (u.formationOffset || 0));
    this._radioMove(u, a, dt, gx, gy, terrain);
  }

  /**
   * Holding a MOVE zone with no enemy in it: walk to our slot (zone middle + depth offset, our lane)
   * and stand there. Once there (held), we only walk back when pushed more than 20 px off it, so a
   * crowd settles instead of jostling for exact spots.
   */
  _toSlot(u, a, dt, o, lo, hi, terrain) {
    const gx = Math.max(lo + 6, Math.min(hi - 6, (lo + hi) / 2 + (o.sx || 0)));
    const gy = this._fieldY(o.sy);
    const d = Math.hypot(gx - u.x, gy - u.y);
    if (o.held) {
      // Held: walk back only when pushed well off the spot we settled on.
      if (d < Math.max(20, (o.heldD || 0) + 10)) return;
      o.held = false; o.stall = null;
    }
    // Arrived: on the spot, close to it while other units press on us (a crowd can keep us from the
    // exact point forever), or no closer for SLOT_STALL_S. Before, units fought for exact points.
    const pressed = u.crowdAt != null && this.elapsed - u.crowdAt < 0.3;
    // The stall clock runs only while we keep walking to the slot (a chase or a walk resets it), and
    // only near the slot: a unit far away and blocked is the no-progress watch's job (re-path).
    if (!o.stall || d < o.stall.d - 2 || this.elapsed - o.stall.seen > 0.2) o.stall = { d, t: this.elapsed, seen: this.elapsed };
    o.stall.seen = this.elapsed;
    const stalled = d < SLOT_STALL_NEAR && this.elapsed - o.stall.t >= SLOT_STALL_S;
    if (d < SLOT_ARRIVE || (pressed && d < SLOT_PRESSED) || stalled) {
      o.held = true; o.heldD = d; o.stall = null;
      return;
    }
    this._radioMove(u, a, dt, gx, gy, terrain);
  }

  /**
   * MOVE slots for a group: ground units share up to SLOT_LANES lanes across the field, centred on
   * the group's mean height, in rows up to SLOT_DEPTH px apart along the line of march. Front-liners
   * (armor, fast) get the rows nearest the enemy, ranged units the next, healers the last. Air units
   * keep no slot. Sets o.sy (lane height) and o.sx (depth offset from the zone middle) on each unit's order.
   */
  _assignSlots(side, units) {
    const ground = units.filter(u => u.radio && u.radio.kind === 'move' && planeOfUnit(u) === 'ground' && !U.isFlying(u.type));
    const n = ground.length;
    if (!n) return;
    // Rows by role (slotRank): front-liners (armor, fast) take the rows nearest the enemy, then
    // ranged units, then healers. Each role starts a new row; inside a row, lanes go top to bottom by
    // current height so nobody crosses the group, and a short row is centred.
    ground.sort((p, q) => (slotRank(p.type) - slotRank(q.type)) || (p.y - q.y) || (p.id - q.id));
    const byRank = [0, 1, 2].map(r => ground.filter(u => slotRank(u.type) === r)).filter(l => l.length);
    const lanes = Math.min(SLOT_LANES, Math.max(...byRank.map(l => l.length)));
    const lines = [];
    for (const list of byRank) for (let i = 0; i < list.length; i += lanes) lines.push(list.slice(i, i + lanes));
    const rows = lines.length;
    const top = 30 + 14, bot = H - 24 - 14;
    const gap = Math.min(SLOT_GAP, (bot - top) / Math.max(1, lanes - 1));
    const mean = ground.reduce((sum, u) => sum + u.y, 0) / n;
    const half = (gap * (lanes - 1)) / 2;
    const cy = Math.max(top + half, Math.min(bot - half, mean));
    const dir = side === 0 ? 1 : -1;
    // Rows closer than SLOT_DEPTH when there are many, so every row fits in the zone.
    const depth = Math.min(SLOT_DEPTH, (W / C.ZONES - 20) / Math.max(1, rows - 1));
    lines.forEach((line, row) => {
      line.sort((p, q) => (p.y - q.y) || (p.id - q.id));
      const off = (lanes - line.length) / 2;
      line.forEach((u, i) => {
        u.radio.sy = cy - half + (i + off) * gap;
        u.radio.sx = dir * ((rows - 1) / 2 - row) * depth;
        u.radio.held = false; u.radio.stall = null;
      });
    });
    // A slot inside a wall's padding can never be reached (the unit pressed on the wall forever):
    // move it to the nearest free lane, up or down, on the same row.
    // Not onto another slot of the same row either (two units on one spot shove each other).
    const zw = W / C.ZONES;
    const minGap = Math.min(gap, 24);
    const taken = (u, sy) => ground.some(v => v !== u && v.radio.sx === u.radio.sx && Math.abs(v.radio.sy - sy) < minGap);
    for (const u of ground) {
      const o = u.radio;
      if (o.zone == null) continue;
      const lo = o.zone * zw, hi = lo + zw;
      const gx = Math.max(lo + 6, Math.min(hi - 6, (lo + hi) / 2 + (o.sx || 0)));
      const r = TYPES[u.type].r + 2;
      if (!this._blockedAt(gx, o.sy, r)) continue;
      let pick = null, loose = null;
      for (let k = 1; k <= 40 && pick == null; k++) {
        const sy = this._fieldY(o.sy + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 8);
        if (this._blockedAt(gx, sy, r)) continue;
        if (loose == null) loose = sy;
        if (!taken(u, sy)) pick = sy;
      }
      if (pick != null || loose != null) o.sy = pick != null ? pick : loose;
    }
  }

  /** Spatial hash of live units, by plane, for steering and separation. Cells are SEP_CELL px. */
  _buildGrid() {
    const grid = new Map();
    for (const u of this.units) {
      if (u.hp <= 0 || u.detonated) continue;
      const key = `${planeOfUnit(u)}:${Math.floor(u.x / SEP_CELL)}:${Math.floor(u.y / SEP_CELL)}`;
      const cell = grid.get(key);
      if (cell) cell.push(u); else grid.set(key, [u]);
    }
    this._grid = grid;
    return grid;
  }

  /** Units on plane p in the 3x3 cells round (x, y). Grid order: stable (this.units order). */
  _near(p, x, y, fn) {
    const cx = Math.floor(x / SEP_CELL), cy = Math.floor(y / SEP_CELL);
    for (let j = cy - 1; j <= cy + 1; j++) for (let i = cx - 1; i <= cx + 1; i++) {
      const cell = this._grid && this._grid.get(`${p}:${i}:${j}`);
      if (cell) for (const v of cell) fn(v);
    }
  }

  /**
   * Steer round a friend in the way: the nearest same-plane friend ahead whose hull overlaps our
   * path within STEER_LOOK px past contact turns us sideways, away from it (tie: by id). Enemies are
   * not steered round; we meet them face to face. Returns the new unit direction [dx, dy].
   */
  _steer(u, a, dx, dy, step) {
    if (!(dx || dy) || !this._grid) return [dx, dy];
    const p = planeOfUnit(u);
    let best = null, bestAlong = Infinity, bestLat = 0;
    this._near(p, u.x, u.y, v => {
      if (v === u || v.side !== u.side || v.hp <= 0 || v.detonated) return;
      const rr = a.r + TYPES[v.type].r;
      const rx = v.x - u.x, ry = v.y - u.y;
      const along = rx * dx + ry * dy;
      if (along <= 0 || along > rr + STEER_LOOK + step) return;
      const lat = dx * ry - dy * rx;
      if (Math.abs(lat) >= rr) return;
      if (along < bestAlong) { best = v; bestAlong = along; bestLat = lat; }
    });
    // Sticky: for STEER_KEEP_S after a choice we keep going round the same friend on the same side,
    // as long as that friend is still in the way (or nobody else is nearer). Re-picking every step
    // was the main source of jitter (a unit swapped sides as the friend drifted across its path).
    const mem = u.steerMem;
    const fresh = mem && this.elapsed - mem.t < STEER_KEEP_S;
    if (fresh && best && mem.id !== best.id) {
      const f = this.units.find(v => v.id === mem.id && v.hp > 0 && !v.detonated);
      if (f) {
        const rx = f.x - u.x, ry = f.y - u.y, along = rx * dx + ry * dy, rr0 = a.r + TYPES[f.type].r;
        if (along > 0 && along <= rr0 + STEER_LOOK + step && Math.abs(dx * ry - dy * rx) < rr0 + 4) {
          best = f; bestAlong = along; bestLat = dx * ry - dy * rx;
        }
      }
    }
    if (!best) return [dx, dy];
    const rr = a.r + TYPES[best.type].r;
    let away = bestLat > 0 ? -1 : bestLat < 0 ? 1 : (u.id < best.id ? 1 : -1);
    if (fresh) away = mem.side;
    else u.steerMem = { id: best.id, side: away, t: this.elapsed };
    const w = Math.min(1.5, Math.max(0.35, 1.5 * (1 - (bestAlong - rr) / (STEER_LOOK + step))));
    const turn = side => { const nx = dx + -dy * side * w, ny = dy + dx * side * w, nd = Math.hypot(nx, ny) || 1; return [nx / nd, ny / nd]; };
    // Never steer into a wall: when the chosen side runs into wall padding, take the other side (and
    // remember it); when both do, keep the path's own direction and let separation sort it out.
    const look = Math.max(a.r, step + 2) + 4, pad = a.r + 2;
    const free = d => !this._blockedAt(u.x + d[0] * look, u.y + d[1] * look, pad) || this._wallOverlap(u.x, u.y, pad);
    let dir = turn(away);
    if (!free(dir)) {
      const alt = turn(-away);
      if (free(alt)) { dir = alt; u.steerMem = { id: best.id, side: -away, t: this.elapsed }; } else return [dx, dy];
    }
    return dir;
  }

  /**
   * Push apart every overlapping pair on the same plane (SEP_PASSES passes, stable order). A pair
   * splits the overlap by mass (radius squared), so a Breaker shoves a Scout more than the other way
   * round. A push never moves a unit into a wall's padding or off the field; whatever one unit cannot
   * take, the other takes. Exact overlaps split along a direction set by the two ids.
   */
  _separate() {
    const live = this.units.filter(u => u.hp > 0 && !u.detonated);
    if (live.length < 2) return;
    for (let pass = 0; pass < SEP_PASSES; pass++) {
      this._buildGrid();
      let moved = false;
      for (let i = 0; i < live.length; i++) {
        const u = live[i];
        const ra = TYPES[u.type].r;
        const p = planeOfUnit(u);
        this._near(p, u.x, u.y, v => {
          if (v.id <= u.id) return;
          const rb = TYPES[v.type].r;
          let ex = v.x - u.x, ey = v.y - u.y;
          let d = Math.hypot(ex, ey);
          const over = ra + rb - d;
          if (over <= 0.01) return;
          if (d < 1e-6) {
            const ang = ((u.id * 7 + v.id * 13) % 16) * Math.PI / 8;
            ex = Math.cos(ang); ey = Math.sin(ang); d = 1;
          } else { ex /= d; ey /= d; }
          const mu = ra * ra, mv = rb * rb;
          const su = over * mv / (mu + mv);
          // A flying unit ignores walls, so a push may move it over one (r -1: no wall check).
          const pu = U.isFlying(u.type) ? -1 : ra + 2, pv = U.isFlying(v.type) ? -1 : rb + 2;
          const du = this._nudge(u, -ex * su, -ey * su, pu);
          const dv = this._nudge(v, ex * (over - du), ey * (over - du), pv);
          const left = over - du - dv;
          if (left > 0.01) this._nudge(u, -ex * left, -ey * left, pu);
          u.crowdAt = v.crowdAt = this.elapsed;
          moved = true;
        });
      }
      if (!moved) break;
    }
  }

  /** Move u by (dx, dy) unless that puts it in a wall's padding or off the field; tries each axis alone too. Returns the distance moved. */
  _nudge(u, dx, dy, r) {
    const ox = u.x, oy = u.y;
    const nx = this._fieldX(u.x + dx), ny = this._fieldY(u.y + dy);
    if (r < 0) { u.x = nx; u.y = ny; return Math.hypot(u.x - ox, u.y - oy); }
    // Already inside a wall's padding (a spawn slot, a knockback): never push the centre into the wall itself.
    const pad = this._wallOverlap(u.x, u.y, r) ? 0 : r;
    const ok = (x, y) => !this._wallOverlap(x, y, pad);
    if (ok(nx, ny)) { u.x = nx; u.y = ny; }
    else if (ok(nx, u.y)) u.x = nx;
    else if (ok(u.x, ny)) u.y = ny;
    return Math.hypot(u.x - ox, u.y - oy);
  }

  _woundedAlly(side, medic) {
    let best = null, missing = 1;
    for (const u of this.units) {
      // A unit on FALLBACK is coming to us for treatment: it goes first.
      const lost = u.max - u.hp + (u.radio && u.radio.kind === 'fallback' && u.radio.phase === 'go' && u.hp < u.max ? 1000 : 0);
      if (u.side === side && u !== medic && lost > missing) { best = u; missing = lost; }
    }
    return best;
  }

  // Shot look and weight follow the role: armor hits hard (knockback 64, blast), ranged fires a beam,
  // fast shots use the team tint, every other shot uses the unit's color from units.csv.
  _fireAt(u, target, a, tx, ty) {
    if (target) { u.firedAt = this.elapsed; target.hitAt = this.elapsed; }
    const heavy = a.role === 'armor';
    const col = a.role === 'fast' ? (u.side === 0 ? '#d8ffb5' : '#ffd0bc') : a.color;
    const life = heavy ? 0.24 : a.role === 'ranged' ? 0.15 : 0.10;
    this.shots.push({ x: u.x, y: u.y, tx, ty, type: u.type, side: u.side, col, life, maxLife: life });
    this.combatFx.push({ x: u.x, y: u.y, t: 0, life: 0.13, kind: 'muzzle', col, r: heavy ? 10 : 6 });
    if (target) {
      if (U.isKamikaze(target.type)) target.downBy = a.code; // the shot-down note names the last shooter
      const b = a.bonusVs && a.bonusVs[TYPES[target.type] ? TYPES[target.type].code : ''];
      target.hp -= b ? a.dmg * b : a.dmg;
      target.hitFlash = 0.19;
      const d = Math.hypot(target.x - u.x, target.y - u.y) || 1;
      const k = heavy ? 64 : 22;
      target.kx = (target.kx || 0) + (target.x - u.x) / d * k;
      target.ky = (target.ky || 0) + (target.y - u.y) / d * k;
      this.combatFx.push({ x: target.x, y: target.y, t: 0, life: heavy ? 0.38 : 0.22, kind: heavy ? 'blast' : 'impact', col: heavy ? a.color : '#f8efcc', r: heavy ? 23 : 12 });
      this._sparks(target.x, target.y, col, heavy ? 9 : 5);
    }
  }

  _sparks(x, y, col, n = 5) {
    for (let i = 0; i < n; i++) {
      const a = this.rng() * Math.PI * 2, v = 18 + this.rng() * 38;
      this.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.3 + this.rng() * 0.25, col });
    }
  }

  /** FOCUS, AUTOBUY and radio orders end with the match. */
  _clearStanding() {
    this.focus = [null, null];
    this.focusScope = [null, null];
    this.autobuy = [null, null];
    this.radioT0 = [[], []];
    for (const u of this.units || []) u.radio = null;
  }

  _end(side, reason) {
    this.over = true;
    this._clearStanding();
    this.paused = this.pauseAfterMatch || this.holdNext;
    this.holdNext = false;
    this.cameraShake = 0;
    const name = side == null ? 'NOBODY' : this.labels[side].label;
    this.winner = side == null ? { side: null, seat: null, name: 'NOBODY', reason } : {
      side, seat: this.labels[side].seat, name, reason,
    };
    this._log(`${side == null ? 'DRAW' : TEAM[side].log} wins · ${reason}`, side == null ? undefined : side);
    if (!this._endEmitted) {
      this._endEmitted = true;
      const win = this.winner.side == null ? 'draw' : `${P.teamTag(this._seatName(this.winner.side), this.winner.side)} won`;
      this._pushReport(0, 'END', this._endNote(0, win));
      this._pushReport(1, 'END', this._endNote(1, win));
      this.emit('matchEnd', this.publicState());
    }
    this._emit();
  }

  _say(side, title, detail) {
    if (this.sayState[side] === title) return;
    this.sayState[side] = title;
    this.decisionsText[side] = { title, detail };
  }

  _clock() {
    return `${String(Math.floor(this.elapsed / 60)).padStart(2, '0')}:${String(Math.floor(this.elapsed % 60)).padStart(2, '0')}`;
  }

  _metaMs() {
    const meta = this._orderMeta;
    return meta && Number.isFinite(meta.decideMs) ? meta.decideMs : null;
  }

  _orderWhy() {
    const meta = this._orderMeta;
    return meta && meta.why ? meta.why : '';
  }

  _warriorBadge(side, decideMs) {
    if (this.drivers[side] !== 'warrior' || !Number.isFinite(decideMs)) return '';
    return `${(Math.max(0, decideMs) / 1000).toFixed(1)}s`;
  }

  _holdDetail(side) {
    let intruders = 0;
    for (const u of this.units) if (u.side !== side && inHomeZone(side, u.x)) intruders++;
    return intruders ? 'base threat' : 'reserve';
  }

  /** Newest first, eight rows. Repeated holds and banks collapse so a cadence does not flood the panel. */
  _pushPanel(side, row) {
    if (side !== 0 && side !== 1 || !row) return;
    const list = this.panelFeed[side] || (this.panelFeed[side] = []);
    const top = list[0];
    const detail = row.detail || '';
    const why = row.why || '';
    const auto = !!row.auto;
    if (top && (row.kind === 'hold' || row.kind === 'bank') && top.kind === row.kind && top.verb === row.verb && top.detail === detail && top.why === why && top.auto === auto) return;
    list.unshift({ at: this._clock(), kind: row.kind, verb: row.verb, detail, why, ms: row.ms || '', auto });
    if (list.length > 8) list.length = 8;
    this._panelTouched = true;
  }

  _orderRow(side, kind, verb, detail) {
    // Orders posted on READY already have their row; applying them at T0 adds only ERR rows.
    if (this._t0Drain && kind !== 'err') return;
    this._pushPanel(side, {
      kind, verb, detail,
      ms: this._warriorBadge(side, this._metaMs()),
      why: kind === 'err' ? '' : this._orderWhy(),
    });
  }

  _panelHold(side, d) {
    if (!d || !d.title || d.noted) return;
    if (/AWAITING WARRIOR/i.test(d.title)) return;
    let detail = 'reserve';
    if (/MEDICS HELD/i.test(d.title)) detail = 'medics held';
    else if (/LAST UNIT|BASE GUARD/i.test(d.title)) detail = 'base guard';
    else if (/threat/i.test(d.detail || '')) detail = 'base threat';
    this._pushPanel(side, {
      kind: 'hold', verb: 'HOLD', detail,
      why: d.why || P.reasonFromLabel(d.title),
      ms: d.autopilot ? '' : this._warriorBadge(side, d.decideMs),
      auto: !!d.autopilot,
    });
  }

  _panelDeploy(side, d) {
    const types = (d.deploy && d.deploy.types) || [];
    if (!types.length) return;
    const codes = types.map(k => P.CODE_BY_TYPE[k]).join(' ');
    const counts = emptyCounts();
    types.forEach(k => { if (counts[k] != null) counts[k]++; });
    const title = d.title || '';
    let detail = P.formatCounts(counts);
    const warriorWave = d.all || /WARRIOR DEPLOY/i.test(title);
    if (!warriorWave) {
      if (d.deploy.medicUrgent || /MEDIC|WOUNDED|FIELD SUPPORT/i.test(title)) detail = 'wounded ally';
      else if (d.deploy.guard || /BASE GUARD/i.test(title)) detail = 'base threat';
      else if (/SCOUT/i.test(title)) detail = 'scout';
      else if (/RANGED|RIFLE/i.test(title)) detail = 'rifles';
      else if (/BREAKER|TANK/i.test(title)) detail = 'breaker';
    }
    const auto = !!d.autopilot;
    this._pushPanel(side, {
      kind: 'deploy',
      verb: d.all ? 'DEPLOY ALL' : `DEPLOY ${codes}`,
      detail,
      why: d.why || (warriorWave ? '' : P.reasonFromLabel(title)),
      ms: auto ? '' : this._warriorBadge(side, d.decideMs),
      auto,
    });
  }

  _log(msg, side) {
    const stamp = `${String(Math.floor(this.elapsed / 60)).padStart(2, '0')}:${String(Math.floor(this.elapsed % 60)).padStart(2, '0')}`;
    this.logs.unshift({ msg, side, at: stamp });
    this.logs = this.logs.slice(0, 4);
  }

  _randomizeTerrain() {
    const bands = [[[2, 2, 2, 2], [4, 5, 1, 2], [1, 8, 2, 1], [6, 9, 2, 2], [5, 1, 1, 1], [3, 10, 2, 1]], [[8, 2, 2, 1], [11, 4, 1, 2], [9, 8, 2, 2], [13, 1, 2, 2], [12, 9, 1, 1], [7, 5, 2, 1]], [[17, 2, 2, 2], [20, 5, 2, 1], [16, 8, 2, 2], [21, 9, 1, 1], [18, 6, 1, 2], [15, 3, 1, 1]]];
    const cells = [];
    const occupied = new Set();
    for (let band = 0; band < 3; band++) {
      const pool = bands[band].slice().sort(() => this.rng() - 0.5);
      let chosen = 0;
      for (const c of pool) {
        const [x, y, w, h] = c;
        let clear = true;
        for (let xx = x - 1; xx < x + w + 1; xx++) for (let yy = y - 1; yy < y + h + 1; yy++) if (occupied.has(`${xx},${yy}`)) clear = false;
        if (!clear) continue;
        cells.push(c);
        for (let xx = x; xx < x + w; xx++) for (let yy = y; yy < y + h; yy++) occupied.add(`${xx},${yy}`);
        if (++chosen === 2) break;
      }
    }
    this.walls = cells.map(([x, y, w, h]) => [x / 24, y / 12, (x + w) / 24, (y + h) / 12]);
    const roughPool = [[1, 2, 4, 4], [6, 1, 9, 3], [10, 1, 13, 3], [15, 1, 18, 3], [19, 2, 23, 4], [2, 5, 5, 7], [7, 5, 10, 7], [12, 4, 15, 6], [17, 5, 20, 7], [1, 8, 4, 11], [6, 8, 9, 11], [11, 8, 14, 11], [15, 8, 18, 11], [19, 8, 23, 11], [4, 3, 7, 5], [13, 6, 16, 8]];
    this.rough = roughPool.sort(() => this.rng() - 0.5).slice(0, 6).map(([x, y, x2, y2]) => [x / 24, y / 12, x2 / 24, y2 / 12]);
  }

  _inRects(x, y, rects) {
    const nx = x / W, ny = y / H;
    return rects.some(([x0, y0, x1, y1]) => nx >= x0 && nx <= x1 && ny >= y0 && ny <= y1);
  }
  _wallOverlap(x, y, r = 0) {
    for (const [x0, y0, x1, y1] of this.walls) {
      const l = x0 * W - r, t = y0 * H - r, rr = x1 * W + r, b = y1 * H + r;
      if (x >= l && x <= rr && y >= t && y <= b) return true;
    }
    return false;
  }
  // One walkability rule for _move and the pathfinder: the field limits, then wall padding.
  _fieldX(x) { return Math.max(15, Math.min(W - 15, x)); }
  _fieldY(y) { return Math.max(30, Math.min(H - 24, y)); }
  _blockedAt(x, y, r) { return this._wallOverlap(this._fieldX(x), this._fieldY(y), r); }
  _move(u, dx, dy, r) {
    if (this._wallOverlap(u.x, u.y, r)) Object.assign(u, this._freePoint(u.x, u.y, r));
    const length = Math.hypot(dx, dy);
    const n = Math.max(1, Math.ceil(length / Math.max(2, r * 0.35)));
    const sx = dx / n, sy = dy / n;
    for (let i = 0; i < n; i++) {
      const nx = this._fieldX(u.x + sx), ny = this._fieldY(u.y + sy);
      if (!this._wallOverlap(nx, ny, r)) { u.x = nx; u.y = ny; continue; }
      if (!this._wallOverlap(nx, u.y, r)) u.x = nx;
      if (!this._wallOverlap(u.x, ny, r)) u.y = ny;
    }
  }
  // Nearest walkable point to (px, py), straight out of the wall padding it is in.
  // A spawn slot can sit inside a block's padding at the home edge, and _move refuses
  // every step from inside; a goal inside padding can never be reached.
  _freePoint(px, py, r) {
    let best = null;
    for (const [x0, y0, x1, y1] of this.walls) {
      const l = x0 * W - r, t = y0 * H - r, rr = x1 * W + r, b = y1 * H + r;
      if (!(px >= l && px <= rr && py >= t && py <= b)) continue;
      for (const [x, y] of [[l - 0.01, py], [rr + 0.01, py], [px, t - 0.01], [px, b + 0.01]]) {
        if (x !== this._fieldX(x) || y !== this._fieldY(y) || this._wallOverlap(x, y, r)) continue;
        const d = Math.hypot(x - px, y - py);
        if (!best || d < best.d) best = { x, y, d };
      }
    }
    return best ? { x: best.x, y: best.y } : { x: px, y: py };
  }
  // A unit that keeps stepping but gets nowhere in 1.5 s (pressed on a wall, or flipping
  // between two routes) is on a bad route. For the next 3 s it drops its formation lane
  // and the pathfinder avoids the cell it was heading for. Knockback windows don't count.
  _watchProgress(u, want, ox, oy, way, dt) {
    if (want < 0.2) return; // at its waypoint; nothing asked
    const w = u.progress || (u.progress = { x: ox, y: oy, t: 0, asked: 0, knocked: false });
    w.t += dt; w.asked += want;
    if (Math.hypot(u.kx || 0, u.ky || 0) > 2) w.knocked = true;
    // Pressed by other units (separation) rather than a wall: count it, a crowd is not a bad route.
    if (u.crowdAt != null && this.elapsed - u.crowdAt < dt * 1.5) w.crowd = (w.crowd || 0) + dt;
    if (w.t < 1.5) return;
    u.progress = null;
    // A crowd is not a bad route on its own, but a unit pressed in a crowd that has barely moved is
    // stuck too: it re-paths as well (a stricter bar, 10% of what it asked instead of 25%).
    const moved = Math.hypot(u.x - w.x, u.y - w.y);
    if (w.knocked || w.asked < 6) return;
    if (moved >= w.asked * ((w.crowd || 0) > w.t * 0.5 ? 0.1 : 0.25)) return;
    const cellW = W / 24, cellH = H / 12;
    const wc = Math.floor(way.y / cellH) * 24 + Math.floor(way.x / cellW);
    u.repath = 3;
    u.avoidCell = wc === Math.floor(u.y / cellH) * 24 + Math.floor(u.x / cellW) ? -1 : wc;
  }
  _terrainAt(x, y) {
    if (this._inRects(x, y, this.walls)) return 'wall';
    if (this._inRects(x, y, this.rough)) return 'rough';
    return 'plain';
  }
  _lineBlocked(x0, y0, x1, y1) {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 8);
    for (let i = 1; i < n; i++) {
      const q = i / n;
      if (this._terrainAt(x0 + (x1 - x0) * q, y0 + (y1 - y0) * q) === 'wall') return true;
    }
    return false;
  }
  _pathPoint(x, y, tx, ty, r = 0, avoid = -1) {
    const cols = 24, rows = 12, cellW = W / cols, cellH = H / rows;
    const cell = (px, py) => [Math.max(0, Math.min(cols - 1, Math.floor(px / cellW))), Math.max(0, Math.min(rows - 1, Math.floor(py / cellH)))];
    const blocked = (cx, cy) => cy * cols + cx === avoid || this._blockedAt((cx + 0.5) * cellW, (cy + 0.5) * cellH, r);
    let [gx, gy] = cell(tx, ty);
    if (blocked(gx, gy)) {
      let found = false;
      for (let rad = 1; rad < 5 && !found; rad++) for (let yy = -rad; yy <= rad && !found; yy++) for (let xx = -rad; xx <= rad && !found; xx++) {
        const ax = gx + xx, ay = gy + yy;
        if (ax >= 0 && ax < cols && ay >= 0 && ay < rows && !blocked(ax, ay)) { gx = ax; gy = ay; found = true; }
      }
    }
    const [sx, sy] = cell(x, y);
    const goal = gy * cols + gx, start = sy * cols + sx;
    const direct = () => (this._blockedAt(tx, ty, r) ? this._freePoint(this._fieldX(tx), this._fieldY(ty), r) : { x: tx, y: ty });
    if (start === goal) return direct();
    const d = new Int16Array(cols * rows); d.fill(-1); d[goal] = 0;
    const q = new Int16Array(cols * rows);
    let head = 0, tail = 0; q[tail++] = goal;
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    while (head < tail) {
      const id = q[head++], cx = id % cols, cy = (id / cols) | 0;
      for (const [dx, dy] of dirs) {
        const ax = cx + dx, ay = cy + dy;
        if (ax < 0 || ax >= cols || ay < 0 || ay >= rows || blocked(ax, ay)) continue;
        if (dx && dy && (blocked(cx + dx, cy) || blocked(cx, cy + dy))) continue;
        const ni = ay * cols + ax;
        if (d[ni] < 0) { d[ni] = d[id] + 1; q[tail++] = ni; }
      }
    }
    let best = start, bestD = d[start];
    for (const [dx, dy] of dirs) {
      const ax = sx + dx, ay = sy + dy;
      if (ax < 0 || ax >= cols || ay < 0 || ay >= rows || blocked(ax, ay)) continue;
      const v = d[ay * cols + ax];
      if (v >= 0 && (bestD < 0 || v < bestD)) { best = ay * cols + ax; bestD = v; }
    }
    if (best === start || bestD < 0) return direct();
    return { x: this._fieldX((best % cols + 0.5) * cellW), y: this._fieldY((((best / cols) | 0) + 0.5) * cellH) };
  }

  /**
   * Apply up to 3 wire orders for one side. Lines run in order.
   * Returns { results: ['OK …'|'ERR …'] } or { error, results: [] } when the post itself is refused.
   */
  applyProtocolOrders(side, lines, meta) {
    if (side !== 0 && side !== 1) return { error: 'bad side', results: [] };
    const decideMs = meta && Number.isFinite(+meta.decideMs) ? Math.max(0, +meta.decideMs) : null;
    this._orderMeta = { decideMs, why: '' };
    this._panelTouched = false;
    this._postBuys = {}; // type -> units bought by this post (max_per_buy, buy_cooldown_s)
    try {
      // Over covers the moment END is written and the hold between matches. A late
      // order must not append ORDER after END, or the loop's last poll would miss END.
      if (this.over) {
        this._orderRow(side, 'err', 'ERR', 'match over');
        if (this._panelTouched) this._emit();
        return { error: 'match over', results: ['ERR match over'] };
      }
      // The commander posting for a silent Ember warrior (takeover) is not that warrior's contact.
      if (!(meta && meta.npc && this.takeover[side])) {
        this.noteWarriorContact(side);
        this.warriorWired[side] = true;
      }
      const list = [];
      let why = '';
      for (const raw of lines || []) {
        const parsed = P.parseOrder(raw);
        if (parsed.skip) continue;
        if (parsed.why) {
          if (!why) why = parsed.why;
          continue;
        }
        list.push(parsed);
      }
      this._orderMeta.why = why;
      if (!list.length) return { error: 'no orders', results: [] };
      if (list.length > 3) {
        this._orderRow(side, 'err', 'ERR', 'at most 3 orders');
        if (this._panelTouched) this._emit();
        return { error: 'at most 3 orders per post', results: [] };
      }
      const scratch = this._uncommittedReserve(side);
      const results = list.map(parsed => {
        // A radio order (or scoped FOCUS) names units on the field: a DEPLOY earlier in this
        // post fields first, so `DEPLOY ALL` + `MOVE R z3` works in one post.
        if (this.phase === 'live' && (parsed.radio || parsed.scoped) && !this.over) this._flushLiveDeploys(side);
        return this._applyParsedOrder(side, parsed, scratch);
      });
      // Live DEPLOY is queued for the next sim step; field it now so the STATE line and the
      // next outbox report show the unit in f (or still in res after a bare BUY).
      let mutated = results.some(r => /^OK BUY /.test(r) || /^OK DEPLOY /.test(r));
      if (mutated && this.phase === 'live') this._flushLiveDeploys(side);
      // A live AUTOBUY (or a BUY that lifted BANK) can fire at once, so the reply shows it.
      if (this.autobuy[side] && this.phase === 'live' && this._autobuyStep(side)) mutated = true;
      // No ORDER record. The reply carries OK/ERR and a fresh state line.
      // Also push STATE into the outbox: a CREDITS/HEARTBEAT snapshotted between the
      // answered report and this post would otherwise be handed back by long-poll with
      // the pre-buy bank (can-buy then lists units the live bank cannot cover).
      // A standing or radio order changes the line too (`focus M`, `auto T`, `R2@z4>z5`; HOLD does not): a report
      // snapshotted before this post would otherwise echo the old `focus D` until the next STATE.
      if (mutated || (this.phase === 'live' && !(meta && meta.npc) && results.some(r => /^OK (FOCUS|AUTOBUY|BANK|MOVE|ASSIST|FALLBACK|CLEAR)\b/.test(r)))) this._pushReport(side, 'STATE');
      const state = this.protocolState(side);
      if (results.some(r => r.startsWith('OK')) || this._panelTouched) this._emit();
      return { results, ...state };
    } finally {
      this._orderMeta = null;
      this._postBuys = null;
    }
  }

  /** This seat just fetched a live report or posted an order. Match clock, not wall clock. */
  noteWarriorContact(side) {
    if (side !== 0 && side !== 1) return;
    this.warriorSeenAt[side] = this.elapsed;
  }

  beginReportWait(side) {
    if (side !== 0 && side !== 1) return;
    this.warriorPolls[side] += 1;
    this.noteWarriorContact(side);
  }

  endReportWait(side) {
    if (side !== 0 && side !== 1) return;
    this.warriorPolls[side] = Math.max(0, (this.warriorPolls[side] || 0) - 1);
    this.noteWarriorContact(side);
  }

  /**
   * Absolute count of relay long-polls open for this seat. The relay sends the
   * number (not a start/stop edge) so a reconnect cannot leave a poll stuck on.
   */
  setRelayPolls(side, n) {
    if (side !== 0 && side !== 1) return;
    const next = Math.max(0, n | 0);
    if ((this.relayPolls[side] || 0) === next) return;
    this.relayPolls[side] = next;
    this.noteWarriorContact(side);
  }

  _warriorTalking(side) {
    if ((this.warriorPolls[side] || 0) > 0 || (this.relayPolls[side] || 0) > 0) return true;
    const seen = this.warriorSeenAt[side];
    if (seen == null) return false;
    return this.elapsed - seen < this.warriorActiveS;
  }

  /** Protocol report record for this seat's `id`, or null. */
  reportRecord(side, id) {
    return (this.protocolReports[side] || []).find(r => r.id === id) || null;
  }

  /** Wall-clock ms when this seat's report `id` was sent, or null. */
  reportSentAt(side, id) {
    const rec = this.reportRecord(side, id);
    return rec && typeof rec.sentAt === 'number' ? rec.sentAt : null;
  }

  _uncommittedReserve(side) {
    const rem = cloneCounts(this.reserve[side]);
    // Queued DEPLOYs take only what the free active slots will field; the rest is still uncommitted.
    let room = this._activeRoom(side);
    for (const item of this.decisionQueue[side] || []) {
      if (!item || item.hold) continue;
      if (item.all) {
        for (const k of capPick(rem, room)) { rem[k]--; room--; }
        continue;
      }
      for (const t of item.types || []) if (rem[t] > 0 && room > 0) { rem[t]--; room--; }
    }
    return rem;
  }

  _applyParsedOrder(side, parsed, scratch) {
    if (parsed.error) return this._refuse(side, parsed, parsed.error);
    if (parsed.op === 'HOLD') {
      if (this.phase !== 'live') {
        this.decisionQueue[side] = (this.decisionQueue[side] || []).filter(item => !(item && item.atT0));
        this._orderRow(side, 'hold', 'HOLD', 'cleared wave');
        return P.reply(parsed);
      }
      const item = { hold: true, noted: true, decideMs: this._metaMs(), why: this._orderWhy() };
      if (!this.pushDecision(side, item)) return this._refuse(side, parsed, 'queue full');
      this._orderRow(side, 'hold', 'HOLD', this._holdDetail(side));
      return P.reply(parsed);
    }
    if (parsed.op === 'BANK') {
      this.bankHold[side] = true;
      this._orderRow(side, 'bank', 'BANK', '');
      return P.reply(parsed);
    }
    if (parsed.op === 'BUY') return this._liveBuy(side, parsed, scratch);
    if (parsed.op === 'DEPLOY') return this._liveDeploy(side, parsed, scratch);
    if (parsed.op === 'FOCUS') return this._setFocus(side, parsed);
    if (parsed.radio) return this._radioOrder(side, parsed);
    if (parsed.op === 'AUTOBUY') return this._setAutobuy(side, parsed);
    return this._refuse(side, parsed, 'unknown order');
  }

  /** Reply for a standing order. Before T0 it says so, like a queued DEPLOY. */
  _standingReply(parsed) {
    return this.phase !== 'live' ? `OK ${parsed.line} (at T0)` : P.reply(parsed);
  }

  /**
   * Units named by radio selectors, living now. `rank` orders the pick for `2R` (best first).
   * Returns { units } or { error }: unknown ID, dead ID, or not enough of a code on the field.
   */
  _resolveSel(side, sels, rank) {
    const mine = this.units.filter(u => u.side === side && u.hp > 0);
    const out = new Set();
    for (const sel of sels) {
      if (sel.all) { mine.forEach(u => out.add(u)); continue; }
      if (sel.id) {
        const u = mine.find(v => this._tagOf(v) === sel.id);
        if (u) { out.add(u); continue; }
        const issued = (this.unitSerial && this.unitSerial[side] && this.unitSerial[side][sel.type]) || 0;
        return { error: sel.n <= issued ? `${sel.id} is dead` : `unknown unit ${sel.id}` };
      }
      const code = P.CODE_BY_TYPE[sel.type];
      let group = mine.filter(u => u.type === sel.type);
      if (!group.length) return { error: `no ${code} on the field` };
      if (sel.count != null) {
        if (group.length < sel.count) return { error: `only ${group.length}${code} on the field` };
        group = group.slice().sort((x, y) => (rank ? rank(x) - rank(y) : 0) || x.serial - y.serial).slice(0, sel.count);
      }
      group.forEach(u => out.add(u));
    }
    if (!out.size) return { error: 'no units on the field' };
    return { units: [...out] };
  }

  /** Short panel text for a unit list: the IDs while they fit, else a count. */
  _unitsText(units, max = 18) {
    const ids = units.map(u => this._tagOf(u)).join(' ');
    return ids.length <= max ? ids : `${units.length} units`;
  }

  /**
   * MOVE, ASSIST, FALLBACK, CLEAR. Before T0 they are queued and applied in order at T0
   * (`OK MOVE R z5 (at T0)`); units are found then. Live they act at once.
   */
  _radioOrder(side, parsed) {
    if (this.phase !== 'live') {
      this.radioT0[side].push({ parsed, why: this._orderWhy() });
      this._radioRow(side, parsed, null);
      return `OK ${parsed.line} (at T0)`;
    }
    const zw = W / C.ZONES;
    if (parsed.op === 'MOVE') {
      const center = parsed.zone * zw + zw / 2;
      const r = this._resolveSel(side, parsed.sels, u => Math.abs(u.x - center));
      if (r.error) return this._refuse(side, parsed, r.error);
      const gid = ++this.moveSeq;
      for (const u of r.units) u.radio = { kind: 'move', zone: parsed.zone, gid };
      this._assignSlots(side, r.units);
      this._rememberGroupOrder(side, parsed.sels, { zone: parsed.zone, gid, seq: gid });
      this._radioRow(side, parsed, r.units);
      return P.reply(parsed);
    }
    if (parsed.op === 'ASSIST') {
      if (!this._zoneHasEnemy(parsed.zone, side)) return this._refuse(side, parsed, `no enemy in z${parsed.zone + 1}`);
      const units = this.units.filter(u => u.side === side && u.hp > 0
        && Math.abs(C.zoneOf(u.x) - parsed.zone) <= parsed.radius && !(u.radio && u.radio.kind === 'fallback'));
      if (!units.length) return this._refuse(side, parsed, `no units within ${parsed.radius} of z${parsed.zone + 1}`);
      for (const u of units) {
        const prior = u.radio;
        u.radio = { kind: 'assist', zone: parsed.zone, back: C.zoneOf(u.x), phase: 'go', resume: prior && prior.kind === 'move' ? prior : prior && prior.resume || null };
      }
      this._radioRow(side, parsed, units);
      return P.reply(parsed);
    }
    if (parsed.op === 'FALLBACK') {
      const r = this._resolveSel(side, parsed.sels, u => u.hp / u.max);
      if (r.error) return this._refuse(side, parsed, r.error);
      const hurt = u => u.hp < u.max * 0.9;
      const named = parsed.sels.find(sel => sel.id && !hurt(r.units.find(u => this._tagOf(u) === sel.id)));
      if (named) return this._refuse(side, parsed, `${named.id} not hurt`);
      const units = r.units.filter(hurt);
      if (!units.length) return this._refuse(side, parsed, 'none hurt');
      for (const u of units) {
        const prior = u.radio;
        const medic = U.isHealer(u.type) ? null : this._nearestHealer(u);
        u.radio = { kind: 'fallback', back: C.zoneOf(u.x), phase: 'go', via: medic ? this._tagOf(medic) : 'base', resume: prior && prior.kind === 'move' ? prior : prior && prior.resume || null };
      }
      this._radioRow(side, parsed, units);
      return P.reply(parsed);
    }
    // CLEAR
    const r = this._resolveSel(side, parsed.sels);
    if (r.error) return this._refuse(side, parsed, r.error);
    for (const u of r.units) u.radio = null;
    this._rememberGroupOrder(side, parsed.sels, null);
    this._radioRow(side, parsed, r.units);
    return P.reply(parsed);
  }

  /**
   * MOVE inheritance memory for later deploys: MOVE ALL / MOVE <code> (no count, no ID) store
   * `move`; CLEAR ALL / CLEAR <code> (move null) store a clear. Counted or ID selectors are not a group.
   */
  _rememberGroupOrder(side, sels, move) {
    const mem = this.moveMemory && this.moveMemory[side];
    if (!mem || !sels) return;
    const seq = move ? move.seq : ++this.moveSeq;
    for (const sel of sels) {
      if (sel.all) {
        if (move) { mem.all = move; mem.types = {}; } else { mem.clearAll = seq; mem.all = null; mem.types = {}; }
      } else if (sel.type && !sel.id && sel.count == null) {
        if (move) mem.types[sel.type] = move; else { mem.clearTypes[sel.type] = seq; delete mem.types[sel.type]; }
      }
    }
  }

  /** Decision-feed row and battle-log line for a radio order. `units` is null when queued for T0. */
  _radioRow(side, parsed, units) {
    const sel = units ? this._unitsText(units) : parsed.line.split(' ').slice(1, parsed.op === 'MOVE' ? -1 : undefined).join(' ');
    let verb, detail = '';
    if (parsed.op === 'MOVE') verb = `MOVE ${sel} → z${parsed.zone + 1}`;
    else if (parsed.op === 'ASSIST') { verb = `ASSIST → z${parsed.zone + 1}`; detail = units ? `${units.length} unit${units.length === 1 ? '' : 's'}` : `radius ${parsed.radius}`; }
    else if (parsed.op === 'FALLBACK') { verb = `FALLBACK ${sel}`; detail = units && units.every(u => u.radio && u.radio.via === 'base') ? 'to base' : 'to medic'; }
    else verb = `CLEAR ${sel}`;
    if (!units) detail = detail ? `${detail} · at T0` : 'at T0';
    this._orderRow(side, parsed.op === 'CLEAR' ? 'hold' : 'deploy', verb, detail);
    if (units) this._log(`${TEAM[side].log} radio · ${verb}${detail ? ' · ' + detail : ''}`, side);
  }

  /** Radio orders and scoped FOCUS posted on READY, in order, right after the T0 wave left. */
  _drainRadioT0(side) {
    const list = this.radioT0[side] || [];
    this.radioT0[side] = [];
    this._t0Drain = true;
    for (const item of list) {
      this._orderMeta = { decideMs: null, why: item.why || '' };
      try {
        const res = item.parsed.op === 'FOCUS' ? this._setFocus(side, item.parsed) : this._radioOrder(side, item.parsed);
        if (/^ERR/.test(res)) this._log(`${TEAM[side].log} T0 · ${res.slice(0, 40)}`, side);
      } finally { this._orderMeta = null; }
    }
    this._t0Drain = false;
  }

  /**
   * FOCUS <code> sets target priority for this side's attacks; FOCUS NONE clears it.
   * FOCUS <code> <units> <zone> narrows it to those units (found now) and to enemies in that zone.
   */
  _setFocus(side, parsed) {
    if (parsed.scoped && parsed.sels && this.phase !== 'live') {
      this.radioT0[side].push({ parsed, why: this._orderWhy() });
      this._orderRow(side, 'hold', parsed.line, 'at T0');
      return `OK ${parsed.line} (at T0)`;
    }
    let scope = null;
    if (parsed.scoped) {
      let units = null;
      if (parsed.sels) {
        const r = this._resolveSel(side, parsed.sels);
        if (r.error) return this._refuse(side, parsed, r.error);
        units = new Set(r.units);
      }
      scope = { units, zone: parsed.zone };
    }
    this.focusScope[side] = parsed.type ? scope : null;
    this.focus[side] = parsed.type || null;
    this._orderRow(side, 'hold', parsed.line, '');
    if (parsed.type) this._log(`${TEAM[side].log} focus · ${TYPES[parsed.type].name.toUpperCase()} first`, side);
    else this._log(`${TEAM[side].log} focus cleared`, side);
    return this._standingReply(parsed);
  }

  /**
   * AUTOBUY <code> [RESERVE n] installs the rule; AUTOBUY OFF removes it. Installing it also
   * lifts BANK (a new spend stance). BANK posted later pauses the rule until a BUY or AUTOBUY.
   */
  _setAutobuy(side, parsed) {
    if (!parsed.type) {
      this.autobuy[side] = null;
      this._orderRow(side, 'buy', 'AUTOBUY OFF', '');
      this._log(`${TEAM[side].log} autobuy off`, side);
      return this._standingReply(parsed);
    }
    const reserve = Math.max(0, parsed.reserve | 0);
    this.autobuy[side] = { type: parsed.type, reserve, why: this._orderWhy() };
    this.bankHold[side] = false;
    this._orderRow(side, 'buy', `AUTOBUY ${P.CODE_BY_TYPE[parsed.type]}`, reserve ? `keep ${reserve} CR` : '');
    this._log(`${TEAM[side].log} autobuy · ${TYPES[parsed.type].name.toUpperCase()}${reserve ? ` · keeps ${reserve} CR` : ''}`, side);
    return this._standingReply(parsed);
  }

  /** Why the AUTOBUY rule cannot fire right now: 'bank' (BANK is set), 'max' (6 buys or 24 units), 'cap' (max_alive), or ''. */
  _autobuyState(side) {
    if (!this.autobuy[side]) return '';
    if (this.bankHold[side]) return 'bank';
    if (this.reinf[side] + this.liveBuys[side] >= MAX_BUYS) return 'max';
    if (total(this.rosters[side]) >= C.ROSTER_LIMIT) return 'max';
    const t = TYPES[this.autobuy[side].type];
    if (t && t.maxAlive > 0 && this._aliveOf(side, this.autobuy[side].type) >= t.maxAlive) return 'cap';
    return '';
  }

  /**
   * One AUTOBUY purchase when the bank covers the live price plus the kept reserve:
   * the unit is bought and fielded at once. At most one per step. Returns 1 when it fired.
   * It is the warrior's own order: the panel row carries its WHY (or `autobuy`) and `rule`
   * where a decide time would go, never the autopilot `auto` tag.
   */
  _autobuyStep(side) {
    const rule = this.autobuy[side];
    if (!rule || this.phase !== 'live' || this.over || !TYPES[rule.type]) return 0;
    if (this._autobuyState(side)) return 0;
    const k = rule.type;
    const cost = this._livePrice(side, k);
    if (this._buyCapReason(side, k)) return 0;
    if (!(Math.floor(this.fieldCredits[side]) >= cost + rule.reserve)) return 0;
    this.fieldCredits[side] -= cost;
    this._noteBuy(side, k);
    this.reserve[side][k] = (this.reserve[side][k] || 0) + 1;
    this.rosters[side][k] = (this.rosters[side][k] || 0) + 1;
    this.liveBuys[side]++;
    this._noteWire('buy', side, k);
    this._noteWire('auto', side, k);
    this._syncCreditGate(side);
    const fielded = this._releaseUnit(side, k, false, this._waveY(0, 1));
    if (fielded) {
      this.lastDeployAt[side] = this.elapsed;
      this.warriorQuietSince[side] = this.elapsed;
    }
    const code = P.CODE_BY_TYPE[k];
    // At the active cap the bought unit waits in reserve (a later DEPLOY fields it into a freed slot).
    this._pushPanel(side, { kind: fielded ? 'deploy' : 'buy', verb: fielded ? `BUY+DEPLOY ${code}` : `BUY ${code}`, detail: fielded ? `${cost} CR` : `${cost} CR · to reserve, cap ${this.activeCap}`, why: rule.why || 'autobuy', ms: 'rule' });
    this._log(`${TEAM[side].log} autobuy · ${TYPES[k].name.toUpperCase()} −${cost} CR${fielded ? ', fielded' : ', to reserve (cap)'}`, side);
    this._panelTouched = true;
    return 1;
  }

  _refuse(side, parsed, reason) {
    const line = parsed && parsed.line ? String(parsed.line).trim().toUpperCase() : 'ERR';
    this._orderRow(side, 'err', line.length > 24 ? line.slice(0, 24) : line, reason);
    return P.reply(parsed, reason);
  }

  /** What a live BUY of that type costs this side right now. The report's can-buy uses the same price. */
  _livePrice(side, type) {
    return FIELD_COST[type];
  }

  /** Units of that type this side has alive: on the field plus in reserve (max_alive counts both). */
  _aliveOf(side, type) {
    let n = this.reserve[side][type] || 0;
    for (const u of this.units) if (u.side === side && u.type === type && u.hp > 0) n++;
    return n;
  }

  /**
   * Why a buy of that type is refused by its units.csv caps right now, or '' when it is allowed:
   * max_alive (field + reserve), max_per_buy (per orders post) and buy_cooldown_s (match seconds since
   * the last post or autobuy that bought one; more buys in that same post are allowed up to max_per_buy).
   */
  _buyCapReason(side, type) {
    const t = TYPES[type];
    if (!t) return 'unknown unit';
    const code = t.code;
    if (t.maxAlive > 0 && this._aliveOf(side, type) >= t.maxAlive) return `max ${t.maxAlive}${code} alive`;
    const inPost = (this._postBuys && this._postBuys[type]) || 0;
    if (t.maxPerBuy > 0 && inPost >= t.maxPerBuy) return `max ${t.maxPerBuy}${code} per post`;
    if (t.buyCooldown > 0 && !inPost) {
      const last = this.lastBuyAt[side][type];
      const left = last == null ? 0 : t.buyCooldown - (this.elapsed - last);
      if (left > 1e-6) return `${code} cooldown ${left.toFixed(1)}s`;
    }
    return '';
  }

  /** How many of that type the caps still allow in one buy (can-buy count). Infinity when uncapped. */
  _buyCapRoom(side, type) {
    const t = TYPES[type];
    if (!t) return 0;
    let room = Infinity;
    if (t.maxAlive > 0) room = Math.max(0, t.maxAlive - this._aliveOf(side, type));
    if (t.maxPerBuy > 0) room = Math.min(room, t.maxPerBuy);
    return room;
  }

  _noteBuy(side, type) {
    this.lastBuyAt[side][type] = this.elapsed;
    if (this._postBuys) this._postBuys[type] = (this._postBuys[type] || 0) + 1;
  }

  /** A live buy spends the bank now and does not consume the pre-match queue. A successful BUY clears BANK. */
  _liveBuy(side, parsed, scratch) {
    const cost = this._livePrice(side, parsed.type);
    const capped = this._buyCapReason(side, parsed.type);
    if (capped) return this._refuse(side, parsed, capped);
    if (!(this.fieldCredits[side] >= cost)) return this._refuse(side, parsed, `bank ${Math.floor(this.fieldCredits[side])} < ${cost}`);
    this.fieldCredits[side] -= cost;
    this.liveBuys[side]++;
    this._noteBuy(side, parsed.type);
    this.reserve[side][parsed.type] = (this.reserve[side][parsed.type] || 0) + 1;
    this.rosters[side][parsed.type] = (this.rosters[side][parsed.type] || 0) + 1;
    this._noteWire('buy', side, parsed.type);
    if (scratch) scratch[parsed.type] = (scratch[parsed.type] || 0) + 1;
    this.bankHold[side] = false;
    this._syncCreditGate(side);
    this._orderRow(side, 'buy', `BUY ${P.CODE_BY_TYPE[parsed.type]}`, `${cost} CR`);
    this._log(`${TEAM[side].log} buys ${TYPES[parsed.type].name.toUpperCase()} · −${cost} CR`, side);
    return P.reply(parsed);
  }

  _liveDeploy(side, parsed, scratch) {
    const atT0 = this.phase !== 'live';
    const accepted = () => atT0 ? `OK ${parsed.line} (at T0)` : P.reply(parsed);
    const queued = { atT0, decideMs: this._metaMs(), why: this._orderWhy() };
    // The active cap: free slots now, less what earlier DEPLOYs already queued (reserve - scratch).
    const cap = this.activeCap > 0 ? this.activeCap : 0;
    const pending = Math.max(0, total(this.reserve[side]) - total(scratch));
    const room = cap ? Math.max(0, this._activeRoom(side) - pending) : Infinity;
    const capRefusal = () => `cap ${cap} active, ${total(scratch)} in reserve`;
    // `OK DEPLOY ALL (4 of 7, cap 6)`: the rest stay in reserve for a freed slot.
    const partial = (n, of) => `OK ${parsed.line} (${n} of ${of}${atT0 ? ' at T0' : ''}, cap ${cap})`;
    if (parsed.all) {
      const types = expandReserve(scratch);
      if (!types.length) {
        const sent = total(this.t0Out[side]);
        return this._refuse(side, parsed, sent && !atT0 ? 'already deployed' : 'none in reserve');
      }
      if (room <= 0) return this._refuse(side, parsed, capRefusal());
      const pick = capPick(scratch, room);
      if (!this.pushDecision(side, { all: true, ...queued })) return this._refuse(side, parsed, 'queue full');
      for (const k of pick) scratch[k]--;
      return pick.length < types.length ? partial(pick.length, types.length) : accepted();
    }
    const trial = cloneCounts(scratch);
    for (const t of parsed.types) {
      if ((trial[t] || 0) > 0) { trial[t]--; continue; }
      const code = P.CODE_BY_TYPE[t];
      const have = scratch[t] || 0;
      if (have <= 0) {
        const sent = (this.t0Out[side] && this.t0Out[side][t]) || 0;
        if (sent && !atT0) return this._refuse(side, parsed, parsed.types.length === 1 ? 'already deployed' : `${code} already deployed`);
        return this._refuse(side, parsed, parsed.types.length === 1 ? 'none in reserve' : `${code} none in reserve`);
      }
      return this._refuse(side, parsed, `reserve has ${have}${code}`);
    }
    if (room <= 0) return this._refuse(side, parsed, capRefusal());
    const fit = parsed.types.slice(0, room);
    if (!this.pushDecision(side, { types: fit, ...queued })) return this._refuse(side, parsed, 'queue full');
    for (const t of fit) scratch[t]--;
    return fit.length < parsed.types.length ? partial(fit.length, parsed.types.length) : accepted();
  }

  /**
   * Field every live (not at-T0) DEPLOY still in the seat queue.
   * Wire orders run between sim steps; without this the bought unit sits only in the
   * queue and the STATE/outbox line can hide it from both res and f.
   */
  _flushLiveDeploys(side) {
    if (side !== 0 && side !== 1) return;
    if (this.phase !== 'live') return;
    const keep = [];
    const run = [];
    for (const item of this.decisionQueue[side] || []) {
      if (item && !item.atT0 && !item.hold) run.push(item);
      else keep.push(item);
    }
    if (!run.length) return;
    this.decisionQueue[side] = keep;
    for (const item of run) {
      const view = {
        side, style: this.plans[side], elapsed: this.elapsed, lastDeployAt: this.lastDeployAt[side],
        width: W, height: H, reserve: cloneCounts(this.reserve[side]),
        units: this.units.map(u => ({ side: u.side, type: u.type, x: u.x, y: u.y, hp: u.hp, max: u.max })),
        hp: this.hp.slice(), rng: this.rng,
      };
      const d = this._applyQueued(item, view);
      if (!d || !d.deploy || !d.deploy.types || !d.deploy.types.length) continue;
      const before = this.units.length;
      this._releaseWave(side, d.deploy.types, !!d.deploy.guard, !!d.deploy.medicUrgent);
      if (this.units.length > before) this._panelDeploy(side, d);
      this.lastDeployAt[side] = this.elapsed;
      this.warriorQuietSince[side] = this.elapsed;
      if (d.title) this._say(side, d.title, d.detail || '');
    }
  }

  /**
   * Pre-start DEPLOY lines all leave on the step that opens T0.
   * A code that is no longer in reserve is counted as a miss for the START note.
   */
  _drainT0(side) {
    const queued = [];
    const keep = [];
    for (const item of this.decisionQueue[side] || []) {
      if (item && item.atT0 && !item.hold) queued.push(item);
      else keep.push(item);
    }
    this.decisionQueue[side] = keep;
    if (!queued.length) return;
    const shadow = cloneCounts(this.reserve[side]);
    const planned = [];
    const miss = emptyCounts();
    // The active cap: units past the free slots stay in reserve (not a miss: they are still there).
    let room = this._activeRoom(side);
    for (const item of queued) {
      const types = item.all ? capPick(shadow, room) : (item.types || []).filter(k => TYPES[k]);
      for (const k of types) {
        if ((shadow[k] || 0) > 0) {
          if (room <= 0) { this.capHeld[side]++; continue; }
          planned.push(k); shadow[k]--; room--;
        } else miss[k]++;
      }
    }
    const out = emptyCounts();
    const sent = [];
    planned.forEach((k, i) => {
      if (this._releaseUnit(side, k, false, this._waveY(i, planned.length))) { out[k]++; sent.push(k); }
      else miss[k]++;
    });
    addCounts(this.t0Out[side], out);
    addCounts(this.t0Miss[side], miss);
    if (!total(out)) return;
    this.lastDeployAt[side] = this.elapsed;
    this.warriorQuietSince[side] = this.elapsed;
    const decideMs = queued.reduce((ms, item) => Number.isFinite(item.decideMs) ? item.decideMs : ms, null);
    const why = queued.reduce((text, item) => item.why || text, '');
    this._panelDeploy(side, { deploy: { types: sent }, all: queued.some(item => item.all), decideMs, why, title: 'WARRIOR DEPLOY' });
    this._say(side, 'WARRIOR DEPLOY', `Opening wave at T0 · ${P.formatCounts(out)}.`);
    this._log(`${TEAM[side].log} fields at T0 · ${P.formatCounts(out)}`, side);
  }

  _syncCreditGate(side) {
    const next = P.nextBuyOf(this.queue[side], this.reinf[side]);
    const covers = !!(next && Math.floor(this.fieldCredits[side]) >= next.cost);
    if (!covers) this.protocolCreditOpen[side] = false;
  }

  _seatName(side) {
    return (this.labels[side] && this.labels[side].seat) || (side === 0 ? 'Green' : 'Ember');
  }

  /** Losses and buys since each seat's previous report. `kind` is `loss` or `buy`. */
  _noteWire(kind, side, type) {
    if ((side !== 0 && side !== 1) || !this.wirePending || !P.CODE_BY_TYPE[type]) return;
    for (const obs of this.wirePending) obs[kind][side][type] = (obs[kind][side][type] || 0) + 1;
  }

  /**
   * Zones held, ours/theirs (the same count as the panel's land), then `c<n>` when n zones have units
   * from both sides in them right now: `5/2`, `4/3 c1`.
   */
  _zoneTotals(side) {
    const g = [0, 0, 0, 0, 0, 0, 0, 0];
    const e = [0, 0, 0, 0, 0, 0, 0, 0];
    for (const u of this.units) {
      if (!grounded(u)) continue;
      const i = Math.min(7, Math.max(0, Math.floor(u.x / (W / 8))));
      if (u.side === 0) g[i]++;
      else e[i]++;
    }
    const contested = g.filter((n, i) => n > 0 && e[i] > 0).length;
    const held = `${this._zonesHeld(side)}/${this._zonesHeld(1 - side)}`;
    return contested ? `${held} c${contested}` : held;
  }

  /** Their healers (role healer in units.csv) on the field. The v2 delta names a change. */
  _fieldMedics(side) {
    return this.units.filter(u => u.side === side && U.isHealer(u.type)).length;
  }

  /** Zones on the enemy half that pay the +12 income. The same cut as `_territory`. */
  _incomeZones(side) {
    let n = 0;
    for (let i = 0; i < this.land.length; i++) {
      if (side === 0) { if (i >= 3 && this.land[i] > 0.35) n++; }
      else if (i <= 4 && this.land[i] < -0.35) n++;
    }
    return n;
  }

  /**
   * The report's income token. Zones and base together per income tick: `income +28/4s (base 4)`.
   * With no frontier zone the base still pays: `income +4/4s base, need 1 zone on E half`.
   * With base income off (BASE_INCOME=0) the old wording: `income +24/4s`, `income: 0 CR, need 1 more zone on E half`.
   */
  _incomeHint(side) {
    if (this.reinf[side] >= MAX_BUYS) return 'income: buys maxed';
    const n = this._incomeZones(side);
    const base = this.baseIncome > 0 ? this.baseIncome : 0;
    const fmt = v => (Number.isInteger(v) ? String(v) : v.toFixed(1));
    if (!n) {
      const half = P.teamTag(this._seatName(1 - side), 1 - side);
      if (base) return `income +${fmt(base)}/4s base, need 1 zone on ${half} half`;
      return `income: 0 CR, need 1 more zone on ${half} half`;
    }
    return base ? `income +${fmt(n * C.ZONE_INCOME + base)}/4s (base ${fmt(base)})` : `income +${n * C.ZONE_INCOME}/4s`;
  }

  /** Our units on the field that count toward the active cap: every living unit, drones included. */
  _activeCount(side) {
    let n = 0;
    for (const u of this.units) if (u.side === side && u.hp > 0) n++;
    return n;
  }

  /** Free active slots now (Infinity when the cap is off). */
  _activeRoom(side) {
    if (!(this.activeCap > 0)) return Infinity;
    return Math.max(0, this.activeCap - this._activeCount(side));
  }

  /** What changed for this seat since its previous report. The first report is `no change`. */
  _protocolDelta(side) {
    const snap = this.protocolSnap[side];
    if (!snap || !this.wirePending[side]) return 'no change';
    const them = 1 - side;
    const tag = P.teamTag(this._seatName(them), them);
    const pending = this.wirePending[side];
    const parts = [];
    const land = this._zonesHeld(side) - snap.land;
    if (land) parts.push(`${land > 0 ? '+' : ''}${land} zone${Math.abs(land) === 1 ? '' : 's'}`);
    const medics = this._fieldMedics(them);
    const medicDiff = medics - (snap.theirMedics | 0);
    const mc = U.healerCode();
    if (medicDiff) parts.push(`${tag} ${medicDiff > 0 ? '+' : ''}${medicDiff}${mc}, now ${medics}${mc}`);
    const lost = P.formatCounts(pending.loss[side]);
    if (lost !== 'none') parts.push(`lost ${lost}`);
    const focusKills = pending.focus ? P.formatCounts(pending.focus[side]) : 'none';
    if (focusKills !== 'none') parts.push(`focus kill ${focusKills}`);
    const autoBought = pending.auto ? P.formatCounts(pending.auto[side]) : 'none';
    if (autoBought !== 'none') parts.push(`auto bought ${autoBought}`);
    const bought = P.formatCounts(pending.buy[them]);
    if (bought !== 'none') parts.push(`${tag} bought ${bought}`);
    const theirLand = this._zonesHeld(them) - snap.theirLand;
    if (theirLand) parts.push(`${tag} ${theirLand > 0 ? '+' : ''}${theirLand} zone${Math.abs(theirLand) === 1 ? '' : 's'}`);
    const theirLost = P.formatCounts(pending.loss[them]);
    if (theirLost !== 'none') parts.push(`${tag} lost ${theirLost}`);
    while (parts.length > 1 && parts.join(', ').length > 80) parts.pop();
    return parts.length ? parts.join(', ') : 'no change';
  }

  _commitProtocolSnap(side) {
    const them = 1 - side;
    this.protocolSnap[side] = { land: this._zonesHeld(side), theirLand: this._zonesHeld(them), theirMedics: this._fieldMedics(them) };
    this.wirePending[side] = emptyWire();
  }

  /**
   * That seat's wire view. `us` is this side, `them` is the other.
   * near-base counts the enemy inside our home zone (the same cut as base threat).
   * `reserveOverride` is the uncommitted reserve on an orders reply, so a queued DEPLOY already shows.
   */
  _protocolView(side, event, note, reserveOverride) {
    const them = 1 - side;
    const counts = s => {
      const c = emptyCounts();
      for (const u of this.units) if (u.side === s && c[u.type] != null) c[u.type]++;
      return c;
    };
    const hurt = this.units.filter(u => u.side === side && u.max - u.hp >= 20).length;
    const nearBase = this.units.filter(u => u.side === them && inHomeZone(side, u.x)).length;
    const theirTag = P.teamTag(this._seatName(them), them);
    const reserve = reserveOverride || this.reserve[side];
    const usHp = Math.max(0, Math.ceil(this.hp[side]));
    const themHp = Math.max(0, Math.ceil(this.hp[them]));
    const usLand = this._zonesHeld(side);
    const themLand = this._zonesHeld(them);
    return {
      t: Math.floor(this.elapsed + 1e-4),
      event,
      delta: this._protocolDelta(side),
      situation: P.situationText({ nearBase, usHp, themHp, usLand, themLand, theirTag }),
      zones: this._zoneTotals(side),
      income: this._incomeHint(side),
      canBuy: P.canBuyCodes(Math.floor(this.fieldCredits[side]), total(this.rosters[side]), total(reserve), type => this._livePrice(side, type), type => this._buyCapRoom(side, type)),
      us: {
        tag: P.teamTag(this._seatName(side), side),
        hp: usHp,
        bank: Math.floor(this.fieldCredits[side]),
        land: usLand,
        reserve,
        field: counts(side),
        hurt,
        standing: P.standingText(this.focus[side], this.autobuy[side], this._autobuyState(side), this._focusScopeView(side)),
        active: this._activeCount(side),
        cap: this.activeCap,
        units: this._reportUnits(side),
      },
      them: {
        tag: theirTag,
        hp: themHp,
        land: themLand,
        field: counts(them),
        nearBase,
        groups: this._reportGroups(them),
      },
      fights: this._fightZones().map(f => ({ zone: f.zone + 1, us: f.n[side], them: f.n[them] })),
      nextBuy: P.nextBuyOf(this.queue[side], this.reinf[side]),
      note: this._protocolNote(side, event, note, theirTag),
    };
  }

  /** Scoped FOCUS for the report: { tags (living units, null = all), zone }, or null. */
  _focusScopeView(side) {
    const sc = this.focusScope[side];
    if (!sc) return null;
    const tags = sc.units ? this.units.filter(u => sc.units.has(u) && u.hp > 0).map(u => this._tagOf(u)) : null;
    return { tags, zone: sc.zone };
  }

  /** Our field units for the report, in table order then number: { tag, zone (1..8), hurt, combat, order }. */
  _reportUnits(side) {
    return this.units.filter(u => u.side === side)
      .map(u => ({ u, tag: this._tagOf(u), ti: TYPE_IDS.indexOf(u.type) }))
      .sort((a, b) => a.ti - b.ti || a.u.serial - b.u.serial)
      .map(({ u, tag }) => ({
        tag, zone: C.zoneOf(u.x) + 1, hurt: u.hp <= u.max * 0.5, combat: this._inCombat(u), order: this._orderToken(u),
      }));
  }

  /** Their field units by zone then type: [{ code, zone (1..8), n }]. No IDs for the other side. */
  _reportGroups(side) {
    const map = new Map();
    for (const u of this.units) {
      if (u.side !== side || !P.CODE_BY_TYPE[u.type]) continue;
      const zone = C.zoneOf(u.x) + 1;
      const key = `${zone}:${u.type}`;
      const g = map.get(key) || { code: P.CODE_BY_TYPE[u.type], zone, ti: TYPE_IDS.indexOf(u.type), n: 0 };
      g.n++;
      map.set(key, g);
    }
    return [...map.values()].sort((a, b) => a.zone - b.zone || a.ti - b.ti).map(({ code, zone, n }) => ({ code, zone, n }));
  }

  _protocolNote(side, event, note, theirTag) {
    if (note) return note;
    if (event === 'START') return this._startNote(side, theirTag);
    const bits = [];
    if (this.protocolAutopilotNote[side]) bits.push('autopilot acted');
    // Kamikaze blasts since this seat's last report: ours first, then theirs, contact blasts before
    // shot-down ones. `drone hit z5 (3 units)` exploded on contact; `drone shot down z4 (0 units)`
    // was shot before contact and went off with its death blast where it fell.
    const hits = this.wirePending[side] && this.wirePending[side].hits;
    if (hits) {
      const name = (U.idsWithRole('kamikaze')[0] && TYPES[U.idsWithRole('kamikaze')[0]].name.toLowerCase()) || 'drone';
      for (const s of [side, 1 - side]) {
        for (const shot of [false, true]) {
          const list = (hits[s] || []).filter(h => !!h.shot === shot);
          if (!list.length) continue;
          const k = list.reduce((n, h) => n + h.k, 0);
          const top = list.reduce((b, h) => (h.k > b.k ? h : b), list[list.length - 1]);
          // Shot down: `by M` names who downed the last one there (a unit code, or `blast` for one
          // caught in another drone's blast).
          const by = shot && top.by ? ` by ${top.by}` : '';
          bits.push(`${s === side ? '' : theirTag + ' '}${name} ${shot ? 'shot down' : 'hit'} z${top.zone + 1}${by} (${k} unit${k === 1 ? '' : 's'})`);
        }
      }
    }
    const bought = this.wirePending[side] ? P.formatCounts(this.wirePending[side].buy[1 - side]) : 'none';
    if (bought !== 'none') bits.push(`${theirTag} bought ${bought}`);
    if (!bits.length) return '';
    const text = bits.join(', ');
    return text.length <= 48 ? text : bits[0];
  }

  /** Fresh board for an orders reply. Not written to the outbox. Reserve is what is still unqueued. */
  protocolState(side) {
    const view = this._protocolView(side, 'STATE', '', this._uncommittedReserve(side));
    const last = (this.protocolReports[side] || [])[(this.protocolReports[side] || []).length - 1];
    return {
      version: P.PROTOCOL_VERSION,
      line: P.formatReport(view),
      event: 'STATE',
      t: view.t,
      id: last ? last.id : 0,
      match: this.matchNo,
    };
  }

  _startNote(side, theirTag) {
    const draft = `${theirTag} draft ${P.formatCounts(this.rosters[1 - side])}`;
    const out = this.t0Out[side];
    const miss = this.t0Miss[side];
    if (!total(out) && !total(miss)) return draft;
    const parts = [total(out) ? `out ${P.formatCounts(out)}` : 'out none'];
    if (total(miss)) parts.push(`miss ${P.formatCounts(miss)}`);
    const deployed = parts.join(' ');
    const both = `${deployed} ${draft}`;
    if (both.length <= 48) return both;
    return deployed.length <= 48 ? deployed : deployed.slice(0, 48);
  }

  _endNote(side, win) {
    const extra = P.decideSummary(this.decideStats(side));
    if (!extra) return win;
    const both = `${win} ${extra}`;
    return both.length <= 48 ? both : extra;
  }

  /** Wall-clock decide time for one orders post that named a report id. `at` is when the post was received. */
  noteDecide(side, decideMs, at) {
    if (side !== 0 && side !== 1) return;
    if (!Number.isFinite(decideMs)) return;
    this.decideLog[side].push({ at: Number.isFinite(at) ? at : Date.now(), decideMs: Math.max(0, decideMs) });
  }

  decideStats(side) {
    return P.latencyStats(this.decideLog[side] || []);
  }

  protocolLine(side, event = 'HEARTBEAT') {
    return P.formatReport(this._protocolView(side, event));
  }

  _pushReport(side, event, note) {
    const view = this._protocolView(side, event, note);
    if (!note && event !== 'START' && view.note === 'autopilot acted') this.protocolAutopilotNote[side] = false;
    const line = P.formatReport(view);
    const reports = this.protocolReports[side];
    const last = reports[reports.length - 1];
    // A reboot before the first step (an opening posted on a held match) rewrites this seat's START in place.
    if (event === 'START' && last && last.event === 'START' && last.match === this.matchNo && this.elapsed < P.DEBOUNCE_S) {
      last.line = line;
      last.t = view.t;
      last.at = this.elapsed;
      last.sentAt = Date.now();
      last.rev = (last.rev || 1) + 1;
      this._commitProtocolSnap(side);
      this.protocolLastAt[side] = this.elapsed;
      if (this.protocolPending[side] === 'HEARTBEAT') this.protocolPending[side] = null;
      this.emit('protocol', last);
      return last;
    }
    const rec = {
      id: ++this.protocolSeq[side],
      line, event, t: view.t, match: this.matchNo, at: this.elapsed, rev: 1,
      side, seat: this._seatName(side), sentAt: Date.now(),
    };
    reports.push(rec);
    if (reports.length > 48) reports.shift();
    this._commitProtocolSnap(side);
    this.protocolLastAt[side] = this.elapsed;
    if (this.protocolPending[side] === 'HEARTBEAT') this.protocolPending[side] = null;
    this.emit('protocol', rec);
    return rec;
  }

  /**
   * Per seat: CREDITS when that side's bank covers its next queue buy and still does
   * after this step (auto-buy already ran, or was held because the seat is talking).
   * HEARTBEAT when ~8s of the match clock passed with no report for that seat.
   * Any report resets that wait. HEARTBEAT and CREDITS wait out a 2s debounce.
   * ORDER, END and START are pushed directly and do not wait.
   */
  _protocolTick() {
    for (let side = 0; side < 2; side++) this._protocolTickSide(side);
  }

  _protocolTickSide(side) {
    const next = P.nextBuyOf(this.queue[side], this.reinf[side]);
    const covers = !!(next && Math.floor(this.fieldCredits[side]) >= next.cost);
    if (covers && !this.protocolCreditOpen[side]) {
      this.protocolCreditOpen[side] = true;
      this.protocolPending[side] = 'CREDITS';
    } else if (!covers) {
      this.protocolCreditOpen[side] = false;
      if (this.protocolPending[side] === 'CREDITS') this.protocolPending[side] = null;
    }
    if (!this.protocolPending[side] && this.elapsed - this.protocolLastAt[side] >= P.HEARTBEAT_S - 1e-4) this.protocolPending[side] = 'HEARTBEAT';
    if (!this.protocolPending[side]) return;
    const reports = this.protocolReports[side];
    if (reports.length && this.elapsed - this.protocolLastAt[side] < P.DEBOUNCE_S - 1e-4) return;
    const event = this.protocolPending[side];
    this.protocolPending[side] = null;
    this._pushReport(side, event);
  }

  _zonesHeld(s) {
    let owned = 0;
    for (const v of this.land) if (s === 0 ? v > 0.12 : v < -0.12) owned++;
    return owned;
  }

  _sideView(s) {
    let intruders = 0, healing = 0, contacts = false;
    const owned = this._zonesHeld(s);
    for (const u of this.units) {
      if (u.side === s) { if (u.healing) healing++; }
      else { contacts = true; if (inHomeZone(s, u.x)) intruders++; }
    }
    const next = this.reinf[s] >= MAX_BUYS || !this.queue[s][this.reinf[s]]
      ? `MAXED · ${this.reinf[s]} / ${MAX_BUYS}`
      : `${TYPES[this.queue[s][this.reinf[s]]].name.toUpperCase()} · ${FIELD_COST[this.queue[s][this.reinf[s]]]} CR`;
    const dec = this.decisionsText[s];
    const lab = this.labels[s];
    const feed = (this.panelFeed[s] || []).slice(0, 8);
    const top = feed[0];
    const mobile = top ? `${top.verb}${top.detail ? ' · ' + top.detail : ''}`.slice(0, 42) : D.mobileDecision(dec.title);
    return {
      seat: lab.seat, label: lab.label, base: lab.base, color: lab.color,
      role: lab.role || (s === 0 ? 'AUTO-DRAFTED · AGENT COMMAND' : 'RIVAL AGENT · COUNTER-BUILD'),
      hp: Math.max(0, Math.ceil(this.hp[s])),
      field: this.units.filter(u => u.side === s).length,
      reserve: total(this.reserve[s]),
      land: `${owned} / 8 ZONES`,
      bank: `${Math.floor(this.fieldCredits[s])} CR`,
      next, posture: intruders ? `DEFEND · ${intruders}` : contacts ? 'ENGAGE' : 'ADVANCE',
      healing: `${healing} UNITS`,
      decision: dec.title, explain: dec.detail, mobile, feed,
      driver: this.drivers[s],
      plan: this.plans[s],
      // Complete arsenal: every unit type in TYPES, zeros included, so a new type shows up on its own. count = reserve (bought, not deployed).
      inventory: TYPE_IDS.map(k => ({ type: k, name: TYPES[k].name, glyph: TYPES[k].glyph, color: TYPES[k].color, count: this.reserve[s][k] || 0 })),
    };
  }

  publicState() {
    const r1 = v => Math.round(v * 10) / 10;
    const stamp = `${String(Math.floor(this.elapsed / 60)).padStart(2, '0')}:${String(Math.floor(this.elapsed % 60)).padStart(2, '0')}`;
    const sides = [0, 1].map(s => this._sideView(s));
    return {
      mode: 'agrts', game: 'GrokBotWar', matchNo: this.matchNo, seed: this.baseSeed,
      tick: this.steps, steps: this.steps, maxTicks: Math.round(MATCH_CAP / STEP),
      status: this.over ? 'over' : 'running', paused: this.paused, held: this.over && this.paused,
      phase: this.phase, countdown: this.phase === 'countdown' ? this.countdown : null, viewers: this.viewers || 0,
      elapsed: this.elapsed, clock: stamp, speed: SPEED, tickMs: 50, autoRestart: false, restartInMs: null,
      pauseAfterMatch: this.pauseAfterMatch, holdAfterMatch: this.holdNext,
      w: W, h: H, arena: { w: W, h: H }, robotRadius: 11,
      hp: this.hp.map(v => Math.max(0, v)),
      plans: this.plans.slice(),
      hooks: { source: this.decisions.id, drivers: this.drivers.slice(), warriorAutopilot: this.warriorAutopilot, warriorActiveS: this.warriorActiveS, npcDecisionS: this.npcDecisionS, doc: '/docs/TEAM-DECISIONS.md' },
      error: this.error || '',
      // The unit table this match runs on (units.csv). Watch pages draw and label units from it,
      // so a new row draws on the public relay page without a relay rebuild.
      unitTable: U.viewerTable(),
      unitsError: this.unitsError || '',
      unitsLock: this.unitsLock ? { hash: this.unitsLock.hash, official: this.unitsLock.official } : null,
      // Version stamp (version.js, docs/SPEC.md §5.4 "Version stamp"): build, PvP protocol and this match's unit table. Information only.
      version: V.stamp(this.unitsLock),
      // Availability (docs/SPEC.md §5.4 "Availability"): { state: free|busy|reserved, since, matchId? }. Information only.
      availability: this.availability.view(this),
      winner: this.winner,
      sides,
      land: this.land.slice(),
      walls: this.walls, rough: this.rough,
      cameraShake: this.cameraShake,
      units: this.units.map(u => ({
        id: u.id, side: u.side, type: u.type, x: r1(u.x), y: r1(u.y), hp: r1(u.hp), max: u.max,
        facingX: u.facingX || 0, facingY: u.facingY || 0, guard: !!u.guard, medicMode: u.medicMode || '',
        medicTargetId: u.medicTargetId, healing: !!u.healing, hitFlash: u.hitFlash || 0, age: u.age, spawnShield: u.spawnShield || 0,
      })),
      shots: this.shots.map(s => ({ x: s.x, y: s.y, tx: s.tx, ty: s.ty, type: s.type, side: s.side, col: s.col, life: s.life, maxLife: s.maxLife })),
      sparks: this.sparks.map(p => ({ x: p.x, y: p.y, life: p.life, col: p.col })),
      combatFx: this.combatFx, spawnFx: this.spawnFx, capturePulses: this.capturePulses,
      spendPulses: this.spendPulses, healPopups: this.healPopups, notices: this.notices.slice(-3),
      logs: this.logs,
      // Relay publisher keeps teams/robots/shells for the classic watch path.
      // Agrts frames also carry the field (walls, land, units, sides) so the phone page paints Iteration 11 when mode is agrts.
      teams: sides.map((sd, i) => ({
        id: i, name: sd.label, color: sd.color, seat: sd.seat, avatar: null, avatarKind: 'none', displayName: sd.label,
        energy: Math.floor(this.fieldCredits[i]), energyMax: 0, heroes: sd.field, drones: sd.reserve, pending: 0,
        eliminated: this.hp[i] <= 0, score: Math.max(0, this.hp[i]), hasBattlePlan: true,
        battlePlanThought: sd.decision,
      })),
      robots: this.units.map(u => ({
        id: u.id, name: TYPES[u.type].name, color: TEAM[u.side].color, team: u.side, kind: u.type, type: u.type,
        radius: TYPES[u.type].r, maxHealth: u.max, x: r1(u.x), y: r1(u.y), heading: 0, health: r1(u.hp), heat: 0, alive: u.hp > 0,
        lastCmd: null, kills: 0,
      })),
      shells: this.shots.map((s, i) => ({ id: i, owner: s.side, power: 1, small: U.roleOf(s.type) !== 'armor', x: r1(s.x), y: r1(s.y), vx: 0, vy: 0 })),
      events: this.logs.map(l => ({ type: 'log', text: l.msg, team: l.side, at: l.at })),
    };
  }

  _emit() { this.emit('state', this.publicState()); }
}

module.exports = { AgrtsMatch, STEP, SPEED };
