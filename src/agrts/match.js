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
const crypto = require('crypto');
const C = require('./constants');
const D = require('./team-decisions');
const P = require('./protocol');
const U = require('./units');
const EP = require('./ember-plus');
const ER = require('./ember-range');
const V = require('./version');
const { Availability } = require('./availability');
const K = require('./commander');
const CM = require('./comms');
const ST = require('./stance');
const HH = require('./hospital');
const RULES = require('./rules');
const E = require('./economy');
const TW = require('./towers');

const { TYPES, TYPE_IDS, FIELD_COST, FIELD_W: W, FIELD_H: H, STEP, SPEED, TEAM, cloneCounts, total } = C;

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
const POST_R = 15; // forward post hull radius, px (drawing, reach, drone contact, splash)
// How long a mortar shell stays on screen, and how long the scorch lasts after it lands.
// The flight is long enough to read at watch-page scale; the scorch fades over about a second.
const MORTAR_FLIGHT = 0.62;
const MORTAR_SCORCH = 1;
// Drones are launch and forget (docs/DRONE.md): on its first step a kamikaze unit picks one enemy
// (see _droneLaunchPick), locks that unit's id and flies at it until it hits or dies. It never holds,
// hovers or waits, and later MOVE / FOCUS orders do not retarget it; only the target's death does.
// An engaged enemy fired or was hit in the last ENGAGED_S seconds and stands within ENGAGED_NEAR px
// of one of our ground units. The commander (src/agrts/commander.js) keeps its Drones in reserve and
// launches them only while such a stack exists.
// Hospital contact reach (px): a Rifle's range. Longer weapons (the Mortar) count contact only this close.
const CONTACT_R = 100;
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
// Longer than the 1.5 s route watch. Progress is the distance to the goal at the end of
// the window. A closer reading in the middle does not count, and neither does sliding
// along a wall: both used to restart the clock while a breaker oscillated under the
// rocks in z1. A unit that is not STUCK_X px closer after STUCK_N seconds escalates:
// sidestep, then walk to the nearest open cell, then repath with the cell it stood in blocked.
const STUCK_N = 6;
const STUCK_X = 22;
// A MOVE slot counts as reached within SLOT_ARRIVE px, within SLOT_PRESSED px while pressed by
// other units, or after SLOT_STALL_S seconds without getting closer while within SLOT_STALL_NEAR px.
const SLOT_ARRIVE = 6;
const SLOT_PRESSED = 24;
const SLOT_STALL_S = 1;
const SLOT_STALL_NEAR = 64;
// A unit on MOVE engages a ground enemy within its range + ENGAGE_EXTRA px in its zone, its goal
// zone, the zones between, or one zone beyond either, instead of walking past it to its slot.
const ENGAGE_EXTRA = 60;
/** Slot row for a role: front-liners (armor, fast) 0, ranged and others 1, healers 2, mortars 3. */
function slotRank(type) {
  const r = U.roleOf(type);
  return r === 'armor' || r === 'fast' ? 0 : r === 'healer' ? 2 : r === 'mortar' ? 3 : 1;
}
function planeOfUnit(u) { return U.planeOf(u.type); }
/** Distance a unit closes to before it stops and shoots: 55% of its range, never inside the target's hull.
 *  A gun with a minimum range stops outside that dead zone. */
function standoffOf(a, u, v) {
  const minR = a.minRange || 0;
  const base = Math.max(a.range * 0.55, minR > 0 ? minR + 10 : 0);
  const cap = a.range * 0.95;
  if (!v || planeOfUnit(u) !== planeOfUnit(v)) return Math.min(cap, base);
  return Math.min(cap, Math.max(base, a.r + TYPES[v.type].r + 3));
}

/** Distance a unit closes to before it shoots an enemy turret: 55% of its range, never inside the turret's hull. */
function turretStandoff(a) {
  return Math.min(a.range * 0.95, Math.max(a.range * 0.55, a.r + C.TURRET.r + 3));
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

// Medic seek (fix/medic-seek): hurt share that draws a medic, how far it looks, and the 'near' radius for odds and allies.
const MEDIC_SEEK_PCT = 0.15, MEDIC_SEEK_R = 200, MEDIC_NEAR_R = 120;
// Aggressive medic (medic-aggression, both sides; MEDIC_AGGRO_EMBER=0 brings back Ember's old passive medic; The Range's no-order medic rushes any hurt ally):
// seek 8%+ hurt allies within 320 px, Breakers weighted 1.5x, skip a patient only when enemies near it outnumber ours by 3+,
// and with nobody hurt stand MEDIC_FRONT_GAP px behind the frontmost ally instead of half a zone behind the group's rear.
const MEDIC_AGGRO_PCT = 0.08, MEDIC_AGGRO_R = 320, MEDIC_AGGRO_ODDS = 3, MEDIC_FRONT_GAP = 34;
const MEDIC_AGGRO_SIDES = [true, process.env.MEDIC_AGGRO_EMBER !== '0'];
const medicWeight = (v) => (U.roleOf(v.type) === 'armor' ? 1.5 : 1);

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
    // One Drone buy is a pack of this many Drones (docs/DRONE.md "Drone packs"): one price, one buy, DEPLOY D fields the pack at once.
    // opts.dronePack or env DRONE_PACK (1 = the old single Drone), 1..6, default 3. The units.csv max_alive counts Drones, not packs.
    this.dronePack = Math.max(1, Math.min(6, Math.floor(Number.isFinite(opts.dronePack) ? opts.dronePack : P.readEnvNumber('DRONE_PACK', 3)) || 1));
    this.npcDrones = opts.npcDrones != null ? opts.npcDrones !== false : P.readEnvNumber('NPC_DRONES', 1) !== 0;
    // Base income (credits per income tick from each base) and the active-unit cap (docs/SPEC.md §5.4, §5.5).
    // Defaults come from constants.js (env BASE_INCOME, ACTIVE_CAP); a match may pass its own.
    // Base turrets (C.TURRET) on unless the match turns them off (opts.turrets === false; tests of base reach use it).
    this.turretsOn = opts.turrets !== false;
    // Towers and Team HP (src/agrts/towers.js). Off by default: with tw.on false nothing below changes a step.
    this._opts = opts;
    this._rulesSync(true); // tw, baseIncome, territory*, catchupIncome, breakerDiscount, bankDecay, reserveCap, maxBuys, dmgScale, activeCap
    // Field hospitals (docs/FIELD-HOSPITAL.md). On by default (FIELD_HOSPITAL=0 turns it off) unless the match passes fieldHospital.
    // With it off, no hospital is built and every later check returns before it can change a step.
    this.fieldHospital = opts.fieldHospital != null ? opts.fieldHospital === true || opts.fieldHospital === 1 : V.fieldHospital();
    // Upkeep (units.csv `support`): on unless env UPKEEP=0 or opts.upkeep === false.
    this.upkeep = opts.upkeep != null ? opts.upkeep !== false && opts.upkeep !== 0 && opts.upkeep !== '0' : process.env.UPKEEP !== '0';
    this.upkeepTotal = [0, 0];
    this.emberPlus = EP.level(opts.emberPlus != null ? opts.emberPlus : (process.env.EMBER_PLUS != null && process.env.EMBER_PLUS !== '' ? process.env.EMBER_PLUS : 0));
    // Mortar (docs/MORTAR.md). On unless MORTAR=0 or the match passes mortar:false. Off: the tube is
    // not drafted, bought, or a legal order, the same as a code that is not in the table.
    this.mortarOn = opts.mortar != null ? opts.mortar === true || opts.mortar === 1 || opts.mortar === '1' : V.mortarOn();
    // Default assist radius in zones (C.ASSIST_RADIUS_DEFAULT). 0 turns default assist off.
    // Stance defaults: 'default' (per role, docs/STANCES.md) or 'hold' (every unit HOLD: today's behavior, sims).
    // A [green, ember] pair sets each side apart (balance runs).
    this.stanceMode = Array.isArray(opts.stanceMode) ? opts.stanceMode.slice(0, 2) : [opts.stanceMode || process.env.STANCE_MODE || 'default', opts.stanceMode || process.env.STANCE_MODE || 'default'];
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
    // Viewer gate (docs/SPEC.md "Viewer gate"). A match armed behind the gate gets a one-time gate id (nonce). With gateStrict
    // on (the host turns it on when a relay is configured) only a watch page that presents THAT id, or the owner's explicit
    // Start, releases it: a page that was already open (a phone, an old tab) is just a spectator. Off (headless tests, local-only
    // arenas with no owner link) any viewer releases it, as before.
    this.gateStrict = opts.gateStrict === true;
    this.gateId = null;          // current nonce (32 hex); never in publicState
    this._gateMatch = 0;         // the match number it was made for: a re-arm of the same match keeps it
    this._gateReleased = false;  // sticky for this match: the gate was released by the id or by the owner's Start
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
      queue: (order.queue || []).filter(k => TYPES[k]).slice(0, this.maxBuys),
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
        while (acc >= STEP && n < 3 * x) { this.update(STEP); acc -= STEP; n++; }
        if (n === 3 * x && acc >= STEP) acc = STEP - 0.001;
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

  /**
   * The match settings that come from the ruleset (economy.csv, src/agrts/rules.js) or the env: tower numbers,
   * income, territory income, buy and active caps, damage scale. An opt passed to the match wins over both.
   * Run when the match is built, and again at a match boot only if a resolved number changed since
   * (a new download, an edited economy.csv, an env change), so a setting a test assigns by hand survives a restart.
   */
  _rulesSync(first) {
    RULES.boot();
    C.applyRules(); TW.applyRules(); HH.applyRules();
    const sig = RULES.signature();
    if (!first && sig === this._rulesSig) return;
    this._rulesSig = sig;
    const opts = this._opts || {};
    this.tw = TW.config(opts.towers);
    this.baseIncome = Number.isFinite(opts.baseIncome) && opts.baseIncome >= 0 ? opts.baseIncome : C.BASE_INCOME;
    // Territory income (docs/TERRITORY-INCOME.md). Omitted opts follow the env, then the ruleset. TERRITORY_CAP defaults to 3.
    // Explicit 0 / off pays every zone. The other four knobs still default off.
    const econ = E.fromEnv();
    this.territoryCap = opts.territoryCap != null ? E.capValue(opts.territoryCap) : econ.cap;
    this.territoryDiminish = opts.territoryDiminish != null ? E.diminishValue(opts.territoryDiminish) : econ.diminish;
    this.catchupIncome = opts.catchupIncome != null ? E.catchupValue(opts.catchupIncome) : econ.catchup;
    this.breakerDiscount = opts.breakerDiscount != null ? E.discountValue(opts.breakerDiscount) : econ.discount;
    this.bankDecay = opts.bankDecay != null ? E.decayValue(opts.bankDecay) : econ.decay;
    this.reserveCap = Math.floor(opts.reserveCap != null ? +opts.reserveCap || 0 : C.envNumber('RESERVE_CAP', RULES.value('reserve_cap')));
    // Per-match buy cap (BUY_CAP env via C.MAX_BUYS; opts.buyCap 0 or Infinity = none).
    this.maxBuys = opts.buyCap === 0 || opts.buyCap === Infinity ? Infinity : Number.isFinite(opts.buyCap) && opts.buyCap > 0 ? Math.floor(opts.buyCap) : C.MAX_BUYS;
    this.dmgScale = Number.isFinite(opts.damageScale) && opts.damageScale > 0 ? opts.damageScale : C.DAMAGE_SCALE; // unit damage only
    this.activeCap = Number.isFinite(opts.activeCap) && opts.activeCap >= 0 ? Math.floor(opts.activeCap) : C.ACTIVE_CAP;
  }

  _boot() {
    if (this.cmdr) this.cmdr.matchEnd();
    // Ruleset first (economy.csv numbers), then units.csv: both are read at the start of every match, never mid-match.
    this._rulesSync(false);
    // units.csv is re-read here, at the start of every match and never mid-match. A bad file
    // keeps the last good table (src/agrts/units.js logs why); the error shows in unitsError.
    const units = U.reload();
    this.unitsError = units.error || '';
    // Locked unit table (units-lock.js): is this match's table the official one? Information only.
    this.unitsLock = U.lockStatus();
    { const r = RULES.status(); this.rulesInfo = { version: r.version, source: r.source }; }
    this.rng = C.mulberry32((this.baseSeed + this.matchNo * 997) >>> 0);
    const roll = () => C.OPENING_STYLES[Math.floor(this.rng() * C.OPENING_STYLES.length)];
    this.plans = [0, 1].map(s => this.styleOverride[s] || roll());
    const rosters = [0, 1].map(s => this._draftSide(s));
    // Draft rollover (The Range c987359): each side's unspent draft budget becomes its starting bank (draft_carry 1).
    this.draftCarry = rosters.map(r => (RULES.value('draft_carry') ? Math.max(0, C.DRAFT_BUDGET - C.spent(r)) : 0));
    // Scout trio (units.csv spawn_count): one drafted Scout fields spawn_count Scouts for the same draft cost. Drones keep DRONE_PACK.
    for (const r of rosters) for (const k of Object.keys(r)) if (TYPES[k] && !U.isKamikaze(k) && (TYPES[k].spawnCount || 1) > 1) r[k] *= TYPES[k].spawnCount;
    this.rosters = rosters.map(cloneCounts);
    this.queue = [0, 1].map(s => this._queueSide(s));
    this.queueSource = [0, 1].map(s => (this.drivers[s] === 'warrior' ? 'warrior' : 'simulated'));
    this.reserve = this.rosters.map(cloneCounts);
    this.units = [];
    this.shots = []; this.sparks = []; this.combatFx = []; this.spawnFx = [];
    this.capturePulses = []; this.spendPulses = []; this.healPopups = []; this.notices = [];
    this.hp = [100, 100];
    // Team HP bookkeeping (towers.js). hpEvents feeds the watch page (last 2 s); hpLoss/hpGain are totals for sweeps.
    this.hpEvents = [];
    this.hpLoss = [0, 1].map(() => ({ base: 0, tower: 0, zone: 0, siege: 0 }));
    this.hpGain = [0, 0];
    this.hpBlocked = [0, 0]; // indirect HP the floor and comeback rules kept off a side
    this.shieldBlocked = [0, 0]; // direct base damage the depot shield absorbed, per side
    this.towerPts = [0, 0]; // tower points each side has taken (gun 2, hospital 1, depot 3)
    this.towerKills = [{ gun: 0, hospital: 0, depot: 0 }, { gun: 0, hospital: 0, depot: 0 }]; // taken BY side
    this.zoneHold = [Array(8).fill(0), Array(8).fill(0)]; // seconds each side has owned each zone (ZONE_LOSS_HP)
    this.zoneLossAt = [Array(8).fill(-99), Array(8).fill(-99)]; // last zone-loss charge per side and zone
    this.hpAcc = [{ siege: 0, regen: 0 }, { siege: 0, regen: 0 }]; // small drains and gains, batched into 1 HP popups
    this.turrets = [0, 1].map(side => this._newTurret(side));
    this.elapsed = 0; this.steps = 0; this.cameraShake = 0;
    this.paused = false; this.over = false; this.winner = null; this.error = '';
    this.logs = [];
    this.lastDeployAt = [-8, -7];
    this.land = Array(8).fill(0);
    this.fieldCredits = (this.draftCarry || [0, 0]).slice();
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
    this.comms = [[], []]; // comm net panel, newest first (src/agrts/comms.js)
    this.commSeq = 0; // msgId / exchangeId counter for this match (COMM NET exchanges)
    this.commConfirms = {}; // exchangeId -> confirmations posted (capped)
    this.commState = [0, 1].map(() => ({ lastSit: 0, contact: {}, threatAt: -99, threat: 0, losses: [], lost: {}, killed: {}, land: null, turretHit: false, turretSpotAt: -99, turretDown: [] }));
    this.protocolSnap = [null, null];
    this.wirePending = [0, 1].map(() => emptyWire());
    this.nextId = 1; this.noticeId = 1;
    this.unitSerial = [{}, {}]; // per side, per type: last number handed out (R1, R2, ...); never reused
    this.lastBuyAt = [{}, {}]; // per side, per type: match time of the last post (or autobuy) that bought it (buy_cooldown_s)
    this.baseDamage = [{ kamikaze: 0, other: 0 }, { kamikaze: 0, other: 0 }]; // damage each base took, by attacker role (sweeps read it)
    this.droneHits = [[], []]; // per side: { t, zone (0..7), k (enemy units hit), kills, shot, by } for each blast
    this.shells = [{ shots: 0, splash: 0, kills: 0 }, { shots: 0, splash: 0, kills: 0 }]; // mortar shells, per side
    // MOVE inheritance (docs/SPEC.md §5.4): per side, the latest MOVE ALL and MOVE <code> (no count,
    // no ID) and the latest CLEAR ALL / CLEAR <code>, each with a sequence number. A unit fielded
    // live takes the newest of these that applies to its type (a CLEAR means no order).
    this.moveSeq = 0;
    this.moveMemory = [0, 1].map(() => ({ all: null, types: {}, clearAll: 0, clearTypes: {} }));
    this.stanceMemory = [{}, {}]; // STANCE <code>/ALL: stance per type for units fielded later this match
    // decisionQueue is intentionally kept. A wave posted while this match was held
    // is the next sim step's order, including the first step after boot.
    this._randomizeTerrain();
    this.hospitals = this.fieldHospital ? [0, 1].map(side => this._newHospital(side)) : null;
    // Towers (towers.js): one gun tower per side. null unless TOWERS=1 and GUN_TOWER on, so every later check is a no-op.
    this.guns = this.tw.on && this.tw.gun && this.tw.gunHp > 0 ? [0, 1].map(side => this._newGun(side)) : null;
    // One depot per side beside the base: half the base income, a shield on the base, rebuilds like the hospital.
    this.depots = this.tw.on && this.tw.depot && this.tw.depotHp > 0 ? [0, 1].map(side => this._newDepot(side)) : null;
    // Forward posts OB (A) / FOB (B) per side (The Range 45dc340/992048e/d884378, docs/FORWARD-POST.md): towers on and post_on 1. [A0, A1, B0, B1].
    this.posts = this.tw.on && RULES.value('post_on') ? ['A', 'B'].flatMap(k => [0, 1].map(sd => this._newPost(sd, k))) : null;
    this.postEvents = []; this._hpDmgAcc = [{}, {}];
    // Bought gun towers (BUY TOWER, TOWER_BUY on only): per side, built after TOWER_BUILD_S, same gun rules, no Team HP or tie-break weight.
    this.extraGuns = [[], []]; this.towerBought = [0, 0];
    // BUY RANGE: per side, per target (gun tower(s) share one pool, the base turret has its own), the rounds left and the time of the last purchase; rangeBuys counts purchases.
    this.rangeRounds = [{ gun: 0, turret: 0 }, { gun: 0, turret: 0 }]; this.rangeAt = [{ gun: -999, turret: -999 }, { gun: -999, turret: -999 }]; this.rangeBuys = [0, 0];
    this._log(`${this.awaitViewer ? 'Match armed' : 'Match started'} · GREEN ${this._sourceLabel(0)} · EMBER ${this._sourceLabel(1)}`);
    this._log(`GREEN arsenal · ${this.summary(this.rosters[0]) || 'empty'}`, 0);
    this._log(`EMBER arsenal · ${this.summary(this.rosters[1]) || 'empty'}`, 1);
    // New match clock. A pending credit edge from the previous match must not leak.
    // With the viewer gate, READY is the armed line and START waits until T0.
    // Without it, START is written now. A reboot before the first step rewrites that START.
    this.phase = this.awaitViewer ? 'waiting' : 'live';
    if (this.awaitViewer && (!this.gateId || this._gateMatch !== this.matchNo)) {
      this.gateId = crypto.randomBytes(16).toString('hex');
      this._gateMatch = this.matchNo;
      this._gateReleased = false;
    }
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
      if (this._gateOpen()) this._beginCountdown();
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
    // Owner approval seam (docs/STRATEGY-CARD.md): the host sets startHold() while the owner's pre-match strategy card is
    // still open. Whatever releases the viewer gate (any viewer, a gate id, the owner's Start) waits here until it is approved.
    if (typeof this.startHold === 'function' && this.startHold()) return;
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

  /** True when the armed match may start counting down: the gate was released (strict), or any viewer is watching (legacy). */
  _gateOpen() {
    if (!this.gateStrict) return (this.viewers || 0) >= 1;
    return this._gateReleased;
  }

  gateHash() { return this.gateId ? crypto.createHash('sha256').update(this.gateId).digest('hex') : null; }

  /** A watch page presented a gate id (local /events?g=). Only the current id releases the gate. Returns true if it did. */
  presentGate(g) {
    if (!this.gateId || typeof g !== 'string' || g.length !== this.gateId.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(g), Buffer.from(this.gateId))) return false;
    return this._release();
  }

  /** The relay reports the sha256 of every gate id its connected pages presented. Only the current id's hash releases the gate. */
  presentGateHashes(list) {
    const h = this.gateHash();
    if (!h || !Array.isArray(list) || !list.includes(h)) return false;
    return this._release();
  }

  /** The owner's explicit Start (a tap on a page that holds the owner key). */
  ownerStart() { return this._release(); }

  _release() {
    if (this.over || this.phase !== 'waiting') return false;
    this._gateReleased = true;
    this._syncViewers();
    if (this.phase === 'waiting') this._emit();   // still held (strategy card not approved yet): pages learn the gate is released
    return true;
  }

  _syncViewers() {
    const n = (this.relayViewers || 0) + (this.localViewers || 0);
    const changed = n !== this.viewers;
    this.viewers = n;
    if (this.phase === 'waiting' && this._gateOpen() && !this.paused && !this.over) {
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
    // The commander swaps a few units for Drones with its own seeded dice (this.rng is not drawn),
    // then one Mortar when that unit is on (draft cost comes out of Scouts, then Rifles).
    let counts = cloneCounts(draft);
    if (this._commanderOn(s) && this.npcDrones) counts = K.draftDrones(counts, this._commanderSeed(s), this.plans[s]);
    if (this._commanderOn(s) && this.mortarOn) counts = K.draftMortars(counts);
    return counts;
  }

  _queueSide(s) {
    if (this.drivers[s] === 'warrior') {
      const order = this.warriorOrders[s];
      return order && order.queue ? order.queue.filter(k => TYPES[k]).slice(0, this.maxBuys) : [];
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
    for (const t of this.turrets) this._stepTurret(t, dt, sideUnits[1 - t.side]);
    if (this.fieldHospital) this._stepHospitals(dt);
    if (this.guns) for (const g of this.guns) this._stepGun(g, dt, sideUnits[1 - g.side]);
    if (this.guns && this.tw.buy) for (const list of this.extraGuns) for (const g of list) {
      g.hitFlash = Math.max(0, (g.hitFlash || 0) - dt);
      if (g.building > 0) { g.building -= dt; if (g.building <= 0) { g.building = 0; this._log(`${TEAM[g.side].log} tower built in z${g.zone + 1}`, g.side); } continue; }
      this._stepGun(g, dt, sideUnits[1 - g.side]);
    }
    if (this.depots) this._stepDepots(dt);
    if (this.posts) {
      this._stepPosts(dt);
      // postEvents (unlock / ready): the watch page reads the frame (glow, building); here they become log lines and are drained so they never pile up.
      for (const e of this.postEvents.splice(0)) this._log(`${TEAM[e.side].log} ${e.slot === 'B' ? 'FOB' : 'OB'} ${e.kind === 'unlock' ? 'unlocked' : 'ready'} · z${e.zone + 1}`, e.side);
    }
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
        this._commLoss(u);
        if (u.focusKill) this._noteWire('focus', 1 - u.side, u.type);
        this._sparks(u.x, u.y, u.side === 0 ? '#bafc82' : '#ff7768', 9);
        return false;
      }
      return true;
    });
    this._protocolTick();
    if (this.phase === 'live' && !this.over) this._commTick();
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
    else if (this.elapsed >= this._timeLimit()) this._timeUp();
  }

  /** Match length in sim seconds: the old 480 s cap, or TIME_LIMIT_S with towers on. */
  _timeLimit() { if (this.tw.on && RULES.value('no_clock')) return 1e9; return this.tw.on ? this.tw.timeLimit : C.MATCH_CAP; }   // no_clock default 0: time_limit_s (360) then _timeUp decides (same as The Range); NO_CLOCK=1 opts out

  /**
   * The clock ran out. Old rules: more base HP wins, equal HP is a draw. Towers on: higher Team HP, then more
   * tower points taken (gun 2, hospital 1, depot 3), then more zones held (land past 0.35), then a draw.
   * The reason names what decided it: `time limit, HP 74-61` (Green first).
   */
  _timeUp() {
    if (!this.tw.on) {
      if (this.hp[0] === this.hp[1]) this._end(null, 'time limit');
      else this._end(this.hp[0] > this.hp[1] ? 0 : 1, 'time limit');
      return;
    }
    const hp = this.hp.map(v => Math.ceil(Math.max(0, v)));
    if (hp[0] !== hp[1]) return this._end(hp[0] > hp[1] ? 0 : 1, `time limit, HP ${hp[0]}-${hp[1]}`);
    const pts = this.towerPts;
    if (pts[0] !== pts[1]) return this._end(pts[0] > pts[1] ? 0 : 1, `time limit, towers ${pts[0]}-${pts[1]}`);
    const z = [0, 1].map(s => this._zonesOwned(s));
    if (z[0] !== z[1]) return this._end(z[0] > z[1] ? 0 : 1, `time limit, zones ${z[0]}-${z[1]}`);
    return this._end(null, 'time limit');
  }

  /** Zones a side owns outright (land past 0.35, the same cut as capture and zone income). */
  _zonesOwned(s) {
    let n = 0;
    for (const v of this.land) if (s === 0 ? v > 0.35 : v < -0.35) n++;
    return n;
  }

  /**
   * Direct damage to a side's base: unit shots, mortar shells, drone blasts. Takes Team HP one to one and can
   * reach 0 (an outright loss). `key` is the attacker class sweeps read from baseDamage.
   */
  /** Team HP per point of structure damage (The Range 6ad3b81): owner loses lost x hp_per_dmg_<kind>. Direct, unfloored. Towers on only. */
  _structHit(t, kind, lost) {
    if (!this.tw.on || this.over || !(lost > 0)) return 0;
    const w = RULES.value('hp_per_dmg_' + kind);
    if (!(w > 0)) return 0;
    const take = lost * w, side = t.side;
    this.hp[side] -= take; this.hpLoss[side].tower += take;
    const acc = this._hpDmgAcc[side]; acc[kind] = (acc[kind] || 0) + take;
    if (acc[kind] >= 1) { const n = Math.floor(acc[kind]); acc[kind] -= n; this.hpEvents.push({ side, amount: n, why: 'tower', kind, at: this.elapsed, zone: t.zone != null ? t.zone + 1 : undefined }); }
    return take;
  }
  _baseHit(side, dmg, key) {
    if (!(dmg > 0)) return 0;
    // The depot shield: while the depot stands, the base takes DEPOT_SHIELD (x0.6) of every direct hit.
    if (this.depots && this.depots[side].alive) {
      const full = dmg;
      dmg *= this.tw.depotShield;
      this.shieldBlocked[side] += full - dmg;
    }
    this.hp[side] -= dmg;
    this.baseDamage[side][key] += dmg;
    this.hpLoss[side].base += dmg;
    return dmg;
  }

  /**
   * Indirect Team HP loss (tower kill, lost zone, siege). Needs towers on. Softened by COMEBACK_MULT below
   * COMEBACK_BELOW, and never takes the side under TEAM_HP_FLOOR: only the base can finish a team.
   * Returns what was actually taken. `why` is tower | zone | siege; `info` rides on the hpEvent for the watch page.
   */
  _teamLoss(side, amount, why, info) {
    if (!this.tw.on || !(amount > 0) || this.over) return 0;
    const hp = this.hp[side];
    let amt = amount;
    if (hp < this.tw.comebackBelow) amt *= this.tw.comebackMult;
    const take = Math.max(0, Math.min(amt, hp - this.tw.floor));
    this.hpBlocked[side] += amount - take;
    if (!(take > 0)) return 0;
    this.hp[side] = hp - take;
    this.hpLoss[side][why] += take;
    // Siege drains tiny amounts every step: only the discrete losses get a popup.
    if (why !== 'siege') this.hpEvents.push({ side, amount: Math.round(take * 10) / 10, why, at: this.elapsed, ...(info || {}) });
    return take;
  }

  /** Indirect Team HP gain (hospital regen). Never past `max`. */
  _teamGain(side, amount, max) {
    if (!this.tw.on || !(amount > 0)) return 0;
    const give = Math.max(0, Math.min(amount, max - this.hp[side]));
    this.hp[side] += give;
    this.hpGain[side] += give;
    return give;
  }

  /**
   * A tower of `side` was destroyed by the other side. Tie-break points and kill counts, the owner's Team HP
   * (indirect: floor and comeback apply; a repeat kill costs the repeat share), and the credits the
   * attacker gets. `zone` (1..8) rides on the hpEvent for the popup.
   */
  _towerDown(kind, side, zone) {
    if (!this.tw.on) return;
    const by = 1 - side, tw = this.tw;
    this.towerPts[by] += TW.KINDS[kind].points;
    const n = this.towerKills[by][kind]++;
    const rule = { gun: [tw.gunHpCost, tw.gunCr, 1], hospital: [tw.hospHp, tw.hospCr, 0.5], depot: [tw.depotHpCost, tw.depotCr, 0.5] }[kind];
    const took = this._teamLoss(side, rule[0] * (n === 0 ? 1 : rule[2]), 'tower', { kind, zone });
    if (rule[1] > 0) {
      this.fieldCredits[by] += rule[1];
      this._spend(by);
    }
    this._log(`${TEAM[by].log} takes the ${TW.KINDS[kind].label}${took > 0 ? ` · ${TEAM[side].log} −${Math.round(took * 10) / 10} HP` : ''}${rule[1] > 0 ? ` · +${rule[1]} CR` : ''}`, by);
  }

  /**
   * The per-step HP rules (towers on): zone-loss damage, siege drain, hospital regeneration. Each is a setting
   * (ZONE_LOSS_HP, SIEGE_DRAIN, HOSP_REGEN_S; 0 turns it off), all indirect (floor, comeback).
   */
  _hpRules(dt) {
    const tw = this.tw;
    if (this.phase !== 'live' || this.over) return;
    while (this.hpEvents.length && this.elapsed - this.hpEvents[0].at > 6) this.hpEvents.shift();
    // Zone loss: a zone a side held for ZONE_HOLD_S or more falls to its enemy side of 0.
    if (tw.zoneLoss > 0) {
      for (let s = 0; s < 2; s++) {
        for (let i = 0; i < 8; i++) {
          const v = s === 0 ? this.land[i] : -this.land[i];
          if (v > 0.35) this.zoneHold[s][i] += dt;
          else if (v <= 0) {
            if (this.zoneHold[s][i] >= tw.zoneHoldS && this.elapsed - this.zoneLossAt[s][i] >= tw.zoneCooldownS) {
              this.zoneLossAt[s][i] = this.elapsed;
              const w = TW.ZONE_WEIGHT[TW.depth(s, i)] * tw.zoneLoss;
              const took = this._teamLoss(s, w, 'zone', { zone: i + 1 });
              this._log(`${TEAM[s].log} loses z${i + 1}${took > 0 ? ` · −${Math.round(took * 10) / 10} HP` : ''}`, 1 - s);
            }
            this.zoneHold[s][i] = 0;
          }
        }
      }
    }
    // Siege: enemy ground units (not Scouts, Medics or Drones) in our two home zones, with none of ours there.
    if (tw.siege > 0) {
      for (let s = 0; s < 2; s++) {
        const home = s === 0 ? [0, 1] : [6, 7];
        let n = 0;
        for (const z of home) {
          let foe = 0, own = 0;
          for (const u of this.units) {
            if (u.hp <= 0 || !grounded(u) || C.zoneOf(u.x) !== z) continue;
            if (u.side === s) own++;
            else if (!U.isHealer(u.type) && U.roleOf(u.type) !== 'fast') foe++;
          }
          if (foe && !own) n += foe;
        }
        if (n) {
          const take = this._teamLoss(s, Math.min(tw.siegeMax, tw.siege * n) * dt, 'siege');
          this._hpPopup(s, 'siege', take);
        }
      }
    }
    // Hospital regeneration: while it stands, Team HP creeps up between HOSP_REGEN_MIN and HOSP_REGEN_MAX.
    if (tw.regenS > 0 && this.fieldHospital && this.hospitals) {
      for (let s = 0; s < 2; s++) {
        const h = this.hospitals[s];
        if (!h || !h.alive || this.hp[s] < tw.regenMin || this.hp[s] >= tw.regenMax) continue;
        const got = this._teamGain(s, dt / tw.regenS, tw.regenMax);
        this._hpPopup(s, 'regen', got);
      }
    }
  }

  /** Batch tiny siege drains and regen gains into whole-HP events for the watch page. */
  _hpPopup(side, why, amount) {
    if (!(amount > 0)) return;
    const acc = this.hpAcc[side];
    acc[why] += amount;
    if (acc[why] >= 1) {
      acc[why] -= 1;
      this.hpEvents.push({ side, amount: 1, why, at: this.elapsed });
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
      this._pushComm(side, [CM.offNet(this._commCtx(side))]);
      this._pushPanel(side, { kind: 'hold', verb: 'COMMANDER TAKES OVER', detail: `warrior silent ${Math.round(quiet)} s`, auto: true });
      return;
    }
    if (!talking) return;
    this.takeover[side] = false;
    this.cmdrKick(side);
    this.warriorQuietSince[side] = this.elapsed;
    this._say(side, 'WARRIOR BACK', `The ${TEAM[side].log} warrior is back. Standing orders the commander set stay until it changes them.`);
    this._log(`${TEAM[side].log} warrior back · commander hands over`, side);
    this._pushComm(side, [CM.backOnNet(this._commCtx(side))]);
    this._pushPanel(side, { kind: 'hold', verb: 'WARRIOR BACK', detail: 'commander hands over', auto: false });
  }

  /**
   * One commander window: build its plain-data view, ask commander.js for up to 3 orders and a
   * WHY, and post them through applyProtocolOrders, the same path a warrior seat uses.
   */
  _commanderStep(side) {
    // A decision already queued for this side (pushDecision) takes this window, as it does for the wave brain.
    if ((this.decisionQueue[side] || []).length) return;
    // Ember's BUY RANGE rule (src/agrts/ember-range.js): defending and outnumbered, only with BUY_RANGE on. Runs before the commander's
    // buys; while the trigger holds and the bank is short, Ember SAVES (no unit buys, auto-buy paused) up to 15 s, then buys range.
    let saving = false;
    if (side === 1 && this.phase === 'live' && this.tw.on && this.tw.rangeBuy && this.guns) {
      try {
        if (this._emberSaveNo !== this.matchNo) { this._emberSave = null; this._emberSaveNo = this.matchNo; }
        const r = ER.step(this._emberRangeView(side), this._emberSave, this.elapsed);
        const was = !!(this._emberSave && this._emberSave.since != null);
        this._emberSave = r.st; saving = r.save;
        if (r.save && !was) this._log(`${TEAM[side].log} saves for RANGE · ${r.need} CR`, side);
        if (r.buy) this.applyProtocolOrders(side, [r.buy.what === 'all' ? 'BUY RANGE' : `BUY RANGE ${r.buy.what === 'gun' ? 'TOWER' : 'TURRET'}`, `WHY ${r.buy.why}`], { npc: true });
      } catch (e) { saving = false; this._emberSave = null; }
    }
    this._emberSaving = saving;
    const mem = this.commanderMem[side] || (this.commanderMem[side] = K.newMemory(this._commanderSeed(side)));
    const price = {};
    for (const k of TYPE_IDS) price[k] = this._livePrice(side, k);
    const view = {
      side, elapsed: this.elapsed,
      units: this.units.map(u => ({ side: u.side, tag: this._tagOf(u), type: u.type, x: u.x, y: u.y, hp: u.hp, max: u.max, radio: u.radio ? { kind: u.radio.kind, zone: u.radio.zone, phase: u.radio.phase } : null, stance: u.stance || null })),
      reserve: cloneCounts(this.reserve[side]), bank: Math.floor(this.fieldCredits[side]), price,
      focus: this.focus[side], autobuy: this.autobuy[side] ? this.autobuy[side].type : null,
      buyCapped: this._autobuyCapped(side), queue: this.queue[side].slice(),
      // Per type: why a buy is refused by the units.csv caps right now ('' = allowed) and how many more the caps allow (the same functions every buy path uses).
      caps: Object.fromEntries(TYPE_IDS.map(k => [k, { block: this._buyCapReason(side, k), room: this._buyCapRoom(side, k) }])),
      activeCap: this.activeCap,
      // Their base turret's HP (0 once it is down, or with the turret off): the commander masses before their home zone.
      enemyTurret: this.turrets[1 - side].alive ? Math.ceil(this.turrets[1 - side].hp) : 0,
      // Their field hospital, or null when the flag is off. The commander focuses it when it is in reach.
      enemyHospital: this.fieldHospital && this.hospitals ? this._hospitalBrief(1 - side) : null,
      postsDown: this.posts && !this._postOff ? this.posts.filter(p => p.side === side && !p.alive).length : 0,   // field runner read (red-buy KNOBS.runner)
      // Towers and Team HP (TOWERS=1): null otherwise. See _towerBrief.
      towers: this.tw.on ? this._towerBrief(side) : null,
      towerBuy: this.tw.on && this.tw.buy && this.tw.buyEmber && this.guns ? { price: this.tw.buyCr, room: Math.max(0, this.tw.buyMax - this.towerBought[side]) } : null,
      // The mortar type when this match fields them. The commander buys one behind its tanks.
      mortar: this.mortarOn ? (U.idsWithRole('mortar')[0] || null) : null,
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
    if (saving && plan.lines) plan.lines = plan.lines.filter(l => !/^(BUY|AUTOBUY)\b/.test(l));   // saving for RANGE: no unit buys
    if (plan.lines && plan.lines.length) {
      const res = this.applyProtocolOrders(side, plan.why ? [...plan.lines, `WHY ${plan.why}`] : plan.lines, { npc: true });
      this.commanderLast = this.commanderLast || [null, null];
      this.commanderLast[side] = { t: this.elapsed, lines: plan.lines.slice(), results: (res && res.results) || [] };
      // The autobuy rows say what the rule is for, not the WHY of the window that installed it.
      const rule = this.autobuy[side];
      if (rule && plan.lines.some(l => /^AUTOBUY /.test(l))) rule.why = rule.reserve ? `keeps ${rule.reserve} CR for a medic` : 'autobuy';
    }
    if (plan.title) this._say(side, plan.title, plan.detail || '');
    // Ember add-on layer (src/agrts/ember-plus.js), level 2 only (default 0, level 1 retired): spend, push, raid, turtle-break.
    if (side === 1 && this.emberPlus > 0) {
      if (!this._emberPlusMem || this._emberPlusMem.no !== this.matchNo) this._emberPlusMem = { no: this.matchNo };
      let extra = [];
      try { extra = EP.emberPlusOrders(this, side, this.emberPlus, this._emberPlusMem); } catch (e) { extra = []; this._emberPlusMem.err = String(e && e.message || e); }
      for (const post of extra) if (post && post.length) this.applyProtocolOrders(side, post, { npc: true });
    }
  }

  /** The commander's seed for this match and side: the match seed, mixed so it is not this.rng's stream. */
  _commanderSeed(side) {
    return ((this.baseSeed + this.matchNo * 997) ^ Math.imul(0x2c1b3c6d, side + 1)) >>> 0;
  }

  /** Units this side has alive: on the field plus in reserve (dead units never count). */
  _livingCount(side) {
    let n = total(this.reserve[side]);
    for (const u of this.units) if (u.side === side && u.hp > 0) n++;
    return n;
  }

  /** Buys used this match: queue buys (reinf) plus live BUYs and autobuys (liveBuys). */
  _buysUsed(side) { return this.reinf[side] + this.liveBuys[side]; }

  /**
   * How many more units this side may buy now, by the one rule every buy path uses (manual BUY, queue,
   * AUTOBUY, both sides): the buy cap (BUY_CAP, Infinity = none) and the 24 living units (field + reserve).
   */
  _buyRoom(side) {
    // reserveCap (opt or env RESERVE_CAP, 0 = off): no buy while that many units already wait in reserve.
    const resRoom = this.reserveCap > 0 ? this.reserveCap - C.total(this.reserve[side]) : Infinity;
    return Math.max(0, Math.min(this.maxBuys - this._buysUsed(side), C.ROSTER_LIMIT - this._livingCount(side), resRoom));
  }

  /** The buy cap or the living-roster limit is reached (no buy path may buy). */
  _autobuyCapped(side) {
    return this._buyRoom(side) <= 0;
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
    const sp = this._spawnPoint(side, y);
    const x = sp.x; y = sp.y;
    const u = {
      id: this.nextId++, side, type: k, x, y, hp: a.hp, max: a.hp, cd: 0.35, age: 0, dir, guard,
      formationOffset: y - H / 2, spawnShield: guard ? 1.4 : 0, facingX: dir, facingY: 0,
      hitFlash: 0, healing: false, medicMode: '', medicTargetId: null,
    };
    this._tagOf(u);
    u.stance = this._stanceFor(side, k);
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
  /** Stance of a newly fielded unit: the STANCE memory for its type, else the default. Null for drones. */
  _stanceFor(side, type) {
    if (!ST.hasStance(type)) return null;
    const mem = this.stanceMemory && this.stanceMemory[side];
    return (mem && mem[type]) || ST.defaultStance(type, this.stanceMode[side]);
  }

  /** u's stance, filling the default in for a unit made without one (tests, older saves). */
  _stance(u) {
    if (u.stance === undefined) u.stance = this._stanceFor(u.side, u.type);
    return u.stance;
  }

  /**
   * CHARGE: the enemy unit that hit u in the last CHARGE_MEMORY_S, alive, on the ground, not shielded, and
   * not standing under their turret (a lone Breaker must not be baited into it). Null otherwise.
   */
  _chargeTarget(u) {
    if (this._stance(u) !== 'CHARGE' || u.hitById == null || this.elapsed - (u.hitByAt || -99) > ST.CHARGE_MEMORY_S) return null;
    const v = this.units.find(w => w.id === u.hitById);
    if (!v || v.hp <= 0 || v.side === u.side || !grounded(v) || v.spawnShield > 0) return null;
    const t = this.turrets && this.turrets[1 - u.side];
    const tr = C.TURRET && C.TURRET.range;
    if (t && t.alive && tr && Math.hypot(v.x - t.x, v.y - t.y) < tr && Math.hypot(u.x - t.x, u.y - t.y) >= tr) return null;
    return v;
  }

  /** True when a shot of this gun can reach something `d` px away. `slop` widens the far end (bases, turrets). */
  _canShoot(a, d, slop = 0) {
    if (!(d < a.range + slop)) return false;
    if (a.minRange > 0 && d < a.minRange) return false;
    return true;
  }

  /** Walls block a direct gun. An indirect gun (the mortar) fires over them. */
  _shotBlocked(a, x0, y0, x1, y1) {
    if (a && a.indirect) return false;
    return this._lineBlocked(x0, y0, x1, y1);
  }

  /**
   * Where a mortar stands: a fixed trail behind the lead tank (else the lead scout), so the tube
   * shells the contact from outside its own minimum range. With no screen, it sits on its own half.
   */
  _mortarAnchor(u, a) {
    const dir = u.side === 0 ? 1 : -1;
    const back = 78;
    let lead = null;
    for (const v of this.units) {
      if (v === u || v.side !== u.side || v.hp <= 0 || !grounded(v)) continue;
      const role = U.roleOf(v.type);
      if (role !== 'armor' && role !== 'fast') continue;
      if (!lead || (v.x - lead.x) * dir > 0) lead = v;
    }
    // No Breaker or Scout on the field (an all-Rifle army): follow the front Rifle instead. Before this the
    // tube fell back to a fixed spot in our z2 and sat there while the army took z8 (live match Oct 14).
    if (!lead) {
      for (const v of this.units) {
        if (v === u || v.side !== u.side || v.hp <= 0 || !grounded(v) || U.roleOf(v.type) !== 'ranged') continue;
        if (!lead || (v.x - lead.x) * dir > 0) lead = v;
      }
    }
    if (!lead) {
      // Nobody to screen us: hold half a zone short of our MOVE zone, else the old spot.
      const zw = W / C.ZONES;
      const o = u.radio;
      if (o && o.kind === 'move' && o.zone != null) return { x: this._fieldX(o.zone * zw + zw / 2 - dir * zw * 0.5), y: u.y };
      return { x: u.side === 0 ? W * 0.18 : W * 0.82, y: u.y };
    }
    return { x: this._fieldX(lead.x - dir * back), y: lead.y };
  }

  /**
   * The enemy this tube is shelling. The locked target is kept out to 48 px past max range
   * (wide hysteresis). A new target is acquired only inside the firing band.
   */
  _mortarFoe(u, a) {
    let lock = null, best = null, bestD = Infinity;
    const id = u.mortarPlant && u.mortarPlant.id;
    for (const v of this.units) {
      if (v.side === u.side || v.hp <= 0 || v.spawnShield > 0) continue;
      const d = Math.hypot(v.x - u.x, v.y - u.y);
      if (id && v.id === id) lock = { v, d };
      if (d >= a.minRange && d <= a.range && d < bestD) { best = v; bestD = d; }
    }
    if (lock && lock.d >= a.minRange && lock.d <= a.range + 48) return lock;
    return best ? { v: best, d: bestD } : null;
  }

  /**
   * Mortar movement. Plant on a firing spot and stay: at least 3.2 s, and until the target
   * leaves the wide band. A weaving tank does not pick the tube up again unless the screen
   * has moved about 80 px and there is nothing to shell.
   * Retreat only when a ground enemy is inside the dead zone, or inside 48 px of it and
   * closing faster than 32 px/s. Keep backing until they are 36 px past the dead zone, then plant.
   * An enemy that is merely near does not move the tube. Returns true for a mortar (the caller
   * skips the normal chase, so a MOVE cannot walk the tube into its own minimum range).
   * u.mortarRetreats counts retreats started, not frames spent backing up.
   */
  _mortarStep(u, a, dt, terrain) {
    if (a.role !== 'mortar') return false;
    const dir = u.side === 0 ? 1 : -1;
    const threat = this._kiteThreat(u);
    let closing = 0;
    if (threat && u.mortarPrevId === threat.v.id && u.mortarPrevD != null && dt > 0) closing = (u.mortarPrevD - threat.d) / dt;
    if (threat) { u.mortarPrevId = threat.v.id; u.mortarPrevD = threat.d; }
    else { u.mortarPrevId = 0; u.mortarPrevD = null; }
    const minR = a.minRange || 0;
    const inside = !!(threat && minR > 0 && threat.d < minR);
    const closingFast = !!(threat && minR > 0 && threat.d < minR + 48 && closing > 32);
    const stillBacking = !!(u.mortarBack && threat && minR > 0 && threat.d < minR + 36);
    if (inside || closingFast || stillBacking) {
      if (!u.mortarBack) {
        u.mortarBack = true;
        u.mortarRetreats = (u.mortarRetreats || 0) + 1;
      }
      u.mortarPlant = null;
      const d = threat.d || 1;
      let gx = u.x + (u.x - threat.v.x) / d * 56;
      const gy = u.y + (u.y - threat.v.y) / d * 14;
      const zw = W / C.ZONES;
      const floor = dir > 0 ? zw / 2 : W - zw / 2;
      gx = dir > 0 ? Math.max(floor, gx) : Math.min(floor, gx);
      if (Math.abs(gx - u.x) > 1) this._radioMove(u, a, dt, gx, this._fieldY(gy), terrain);
      return true;
    }
    u.mortarBack = false;
    const foe = this._mortarFoe(u, a);
    const anchor = this._mortarAnchor(u, a);
    if (foe) {
      if (!u.mortarPlant) u.mortarPlant = { x: u.x, y: u.y, until: this.elapsed + 3.2, id: foe.v.id };
      else u.mortarPlant.id = foe.v.id;
      return true;
    }
    const plant = u.mortarPlant;
    if (plant && (this.elapsed < plant.until || Math.hypot(anchor.x - plant.x, anchor.y - plant.y) < 80)) return true;
    const ad = Math.hypot(anchor.x - u.x, anchor.y - u.y);
    if (ad > 24) {
      u.mortarPlant = null;
      this._radioMove(u, a, dt, anchor.x, this._fieldY(anchor.y), terrain);
      return true;
    }
    u.mortarPlant = { x: u.x, y: u.y, until: this.elapsed + 3.2, id: 0 };
    return true;
  }

  /** KITE: the nearest enemy unit that can shoot back (not a drone), and its distance. */
  _kiteThreat(u) {
    let best = null, bestD = Infinity;
    for (const v of this.units) {
      if (v.side === u.side || v.hp <= 0 || v.spawnShield > 0 || U.isKamikaze(v.type)) continue;
      const d = Math.hypot(v.x - u.x, v.y - u.y);
      if (d < bestD) { best = v; bestD = d; }
    }
    return best ? { v: best, d: bestD } : null;
  }

  /**
   * KITE back-off: when the nearest enemy is inside KITE_BACK of our range, step straight away from it,
   * never behind the middle of our home zone. Returns true when it moved us (the caller skips its own move).
   */
  _kiteStep(u, a, dt, terrain) {
    if (this._stance(u) !== 'KITE' || !(a.range > 0)) return false;
    const th = this._kiteThreat(u);
    if (th && this._inCombat(u)) return false; // already fighting: stand and shoot
    if (!th || th.d >= a.range * ST.KITE_BACK) { if (!th || th.d >= a.range) u.kiteFrom = null; return false; }
    const zw = W / C.ZONES;
    const d = th.d || 1;
    let gx = u.x + (u.x - th.v.x) / d * (a.range - th.d + 12);
    let gy = u.y + (u.y - th.v.y) / d * (a.range - th.d + 12);
    // Give ground at most KITE_GIVE_ZONES from where the back-off began (on a MOVE: from the post
    // zone's rear edge), and never behind the middle of our home zone. Then it stands and fights:
    // a faster kiter must not outrun a Breaker forever.
    const dir = u.side === 0 ? 1 : -1;
    if (u.kiteFrom == null) u.kiteFrom = u.x;
    let from = u.kiteFrom;
    const o = u.radio;
    if (o && o.kind === 'move' && o.phase !== 'back' && o.zone != null) from = dir > 0 ? Math.min(from, o.zone * zw) : Math.max(from, (o.zone + 1) * zw);
    const floor = dir > 0 ? Math.max(zw / 2, from - zw * ST.KITE_GIVE_ZONES) : Math.min(W - zw / 2, from + zw * ST.KITE_GIVE_ZONES);
    gx = dir > 0 ? Math.max(floor, gx) : Math.min(floor, gx);
    if (Math.abs(gx - u.x) < 1 && Math.abs(gy - u.y) < 1) return false; // pinned at home: stand and shoot
    this._radioMove(u, a, dt, gx, this._fieldY(gy), terrain);
    return true;
  }

  /** medic-sprint: an aggressive medic seeking a hurt ally outside heal reach runs at the RUSHING 2.5x (as The Range's no-order medic), re-picked every tick. */
  _medicSprint(u, g) {
    if (!MEDIC_AGGRO_SIDES[u.side] || !g || g.why !== 'seek') return;
    u.medicMode = 'RUSHING'; u.medicTargetId = g.id; u.paceV = null;
  }

  /** Aggressive ESCORT: MEDIC_FRONT_GAP px behind the frontmost ground ally of the nearest group, or null. */
  _frontPoint(u) {
    let near = null, nearD = Infinity;
    for (const v of this.units) {
      if (v === u || v.side !== u.side || v.hp <= 0 || !grounded(v) || U.isHealer(v.type)) continue;
      const d = Math.hypot(v.x - u.x, v.y - u.y);
      if (d < nearD) { near = v; nearD = d; }
    }
    if (!near) return null;
    const dir = u.side === 0 ? 1 : -1;
    let front = near;
    for (const v of this.units) {
      if (v === u || v.side !== u.side || v.hp <= 0 || !grounded(v) || U.isHealer(v.type)) continue;
      if (Math.hypot(v.x - near.x, v.y - near.y) > ST.ESCORT_GROUP_R * 2) continue;
      if ((v.x - front.x) * dir > 0) front = v;
    }
    return { x: front.x - dir * MEDIC_FRONT_GAP, y: front.y };
  }

  /** ESCORT: where a healer trails the nearest friendly group (half a zone behind its rear), or null. */
  _escortPoint(u) {
    let near = null, nearD = Infinity;
    for (const v of this.units) {
      if (v === u || v.side !== u.side || v.hp <= 0 || !grounded(v) || U.isHealer(v.type)) continue;
      const d = Math.hypot(v.x - u.x, v.y - u.y);
      if (d < nearD) { near = v; nearD = d; }
    }
    if (!near) return null;
    const dir = u.side === 0 ? 1 : -1;
    let rear = near.x, sy = 0, n = 0;
    for (const v of this.units) {
      if (v === u || v.side !== u.side || v.hp <= 0 || !grounded(v) || U.isHealer(v.type)) continue;
      if (Math.hypot(v.x - near.x, v.y - near.y) > ST.ESCORT_GROUP_R) continue;
      if ((v.x - rear) * dir < 0) rear = v.x;
      sy += v.y; n++;
    }
    const zw = W / C.ZONES;
    return { x: rear - dir * zw * ST.ESCORT_TRAIL_ZONES, y: sy / n };
  }

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
    const room = this._buyRoom(side);
    if (room <= 0) return;
    const res = this.decisions.spendCredits({
      side, credits: this.fieldCredits[side], queue: this.queue[side], bought: this.reinf[side], maxBuys: this.reinf[side] + room,
    }) || { types: [], creditsLeft: this.fieldCredits[side], bought: this.reinf[side] };
    const types = (res.types || []).filter(k => TYPES[k]);
    if (!types.length) {
      if (typeof res.creditsLeft === 'number') this.fieldCredits[side] = res.creditsLeft;
      if (typeof res.bought === 'number') this.reinf[side] = res.bought;
      return;
    }
    for (const k of types) {
      const pack = this._packOf(k);
      this.reserve[side][k] = (this.reserve[side][k] || 0) + pack;
      this.rosters[side][k] = (this.rosters[side][k] || 0) + pack;
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
    // Field runner (economy.csv scout_capture_mult, docs/SCOUT.md): a Scout (role fast) counts that many units, and a zone won with one in it flips that much faster.
    const sm = RULES.value('scout_capture_mult'), runners = Array.from({ length: 8 }, () => [0, 0]);
    for (const u of this.units) if (grounded(u)) {
      const z = Math.min(7, Math.max(0, Math.floor(u.x / (W / 8)))), fast = U.roleOf(u.type) === 'fast';
      counts[z][u.side] += fast ? sm : 1; if (fast) runners[z][u.side]++;
    }
    for (let i = 0; i < this.land.length; i++) {
      const [g, r] = counts[i];
      const wasGreen = this.land[i] > 0.35, wasRed = this.land[i] < -0.35;
      if (g > r) this.land[i] = Math.min(1, this.land[i] + dt * 0.30 * (runners[i][0] ? sm : 1));
      else if (r > g) this.land[i] = Math.max(-1, this.land[i] - dt * 0.30 * (runners[i][1] ? sm : 1));
      if (!wasGreen && this.land[i] > 0.35 && i >= 3) {
        this.fieldCredits[0] += C.ZONE_CAPTURE_CR;
        this.capturePulses.push({ zone: i, side: 0, t: 0, life: 1.1 });
        this._log(`GREEN captures frontier zone · +${C.ZONE_CAPTURE_CR} CR`, 0);
        this._spend(0);
      }
      if (!wasRed && this.land[i] < -0.35 && i <= 4) {
        this.fieldCredits[1] += C.ZONE_CAPTURE_CR;
        this.capturePulses.push({ zone: i, side: 1, t: 0, life: 1.1 });
        this._log(`EMBER captures frontier zone · +${C.ZONE_CAPTURE_CR} CR`, 1);
        this._spend(1);
      }
    }
    if (this.tw.on) this._hpRules(dt);
    this.incomeClock += dt;
    if (this.incomeClock >= C.INCOME_TICK_S) {
      this.incomeClock -= C.INCOME_TICK_S;
      for (let s = 0; s < 2; s++) {
        // Income never stops at the buy cap (credits still pay for nothing else, but the bank stays honest).
        const part = this._incomeParts(s);
        const { n, zone, base, catchup } = part;
        const pay = zone + base + catchup;
        if (pay) {
          this.fieldCredits[s] += pay;
          this.incomeTotal[s] += pay;
          this.baseIncomeTotal[s] += base;
          // The log keeps the zone line; base-only ticks are silent (they come every 4 s).
          // With the flags off, zone is n × 12, so the line is the one the tests already know.
          if (n) this._log(`${TEAM[s].log} holds ${n} frontier zone${n === 1 ? '' : 's'} · +${zone} CR${base > 0 ? ` (+${base} base)` : ''}${catchup > 0 ? ` (+${catchup} catch-up)` : ''}`, s);
          this._spend(s);
        }
        this._payUpkeep(s);
        this._decayBank(s);
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
    // Field hospital: a ground unit at 30% or below walks there when it is out of the fight. Medics and drones do not. Flag off returns immediately.
    if (this._hospitalConsumes(u, a, dt, enemies, terrain)) return;
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
    // Flanker (docs/SCOUT.md): a fast unit with a bonus_vs dives at the nearest such enemy within scout_dive_range, past the front line.
    const dive = a.role === 'fast' && bonus && Object.keys(bonus).length ? RULES.value('scout_dive_range') : 0;
    let bestDive = null, bestDiveD = Infinity;
    for (const v of enemies) {
      if (v.spawnShield > 0) continue;
      const d = Math.hypot(v.x - u.x, v.y - u.y);
      // Inside a minimum range the gun cannot bear on that enemy. Indirect fire skips the wall check.
      if ((a.minRange > 0 && d < a.minRange) || this._shotBlocked(a, u.x, u.y, v.x, v.y)) continue;
      // bonus_vs: a target we have a bonus against counts as that much closer when we pick one.
      const pd = bonus && bonus[TYPES[v.type].code] ? d / bonus[TYPES[v.type].code] : d;
      if (pd < bestD) { target = v; bestD = pd; }
      if (dive > 0 && bonus[TYPES[v.type].code] && d < dive && d < bestDiveD) { bestDive = v; bestDiveD = d; }
      if (u.side === 0 ? v.x < W * 0.29 : v.x > W * 0.71) { if (d < bestThreatD) { bestThreat = v; bestThreatD = d; } }
      if (focusOn && v.type === focusType && d < a.range && d < bestFocusD && (!fsc || fsc.zone == null || C.zoneOf(v.x) === fsc.zone)) { bestFocus = v; bestFocusD = d; }
    }
    if (bestFocus) target = bestFocus;
    else if (bestThreat) target = bestThreat;
    else if (bestDive) target = bestDive;
    // CHARGE: whoever just hit us, over the normal pick (FOCUS and a home-zone intruder still win).
    const charge = !bestFocus && !bestThreat && !medicPatient ? this._chargeTarget(u) : null;
    if (charge) target = charge;
    // Default assist: no enemy inside our own range (not shooting) and a fight within
    // assistRadius zones. We head for the nearest enemy in that fight instead of our normal
    // pick (a farther enemy, a home-zone intruder, or the enemy base). Once anything is in
    // range the normal pick takes over again, and when the fight is clear we simply resume.
    if (this.assistRadius > 0 && !medicPatient && !charge && !(target && Math.hypot(target.x - u.x, target.y - u.y) < a.range)) {
      const pick = this._assistPick(u, enemies, zoneCounts, this.assistRadius);
      if (pick) target = pick;
    }
    const enemyBase = u.side === 0 ? W - 16 : 16;
    const attackRange = a.range;
    // Their base turret guards the base: with no unit to fight we go for it before the base. FOCUS TURRET
    // (or no enemy unit in our range) shoots it whenever it is in range.
    const tur = medicPatient ? null : this._turretTarget(u, a, target, focusOn && focusType === 'turret');
    if (tur) target = null;
    // FOCUS H: their hospital first whenever it is in range. Movement stays on the unit or the base.
    const hospStruct = this.fieldHospital && !medicPatient && focusOn && focusType === 'hospital' ? this._hospitalInReach(u, a) : null;
    // Towers (TOWERS=1): FOCUS GUN / FOCUS DEPOT walk at that structure (when no enemy unit is in the way) and shoot it
    // whenever it is in reach. With no focus, a structure in reach is shot while no enemy unit is in our range.
    const focusSt = this.tw.on && !medicPatient && focusOn && (focusType === 'gun' || focusType === 'depot' || focusType === 'post') ? this._focusStruct(u, focusType) : null;
    const walkSt = focusSt && focusSt.alive && !tur && !target ? focusSt : null;
    const tgt = target || tur || walkSt;
    const tx = medicPatient ? medicPatient.x : tgt ? tgt.x : enemyBase;
    const offset = u.repath > 0 ? 0 : (u.formationOffset || 0); // a stalled unit drops its lane for a while
    const ty = medicPatient ? medicPatient.y : target ? this._fieldY(target.y + offset) : tur ? tur.y : walkSt ? walkSt.y : H / 2 + offset;
    const dist = Math.hypot(tx - u.x, ty - u.y);
    const targetDistance = tgt ? Math.hypot(tgt.x - u.x, tgt.y - u.y) : dist;
    const shotClear = tgt && !this._shotBlocked(a, u.x, u.y, tgt.x, tgt.y);
    const inRange = !!(tgt && this._canShoot(a, targetDistance) && shotClear);
    let towerAim = null;
    const stance = this._stance(u);
    // KITE stands at its own max range; the others close to 55% of it.
    const stand = tur || walkSt ? turretStandoff(a) : stance === 'KITE' && target ? Math.max(standoffOf(a, u, target), a.range * ST.KITE_STAND) : standoffOf(a, u, target);
    // RUN: shoot in passing, but keep going for their base (a home-zone intruder still stops us).
    const runPast = stance === 'RUN' && !!target && !tur && !bestThreat && !medicPatient && !(bestDive && target === bestDive);   // a Scout's backline dive stops the run (docs/SCOUT.md)
    const atStandoff = !runPast && inRange && targetDistance <= stand;
    if (medicPatient && dist < a.healRange) {
      u.medicMode = 'HEALING';
      medicPatient.hp = Math.min(medicPatient.max, medicPatient.hp + a.heal * dt);
      u.medicPopupClock = (u.medicPopupClock || 0) + dt;
      if (u.medicPopupClock >= 1) {
        u.medicPopupClock -= 1;
        this.healPopups.push({ x: medicPatient.x, y: medicPatient.y, t: 0, amount: a.heal, side: u.side });
      }
    } else if (hospStruct && u.cd <= 0) {
      this._shootHospital(u, a, hospStruct);
    } else if (this.tw.on && !medicPatient && u.cd <= 0 && (towerAim = this._towerAim(u, a, focusOn ? focusType : null, !!(target && inRange)))) {
      this._shootStruct(u, a, towerAim);
    } else if (tur && inRange && u.cd <= 0) {
      this._shootTurret(u, a, tur);
    } else if (target && inRange && u.cd <= 0) {
      const wasAlive = target.hp > 0;
      this._fireAt(u, target, a, target.x, target.y);
      if (bestFocus && target === bestFocus && wasAlive && target.hp <= 0) target.focusKill = true;
      u.cd = a.cool;
    } else if (!medicPatient && !tgt && this._canShoot(a, Math.abs(enemyBase - u.x), 8) && !this._shotBlocked(a, u.x, u.y, enemyBase, u.y)) {
      if (u.cd <= 0) {
        u.baseShotAt = this.elapsed;
        const baseDmg = (a.role === 'mortar' ? a.dmg * a.baseMult : a.dmg) * this.dmgScale;
        this._baseHit(1 - u.side, baseDmg, 'other');
        this.cameraShake = Math.max(this.cameraShake, 0.28);
        this._fireAt(u, null, a, enemyBase, u.y);
        u.cd = a.cool;
        this.combatFx.push({ x: enemyBase, y: u.y, t: 0, life: 0.38, kind: 'blast', col: '#ffca83', r: 22 });
        this._log(`${a.name.toUpperCase()} damages base · ${Math.max(0, Math.ceil(this.hp[1 - u.side]))} HP`, u.side);
      }
    }
    // Keep closing to 55% of range after the first shot. Stopping at max range
    // left rifles behind a closer body, outside every shorter weapon.
    // A mortar does not close: it stands behind the tanks, outside its own minimum range.
    if (this._mortarStep(u, a, dt, terrain)) { this._zoneHeal(u, dt, zoneCounts); return; }
    if (!medicPatient && this._kiteStep(u, a, dt, terrain)) { this._zoneHeal(u, dt, zoneCounts); return; }
    // ESCORT: a healer with nobody to treat trails the nearest group instead of walking at the enemy; alone it falls back (fix/medic-seek).
    if (stance === 'ESCORT' && !medicPatient) {
      const p = this._medicGoal(u, null);
      this._medicSprint(u, p);
      if (p) {
        if (Math.hypot(p.x - u.x, p.y - u.y) > 10) this._radioMove(u, a, dt, p.x, this._fieldY(p.y), terrain);
        this._zoneHeal(u, dt, zoneCounts);
        return;
      }
    }
    if (runPast) {
      // Straight on along our lane to their base; stop once it is in reach.
      if (Math.abs(enemyBase - u.x) >= a.range + 8) this._radioMove(u, a, dt, enemyBase, this._fieldY(H / 2 + offset), terrain);
      this._zoneHeal(u, dt, zoneCounts);
      return;
    }
    if (!(medicPatient && dist < a.healRange) && !atStandoff && dist > 0) {
      const holdForBase = !tgt && Math.abs(enemyBase - u.x) < a.range + 8;
      if (!holdForBase) {
        const speed = a.speed * (u.guard ? 1.12 : 1) * (u.medicMode === 'RUSHING' ? 2.5 : 1) * 1.2 * (terrain === 'rough' ? 0.55 : 1);
        const goalX = tgt && shotClear && dist > 0 ? u.x + (tx - u.x) * Math.max(0, (dist - stand) / dist) : tx;
        const goalY = tgt && shotClear && dist > 0 ? u.y + (ty - u.y) * Math.max(0, (dist - stand) / dist) : ty;
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
    // Field hospitals replace the free regen. Flag off keeps the block below byte for byte.
    if (this.fieldHospital) {
      if (!(u.hosp && u.hosp.phase === 'heal')) { u.healing = false; u.healClock = 0; }
      return;
    }
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
    // With no enemy unit left a drone dives on their turret while it stands, then on their base.
    const base = () => {
      // TOWERS=1: a gun tower first, then the turret, then the depot, then the hospital, then the base.
      const prey = this._dronePrey(side);
      if (prey) return { x: prey.x, y: prey.y, base: true };
      const t = this.turrets[1 - side];
      return t.alive ? { x: t.x, y: t.y, base: true } : { x: side === 0 ? W - 16 : 16, y: H / 2, base: true };
    };
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

  /** TOWERS=1: what a drone with no enemy unit to hit dives on: gun tower, then turret, then depot, then hospital. Null = the base. */
  _dronePrey(side) {
    if (!this.tw.on) return null;
    const foe = 1 - side;
    const gun = this._struct(foe, 'gun');
    if (gun && gun.alive) return gun;
    const post = this._struct(foe, 'post');   // forward post (range launch flow)
    if (post && post.alive) return post;
    const t = this.turrets[foe];
    if (t && t.alive) return t;
    const dep = this._struct(foe, 'depot');
    if (dep && dep.alive) return dep;
    const h = this.hospitals && this.hospitals[foe];
    if (h && h.alive) return h;
    return null;
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
      if (this.tw.on) {
        for (const st of this._structList(1 - side)) {
          if (!st || !st.alive) continue;
          const sd = Math.hypot(st.x - u.x, st.y - u.y);
          if (sd <= a.range + st.r) {
            const k = sd > 0 ? (st.r * 0.5) / sd : 0;
            u.x = st.x + (u.x - st.x) * k; u.y = st.y + (u.y - st.y) * k;
            this._detonate(u, 1, false); return true;
          }
        }
        // Their field hospital, the last structure _dronePrey dives on before the base: contact like the gun and depot.
        // (Without this the drone reached it, found no contact, and sat on it for ever.)
        const hosp = this.hospitals && this.hospitals[1 - side];
        if (hosp && hosp.alive) {
          const hd = Math.hypot(hosp.x - u.x, hosp.y - u.y);
          if (hd <= a.range + HH.R) {
            const k = hd > 0 ? (HH.R * 0.5) / hd : 0;
            u.x = hosp.x + (u.x - hosp.x) * k; u.y = hosp.y + (u.y - hosp.y) * k;
            this._detonate(u, 1, false); return true;
          }
        }
      }
      const tur = this.turrets[1 - side];
      const td = tur.alive ? Math.hypot(tur.x - u.x, tur.y - u.y) : Infinity;
      if (td <= a.range + C.TURRET.r) {
        // Onto the turret's hull, as for a unit, so the blast catches it.
        const k = td > 0 ? (C.TURRET.r * 0.5) / td : 0;
        u.x = tur.x + (u.x - tur.x) * k; u.y = tur.y + (u.y - tur.y) * k;
        this._detonate(u, 1, false); return true;
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
    const center = a.dmg * mult * this.dmgScale;
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
    // Their field hospital inside the blast takes the splash, then armor (0: a soft target). docs/FIELD-HOSPITAL.md.
    if (this.fieldHospital && this.hospitals) {
      const hosp = this.hospitals[1 - side];
      if (hosp && hosp.alive) {
        const hd = Math.hypot(hosp.x - u.x, hosp.y - u.y);
        if (hd <= R + HH.R * 0.5) {
          const hFrac = R > 0 ? Math.min(1, hd / R) : 0;
          const hDmg = center * (1 - a.falloff * hFrac);
          if (hDmg > 0) this._damageHospital(hosp, hDmg);
        }
      }
    }
    // Their gun tower and depot inside the blast take the full splash as well (TOWERS=1).
    if (this.guns || this.depots || this.posts) this._splashStructs(1 - side, u.x, u.y, R, center, a.falloff);
    // Their turret inside the blast takes the full splash (no blast_resist, no base_mult).
    const tur = this.turrets[1 - side];
    if (tur.alive) {
      const d = Math.hypot(tur.x - u.x, tur.y - u.y);
      if (d <= R + C.TURRET.r * 0.5) {
        const frac = R > 0 ? Math.min(1, d / R) : 0;
        const dmg = center * (1 - a.falloff * frac);
        if (dmg > 0) this._damageTurret(tur, dmg);
      }
    }
    const enemyBase = side === 0 ? W - 16 : 16;
    let baseHit = 0;
    if (Math.abs(enemyBase - u.x) <= Math.max(R, a.range) + 8) {
      baseHit = center * a.baseMult;
      if (baseHit > 0) {
        this._baseHit(1 - side, baseHit, 'kamikaze');
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
    const realGx = gx, realGy = gy;
    if (u.sidestep && this.elapsed < u.sidestep.until) { gx = u.sidestep.x; gy = u.sidestep.y; }
    else if (u.sidestep) u.sidestep = null;
    const dist = Math.hypot(gx - u.x, gy - u.y);
    if (dist < 0.5) { this._watchStuck(u, realGx, realGy, a.r + 2, null); return; }
    const speed = a.speed * (u.guard ? 1.12 : 1) * (u.medicMode === 'RUSHING' ? 2.5 : 1) * 1.2 * (terrain === 'rough' ? 0.55 : 1);
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
    this._watchStuck(u, realGx, realGy, a.r + 2, way);
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
    // A healed unit with no order walks back to the zone it left, then the return ends.
    // hospReturn is only set while field hospitals are on.
    if (o.hospReturn && C.zoneOf(u.x) === o.zone) { u.radio = null; return true; }
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
      if (!this._canShoot(a, d) || this._shotBlocked(a, u.x, u.y, v.x, v.y)) continue;
      const foc = focusOn && v.type === focusType && (!fsc || fsc.zone == null || C.zoneOf(v.x) === fsc.zone);
      const b = a.bonusVs && a.bonusVs[TYPES[v.type].code];
      const score = (b ? d / b : d) - (foc ? 10000 : 0) - (goalZone != null && C.zoneOf(v.x) === goalZone ? 1000 : 0);
      if (score < fireScore) { fire = v; fireScore = score; isFocus = foc; }
    }
    // A healer on a radio order treats the most hurt ally within reach before anything else.
    let patient = null;
    if (a.role === 'healer') {
      let missing = 1;
      const aggro = MEDIC_AGGRO_SIDES[side];
      for (const v of this.units) {
        if (v === u || v.side !== side || (aggro && v.hp <= 0)) continue;
        const lost = aggro ? (v.max - v.hp >= 1 ? 100 * medicWeight(v) * (v.max - v.hp) / v.max : 0) : v.max - v.hp;
        if (lost > missing && Math.hypot(v.x - u.x, v.y - u.y) < a.healRange) { patient = v; missing = lost; }
      }
    }
    u.medicMode = patient ? 'HEALING' : '';
    u.medicTargetId = patient ? patient.id : null;
    // Medic plan on a radio order (fix/medic-seek): heal in reach (above) > seek a hurt ally > trail the group > retreat when alone.
    if (a.role === 'healer' && !patient && this._stance(u) === 'ESCORT' && o.kind !== 'fallback' && o.phase !== 'back' && !o.hospReturn) {
      const g = this._medicGoal(u, o.zone);
      this._medicSprint(u, g);
      if (g && Math.hypot(g.x - u.x, g.y - u.y) > 10) this._radioMove(u, a, dt, g.x, this._fieldY(g.y), terrain);
      return true;
    }
    const enemyBase = side === 0 ? W - 16 : 16;
    // Their turret: shot first when FOCUS TURRET is on, else when no enemy unit is in our range.
    const tur = patient ? null : this._turretInReach(u, a);
    const shootTur = !!tur && (!fire || (focusOn && focusType === 'turret'));
    // Towers (TOWERS=1): FOCUS GUN / DEPOT whenever in reach; else a gun tower or depot in reach while no enemy unit is.
    const towerSt = this.tw.on && !patient ? this._towerAim(u, a, focusOn ? focusType : null, !!fire) : null;
    // FOCUS H shoots their hospital first. A MOVE or ASSIST onto its zone shoots it when no enemy unit is in range.
    const hospStruct = this.fieldHospital && !patient
      ? this._hospitalAim(u, a, focusOn && focusType === 'hospital', !fire && o.phase !== 'back' ? goalZone : null)
      : null;
    if (patient) {
      patient.hp = Math.min(patient.max, patient.hp + a.heal * dt);
      u.medicPopupClock = (u.medicPopupClock || 0) + dt;
      if (u.medicPopupClock >= 1) {
        u.medicPopupClock -= 1;
        this.healPopups.push({ x: patient.x, y: patient.y, t: 0, amount: a.heal, side });
      }
    } else if (hospStruct) {
      if (u.cd <= 0) this._shootHospital(u, a, hospStruct);
    } else if (towerSt) {
      if (u.cd <= 0) this._shootStruct(u, a, towerSt);
    } else if (shootTur) {
      if (u.cd <= 0) this._shootTurret(u, a, tur);
    } else if (fire && u.cd <= 0) {
      const wasAlive = fire.hp > 0;
      this._fireAt(u, fire, a, fire.x, fire.y);
      if (isFocus && wasAlive && fire.hp <= 0) fire.focusKill = true;
      u.cd = a.cool;
    } else if (!fire && !this.turrets[1 - side].alive && o.kind === 'move' && C.zoneOf(u.x) === o.zone && this._canShoot(a, Math.abs(enemyBase - u.x), 8) && !this._shotBlocked(a, u.x, u.y, enemyBase, u.y)) {
      // Holding the enemy's home zone: hit their base like the normal attack does.
      if (u.cd <= 0) {
        u.baseShotAt = this.elapsed;
        const baseDmg = (a.role === 'mortar' ? a.dmg * a.baseMult : a.dmg) * this.dmgScale;
        this._baseHit(1 - side, baseDmg, 'other');
        this.cameraShake = Math.max(this.cameraShake, 0.28);
        this._fireAt(u, null, a, enemyBase, u.y);
        u.cd = a.cool;
        this.combatFx.push({ x: enemyBase, y: u.y, t: 0, life: 0.38, kind: 'blast', col: '#ffca83', r: 22 });
        this._log(`${a.name.toUpperCase()} damages base · ${Math.max(0, Math.ceil(this.hp[1 - side]))} HP`, side);
      }
    }
    if (patient) return true; // a healer stands while it treats
    // SEEK: a healer with nobody in reach goes to the most hurt ally within one zone of its order's zone and treats it
    // (RUSHING, the dotted line, like a healer with no order). Without this a MOVE / ASSIST held it in the zone, idle,
    // while a hurt ally stood 60 px past its 42 px reach. FALLBACK units walk to us, so that order is left alone.
    if (a.role === 'healer' && o.kind !== 'fallback' && o.phase !== 'back') {
      const w = this._radioPatient(u, goalZone);
      if (w) {
        u.medicMode = 'RUSHING'; u.medicTargetId = w.id; u.paceV = null;
        this._radioMove(u, a, dt, w.x, this._fieldY(w.y), terrain);
        return true;
      }
    }
    // A mortar shells from behind the tanks. MOVE does not walk it into the fight.
    if (this._mortarStep(u, a, dt, terrain)) { if (o.kind === 'move') o.held = false; return true; }
    // Movement.
    // FOCUS GUN / DEPOT: a unit within a zone of that structure, with no enemy unit to shoot, closes on it
    // (a MOVE onto the zone alone can leave a Rifle outside its reach: the lane slot is y 190, the tower y 95 / 285).
    if (this.tw.on && !fire && focusOn && (focusType === 'gun' || focusType === 'depot' || focusType === 'post') && o.kind !== 'fallback') {
      const st = this._focusStruct(u, focusType);
      if (st && st.alive && Math.abs(C.zoneOf(u.x) - C.zoneOf(st.x)) <= 1 && !this._structReach(u, a, st)) {
        const d = Math.hypot(st.x - u.x, st.y - u.y), k = d > 0 ? Math.max(0, (d - turretStandoff(a)) / d) : 0;
        this._radioMove(u, a, dt, u.x + (st.x - u.x) * k, this._fieldY(u.y + (st.y - u.y) * k), terrain);
        return true;
      }
    }
    if (o.kind === 'fallback' && o.phase === 'go') {
      const medic = U.isHealer(u.type) ? null : this._nearestHealer(u);
      o.via = medic ? this._tagOf(medic) : 'base';
      const gx = medic ? medic.x : (side === 0 ? zw / 2 : W - zw / 2);
      const gy = medic ? medic.y : u.y;
      if (Math.hypot(gx - u.x, gy - u.y) > (medic ? 24 : 12)) this._radioMove(u, a, dt, gx, gy, terrain);
      return true;
    }
    const lo = goalZone * zw, hi = lo + zw;
    const uz = C.zoneOf(u.x);
    // A MOVE slot (set when the order was given): walk in our lane, hold our spot in the formation.
    const slot = o.kind === 'move' && o.phase !== 'back' && o.sy != null ? o : null;
    // Engage: an enemy in our zone (holding it), or a ground enemy close by on the way or just past
    // the zone. Without this a short-range unit walked past a fight to its slot and stood there.
    const stance = this._stance(u);
    // CHARGE: whoever just hit us is the chase, inside or outside the post zone (up to the leash).
    const charged = o.phase === 'back' ? null : this._chargeTarget(u);
    const leashed = charged && Math.abs(C.zoneOf(charged.x) - goalZone) <= Math.ceil(ST.CHARGE_LEASH_ZONES) ? charged : null;
    // RUN: on the way to the goal zone nothing stops us (we still shoot in passing, above).
    const running = stance === 'RUN' && uz !== goalZone;
    let chase = o.phase === 'back' || running ? null : (leashed || this._engagePick(u, a, enemies, goalZone));
    // Pace: on a MOVE, ranged units and healers do not walk ahead of the group's front-liners, on
    // the way or closing on an enemy (they still shoot whatever is in range, above).
    // Pacing is a speed match (u.paceV caps our forward speed in _radioMove), never a stop-and-wait:
    // a follower that stood still in the lane made everyone behind it weave round it.
    u.paceV = null;
    if (o.phase !== 'back' && this._kiteStep(u, a, dt, terrain)) { if (slot) slot.held = false; return true; }
    if (o.kind === 'move' && o.phase !== 'back' && !running && (uz !== goalZone || chase) && this._paceHold(u, o)) {
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
    const stand = stance === 'KITE' ? Math.max(standoffOf(a, u, chase), a.range * ST.KITE_STAND) : standoffOf(a, u, chase);
    if (clear && chaseD <= stand) return true;
    let gx = chase.x, gy = chase.y;
    if (clear && chaseD > 0) {
      const k = (chaseD - stand) / chaseD;
      gx = u.x + (chase.x - u.x) * k; gy = u.y + (chase.y - u.y) * k;
    }
    // Holding: chase inside the zone, or up to half a zone past its edge after a close enemy.
    // CHARGE on the one who hit us: up to CHARGE_LEASH_ZONES past the edge, then the normal walk back.
    const pad = chase === leashed && leashed ? zw * ST.CHARGE_LEASH_ZONES : zw / 2;
    if (uz === goalZone || chase === leashed) gx = Math.max(lo + 4 - pad, Math.min(hi - 4 + pad, gx));
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
    let near = false;
    for (const v of this.units) if (v.side !== u.side && v.hp > 0 && grounded(v) && Math.hypot(v.x - u.x, v.y - u.y) < PACE_NEAR) { near = true; break; }
    // Oct 14: on the march (no enemy within PACE_NEAR) a slow Breaker does not hold the push back; only a
    // fast front-liner paces it, and the Breakers follow. In contact the Breaker leads again, as before.
    const lead = near ? (armor || fast) : fast;
    if (!lead) return false;
    const ahead = (u.x - lead.x) * dir;
    if (ahead >= PACE_MAX) return false;
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
    // Their turret first: close to our standoff from it, then the base.
    const t = this.turrets[1 - u.side];
    if (t.alive) {
      const d = Math.hypot(t.x - u.x, t.y - u.y);
      if (d <= turretStandoff(a) && !this._lineBlocked(u.x, u.y, t.x, t.y)) return;
      const k = d > 0 ? Math.max(0, (d - turretStandoff(a)) / d) : 0;
      this._radioMove(u, a, dt, u.x + (t.x - u.x) * k, this._fieldY(u.y + (t.y - u.y) * k), terrain);
      return;
    }
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
    const byRank = [0, 1, 2, 3].map(r => ground.filter(u => slotRank(u.type) === r)).filter(l => l.length);
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

  /** The most hurt ally of a healer on a radio order, within one zone of the order's zone, not walking to a hospital. Null if none. */
  _radioPatient(medic, goalZone) {
    let best = null, missing = 1;
    for (const v of this.units) {
      if (v === medic || v.side !== medic.side || v.hosp || v.hp <= 0) continue;
      const lost = v.max - v.hp;
      if (lost > missing && Math.abs(C.zoneOf(v.x) - goalZone) <= 1) { best = v; missing = lost; }
    }
    return best;
  }

  /**
   * Where an ESCORT medic with nobody in heal reach goes (fix/medic-seek). `zone` = its order zone or null.
   * 2. Seek: the most hurt ally (lost >= MEDIC_SEEK_PCT) within MEDIC_SEEK_R px, not past zone+1, and not where the
   *    enemies near it outnumber our units near it. 3. Trail the nearest group (capped at the order zone).
   * 4. Retreat to the nearest safe standing post, else the base edge, when no group exists or when hit lately
   *    with no ally close. Returns {x, y, why}.
   */
  _medicGoal(u, zone) {
    const side = u.side, dir = side === 0 ? 1 : -1, zw = W / C.ZONES, R = MEDIC_NEAR_R;
    const near = (x, y, sd) => this.units.filter(v => v.side === sd && v.hp > 0 && v !== u && Math.hypot(v.x - x, v.y - y) < R).length;
    const capX = zone == null ? null : (Math.min(7, Math.max(0, zone + dir)) + (side === 0 ? 1 : 0)) * zw;
    const aggro = MEDIC_AGGRO_SIDES[side];
    const pct = aggro ? MEDIC_AGGRO_PCT : MEDIC_SEEK_PCT, seekR = aggro ? MEDIC_AGGRO_R : MEDIC_SEEK_R, odds = aggro ? MEDIC_AGGRO_ODDS : 1;
    let best = null, bestLost = 0;
    for (const v of this.units) {
      if (v === u || v.side !== side || v.hp <= 0 || U.isHealer(v.type)) continue;
      const lost = (v.max - v.hp) / v.max;
      if (lost < pct || Math.hypot(v.x - u.x, v.y - u.y) > seekR) continue;
      if (capX != null && (v.x - capX) * dir > 0) continue;
      if (near(v.x, v.y, 1 - side) > near(v.x, v.y, side) + odds) continue;   // the hurt unit itself counts as ours
      const score = aggro ? lost * medicWeight(v) : lost;
      if (score > bestLost) { best = v; bestLost = score; }
    }
    if (best) return { x: best.x - dir * 14, y: best.y, why: 'seek', id: best.id };
    const p = aggro ? this._frontPoint(u) : this._escortPoint(u);
    const hitLately = u.hitAt != null && this.elapsed - u.hitAt < 2;
    const allyClose = this.units.some(v => v !== u && v.side === side && v.hp > 0 && !U.isHealer(v.type) && Math.hypot(v.x - u.x, v.y - u.y) < R);
    if (p && !(hitLately && !allyClose)) {
      const cap = zone == null ? null : (zone + (aggro ? (side === 0 ? 1 : 0) : 0.5)) * zw;
      return { x: cap != null && (p.x - cap) * dir > 0 ? cap : p.x, y: p.y, why: 'trail' };
    }
    // Retreat: the nearest safe standing post behind us (never toward the enemy), else our base edge; wait there for new units.
    let home = { x: side === 0 ? 30 : W - 30, y: H / 2 };
    let hd = Math.abs(home.x - u.x);
    for (const q of this._postsOf(side)) {
      if (!this._postSafe(q) || (q.x - u.x) * dir > 0) continue;
      const d = Math.abs(q.x - u.x); if (d < hd) { hd = d; home = { x: q.x - dir * (q.r + 8), y: q.y }; }
    }
    return { x: home.x, y: home.y, why: 'retreat' };
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
    if (target) { u.firedAt = this.elapsed; target.hitAt = this.elapsed; target.hitById = u.id; target.hitByAt = this.elapsed; }
    const heavy = a.role === 'armor';
    const mortar = a.role === 'mortar';
    const col = a.role === 'fast' ? (u.side === 0 ? '#d8ffb5' : '#ffd0bc') : a.color;
    const life = mortar ? MORTAR_FLIGHT : heavy ? 0.24 : a.role === 'ranged' ? 0.15 : 0.10;
    this.shots.push({ x: u.x, y: u.y, tx, ty, type: u.type, side: u.side, col, life, maxLife: life, ...(a.indirect ? { arc: true } : {}) });
    if (mortar) this.combatFx.push({ x: u.x, y: u.y, t: 0, life: 0.36, kind: 'mortarLaunch', col, r: 28 });
    else this.combatFx.push({ x: u.x, y: u.y, t: 0, life: 0.13, kind: 'muzzle', col, r: heavy ? 10 : 6 });
    if (target) {
      if (U.isKamikaze(target.type)) target.downBy = a.code; // the shot-down note names the last shooter
      const b = a.bonusVs && a.bonusVs[TYPES[target.type] ? TYPES[target.type].code : ''];
      const dealt = (b ? a.dmg * b : a.dmg) * this.dmgScale;
      const was = target.hp;
      target.hp -= dealt;
      target.hitFlash = 0.19;
      const d = Math.hypot(target.x - u.x, target.y - u.y) || 1;
      const k = heavy ? 64 : 22;
      target.kx = (target.kx || 0) + (target.x - u.x) / d * k;
      target.ky = (target.ky || 0) + (target.y - u.y) / d * k;
      // The mortar's impact is the delayed splash ring from _shellSplash, so the shell can arrive first.
      if (!mortar) this.combatFx.push({ x: target.x, y: target.y, t: 0, life: heavy ? 0.38 : 0.22, kind: heavy ? 'blast' : 'impact', col: heavy ? a.color : '#f8efcc', r: heavy ? 23 : 12 });
      this._sparks(target.x, target.y, col, heavy ? 9 : 5);
      if (a.role === 'mortar' && was > 0 && target.hp <= 0) this.shells[u.side].kills++;
    }
    if (a.role === 'mortar') this.shells[u.side].shots++;
    if (a.splash > 0 && a.role !== 'kamikaze') this._shellSplash(u, a, tx, ty, target);
  }

  /**
   * Splash at a shell's impact. The unit aimed at already took the center hit in _fireAt.
   * Everyone else in the radius takes the same damage, falling off to the edge.
   * friendly_fire off (the mortar) skips our own units: the blast is on the enemy the tube
   * is shelling, and the tanks screening it are often inside a wide radius.
   */
  _shellSplash(u, a, tx, ty, primary) {
    const center = a.dmg * this.dmgScale;
    for (const v of this.units) {
      if (v === u || v === primary || v.hp <= 0) continue;
      if (v.side === u.side && !a.friendlyFire) continue;
      const t = TYPES[v.type];
      const d = Math.hypot(v.x - tx, v.y - ty);
      if (d > a.splash + t.r * 0.5) continue;
      const frac = a.splash > 0 ? Math.min(1, d / a.splash) : 0;
      const dmg = center * (1 - a.falloff * frac) * (1 - (t.blastResist || 0));
      if (!(dmg > 0)) continue;
      const was = v.hp;
      v.hp -= dmg;
      v.hitAt = this.elapsed; v.hitFlash = 0.22;
      if (a.role === 'mortar' && v.side !== u.side) {
        this.shells[u.side].splash++;
        if (was > 0 && v.hp <= 0) this.shells[u.side].kills++;
      }
    }
    // delay is the shell's flight. The painter draws an incoming marker until then, then a ring at
    // the splash radius and a scorch that fades over the rest of the life (about a second).
    if (a.role === 'mortar') this.combatFx.push({ x: tx, y: ty, t: 0, life: MORTAR_FLIGHT + MORTAR_SCORCH, delay: MORTAR_FLIGHT, kind: 'mortar', col: a.color, r: a.splash });
  }

  // ---- Base turret (C.TURRET) ----

  _newTurret(side) {
    const T = C.TURRET;
    const hp = this.turretsOn !== false && T.hp > 0 ? T.hp : 0;
    return {
      side, x: side === 0 ? T.dx : W - T.dx, y: H / 2, hp, max: hp, alive: hp > 0,
      cd: 0, aimId: null, aimX: null, aimY: null, angle: side === 0 ? 0 : Math.PI,
      firedAt: null, hitAt: null, hitFlash: 0, downAt: null,
    };
  }

  /** Their turret when it is alive, within our range and in clear line, else null. */
  _turretInReach(u, a) {
    const t = this.turrets && this.turrets[1 - u.side];
    if (!t || !t.alive) return null;
    if (!this._canShoot(a, Math.hypot(t.x - u.x, t.y - u.y), C.TURRET.r * 0.5)) return null;
    return this._shotBlocked(a, u.x, u.y, t.x, t.y) ? null : t;
  }

  /**
   * The turret as a unit's target (normal pick), or null. FOCUS TURRET: whenever it is in reach.
   * No enemy unit to go for: walk at it (it stands in front of their base, so it comes before the base).
   * Our target out of our range and the turret in reach: shoot it meanwhile.
   */
  _turretTarget(u, a, target, focusTurret) {
    const t = this.turrets && this.turrets[1 - u.side];
    if (!t || !t.alive) return null;
    const reach = this._turretInReach(u, a);
    if (focusTurret && reach) return t;
    if (!target) return t;
    if (reach && Math.hypot(target.x - u.x, target.y - u.y) >= a.range) return t;
    return null;
  }

  /** u fires one shot at turret t. */
  _shootTurret(u, a, t) {
    u.firedAt = this.elapsed;
    this._fireAt(u, null, a, t.x, t.y);
    const heavy = a.role === 'armor';
    this.combatFx.push({ x: t.x, y: t.y, t: 0, life: heavy ? 0.38 : 0.22, kind: heavy ? 'blast' : 'impact', col: heavy ? a.color : '#f8efcc', r: heavy ? 23 : 12 });
    this._damageTurret(t, a.dmg * this.dmgScale);
    u.cd = a.cool;
  }

  /** Damage to a turret. At 0 HP it is down for the rest of the match (no repair). */
  _damageTurret(t, dmg) {
    if (!t.alive || !(dmg > 0)) return;
    this._structHit(t, 'turret', Math.min(t.hp, dmg));
    t.hp -= dmg;
    t.hitAt = this.elapsed; t.hitFlash = 0.19;
    if (this.commState) this.commState[t.side].turretHit = true;
    if (t.hp > 0) return;
    t.hp = 0; t.alive = false; t.downAt = this.elapsed; t.aimId = null;
    this.combatFx.push({ x: t.x, y: t.y, t: 0, life: 0.9, kind: 'turretDown', col: TEAM[t.side].color, r: 34 });
    this._sparks(t.x, t.y, '#ffca83', 14);
    this.cameraShake = Math.max(this.cameraShake, 0.32);
    this._log(`${TEAM[t.side].log} turret destroyed`, 1 - t.side);
    if (this.phase === 'live' && this.commState) for (const cs of this.commState) cs.turretDown.push(t.side);
  }

  /**
   * One step of a base turret. Stops for good when it or its base is down. Target: an enemy that hit
   * our base in the last 2 s, then the nearest ground enemy (clear line), then the nearest Drone.
   * A new target after none waits C.TURRET.firstShot before the first shot.
   */
  _stepTurret(t, dt, enemies) {
    const T = C.TURRET;
    t.hitFlash = Math.max(0, (t.hitFlash || 0) - dt);
    if (!t.alive || this.hp[t.side] <= 0 || this.over) { t.aimId = null; return; }
    t.cd -= dt;
    let best = null, bestScore = Infinity;
    for (const v of enemies) {
      if (v.hp <= 0 || v.spawnShield > 0) continue;
      const d = Math.hypot(v.x - t.x, v.y - t.y);
      if (d >= this._rangeOf(t.side, 'turret', T.range) + TYPES[v.type].r * 0.5) continue;
      const air = !grounded(v);
      if (!air && this._lineBlocked(t.x, t.y, v.x, v.y)) continue;
      const cat = v.baseShotAt != null && this.elapsed - v.baseShotAt < 2 ? 0 : air ? 2 : 1;
      const score = cat * 10000 + d;
      if (score < bestScore) { best = v; bestScore = score; }
    }
    if (!best) { t.aimId = null; t.aimX = null; t.aimY = null; return; }
    if (t.aimId == null) t.cd = Math.max(t.cd, T.firstShot);
    t.aimId = best.id; t.aimX = best.x; t.aimY = best.y;
    t.angle = Math.atan2(best.y - t.y, best.x - t.x);
    if (t.cd > 0) return;
    const far = this.rangeRounds && this.rangeRounds[t.side].turret > 0 && Math.hypot(best.x - t.x, best.y - t.y) >= T.range + TYPES[best.type].r * 0.5;
    t.cd = T.cool; t.firedAt = this.elapsed; this._useRound(t.side, 'turret');
    const col = TEAM[t.side].color;
    this.shots.push({ x: t.x, y: t.y, tx: best.x, ty: best.y, type: 'turret', side: t.side, col, life: 0.15, maxLife: 0.15 });
    this.combatFx.push({ x: t.x + Math.cos(t.angle) * 14, y: t.y + Math.sin(t.angle) * 14, t: 0, life: 0.13, kind: 'muzzle', col, r: 8 });
    if (U.isKamikaze(best.type)) best.downBy = 'turret';
    best.hp -= T.dmg;
    if (far) this._farShot(t.side, 'turret', best);
    best.hitAt = this.elapsed; best.hitFlash = 0.19;
    const d = Math.hypot(best.x - t.x, best.y - t.y) || 1;
    best.kx = (best.kx || 0) + (best.x - t.x) / d * 22;
    best.ky = (best.ky || 0) + (best.y - t.y) / d * 22;
    this.combatFx.push({ x: best.x, y: best.y, t: 0, life: 0.22, kind: 'impact', col: '#f8efcc', r: 12 });
    this._sparks(best.x, best.y, col, 5);
  }

  /** Turret for the report and the frame: HP, or null once down (or off). */
  _turretHp(side) {
    const t = this.turrets && this.turrets[side];
    return t && t.alive ? Math.max(0, Math.ceil(t.hp)) : null;
  }

  // ---- Towers (src/agrts/towers.js). Gun tower now; the depot follows the same entity shape. ----

  _newGun(side) {
    const spot = TW.place('gun', side, (x, y) => this._wallOverlap(x, y, TW.GUN_R + 4));
    const hp = this.tw.gunHp;
    return {
      kind: 'gun', side, x: spot.x, y: spot.y, zone: spot.zone, r: TW.GUN_R, hp, max: hp, alive: true,
      cd: 0, aimId: null, aimX: null, aimY: null, angle: side === 0 ? 0 : Math.PI, firedAt: null, hitAt: null, hitFlash: 0, downAt: null,
    };
  }

  _newDepot(side) {
    const spot = TW.place('depot', side, (x, y) => this._wallOverlap(x, y, TW.DEPOT_R + 4));
    const hp = this.tw.depotHp;
    return {
      kind: 'depot', side, x: spot.x, y: spot.y, zone: spot.zone, r: TW.DEPOT_R, hp, max: hp, alive: true,
      rebuild: 0, costWait: false, hitAt: null, hitFlash: 0, downAt: null,
    };
  }

  /**
   * Depot rebuild, the field hospital's mechanic: down for DEPOT_REBUILD_S, then DEPOT_REBUILD_CR is paid from the
   * bank when the timer ends (it waits, `costWait`, while the bank is short). The shield and the half of the base
   * income come back with it. DEPOT_REBUILD_S=0 means it never rebuilds.
   */
  _stepDepots(dt) {
    const tw = this.tw;
    for (const d of this.depots) {
      d.hitFlash = Math.max(0, (d.hitFlash || 0) - dt);
      if (d.alive || this.over || !(tw.depotRebuildS > 0)) continue;
      if (d.rebuild > 0) d.rebuild -= dt;
      if (d.rebuild > 0) continue;
      d.rebuild = 0;
      if (this.fieldCredits[d.side] >= tw.depotRebuildCr) {
        this.fieldCredits[d.side] -= tw.depotRebuildCr;
        d.alive = true; d.hp = d.max; d.downAt = null; d.costWait = false;
        this._log(`${TEAM[d.side].log} depot rebuilt${tw.depotRebuildCr > 0 ? ` · −${tw.depotRebuildCr} CR` : ''} · base shield up`, d.side);
      } else if (!d.costWait) {
        d.costWait = true;
        this._log(`${TEAM[d.side].log} depot ready · needs ${tw.depotRebuildCr} CR`, d.side);
      }
    }
  }

  // ---- Forward posts (docs/FORWARD-POST.md). Only when `this.posts` is set (the range's launch flow); null = off, the old sim. ----
  /** A side's (not yet built) forward post A or B. Each has a fixed zone (post_a_zone / post_b_zone, Green numbering; Red mirrors 9 - z). */
  _newPost(side, slot) {
    const hp = RULES.value('post_hp'), gz = RULES.value(slot === 'B' ? 'post_b_zone' : 'post_a_zone') - 1, fz = side === 0 ? gz : 7 - gz;
    return { kind: 'post', side, slot, fz, x: 0, y: 0, zone: fz, r: POST_R, hp: 0, max: hp, alive: false, prog: 0, buildZone: null, cool: 0, hitAt: null, hitFlash: 0, downAt: null };
  }
  /** Where a post stands in zone z: just behind mid-zone (away from the front). A sits off the midline away from its gun tower
   * (Green top, Ember bottom); B sits in the other half (Green lower lane, Ember upper), mirrored. */
  _postSpot(side, z, slot) {
    const top = (side === 0) === (slot !== 'B');
    const zw = W / 8, x0 = side === 0 ? z * zw + zw * 0.38 : (z + 1) * zw - zw * 0.38, y0 = top ? 120 : H - 120;
    for (let rad = 0; rad <= 60; rad += 6) for (let i = 0; i < (rad ? 12 : 1); i++) {
      const x = Math.max(z * zw + 18, Math.min((z + 1) * zw - 18, x0 + Math.cos(i / 12 * Math.PI * 2) * rad)), y = this._fieldY(y0 + Math.sin(i / 12 * Math.PI * 2) * rad);
      if (!this._wallOverlap(x, y, POST_R + 4)) return { x, y };
    }
    return { x: x0, y: y0 };
  }
  /** Build timers, each post on its own: its fixed zone and the next post_unlock_offset zone(s) toward the enemy held (land past 0.35), no enemy ground unit in the post zone, for post_build_s. */
  _stepPosts(dt) {
    const need = RULES.value('post_build_s');
    for (const p of this.posts) {
      p.hitFlash = Math.max(0, (p.hitFlash || 0) - dt);
      if (p.alive || this.over) continue;
      if (p.cool > 0) { p.cool = Math.max(0, p.cool - dt); continue; }
      const side = p.side, z = p.fz;
      const own = zz => zz >= 0 && zz < 8 && (side === 0 ? this.land[zz] : -this.land[zz]) > 0.35;
      // Unlock rule (docs/FORWARD-POST.md): the post zone AND every zone up to post_unlock_offset beyond it (toward the enemy) must be held.
      const off = RULES.value('post_unlock_offset'), dir = side === 0 ? 1 : -1;
      let held = own(z); for (let k = 1; held && k <= off; k++) held = own(z + dir * k);
      const contested = held && this.units.some(v => v.side !== side && v.hp > 0 && grounded(v) && C.zoneOf(v.x) === z);
      // Unlock (docs/FORWARD-POST.md): the first moment the unlock rule holds while the post is down. Fires once until the zone is lost again.
      if (!held) p.unlocked = false;
      else if (!p.unlocked) { p.unlocked = true; p.unlockAt = this.elapsed; const sp = this._postSpot(side, z, p.slot); (this.postEvents = this.postEvents || []).push({ kind: 'unlock', side, slot: p.slot, zone: z, x: sp.x, y: sp.y }); }
      if (!held || contested) { p.prog = 0; p.buildZone = null; continue; }
      if (p.buildZone !== z) { const sp = this._postSpot(side, z, p.slot); p.buildZone = z; p.prog = 0; p.x = sp.x; p.y = sp.y; p.zone = z; }
      p.prog += dt;
      // Field runner: one of the side's Scouts (role fast) in the post zone cuts the build to scout_post_build_s (docs/SCOUT.md).
      const runner = this.units.some(v => v.side === side && v.hp > 0 && grounded(v) && U.roleOf(v.type) === 'fast' && C.zoneOf(v.x) === z);
      p.need = runner ? Math.min(need, RULES.value('scout_post_build_s')) : need;
      if (p.prog >= p.need) {
        (this.postEvents = this.postEvents || []).push({ kind: 'ready', side, slot: p.slot, zone: z, x: p.x, y: p.y });
        p.alive = true; p.hp = p.max; p.prog = 0; p.downAt = null; p.hitAt = null;
        this._sparks(p.x, p.y, TEAM[side].color, 10);
        this._log(`${TEAM[side].log} forward post ${p.slot} up in z${p.zone + 1}`, side);
      }
    }
  }
  /** Where a newly fielded unit appears: the side's most forward standing post (B, else A; a little in front of it, lane spread squeezed), else the base edge. */
  _spawnPoint(side, y) {
    const p = this.posts && !this._postOff && this._safePost(side);
    if (p) return { x: this._fieldX(p.x + (side === 0 ? 1 : -1) * (p.r + 10)), y: this._fieldY(p.y + (y - H / 2) * 0.25), post: true, slot: p.slot };
    return { x: side === 0 ? 23 : W - 23, y, post: false };
  }

  /** Depot HP for the report and the frame: HP, `null` once down; undefined when the match has none. `-0` shows as `-`. */
  _depotHp(side) {
    if (!this.depots) return undefined;
    const t = this.depots[side];
    return t.alive ? Math.max(0, Math.ceil(t.hp)) : null;
  }

  /** A side's structure of this kind (gun | depot), or null when it does not exist in this match. */
  _struct(side, kind) {
    if (kind === 'post') return this._postMain(side);
    const list = kind === 'gun' ? this.guns : kind === 'depot' ? this.depots : null;
    return list ? list[side] : null;
  }
  /** Every gun tower / depot / forward post of a side (drone contact, blast splash). */
  _structList(side) {
    const out = [];
    for (const k of ['gun', 'depot']) { const t = this._struct(side, k); if (t) out.push(t); }
    return out.concat(this._postsOf(side));
  }
  /** A side's forward posts, A then B ([] when the match has none). */
  _postsOf(side) { return this.posts ? this.posts.filter(p => p.side === side) : []; }
  /** Safe-spawn (docs/SAFE-SPAWN.md): is this standing post safe to field at? No enemy ground unit within spawn_safe_radius, no damage in the last spawn_safe_hit_s. */
  _postSafe(p) {
    if (!p || !p.alive) return false;
    if (p.hitAt != null && this.elapsed - p.hitAt < RULES.value('spawn_safe_hit_s')) return false;
    const r = RULES.value('spawn_safe_radius');
    return !this.units.some(u => u.side !== p.side && u.hp > 0 && grounded(u) && Math.hypot(u.x - p.x, u.y - p.y) < r);
  }
  /** The furthest-forward safe standing post (FOB, then OB), or null = Main. Same rule for both sides. */
  _safePost(side) {
    const up = this._postsOf(side).filter(p => p.alive).sort((p, q) => (side === 0 ? q.fz - p.fz : p.fz - q.fz));
    return up.find(p => this._postSafe(p)) || null;
  }
  /** A side's "main" post: the most forward standing one (B before A), else A. Spawns, drone dives, the commander brief. */
  _postMain(side) {
    const ps = this._postsOf(side);
    if (!ps.length) return null;
    const up = ps.filter(p => p.alive).sort((p, q) => (side === 0 ? q.fz - p.fz : p.fz - q.fz));
    return up[0] || ps[0];
  }
  /** The nearest of their standing posts u can shoot, or null. */
  _postReach(u, a, foe) {
    let best = null, bd = Infinity;
    for (const p of this._postsOf(foe)) {
      const r = this._structReach(u, a, p);
      if (!r) continue;
      const d = Math.hypot(p.x - u.x, p.y - u.y);
      if (d < bd) { best = r; bd = d; }
    }
    return best;
  }
  /** The structure a FOCUS walks at: their gun tower / depot, or the nearest of their standing posts. */
  _focusStruct(u, kind) {
    if (kind !== 'post') return this._struct(1 - u.side, kind);
    let best = null, bd = Infinity;
    for (const p of this._postsOf(1 - u.side)) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - u.x, p.y - u.y);
      if (d < bd) { best = p; bd = d; }
    }
    return best;
  }

  /** Their structure when alive, within our range and in clear line, else null. */
  _structReach(u, a, t) {
    if (!t || !t.alive || t.building > 0) return null;
    if (!this._canShoot(a, Math.hypot(t.x - u.x, t.y - u.y), t.r * 0.5)) return null;
    return this._shotBlocked(a, u.x, u.y, t.x, t.y) ? null : t;
  }

  /**
   * The gun tower or depot a unit shoots this step, or null. FOCUS GUN / FOCUS DEPOT: that structure whenever in
   * reach. No focus: only while no enemy unit is in our range (`enemyInRange`), the gun tower first, then the
   * depot unless their base turret is in reach (it comes first). Unit targets always come before structures.
   */
  _towerAim(u, a, focusType, enemyInRange) {
    const foe = 1 - u.side;
    if (focusType === 'post') { const t = this._postReach(u, a, foe); if (t) return t; }
    if (focusType === 'gun' || focusType === 'depot') {
      const t = this._structReach(u, a, this._struct(foe, focusType));
      if (t) return t;
      if (focusType === 'gun') { const x = this._extraReach(u, a, foe); if (x) return x; }
    }
    if (enemyInRange) return null;
    const gun = this._structReach(u, a, this._struct(foe, 'gun'));
    if (gun) return gun;
    const xgun = this._extraReach(u, a, foe);
    if (xgun) return xgun;
    const post = this._postReach(u, a, foe);
    if (post) return post;
    if (this._turretInReach(u, a)) return null;
    return this._structReach(u, a, this._struct(foe, 'depot'));
  }

  /** The nearest built bought tower of side `foe` that u can shoot, or null. */
  _extraReach(u, a, foe) {
    if (!this.extraGuns || !this.extraGuns[foe].length) return null;
    let best = null, bd = Infinity;
    for (const t of this.extraGuns[foe]) {
      const r = this._structReach(u, a, t);
      if (!r) continue;
      const d = Math.hypot(t.x - u.x, t.y - u.y);
      if (d < bd) { best = r; bd = d; }
    }
    return best;
  }

  /** u fires one shot at a tower structure. */
  _shootStruct(u, a, t) {
    u.firedAt = this.elapsed;
    this._fireAt(u, null, a, t.x, t.y);
    const heavy = a.role === 'armor';
    this.combatFx.push({ x: t.x, y: t.y, t: 0, life: heavy ? 0.38 : 0.22, kind: heavy ? 'blast' : 'impact', col: heavy ? a.color : '#f8efcc', r: heavy ? 23 : 12 });
    this._damageStruct(t, a.dmg * this.dmgScale);
    u.cd = a.cool;
  }

  /** Damage to a gun tower or depot. At 0 HP it is down: its owner pays, the attacker is paid (_towerDown). */
  _damageStruct(t, dmg) {
    if (!t || !t.alive || !(dmg > 0) || t.building > 0) return;
    if (!t.extra) this._structHit(t, t.kind || 'gun', Math.min(t.hp, dmg));
    t.hp -= dmg;
    t.hitAt = this.elapsed; t.hitFlash = 0.19;
    if (t.hp > 0) return;
    t.hp = 0; t.alive = false; t.downAt = this.elapsed; t.aimId = null;
    if (t.kind === 'depot') { t.rebuild = this.tw.depotRebuildS; t.costWait = false; }
    this.combatFx.push({ x: t.x, y: t.y, t: 0, life: 0.9, kind: t.kind === 'gun' ? 'turretDown' : 'blast', col: TEAM[t.side].color, r: t.kind === 'gun' ? 30 : 34 });
    this._sparks(t.x, t.y, '#ffca83', 14);
    this.cameraShake = Math.max(this.cameraShake, 0.3);
    if (t.kind === 'depot') this._log(`${TEAM[t.side].log} depot destroyed · base shield down`, 1 - t.side);
    if (t.kind === 'post') { // forward post: spawns go back to the base; rebuild after post_rebuild_s. Team HP is the per-damage rule only.
      t.cool = RULES.value('post_rebuild_s'); t.prog = 0; t.buildZone = null;
      this._log(`${TEAM[t.side].log} forward post ${t.slot || ''} destroyed in z${t.zone + 1}`, 1 - t.side);
      return;
    }
    if (t.extra) { // a bought tower: only a small bounty, no Team HP, no tie-break points, no rebuild
      const b = this.tw.buyBounty;
      if (b > 0) { this.fieldCredits[1 - t.side] += b; this._spend(1 - t.side); }
      this._log(`${TEAM[1 - t.side].log} destroys a tower in z${t.zone + 1}${b > 0 ? ` · +${b} CR` : ''}`, 1 - t.side);
      return;
    }
    this._towerDown(t.kind, t.side, t.zone + 1);
  }

  /** Splash from a blast at (x, y) on a side's gun tower and depot. Full damage, no resist (like the turret). */
  _splashStructs(side, x, y, R, center, falloff) {
    for (const t of this._structList(side)) {
      if (!t || !t.alive) continue;
      const d = Math.hypot(t.x - x, t.y - y);
      if (d > R + t.r * 0.5) continue;
      const dmg = center * (1 - falloff * (R > 0 ? Math.min(1, d / R) : 0));
      if (dmg > 0) this._damageStruct(t, dmg);
    }
    if (this.extraGuns) for (const t of this.extraGuns[side]) {
      if (!t.alive || t.building > 0) continue;
      const d = Math.hypot(t.x - x, t.y - y);
      if (d > R + t.r * 0.5) continue;
      const dmg = center * (1 - falloff * (R > 0 ? Math.min(1, d / R) : 0));
      if (dmg > 0) this._damageStruct(t, dmg);
    }
  }

  /** A structure's range now: boosted while a BUY RANGE is running for that side and target. */
  _rangeOf(side, kind, base) {
    return this.rangeRounds && this.rangeRounds[side][kind] > 0 ? base * (1 + this.tw.rangePct / 100) : base;
  }

  /**
   * Rounds one purchase gives a weapon: RANGE_BUY_S seconds of that weapon's own fire, i.e. round(RANGE_BUY_S / its cooldown), so a boost is worth the same
   * time on the gun tower (RANGE_BUY_ROUNDS_GUN overrides) and on the base turret (RANGE_BUY_ROUNDS_TURRET overrides) however the cooldowns are tuned.
   */
  _roundsFor(kind) {
    const tw = this.tw, ov = kind === 'gun' ? tw.rangeRoundsGun : tw.rangeRoundsTurret;
    if (ov > 0) return Math.round(ov);
    const cool = kind === 'gun' ? tw.gunCool : C.TURRET.cool;
    return Math.max(1, Math.round(tw.rangeS / (cool > 0 ? cool : 1)));
  }

  /** A boosted structure fired: one round used (every shot counts, near or far); the boost ends at 0 rounds. */
  _useRound(side, kind) {
    if (this.rangeRounds && this.rangeRounds[side][kind] > 0) this.rangeRounds[side][kind]--;
  }

  /** A boosted shot beyond the normal reach landed (BUY RANGE): counted per side (rangeFar: shots, kills); a kill is logged. */
  _farShot(side, kind, v) {
    if (!this.rangeFar) this.rangeFar = [{ shots: 0, kills: 0 }, { shots: 0, kills: 0 }];
    this.rangeFar[side].shots++;
    if (v.hp <= 0) { this.rangeFar[side].kills++; this._log(`${TEAM[side].log} ${kind === 'gun' ? 'tower' : 'turret'} boosted shot downs ${this._tagOf(v)}`, side); }
  }

  /** Rounds left on a side's gun tower(s) plus base turret, for the report (rng token); undefined when BUY RANGE is off. */
  _rangeLeft(side) {
    if (!this.tw.on || !this.tw.rangeBuy || !this.rangeRounds) return undefined;
    return this.rangeRounds[side].gun + this.rangeRounds[side].turret;
  }

  /**
   * BUY RANGE [TOWER|TURRET|ALL] (RANGE_BUY on): our gun tower(s) and/or base turret reach RANGE_BUY_PCT further for a number of ROUNDS (see _roundsFor): every shot they fire while boosted uses one round (near or far), the boost ends at 0.
   * ALL = RANGE_BUY_CR, one target 70% of it. A running boost cannot be topped up (re-buy at 0 rounds), optional cooldown RANGE_BUY_COOL_S (default 0),
   * RANGE_BUY_MAX purchases a match; a target that is down cannot be boosted. Match live only. No Team HP, no tie-break effect.
   */
  _buyRange(side, parsed) {
    const tw = this.tw;
    if (!tw.on || !tw.rangeBuy || !this.guns) return this._refuse(side, parsed, 'unknown unit RANGE');
    if (this.phase !== 'live') return this._refuse(side, parsed, 'RANGE can be bought once the match is live');
    if (this.rangeBuys[side] >= tw.rangeMax) return this._refuse(side, parsed, `range limit ${tw.rangeMax} a match`);
    const want = parsed.what === 'all' ? ['gun', 'turret'] : [parsed.what];
    const alive = k => (k === 'gun' ? this.guns[side].alive || this.extraGuns[side].some(g => g.alive) : !!(this.turrets && this.turrets[side] && this.turrets[side].alive));
    const ok = [];
    for (const k of want) {
      if (!alive(k)) { if (want.length === 1) return this._refuse(side, parsed, `${k === 'gun' ? 'gun tower' : 'turret'} is down`); continue; }
      if (this.rangeRounds[side][k] > 0) { if (want.length === 1) return this._refuse(side, parsed, `${k === 'gun' ? 'tower' : 'turret'} range still on (${this.rangeRounds[side][k]} rounds left)`); continue; }
      if (tw.rangeCool > 0 && this.elapsed - this.rangeAt[side][k] < tw.rangeCool) { if (want.length === 1) return this._refuse(side, parsed, `${k === 'gun' ? 'tower' : 'turret'} range cooldown ${Math.ceil(tw.rangeCool - (this.elapsed - this.rangeAt[side][k]))}s`); continue; }
      ok.push(k);
    }
    if (!ok.length) return this._refuse(side, parsed, 'nothing to boost (down, running or cooling down)');
    const cost = parsed.what === 'all' && ok.length === 2 ? tw.rangeCr : Math.round(tw.rangeCr * 0.7);
    if (!(this.fieldCredits[side] >= cost)) return this._refuse(side, parsed, `bank ${Math.floor(this.fieldCredits[side])} < ${cost}`);
    this.fieldCredits[side] -= cost;
    this.rangeBuys[side]++;
    for (const k of ok) { this.rangeRounds[side][k] = this._roundsFor(k); this.rangeAt[side][k] = this.elapsed; }
    this._syncCreditGate(side);
    const names = ok.map(k => (k === 'gun' ? 'TOWER' : 'TURRET')).join(' + ');
    this._orderRow(side, 'buy', `BUY RANGE ${parsed.what === 'all' ? 'ALL' : names}`, `${cost} CR`);
    this._log(`${TEAM[side].log} buys RANGE +${tw.rangePct}% · ${names} · ${ok.map(k => `${this._roundsFor(k)} ${k === 'gun' ? 'tower' : 'turret'}`).join(' + ')} rounds · −${cost} CR`, side);
    return P.reply(parsed);
  }

  /** Plain view for Ember's BUY RANGE rule (ember-range.js): field counts, Green in our half, each weapon's state and threat, prices, reinforcement need. */
  _emberRangeView(side) {
    const tw = this.tw, them = 1 - side;
    const mine = this.units.filter(u => u.side === side && u.hp > 0), theirs = this.units.filter(u => u.side === them && u.hp > 0);
    const inHalf = theirs.filter(u => grounded(u) && (side === 1 ? C.zoneOf(u.x) >= ER.KNOBS.halfFromZone : C.zoneOf(u.x) < ER.KNOBS.halfFromZone));
    const near = (pts, reach) => inHalf.filter(u => pts.some(p => Math.hypot(u.x - p.x, u.y - p.y) <= reach + ER.KNOBS.threatPad)).length;
    const guns = [this.guns[side], ...(this.extraGuns ? this.extraGuns[side] : [])].filter(g => g && g.alive && !(g.building > 0));
    const best = guns.reduce((a, g) => (!a || g.hp / g.max > a.hp / a.max ? g : a), null);
    const gun = best ? { alive: true, hp: best.hp, max: best.max, rounds: this.rangeRounds[side].gun, threat: near(guns, tw.gunRange * (1 + tw.rangePct / 100)) } : { alive: false };
    const t = this.turrets && this.turrets[side];
    const turret = t && t.alive ? { alive: true, hp: t.hp, max: t.max, rounds: this.rangeRounds[side].turret, threat: near([t], C.TURRET.range * (1 + tw.rangePct / 100)) } : { alive: false };
    let reinfNeed = 0;
    if (this._buyRoom(side) > 0) {
      const ps = TYPE_IDS.filter(k => !this._buyCapReason(side, k)).map(k => this._livePrice(side, k)).filter(p => p > 0);
      reinfNeed = ps.length ? Math.min(...ps) : 0;
    }
    return {
      on: true, buysLeft: tw.rangeMax - this.rangeBuys[side], greenInHalf: inHalf.length, emberField: mine.length, greenField: theirs.length,
      gun, turret, bank: Math.floor(this.fieldCredits[side]), reinfNeed, baseHp: this.hp[side], priceAll: tw.rangeCr, priceOne: Math.round(tw.rangeCr * 0.7),
    };
  }

  /** Alive bought towers (built or building) of a side; undefined when BUY TOWER is off (nothing then shows in the report). */
  _xgunCount(side) {
    if (!this.tw.on || !this.tw.buy || !this.extraGuns) return undefined;
    return this.extraGuns[side].filter(t => t.alive).length;
  }

  /**
   * BUY TOWER [z<n>]: a gun tower bought with idle credits (TOWER_BUY_CR), at most TOWER_BUY_MAX a match, in our own half or a zone we hold
   * (never their home zone), at most two towers a zone. Built after TOWER_BUILD_S; it shoots like the gun tower (not scaled, no repair, no rebuild),
   * has TOWER_BUY_HP and, when it falls, pays the attacker a small bounty only. No Team HP and no tie-break points either way.
   */
  _buyTower(side, parsed) {
    const tw = this.tw;
    if (!tw.on || !tw.buy || !this.guns) return this._refuse(side, parsed, 'unknown unit TOWER');
    if (this.phase !== 'live') return this._refuse(side, parsed, 'TOWER can be bought once the match is live');
    if (this.towerBought[side] >= tw.buyMax) return this._refuse(side, parsed, `tower limit ${tw.buyMax} a match`);
    const held = i => (side === 0 ? this.land[i] : -this.land[i]) > 0.35;
    const own = i => (side === 0 ? i <= 3 : i >= 4);
    const homeEnemy = side === 0 ? 7 : 0;
    const count = i => this.guns.filter(g => g.alive && g.side === side && g.zone === i).length + this.extraGuns[side].filter(g => g.alive && g.zone === i).length;
    let zi = parsed.zone != null ? parsed.zone - 1 : -1;
    if (parsed.zone == null) { // default: our front-most held zone (never their home zone), else our front own zone with room
      let best = -1;
      for (let i = 0; i < 8; i++) {
        if (i === homeEnemy || !(held(i) || own(i)) || count(i) >= 2) continue;
        if (best < 0 || (side === 0 ? i > best : i < best)) best = i;
      }
      zi = best;
    }
    if (zi < 0 || zi > 7) return this._refuse(side, parsed, 'no zone free for a tower');
    if (zi === homeEnemy || !(own(zi) || held(zi))) return this._refuse(side, parsed, `z${zi + 1}: own half or a held zone only`);
    if (count(zi) >= 2) return this._refuse(side, parsed, `z${zi + 1}: 2 towers already`);
    if (!(this.fieldCredits[side] >= tw.buyCr)) return this._refuse(side, parsed, `bank ${Math.floor(this.fieldCredits[side])} < ${tw.buyCr}`);
    const lowTaken = [...this.guns.filter(g => g.alive && g.side === side && g.zone === zi), ...this.extraGuns[side].filter(g => g.alive && g.zone === zi)].filter(g => g.y > 190).length;
    const spot = TW.placeAt(zi, lowTaken === 0, (x, y) => this._wallOverlap(x, y, TW.GUN_R + 4));
    this.fieldCredits[side] -= tw.buyCr;
    this.towerBought[side]++;
    this.extraGuns[side].push({
      kind: 'gun', extra: true, side, x: spot.x, y: spot.y, zone: spot.zone, r: TW.GUN_R, hp: tw.buyHp, max: tw.buyHp, alive: true, building: tw.buyBuildS,
      cd: 0, aimId: null, aimX: null, aimY: null, angle: side === 0 ? 0 : Math.PI, firedAt: null, hitAt: null, hitFlash: 0, downAt: null,
    });
    this._syncCreditGate(side);
    this._orderRow(side, 'buy', `BUY TOWER z${zi + 1}`, `${tw.buyCr} CR`);
    this._log(`${TEAM[side].log} buys a TOWER in z${zi + 1} · −${tw.buyCr} CR · ready in ${tw.buyBuildS}s`, side);
    return P.reply(parsed);
  }

  /**
   * One step of a gun tower. Target: the nearest enemy ground unit inside its range in clear line, a Drone only when
   * no ground unit is. The first shot waits `firstShot` after a new target. Damage is not scaled by DAMAGE_SCALE
   * (like the base turret), no repair, down for the rest of the match.
   */
  _stepGun(t, dt, enemies) {
    t.hitFlash = Math.max(0, (t.hitFlash || 0) - dt);
    if (!t.alive || this.hp[t.side] <= 0 || this.over) { t.aimId = null; return; }
    t.cd -= dt;
    const range = this._rangeOf(t.side, 'gun', this.tw.gunRange);
    let best = null, bestScore = Infinity;
    for (const v of enemies) {
      if (v.hp <= 0 || v.spawnShield > 0) continue;
      const d = Math.hypot(v.x - t.x, v.y - t.y);
      if (d >= range + TYPES[v.type].r * 0.5) continue;
      const air = !grounded(v);
      if (!air && this._lineBlocked(t.x, t.y, v.x, v.y)) continue;
      const score = (air ? 10000 : 0) + d;
      if (score < bestScore) { best = v; bestScore = score; }
    }
    if (!best) { t.aimId = null; t.aimX = null; t.aimY = null; return; }
    if (t.aimId == null) t.cd = Math.max(t.cd, C.TURRET.firstShot);
    t.aimId = best.id; t.aimX = best.x; t.aimY = best.y;
    t.angle = Math.atan2(best.y - t.y, best.x - t.x);
    if (t.cd > 0) return;
    const far = this.rangeRounds && this.rangeRounds[t.side].gun > 0 && Math.hypot(best.x - t.x, best.y - t.y) >= this.tw.gunRange + TYPES[best.type].r * 0.5;
    t.cd = this.tw.gunCool; t.firedAt = this.elapsed; this._useRound(t.side, 'gun');
    const col = TEAM[t.side].color;
    this.shots.push({ x: t.x, y: t.y, tx: best.x, ty: best.y, type: 'turret', side: t.side, col, life: 0.15, maxLife: 0.15 });
    this.combatFx.push({ x: t.x + Math.cos(t.angle) * 12, y: t.y + Math.sin(t.angle) * 12, t: 0, life: 0.13, kind: 'muzzle', col, r: 7 });
    if (U.isKamikaze(best.type)) best.downBy = 'gun';
    best.hp -= this.tw.gunDmg;
    if (far) this._farShot(t.side, 'gun', best);
    best.hitAt = this.elapsed; best.hitFlash = 0.19;
    const d = Math.hypot(best.x - t.x, best.y - t.y) || 1;
    best.kx = (best.kx || 0) + (best.x - t.x) / d * 22;
    best.ky = (best.ky || 0) + (best.y - t.y) / d * 22;
    this.combatFx.push({ x: best.x, y: best.y, t: 0, life: 0.22, kind: 'impact', col: '#f8efcc', r: 12 });
    this._sparks(best.x, best.y, col, 5);
  }

  /** Gun tower HP for the report and the frame: HP, or null once down; undefined when the match has none. */
  _gunHp(side) {
    if (!this.guns) return undefined;
    const t = this.guns[side];
    return t.alive ? Math.max(0, Math.ceil(t.hp)) : null;
  }

  // ---- Field hospital (docs/FIELD-HOSPITAL.md). Every method no-ops when the flag is off. ----

  _newHospital(side) {
    const spot = HH.place(side, (x, y) => this._wallOverlap(x, y, HH.R + 4));
    return {
      side, x: spot.x, y: spot.y, zone: spot.zone, hp: HH.HP, max: HH.HP, alive: true,
      rebuild: 0, costWait: false, downAt: null, hitFlash: 0, slots: [],
    };
  }

  /** The commander's view of the towers (TOWERS=1): time left, Team HP, tie-break points and zones, and each side's structures. */
  _towerBrief(side) {
    const them = 1 - side, st = (s, kind) => {
      const t = kind === 'hospital' ? (this.hospitals && this.hospitals[s]) : this._struct(s, kind);
      if (!t) return null;
      return { alive: !!t.alive, hp: Math.ceil(Math.max(0, t.hp)), max: t.max || 100, zone: t.zone, x: t.x, y: t.y, hitAgo: t.hitAt == null ? null : this.elapsed - t.hitAt };
    }, pb = t => ({ slot: t.slot, alive: !!t.alive, hp: Math.ceil(Math.max(0, t.hp)), max: t.max || 100, zone: t.zone, x: t.x, y: t.y, hitAgo: t.hitAt == null ? null : this.elapsed - t.hitAt });
    return {
      timeLeft: Math.max(0, this._timeLimit() - this.elapsed),
      hp: [Math.ceil(this.hp[side]), Math.ceil(this.hp[them])],
      pts: [this.towerPts[side], this.towerPts[them]],
      zones: [this._zonesOwned(side), this._zonesOwned(them)],
      ours: { gun: st(side, 'gun'), depot: st(side, 'depot'), hospital: st(side, 'hospital'), post: st(side, 'post'), posts: this._postsOf(side).map(pb) },
      theirs: { gun: st(them, 'gun'), depot: st(them, 'depot'), hospital: st(them, 'hospital'), post: st(them, 'post'), posts: this._postsOf(them).map(pb) },
    };
  }

  _hospitalBrief(side) {
    const h = this.hospitals && this.hospitals[side];
    if (!h) return null;
    return { alive: !!h.alive, hp: Math.ceil(Math.max(0, h.hp)), zone: h.zone, x: h.x, y: h.y, rebuild: h.alive ? 0 : Math.ceil(Math.max(0, h.rebuild)) };
  }

  /** Their hospital when it is alive, within our range and in clear line, else null. */
  _hospitalInReach(u, a, h) {
    const t = h || (this.hospitals && this.hospitals[1 - u.side]);
    if (!t || !t.alive) return null;
    if (!this._canShoot(a, Math.hypot(t.x - u.x, t.y - u.y), HH.R * 0.5)) return null;
    return this._shotBlocked(a, u.x, u.y, t.x, t.y) ? null : t;
  }

  /**
   * The enemy hospital as a shot, or null. FOCUS H: whenever it is in reach.
   * A MOVE or ASSIST whose zone is the hospital's zone: when it is in reach and `zone` is that zone.
   */
  _hospitalAim(u, a, focusHosp, zone) {
    const t = this.hospitals && this.hospitals[1 - u.side];
    if (!t || !t.alive) return null;
    const reach = this._hospitalInReach(u, a, t);
    if (!reach) return null;
    if (focusHosp) return t;
    if (zone != null && zone === t.zone) return t;
    return null;
  }

  _shootHospital(u, a, h) {
    u.firedAt = this.elapsed;
    this._fireAt(u, null, a, h.x, h.y);
    const heavy = a.role === 'armor';
    this.combatFx.push({ x: h.x, y: h.y, t: 0, life: heavy ? 0.38 : 0.22, kind: heavy ? 'blast' : 'impact', col: heavy ? a.color : '#f8efcc', r: heavy ? 23 : 12 });
    this._damageHospital(h, a.dmg * this.dmgScale);
    u.cd = a.cool;
  }

  /** Damage after armor (0 on a soft target). At 0 the building is down and the rebuild timer starts. */
  _damageHospital(h, dmg) {
    if (!h || !h.alive || !(dmg > 0)) return;
    this._structHit(h, 'hospital', Math.min(h.hp, dmg * (1 - HH.ARMOR)));
    h.hp -= dmg * (1 - HH.ARMOR);
    h.hitFlash = 0.19;
    if (h.hp > 0) return;
    h.hp = 0; h.alive = false; h.downAt = this.elapsed; h.rebuild = HH.REBUILD; h.costWait = false; h.slots = [];
    this.combatFx.push({ x: h.x, y: h.y, t: 0, life: 0.9, kind: 'blast', col: TEAM[h.side].color, r: 28 });
    this._sparks(h.x, h.y, '#ffca83', 12);
    this.cameraShake = Math.max(this.cameraShake, 0.28);
    this._log(`${TEAM[h.side].log} field hospital destroyed`, 1 - h.side);
    this._towerDown('hospital', h.side, h.zone + 1);
    for (const u of this.units) if (u.side === h.side && u.hosp) this._hospitalAbort(u);
  }

  _hospitalAbort(u) {
    u.hosp = null;
    u.healing = false;
  }

  /** Healed: resume the radio order, or walk back to the zone the retreat started in. */
  _hospitalRelease(u) {
    const saved = u.hosp;
    u.hosp = null;
    u.healing = false;
    if (!saved || u.radio) return;
    u.radio = { kind: 'move', zone: saved.zone, phase: 'go', back: saved.zone, hospReturn: true, sy: saved.y };
  }

  /**
   * Retreat, or keep walking to our hospital. Returns true when this step belongs to the hospital
   * (the caller skips radio, combat movement and zone regen). False when the flag is off, the unit
   * is a drone or a medic, the building is down, this unit is above 30% and not already committed,
   * or it is still in contact (an enemy inside weapon range, or a hit in the last QUIET seconds).
   * Contact is checked only when the retreat starts. A unit already walking keeps going if it is shot.
   * Healing itself runs in _stepHospitals so the slots are assigned together.
   * A unit leaves at 80% HP (HH.HEAL_TO), not at full.
   */
  _hospitalConsumes(u, a, dt, enemies, terrain) {
    if (!this.fieldHospital || !this.hospitals) return false;
    // Medics use the hospital like every other ground unit (medic-hospital); only flyers and drones skip it.
    if (U.isFlying(u.type) || a.role === 'kamikaze') {
      if (u.hosp) this._hospitalAbort(u);
      return false;
    }
    const h = this.hospitals[u.side];
    if (u.hosp && (!h || !h.alive)) { this._hospitalAbort(u); return false; }
    if (u.hosp && u.hp >= u.max * HH.HEAL_TO) { this._hospitalRelease(u); return false; }
    if (!u.hosp) {
      if (!h || !h.alive || !(u.hp > 0) || u.hp > u.max * HH.RETREAT) return false;
      if (!this._hospitalClear(u, a, enemies)) return false;
      u.hosp = { phase: 'go', zone: C.zoneOf(u.x), y: u.y, arrived: null };
    }
    const d = Math.hypot(h.x - u.x, h.y - u.y);
    if (d <= HH.PAD || u.hosp.phase === 'pad' || u.hosp.phase === 'heal' || u.hosp.phase === 'wait') {
      if (d > HH.PAD * 3) u.hosp.phase = 'go';
      else {
        u.hosp.phase = 'pad';
        if (u.hosp.arrived == null) u.hosp.arrived = this.elapsed;
        return true;
      }
    }
    this._radioMove(u, a, dt, h.x, h.y, terrain);
    this._hospitalVolley(u, a, enemies);
    return true;
  }

  /**
   * Out of the fight: no living enemy inside weapon range, and no hit in the last QUIET seconds.
   * Line of sight does not matter. A hit is hitAt, set by shots, turrets and blasts.
   */
  _hospitalClear(u, a, enemies) {
    if (u.hitAt != null && this.elapsed - u.hitAt < HH.QUIET) return false;
    // Contact = an enemy inside our range or we inside its, capped at a Rifle's reach: a Mortar's 188 px
    // shell range counted the whole middle of the field as contact, so a hurt tube never went (Oct 14).
    for (const v of enemies) {
      if (v.hp <= 0) continue;
      const vr = (TYPES[v.type] && TYPES[v.type].range) || 0;
      if (Math.hypot(v.x - u.x, v.y - u.y) < Math.max(Math.min(a.range, CONTACT_R), vr + 8)) return false;
    }
    return true;
  }

  /** Shoot an enemy in range without stopping the walk to the hospital. */
  _hospitalVolley(u, a, enemies) {
    if (u.cd > 0) return;
    let best = null, bd = Infinity;
    for (const v of enemies) {
      if (v.hp <= 0 || v.spawnShield > 0) continue;
      const d = Math.hypot(v.x - u.x, v.y - u.y);
      if (this._canShoot(a, d) && d < bd && !this._shotBlocked(a, u.x, u.y, v.x, v.y)) { best = v; bd = d; }
    }
    if (!best) return;
    this._fireAt(u, best, a, best.x, best.y);
    u.cd = a.cool;
  }

  /** Rebuild timer, then the 40 CR cost, then heal the earliest arrivals up to 80% HP. */
  _stepHospitals(dt) {
    if (!this.fieldHospital || !this.hospitals) return;
    for (const h of this.hospitals) {
      h.hitFlash = Math.max(0, (h.hitFlash || 0) - dt);
      if (!h.alive) {
        if (h.rebuild > 0) h.rebuild -= dt;
        if (h.rebuild <= 0) {
          h.rebuild = 0;
          if (this.fieldCredits[h.side] >= HH.COST) {
            this.fieldCredits[h.side] -= HH.COST;
            h.alive = true; h.hp = h.max; h.downAt = null; h.costWait = false; h.slots = [];
            this._log(`${TEAM[h.side].log} field hospital rebuilt · −${HH.COST} CR`, h.side);
          } else if (!h.costWait) {
            h.costWait = true;
            this._log(`${TEAM[h.side].log} field hospital ready · needs ${HH.COST} CR`, h.side);
          }
        }
        continue;
      }
      const capOf = u => u.max * HH.HEAL_TO;
      const pad = this.units.filter(u => u.side === h.side && u.hp > 0 && u.hosp && (u.hosp.phase === 'pad' || u.hosp.phase === 'heal' || u.hosp.phase === 'wait') && u.hp < capOf(u) && Math.hypot(h.x - u.x, h.y - u.y) <= HH.PAD * 1.5);
      pad.sort((a, b) => (a.hosp.arrived == null ? 9e9 : a.hosp.arrived) - (b.hosp.arrived == null ? 9e9 : b.hosp.arrived) || a.id - b.id);
      const chosen = new Set(pad.slice(0, HH.SLOTS));
      h.slots = [];
      for (const u of pad) {
        if (!chosen.has(u)) { u.hosp.phase = 'wait'; u.healing = false; continue; }
        u.hosp.phase = 'heal';
        h.slots.push(u.id);
        const before = u.hp;
        const cap = u.max * HH.HEAL_TO;
        u.hp = Math.min(cap, u.hp + HH.HEAL * dt);
        u.healing = true;
        u.healClock = (u.healClock || 0) + dt;
        if (u.healClock >= 1) {
          u.healClock -= 1;
          const amount = Math.max(1, Math.round(u.hp - before));
          this.healPopups.push({ x: u.x, y: u.y, t: 0, amount, side: u.side });
        }
        if (u.hp >= cap - 1e-9) this._hospitalRelease(u);
      }
    }
  }

  /** Report lists: our IDs, their counts. Retreating or healing, not the walk back. */
  _hospitalEn(side, ours) {
    const list = this.units.filter(u => u.side === side && u.hosp && u.hosp.phase !== 'back');
    if (ours) return list.map(u => this._tagOf(u)).sort();
    const n = {};
    for (const u of list) n[u.type] = (n[u.type] || 0) + 1;
    return TYPE_IDS.filter(k => n[k]).map(k => `${n[k] > 1 ? n[k] : ''}${P.CODE_BY_TYPE[k]}`);
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
    this.stanceMemory = [{}, {}];
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
      if (this.cmdr) this.cmdr.matchEnd();
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

  /** Comm net context for one side: its callsign, the enemy's name, its base and reporting station. */
  _commCtx(side) {
    const lab = this.labels[side] || {}, foe = this.labels[1 - side] || {};
    let st = null;
    for (const u of this.units) if (u.side === side && u.hp > 0) {
      const t = this._tagOf(u);
      if (!st || u.type < st.type || (u.type === st.type && u.serial < st.serial)) st = { type: u.type, serial: u.serial, tag: t };
    }
    const nice = b => String(b || '').toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, a, c) => a + c.toUpperCase());
    return {
      name: lab.name || (side === 0 ? 'Green' : 'Ember'),
      enemy: foe.name || (side === 0 ? 'Ember' : 'Green'),
      base: nice(lab.base) || 'Base',
      station: st && st.tag,
      homeZone: side === 0 ? 1 : C.ZONES,
      enemyHomeZone: side === 0 ? C.ZONES : 1,
      names: this._commNames || (this._commNames = Object.fromEntries(TYPE_IDS.map(k => [P.CODE_BY_TYPE[k], TYPES[k].name]))),
    };
  }

  /** Entries oldest-first; each goes on top, so the newest is first. 200 kept (snapshot sends the newest 24; the page keeps its own scrollback). */
  // Exchange ids (docs/COMMNET-EXCHANGES.md): every entry gets a msgId. An entry marked `reply` by its template
  // answers the lead entry of the same batch (its exchangeId, replyTo = the lead's msgId); an entry that carries
  // an explicit exchangeId / replyTo (a unit confirming an order) keeps them; anything else opens a new exchange.
  // Structure only, never timing. Returns the stored entries.
  _pushComm(side, entries) {
    const list = this.comms[side];
    if (!list || !entries || !entries.length) return [];
    const at = this._clock();
    const pre = side === 0 ? 'g' : 'e';
    let lead = null;
    const out = [];
    for (const e of entries) {
      const msgId = `${pre}${++this.commSeq}`;
      const { reply, ...rest } = e;
      let exchangeId = e.exchangeId || null, replyTo = e.replyTo || null;
      if (!exchangeId && reply && lead) { exchangeId = lead.exchangeId; replyTo = lead.msgId; }
      if (!exchangeId) { exchangeId = `x${msgId}`; replyTo = null; }
      const row = { at, ...rest, msgId, exchangeId, replyTo, side, match: this.matchNo };
      if (!replyTo) lead = row;
      list.unshift(row);
      out.push(row);
    }
    if (list.length > 200) list.length = 200;
    this._panelTouched = true;
    return out;
  }

  /** A unit confirms an order from a real game event (arrived in its MOVE zone, reached its healer). Max 4 per exchange. */
  _commConfirms() {
    for (const u of this.units) {
      const o = u.radio;
      if (!o || !o.comm || o.comm.done || u.hp <= 0) continue;
      let what = null, extra = {};
      if (o.kind === 'move' && C.zoneOf(u.x) === o.zone) { what = 'position'; extra = { z: o.zone + 1 }; }
      else if (o.kind === 'fallback' && o.phase === 'go') {
        if (o.via && o.via !== 'base') {
          const m = this.units.find(v => v.side === u.side && v.hp > 0 && v.tag === o.via);
          if (m && Math.hypot(m.x - u.x, m.y - u.y) <= 40) { what = 'medic'; extra = { via: o.via }; }
        } else if (o.via === 'base' && inHomeZone(u.side, u.x)) what = 'base';
      }
      if (!what) continue;
      o.comm.done = true;
      const n = this.commConfirms[o.comm.exchangeId] || 0;
      if (n >= 4) continue;
      this.commConfirms[o.comm.exchangeId] = n + 1;
      const e = CM.confirm(this._commCtx(u.side), this._tagOf(u), what, extra);
      this._pushComm(u.side, [{ ...e, exchangeId: o.comm.exchangeId, replyTo: o.comm.msgId }]);
    }
  }

  /** `ACK <id> [NEG] <text>` from the seat: mark the owner's note, put Main's roger on the net (never the note). */
  _cmdrAck(side, a) {
    if (!this.cmdr || !a.id) return 'ERR ACK: unknown note';
    const r = this.cmdr.ack(side, a.id, a.rest);
    if (r.error) return `ERR ACK ${a.id}: ${r.error}`;
    if (!r.dup) this._pushComm(side, [CM.cmdrAck(this._commCtx(side), { text: r.text, neg: r.neg, pvp: !!this.cmdrPvp })]);
    return `OK ACK ${a.id}`;
  }

  /** One order post on the net: FRAGO + wilco, or a Negative. */
  _commOrders(side, list, results, meta, postUnits) {
    if (!list || !list.length) return;
    const orders = list.map((parsed, i) => {
      const r = String(results[i] || '');
      const ok = r.startsWith('OK');
      const reason = ok ? '' : r.replace(/^ERR [^:]*:\s*/, '');
      return { line: parsed.line || '', ok, reason, code: ok ? null : P.errCode(reason) };
    });
    const rows = this._pushComm(side, CM.orderExchange(this._commCtx(side), orders));
    // Each order is a FRAGO lead + one reply, in order: tie the units it moved to that FRAGO so their
    // arrival (a real game event) answers in the same exchange.
    const leads = rows.filter(r => !r.replyTo);
    (postUnits || []).forEach((units, i) => {
      const lead = leads[i];
      if (!lead || !units || !results[i] || !String(results[i]).startsWith('OK')) return;
      for (const u of units) if (u.radio && (u.radio.kind === 'move' || u.radio.kind === 'fallback')) u.radio.comm = { exchangeId: lead.exchangeId, msgId: lead.msgId };
    });
  }

  _commLoss(u) {
    if (this.phase !== 'live') return;
    const cs = this.commState[u.side];
    cs.losses.push({ tag: this._tagOf(u), zone: C.zoneOf(u.x) + 1 });
    const code = P.CODE_BY_TYPE[u.type];
    cs.lost[code] = (cs.lost[code] || 0) + 1;
    const os = this.commState[1 - u.side];
    os.killed[code] = (os.killed[code] || 0) + 1;
  }

  /** SPOTREPs on losses, new contact and base threat; a full sitrep every 30 s of match time. */
  _commTick() {
    const fights = this._fightZones();
    for (let side = 0; side < 2; side++) {
      const cs = this.commState[side];
      if (cs.land == null) cs.land = this._zonesHeld(side);
      const ctx = this._commCtx(side);
      if (side === 0) this._commConfirms();
      if (cs.losses.length) { this._pushComm(side, [CM.spotLoss(ctx, cs.losses.slice(0, 3))]); cs.losses = []; }
      for (const f of fights) {
        const z = f.zone;
        if (cs.contact[z] != null && this.elapsed - cs.contact[z] < 15) { cs.contact[z] = this.elapsed; continue; }
        if (cs.contact[z] == null || this.elapsed - cs.contact[z] >= 15) {
          this._pushComm(side, [CM.spotContact(ctx, { zone: z + 1, us: f.n[side], them: f.n[1 - side] })]);
        }
        cs.contact[z] = this.elapsed;
      }
      let n = 0, zz = 0;
      for (const u of this.units) if (u.side !== side && u.hp > 0 && inHomeZone(side, u.x)) { n++; zz = C.zoneOf(u.x) + 1; }
      if (n && !cs.threat && this.elapsed - cs.threatAt >= 15) { this._pushComm(side, [CM.spotBase(ctx, n, zz)]); cs.threatAt = this.elapsed; }
      cs.threat = n;
      // Our turret under fire: the first hit, then at most once every 15 s. Either turret down: both nets.
      if (cs.turretHit && this.turrets[side].alive && this.elapsed - cs.turretSpotAt >= 15) {
        this._pushComm(side, [CM.spotTurret(ctx, this._turretHp(side))]);
        cs.turretSpotAt = this.elapsed;
      }
      cs.turretHit = false;
      for (const s of cs.turretDown) this._pushComm(side, [CM.spotTurretDown(ctx, s === side)]);
      cs.turretDown = [];
      if (this.elapsed - cs.lastSit >= 30) {
        cs.lastSit = this.elapsed;
        const held = this._zonesHeld(side);
        const chg = CM.changeWords({ lost: cs.lost, killed: cs.killed, land: held - cs.land }, ctx.enemy, ctx.names);
        cs.lost = {}; cs.killed = {}; cs.land = held;
        const usHp = Math.ceil(this.hp[side]), themHp = Math.ceil(this.hp[1 - side]);
        const sit = n ? 'base-threat' : (usHp - themHp > 10 || held > this._zonesHeld(1 - side) + 1) ? 'ahead'
          : (themHp - usHp > 10 || this._zonesHeld(1 - side) > held + 1) ? 'behind' : 'even';
        const mine = fights.filter(f => true).map(f => ({ zone: f.zone + 1, us: f.n[side], them: f.n[1 - side] }));
        this._pushComm(side, CM.sitrep(ctx, {
          sit, bank: Math.floor(this.fieldCredits[side]), field: this.units.filter(u => u.side === side).length,
          reserve: total(this.reserve[side]), hp: usHp, enemyHp: themHp,
          enemyActive: this.units.filter(u => u.side !== side).length, fights: mine, chg,
          turret: this.turrets[side].max > 0 ? this._turretHp(side) : undefined,
        }));
      }
    }
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
  // A free point the unit still cannot pass through. The old slit was only a center sitting
  // in two wall paddings at r+2. Any corridor narrower than the unit's diameter (2*r) is the
  // same kind of gap: wall against wall, or wall against the map edge. The grid must not
  // route through it. A center that is already inside padding is blocked on its own.
  _narrow(px, py, r) {
    const x = this._fieldX(px), y = this._fieldY(py);
    if (r <= 0 || this._wallOverlap(x, y, r)) return false;
    let pinch = 0;
    let left = 0, right = W, up = 0, down = H;
    for (const [x0, y0, x1, y1] of this.walls) {
      const l = x0 * W, t = y0 * H, rr = x1 * W, b = y1 * H;
      const near = rad => x >= l - rad && x <= rr + rad && y >= t - rad && y <= b + rad;
      if (near(r + 2) && !near(r)) pinch++;
      if (y >= t && y <= b) {
        if (rr <= x) left = Math.max(left, rr);
        else if (l >= x) right = Math.min(right, l);
      }
      if (x >= l && x <= rr) {
        if (b <= y) up = Math.max(up, b);
        else if (t >= y) down = Math.min(down, t);
      }
    }
    if (pinch >= 2) return true;
    return (right - left) < 2 * r || (down - up) < 2 * r;
  }
  // True when the straight step from (x0, y0) to (x1, y1) crosses wall padding. Cell centers can
  // sit in a slit a unit cannot walk: the grid calls both ends free, and the unit slides on the wall.
  _segmentBlocked(x0, y0, x1, y1, r) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 8));
    for (let i = 1; i <= n; i++) {
      const q = i / n;
      if (this._blockedAt(x0 + (x1 - x0) * q, y0 + (y1 - y0) * q, r)) return true;
    }
    return false;
  }
  // A point one step off the line to (tx, ty), on the side that is not in wall padding.
  _openStep(x, y, tx, ty, r) {
    const dx = tx - x, dy = ty - y, md = Math.hypot(dx, dy) || 1;
    const px = -dy / md, py = dx / md;
    let best = null, bestClear = -1;
    for (const s of [1, -1]) {
      const qx = this._fieldX(x + px * s * 32), qy = this._fieldY(y + py * s * 32);
      if (this._segmentBlocked(x, y, qx, qy, r)) continue;
      let clear = 0;
      for (; clear <= 24; clear += 4) if (this._blockedAt(qx, qy, r + clear)) break;
      if (clear > bestClear) { bestClear = clear; best = { x: qx, y: qy }; }
    }
    return best;
  }
  // Nearest walkable cell center within two cells. Prefer one the unit can walk to
  // in a straight line. This is a local correction, not a jump across the map.
  _nearestOpen(x, y, r) {
    const cols = 24, rows = 12, cellW = W / cols, cellH = H / rows;
    const maxD = Math.hypot(cellW, cellH) * 2;
    let clear = null, clearD = Infinity, any = null, anyD = Infinity;
    for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
      const px = this._fieldX((cx + 0.5) * cellW), py = this._fieldY((cy + 0.5) * cellH);
      const d = Math.hypot(px - x, py - y);
      if (d < 2 || d > maxD) continue;
      if (this._blockedAt(px, py, r) || this._narrow(px, py, r)) continue;
      if (d < anyD) { anyD = d; any = { x: px, y: py }; }
      if (this._segmentBlocked(x, y, px, py, r)) continue;
      if (d < clearD) { clearD = d; clear = { x: px, y: py }; }
    }
    return clear || any;
  }
  // Strike 1: sidestep off the line and repath around the waypoint.
  // Strike 2: walk (never teleport) to the nearest open cell.
  // Strike 3: block the cell the unit is standing in and repath, still walking to that cell.
  _beginSidestep(u, gx, gy, r, way) {
    const cellW = W / 24, cellH = H / 12;
    const here = Math.floor(u.y / cellH) * 24 + Math.floor(u.x / cellW);
    const strike = (u.stuckStrikes = (u.stuckStrikes || 0) + 1);
    u.stuckWatch = null;
    if (strike <= 1) {
      u.repath = 3;
      if (way) {
        const wc = Math.floor(way.y / cellH) * 24 + Math.floor(way.x / cellW);
        u.avoidCell = wc === here ? -1 : wc;
      }
      const step = this._openStep(u.x, u.y, gx, gy, r);
      if (step) u.sidestep = { x: step.x, y: step.y, until: this.elapsed + 1.5 };
      return;
    }
    const open = this._nearestOpen(u.x, u.y, r);
    const openId = open ? Math.floor(open.y / cellH) * 24 + Math.floor(open.x / cellW) : -1;
    if (strike === 2) {
      u.repath = 0;
      u.avoidCell = -1;
    } else {
      u.repath = 3;
      u.avoidCell = openId === here ? -1 : here;
      u.stuckStrikes = 0;
    }
    if (!open) return;
    // Walk toward that cell. _move stops at padding, so this is not a teleport.
    const dx = open.x - u.x, dy = open.y - u.y, md = Math.hypot(dx, dy) || 1;
    const step = Math.min(24, md);
    this._move(u, dx / md * step, dy / md * step, r);
    if (Math.hypot(open.x - u.x, open.y - u.y) > 2) u.sidestep = { x: open.x, y: open.y, until: this.elapsed + 2 };
  }
  // Not STUCK_X px closer to the goal after STUCK_N seconds. A slide along a wall
  // covers ground without closing on the goal, so travel distance does not reset this.
  _watchStuck(u, gx, gy, r, way) {
    if (u.sidestep && this.elapsed < u.sidestep.until) return;
    const d = Math.hypot(gx - u.x, gy - u.y);
    if (d < 28) { u.stuckWatch = null; u.stuckStrikes = 0; return; }
    const w = u.stuckWatch;
    if (!w || Math.hypot(gx - w.gx, gy - w.gy) > 70) {
      u.stuckWatch = { x: u.x, y: u.y, t: this.elapsed, gx, gy, d };
      return;
    }
    if (this.elapsed - w.t < STUCK_N) return;
    if (w.d - d >= STUCK_X) {
      u.stuckWatch = { x: u.x, y: u.y, t: this.elapsed, gx, gy, d };
      u.stuckStrikes = 0;
      return;
    }
    this._beginSidestep(u, gx, gy, r, way);
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
  // Blocked cells and the edges between them, for one radius. An edge whose straight
  // walk crosses padding is a gap the unit cannot step through, even when both centers
  // are free. Cached per wall layout; assigning this.walls drops the cache.
  _navGrid(r) {
    if (this._navWalls !== this.walls || !this._navCache) {
      this._navWalls = this.walls;
      this._navCache = new Map();
    }
    const key = String(r);
    const hit = this._navCache.get(key);
    if (hit) return hit;
    const cols = 24, rows = 12, cellW = W / cols, cellH = H / rows, n = cols * rows;
    const blocked = new Uint8Array(n);
    const center = id => {
      const cx = id % cols, cy = (id / cols) | 0;
      return [this._fieldX((cx + 0.5) * cellW), this._fieldY((cy + 0.5) * cellH)];
    };
    for (let id = 0; id < n; id++) {
      const [px, py] = center(id);
      if (this._blockedAt(px, py, r) || this._narrow(px, py, r)) blocked[id] = 1;
    }
    // 8 bits per cell: that step's segment crosses padding.
    const edge = new Uint8Array(n);
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (let id = 0; id < n; id++) {
      if (blocked[id]) continue;
      const cx = id % cols, cy = (id / cols) | 0;
      const [x0, y0] = center(id);
      let bits = 0;
      for (let k = 0; k < 8; k++) {
        const ax = cx + dirs[k][0], ay = cy + dirs[k][1];
        if (ax < 0 || ax >= cols || ay < 0 || ay >= rows || blocked[ay * cols + ax]) continue;
        const [x1, y1] = center(ay * cols + ax);
        if (this._segmentBlocked(x0, y0, x1, y1, r)) bits |= 1 << k;
      }
      edge[id] = bits;
    }
    const grid = { blocked, edge, dirs, cols, rows, cellW, cellH };
    this._navCache.set(key, grid);
    return grid;
  }
  _pathPoint(x, y, tx, ty, r = 0, avoid = -1) {
    avoid = avoid | 0;
    if (avoid < 0) avoid = -1;
    const cols = 24, rows = 12, cellW = W / cols, cellH = H / rows;
    const cell = (px, py) => [Math.max(0, Math.min(cols - 1, Math.floor(px / cellW))), Math.max(0, Math.min(rows - 1, Math.floor(py / cellH)))];
    const grid = r > 0 ? this._navGrid(r) : null;
    const blocked = (cx, cy) => {
      const id = cy * cols + cx;
      if (id === avoid) return true;
      if (!grid) {
        const px = (cx + 0.5) * cellW, py = (cy + 0.5) * cellH;
        return this._blockedAt(px, py, r);
      }
      return grid.blocked[id] === 1;
    };
    const edgeBlocked = (id, k) => grid && (grid.edge[id] & (1 << k)) !== 0;
    let [gx, gy] = cell(tx, ty);
    if (blocked(gx, gy)) {
      let best = null, bestD = Infinity;
      for (let rad = 1; rad < 6 && bestD === Infinity; rad++) for (let yy = -rad; yy <= rad; yy++) for (let xx = -rad; xx <= rad; xx++) {
        if (Math.max(Math.abs(xx), Math.abs(yy)) !== rad) continue;
        const ax = gx + xx, ay = gy + yy;
        if (ax < 0 || ax >= cols || ay < 0 || ay >= rows || blocked(ax, ay)) continue;
        const d0 = Math.hypot((ax + 0.5) * cellW - tx, (ay + 0.5) * cellH - ty);
        if (d0 < bestD) { bestD = d0; best = [ax, ay]; }
      }
      if (best) { gx = best[0]; gy = best[1]; }
    }
    const [sx, sy] = cell(x, y);
    const goal = gy * cols + gx, start = sy * cols + sx;
    const direct = () => (this._blockedAt(tx, ty, r) ? this._freePoint(this._fieldX(tx), this._fieldY(ty), r) : { x: this._fieldX(tx), y: this._fieldY(ty) });
    const at = id => ({ x: this._fieldX((id % cols + 0.5) * cellW), y: this._fieldY((((id / cols) | 0) + 0.5) * cellH) });
    // Same cell as the (possibly relocated) goal. A blocked zone center's nearest
    // free cell is this one: stand there, don't aim through the rock at the center.
    if (start === goal) {
      const raw = direct();
      if (!(r > 0 && this._segmentBlocked(x, y, raw.x, raw.y, r))) return raw;
      const home = at(start);
      if (!blocked(sx, sy) && !this._segmentBlocked(x, y, home.x, home.y, r)) return home;
      return { x, y };
    }
    const dirs = grid ? grid.dirs : [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    const fieldKey = r + ':' + (avoid | 0) + ':' + goal;
    let d = grid && this._navCache.get(fieldKey);
    if (!d) {
      d = new Int16Array(cols * rows); d.fill(-1); d[goal] = 0;
      const q = new Int16Array(cols * rows);
      let head = 0, tail = 0; q[tail++] = goal;
      while (head < tail) {
        const id = q[head++], cx = id % cols, cy = (id / cols) | 0;
        for (let k = 0; k < 8; k++) {
          const dx = dirs[k][0], dy = dirs[k][1];
          const ax = cx + dx, ay = cy + dy;
          if (ax < 0 || ax >= cols || ay < 0 || ay >= rows || blocked(ax, ay)) continue;
          if (dx && dy && (blocked(cx + dx, cy) || blocked(cx, cy + dy))) continue;
          const ni = ay * cols + ax;
          if (edgeBlocked(id, k)) continue;
          if (d[ni] < 0) { d[ni] = d[id] + 1; q[tail++] = ni; }
        }
      }
      if (grid) this._navCache.set(fieldKey, d);
    }
    // The next cell on the route, but only if the unit can walk there from where it stands.
    // A center-to-center edge can be clear while the off-center approach clips the padding;
    // aiming at that center is what pinned the breaker to the underside of the z1 rocks.
    // Step onto this cell's own center first when that is what makes the real next edge walkable.
    let ideal = null, idealD = Infinity, reach = null, reachD = Infinity;
    for (let k = 0; k < 8; k++) {
      const ax = sx + dirs[k][0], ay = sy + dirs[k][1];
      if (ax < 0 || ax >= cols || ay < 0 || ay >= rows || blocked(ax, ay)) continue;
      const ni = ay * cols + ax;
      const v = d[ni];
      if (v < 0) continue;
      const p = at(ni);
      if (v < idealD) { idealD = v; ideal = p; }
      if (v < reachD && !this._segmentBlocked(x, y, p.x, p.y, r)) { reachD = v; reach = p; }
    }
    if (ideal && reach && idealD === reachD) return reach;
    // The ideal next cell is not walkable from this off-center spot. Step onto the
    // center only when that center sits between us and the ideal cell. Stepping back
    // to it after we had already left (one frame down, the next frame back) is the
    // medic pinned under a block.
    if (ideal && !blocked(sx, sy)) {
      const home = at(start);
      const toward = Math.hypot(ideal.x - home.x, ideal.y - home.y) + 1 < Math.hypot(ideal.x - x, ideal.y - y);
      if (toward && Math.hypot(home.x - x, home.y - y) > 2 && !this._segmentBlocked(x, y, home.x, home.y, r)) return home;
    }
    if (reach) return reach;
    const open = r > 0 ? this._nearestOpen(x, y, r) : null;
    if (open && !this._segmentBlocked(x, y, open.x, open.y, r)) return open;
    const raw = direct();
    if (r > 0 && this._segmentBlocked(x, y, raw.x, raw.y, r)) return { x, y };
    return raw;
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
      const acks = [];
      let why = '';
      for (const raw of lines || []) {
        const parsed = P.parseOrder(raw);
        if (parsed.skip) continue;
        if (parsed.ack) { if (acks.length < 4) acks.push(parsed.ack); continue; }
        if (parsed.why) {
          if (!why) why = parsed.why;
          continue;
        }
        list.push(parsed);
      }
      this._orderMeta.why = why;
      const ackResults = acks.map(a => this._cmdrAck(side, a));
      if (!list.length && ackResults.length) {
        this._emit();
        return { results: ackResults, ...this.protocolState(side) };
      }
      if (!list.length) return { error: 'no orders', results: [] };
      // STANCE rides free next to a MOVE in the same post (no order slot), at most 3 of them.
      const hasMove = list.some(p => p.op === 'MOVE');
      const stanceN = list.filter(p => p.op === 'STANCE').length;
      const counted = hasMove ? list.length - Math.min(3, stanceN) : list.length;
      if (counted > 3) {
        this._orderRow(side, 'err', 'ERR', 'at most 3 orders');
        if (this._panelTouched) this._emit();
        return { error: 'at most 3 orders per post', results: [] };
      }
      const scratch = this._uncommittedReserve(side);
      const postUnits = [];
      const results = list.map(parsed => {
        // A radio order (or scoped FOCUS) names units on the field: a DEPLOY earlier in this
        // post fields first, so `DEPLOY ALL` + `MOVE R z3` works in one post.
        if (this.phase === 'live' && (parsed.radio || parsed.scoped || parsed.op === 'STANCE') && !this.over) this._flushLiveDeploys(side);
        this._radioLast = null;
        const res = this._applyParsedOrder(side, parsed, scratch);
        postUnits.push(this._radioLast);
        return res;
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
      if (mutated || (this.phase === 'live' && !(meta && meta.npc) && results.some(r => /^OK (FOCUS|AUTOBUY|BANK|MOVE|ASSIST|FALLBACK|CLEAR|STANCE)\b/.test(r)))) this._pushReport(side, 'STATE');
      const state = this.protocolState(side);
      if (results.some(r => r.startsWith('OK')) || this._panelTouched) this._emit();
      const errors = results.map((r, i) => /^ERR/.test(r) ? { line: (list[i] && list[i].line) || '', code: P.errCode(r.replace(/^ERR [^:]*:\s*/, '')), reason: r.replace(/^ERR [^:]*:\s*/, '') } : null).filter(Boolean);
      this._commOrders(side, list, results, meta, postUnits);
      if (ackResults.length) results.push(...ackResults);
      return errors.length ? { results, errors, ...state } : { results, ...state };
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
    if (!this.mortarOn) {
      const tube = U.idsWithRole('mortar')[0];
      const named = (parsed.type && U.roleOf(parsed.type) === 'mortar') || (parsed.types || []).some(t => U.roleOf(t) === 'mortar');
      if (named) return this._refuse(side, parsed, `unknown unit ${tube ? U.CODE_BY_TYPE[tube] : 'O'}`);
    }
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
    if (parsed.op === 'BUY' && parsed.tower) return this._buyTower(side, parsed);
    if (parsed.op === 'BUY' && parsed.range) return this._buyRange(side, parsed);
    if (parsed.op === 'BUY') return this._liveBuy(side, parsed, scratch);
    if (parsed.op === 'DEPLOY') return this._liveDeploy(side, parsed, scratch);
    if (parsed.op === 'FOCUS') return this._setFocus(side, parsed);
    if (parsed.op === 'STANCE') return this._setStance(side, parsed);
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
        return { error: sel.n <= issued ? `unit ${sel.id} is dead` : `unknown unit ${sel.id}` };
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
      this._radioLast = r.units;
      this._assignSlots(side, r.units);
      this._rememberGroupOrder(side, parsed.sels, { zone: parsed.zone, gid, seq: gid });
      this._radioRow(side, parsed, r.units);
      return P.reply(parsed);
    }
    if (parsed.op === 'ASSIST' && parsed.assistId) {
      const sel = P.parseUnitSel(parsed.assistId);
      if (sel.error) return this._refuse(side, parsed, sel.error);
      const r = this._resolveSel(side, [sel]);
      if (r.error) return this._refuse(side, parsed, r.error);
      parsed = { ...parsed, zone: C.zoneOf(r.units[0].x) };
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
      this._radioLast = units;
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
    else if (parsed.op === 'ASSIST') { verb = parsed.zone == null ? `ASSIST ${parsed.assistId}` : `ASSIST → z${parsed.zone + 1}`; detail = units ? `${units.length} unit${units.length === 1 ? '' : 's'}` : `radius ${parsed.radius}`; }
    else if (parsed.op === 'FALLBACK') { verb = `FALLBACK ${sel}`; detail = units && units.every(u => u.radio && u.radio.via === 'base') ? 'to base' : 'to medic'; }
    else verb = `CLEAR ${sel}`;
    if (!units) detail = detail ? `${detail} · at T0` : 'at T0';
    this._orderRow(side, parsed.op === 'CLEAR' ? 'hold' : 'deploy', verb, detail);
    if (units) this._log(`${TEAM[side].log} radio · ${verb}${detail ? ' · ' + detail : ''}`, side);
  }

  /**
   * STANCE <units> <stance>. Live: the named units take it now (drones are skipped), and a code group
   * (`T`) or ALL also sets the stance later deploys of that type get this match. Before T0 it is queued
   * like a radio order. DEFAULT puts the type's own default back.
   */
  _setStance(side, parsed) {
    if (this.phase !== 'live') {
      this.radioT0[side].push({ parsed, why: this._orderWhy() });
      this._orderRow(side, 'deploy', parsed.line, 'at T0');
      return `OK ${parsed.line} (at T0)`;
    }
    const mem = this.stanceMemory[side];
    const pick = type => parsed.stance === 'DEFAULT' ? ST.defaultStance(type, this.stanceMode[side]) : parsed.stance;
    for (const sel of parsed.sels) {
      const types = sel.all ? TYPE_IDS : sel.type && !sel.id && sel.count == null ? [sel.type] : [];
      for (const t of types) if (ST.hasStance(t)) { if (parsed.stance === 'DEFAULT') delete mem[t]; else mem[t] = parsed.stance; }
    }
    const r = this._resolveSel(side, parsed.sels);
    const units = r.units ? r.units.filter(u => ST.hasStance(u.type)) : [];
    // No such unit on the field yet: a group selector still stands for later deploys.
    const remembered = parsed.sels.some(sel => sel.all || (sel.type && !sel.id && sel.count == null && ST.hasStance(sel.type)));
    if (!units.length && !remembered) return this._refuse(side, parsed, r.error || 'drones have no stance');
    for (const u of units) u.stance = pick(u.type);
    this._orderRow(side, 'deploy', parsed.line, units.length ? this._unitsText(units) : 'next deploys');
    this._log(`${TEAM[side].log} stance · ${parsed.line}`, side);
    return P.reply(parsed);
  }

  /** Radio orders and scoped FOCUS posted on READY, in order, right after the T0 wave left. */
  _drainRadioT0(side) {
    const list = this.radioT0[side] || [];
    this.radioT0[side] = [];
    this._t0Drain = true;
    for (const item of list) {
      this._orderMeta = { decideMs: null, why: item.why || '' };
      try {
        const res = item.parsed.op === 'FOCUS' ? this._setFocus(side, item.parsed) : item.parsed.op === 'STANCE' ? this._setStance(side, item.parsed) : this._radioOrder(side, item.parsed);
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
    if (parsed.type === 'hospital' && !this.fieldHospital) return this._refuse(side, parsed, 'unknown unit H');
    if ((parsed.type === 'gun' && !this.guns) || (parsed.type === 'depot' && !this.depots) || (parsed.type === 'post' && !this.posts)) return this._refuse(side, parsed, `unknown unit ${parsed.type.toUpperCase()}`);
    this.focusScope[side] = parsed.type ? scope : null;
    this.focus[side] = parsed.type || null;
    this._orderRow(side, 'hold', parsed.line, '');
    const focusName = parsed.type === 'turret' ? 'TURRET' : parsed.type === 'hospital' ? 'HOSPITAL' : parsed.type === 'gun' ? 'GUN TOWER' : parsed.type === 'depot' ? 'DEPOT' : parsed.type === 'post' ? 'FORWARD POST' : parsed.type ? TYPES[parsed.type].name.toUpperCase() : '';
    if (parsed.type) this._log(`${TEAM[side].log} focus · ${focusName} first`, side);
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
    if (this._autobuyCapped(side)) return 'max';
    const t = TYPES[this.autobuy[side].type];
    if (t && t.maxAlive > 0 && this._aliveOf(side, this.autobuy[side].type) + this._packOf(this.autobuy[side].type) > t.maxAlive) return 'cap';
    return '';
  }

  /**
   * One AUTOBUY purchase when the bank covers the live price plus the kept reserve:
   * the unit is bought and fielded at once. At most one per step. Returns 1 when it fired.
   * It is the warrior's own order: the panel row carries its WHY (or `autobuy`) and `rule`
   * where a decide time would go, never the autopilot `auto` tag.
   */
  _autobuyStep(side) {
    if (side === 1 && this._emberSaving) return false;   // Ember saving for BUY RANGE (ember-range.js step)
    const rule = this.autobuy[side];
    if (!rule || this.phase !== 'live' || this.over || !TYPES[rule.type]) return 0;
    if (this._autobuyState(side)) return 0;
    const k = rule.type;
    const cost = this._livePrice(side, k);
    if (this._buyCapReason(side, k)) return 0;
    if (!(Math.floor(this.fieldCredits[side]) >= cost + rule.reserve)) return 0;
    this.fieldCredits[side] -= cost;
    this._noteBuy(side, k);
    const pack = this._packOf(k);
    this.reserve[side][k] = (this.reserve[side][k] || 0) + pack;
    this.rosters[side][k] = (this.rosters[side][k] || 0) + pack;
    this.liveBuys[side]++;
    this._noteWire('buy', side, k);
    this._noteWire('auto', side, k);
    this._syncCreditGate(side);
    let fielded = false;
    for (let j = 0; j < pack; j++) if (this._releaseUnit(side, k, false, this._waveY(pack > 1 ? j : 0, pack))) fielded = true;   // a pack goes out at once, abreast
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

  /**
   * What a live BUY of that type costs this side right now. The report's can-buy uses the same price.
   * BREAKER_DISCOUNT, while this side holds fewer zones, cuts the armor role only (the Breaker).
   */
  _livePrice(side, type) {
    const cost = FIELD_COST[type];
    if (!(this.breakerDiscount > 0) || !TYPES[type] || TYPES[type].role !== 'armor') return cost;
    if (!(this._zonesHeld(side) < this._zonesHeld(1 - side))) return cost;
    return E.discountedPrice(cost, this.breakerDiscount);
  }

  /**
   * While the field is at the active cap, drop BANK_DECAY of the credits above one Breaker's listed
   * price. The ceiling is the csv price, not the discounted one, so a side that is behind still
   * keeps a full Breaker in the bank. Off when the flag is off or the cap is off.
   */
  _decayBank(side) {
    if (!(this.bankDecay > 0) || !(this.activeCap > 0)) return;
    if (this._activeCount(side) < this.activeCap) return;
    const armor = U.idsWithRole('armor')[0];
    const ceiling = armor ? FIELD_COST[armor] : 0;
    if (!(ceiling > 0)) return;
    this.fieldCredits[side] = E.decayedBank(this.fieldCredits[side], ceiling, this.bankDecay);
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
  /** Units one buy of that type puts in reserve: a Drone is a pack (dronePack), everything else is one. */
  _packOf(type) { return U.isKamikaze(type) ? this.dronePack : Math.max(1, (TYPES[type] && TYPES[type].spawnCount) || 1); }   // Scout trio: units.csv spawn_count

  _buyCapReason(side, type) {
    const t = TYPES[type];
    if (!t) return 'unknown unit';
    const code = t.code;
    if (t.maxAlive > 0 && this._aliveOf(side, type) + this._packOf(type) > t.maxAlive) return `max ${t.maxAlive}${code} alive`;
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
    if (t.maxAlive > 0) room = Math.max(0, Math.floor((t.maxAlive - this._aliveOf(side, type)) / this._packOf(type)));   // buys, a Drone buy is a pack
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
    if (this._buysUsed(side) >= this.maxBuys) return this._refuse(side, parsed, `buys maxed ${this._buysUsed(side)}/${this.maxBuys}`);
    if (this._livingCount(side) + this._packOf(parsed.type) > C.ROSTER_LIMIT) return this._refuse(side, parsed, `roster full ${C.ROSTER_LIMIT} alive`);
    const capped = this._buyCapReason(side, parsed.type);
    if (capped) return this._refuse(side, parsed, capped);
    if (!(this.fieldCredits[side] >= cost)) return this._refuse(side, parsed, `bank ${Math.floor(this.fieldCredits[side])} < ${cost}`);
    this.fieldCredits[side] -= cost;
    this.liveBuys[side]++;
    this._noteBuy(side, parsed.type);
    const pack = this._packOf(parsed.type);
    this.reserve[side][parsed.type] = (this.reserve[side][parsed.type] || 0) + pack;
    this.rosters[side][parsed.type] = (this.rosters[side][parsed.type] || 0) + pack;
    this._noteWire('buy', side, parsed.type);
    if (scratch) scratch[parsed.type] = (scratch[parsed.type] || 0) + pack;
    this.bankHold[side] = false;
    this._syncCreditGate(side);
    this._orderRow(side, 'buy', `BUY ${P.CODE_BY_TYPE[parsed.type]}`, `${cost} CR`);
    this._log(`${TEAM[side].log} buys ${pack > 1 ? pack + ' ' : ''}${TYPES[parsed.type].name.toUpperCase()}${pack > 1 ? 'S' : ''} · −${cost} CR`, side);
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
    // A Drone is a pack: DEPLOY D fields up to dronePack Drones from the reserve at once (what it holds, if fewer).
    let named = parsed.types;
    if (named.some(t => this._packOf(t) > 1)) {
      const left = cloneCounts(scratch); named = [];
      for (const t of parsed.types) {
        // `DEPLOY D D` after one BUY D (the old "two Drones") is not an error: the pack already took what was there.
        if (this._packOf(t) > 1 && (left[t] || 0) <= 0 && named.includes(t)) continue;
        const n = Math.max(1, Math.min(this._packOf(t), left[t] || 0));
        for (let i = 0; i < n; i++) named.push(t);
        left[t] = (left[t] || 0) - n;
      }
    }
    const trial = cloneCounts(scratch);
    for (const t of named) {
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
    const fit = named.slice(0, room);
    if (!this.pushDecision(side, { types: fit, ...queued })) return this._refuse(side, parsed, 'queue full');
    for (const t of fit) scratch[t]--;
    return fit.length < named.length ? partial(fit.length, named.length) : accepted();
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
   * What the next income tick pays. `zone` is the frontier part after the cap and the diminish
   * series (docs/TERRITORY-INCOME.md). With both flags off it is n × 12. `catchup` is 0 unless
   * CATCHUP_INCOME is on and this side holds fewer zones on the map.
   */
  _incomeParts(side) {
    const n = this._incomeZones(side);
    const zone = E.zoneIncomePay(n, C.ZONE_INCOME, this.territoryCap, this.territoryDiminish);
    let base = this.baseIncome > 0 ? this.baseIncome : 0;
    // The depot pays DEPOT_INCOME of the base income (6 of 12) while it stands: a side without one earns less, never more.
    if (base > 0 && this.depots && !this.depots[side].alive) base -= Math.min(this.tw.depotIncome, base);
    let catchup = 0;
    if (this.catchupIncome > 0) {
      const deficit = this._zonesHeld(1 - side) - this._zonesHeld(side);
      if (deficit > 0) catchup = deficit * this.catchupIncome;
    }
    return { n, zone, base, catchup };
  }

  /**
   * The report's income token. Zones and base together per income tick: `income +28/4s (base 4)`.
   * With no frontier zone the base still pays: `income +4/4s base, need 1 zone on E half`.
   * With base income off (BASE_INCOME=0) the old wording: `income +24/4s`, `income: 0 CR, need 1 more zone on E half`.
   * The number is what the next tick pays. A cap or a diminish series changes that number and leaves the wording.
   * Catch-up, when it pays, is named in the parentheses.
   */
  /** Forward-post token for the report: `posts OB up FOB 40%` (up / NN% building / locked / down Ns). Empty when posts are off. */
  _postsHint(side) {
    if (!this.posts) return '';
    const name = { A: 'OB', B: 'FOB' };
    const st = p => p.alive ? `up${p.hp < p.max ? Math.ceil(p.hp) : ''}` : p.cool > 0 ? `down${Math.ceil(p.cool)}s` : p.buildZone != null && p.prog > 0 ? `${Math.floor(100 * p.prog / (p.need || 12))}%` : '-';
    const mine = this._postsOf(side).map(p => `${name[p.slot]} ${st(p)}`).join(' ');
    const theirs = this._postsOf(1 - side).filter(p => p.alive).map(p => name[p.slot]).join('+') || '-';
    return `posts ${mine} · E posts ${theirs}`;
  }
  _incomeHint(side) {
    const ph = this._postsHint(side);
    // Flat time income (The Range 1168ddf): no zone money, so the token is just the base rate per tick.
    if (!(C.ZONE_INCOME > 0) && !(this.catchupIncome > 0)) {
      const { base } = this._incomeParts(side);
      const tick = Math.round(C.INCOME_TICK_S * 10) / 10;
      return `income +${Number.isInteger(base) ? base : base.toFixed(1)}/${tick}s flat${ph ? ` · ${ph}` : ''}`;
    }
    const { n, zone, base, catchup } = this._incomeParts(side);
    const fmt = v => (Number.isInteger(v) ? String(v) : v.toFixed(1));
    const half = P.teamTag(this._seatName(1 - side), 1 - side);
    const total = zone + base + catchup;
    if (!n && !(catchup > 0)) {
      if (base) return `income +${fmt(base)}/4s base, need 1 zone on ${half} half`;
      return `income: 0 CR, need 1 more zone on ${half} half`;
    }
    if (!n) {
      if (base) return `income +${fmt(total)}/4s (base ${fmt(base)}, catch-up ${fmt(catchup)}), need 1 zone on ${half} half`;
      return `income +${fmt(total)}/4s (catch-up ${fmt(catchup)}), need 1 zone on ${half} half`;
    }
    if (base && catchup > 0) return `income +${fmt(total)}/4s (base ${fmt(base)}, catch-up ${fmt(catchup)})`;
    if (base) return `income +${fmt(total)}/4s (base ${fmt(base)})`;
    if (catchup > 0) return `income +${fmt(total)}/4s (catch-up ${fmt(catchup)})`;
    return `income +${fmt(total)}/4s`;
  }

  /** Our units on the field that count toward the active cap: every living unit, drones included. */
  /** Upkeep: every unit on the field (alive, not reserve) costs its units.csv `support` each income tick. Bank floors at 0. */
  _payUpkeep(side) {
    if (!this.upkeep) return 0;
    let due = 0;
    for (const u of this.units) if (u.side === side && u.hp > 0) due += (TYPES[u.type] && TYPES[u.type].support) | 0;
    if (!due) return 0;
    const paid = Math.min(this.fieldCredits[side], due);
    this.fieldCredits[side] -= paid;
    this.upkeepTotal[side] += paid;
    return paid;
  }

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
      version: this.tw.on ? P.PROTOCOL_VERSION_TOWERS : undefined,
      t: Math.floor(this.elapsed + 1e-4),
      event,
      delta: this._protocolDelta(side),
      situation: P.situationText({ nearBase, usHp, themHp, usLand, themLand, theirTag }),
      zones: this._zoneTotals(side),
      income: this._incomeHint(side),
      canBuy: P.canBuyCodes(Math.floor(this.fieldCredits[side]), this._livingCount(side), total(reserve), type => (!this.mortarOn && U.roleOf(type) === 'mortar' ? Infinity : this._livePrice(side, type)), type => Math.min(this._buyCapRoom(side, type), Math.max(0, this.maxBuys - this._buysUsed(side))), type => Math.max(0, this._activeRoom(side) - total(reserve)) / this._packOf(type)),
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
        turret: this.turrets[side].max > 0 ? this._turretHp(side) : undefined,
        gun: this._gunHp(side),
        depot: this._depotHp ? this._depotHp(side) : undefined,
        xgun: this._xgunCount(side),
        rng: this._rangeLeft(side),
      },
      them: {
        tag: theirTag,
        hp: themHp,
        land: themLand,
        field: counts(them),
        nearBase,
        groups: this._reportGroups(them),
        turret: this.turrets[them].max > 0 ? this._turretHp(them) : undefined,
        gun: this._gunHp(them),
        xgun: this._xgunCount(them),
        rng: this._rangeLeft(them),
        depot: this._depotHp ? this._depotHp(them) : undefined,
      },
      fights: this._fightZones().map(f => ({ zone: f.zone + 1, us: f.n[side], them: f.n[them] })),
      hospital: this.fieldHospital && this.hospitals ? {
        usTag: P.teamTag(this._seatName(side), side),
        themTag: theirTag,
        usAlive: this.hospitals[side].alive, usHp: Math.ceil(this.hospitals[side].hp), usRebuild: Math.ceil(Math.max(0, this.hospitals[side].rebuild)),
        themAlive: this.hospitals[them].alive, themHp: Math.ceil(this.hospitals[them].hp), themRebuild: Math.ceil(Math.max(0, this.hospitals[them].rebuild)),
        usEn: this._hospitalEn(side, true), themEn: this._hospitalEn(them, false),
      } : undefined,
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
        stance: this._stance(u), stanceDefault: this._stance(u) === ST.defaultStance(u.type, this.stanceMode[side]),
        ...(u.hosp && u.hosp.phase !== 'back' ? { hospital: true } : {}),
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
    view.cmdr = this._cmdrFor(side);
    const last = (this.protocolReports[side] || [])[(this.protocolReports[side] || []).length - 1];
    return {
      version: view.version || P.PROTOCOL_VERSION,
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

  /** Commander notes for this seat's next report (owner seat only, warrior has the con, live). */
  _cmdrFor(side) {
    if (!this.cmdr) return null;
    const list = this.cmdr.forReport({ side, seated: this._seated(side), live: this.phase === 'live' && !this.over, matchNo: this.matchNo, elapsed: this.elapsed });
    return list.length ? list : null;
  }

  /**
   * A commander note arrived (or a takeover ended with notes waiting): push a CMDR report at once so a pending
   * long-poll returns. At most one per CMDR_DEBOUNCE_MS (wall clock); a burst inside the window rides one report.
   * CMDR is off-cadence: it does not commit the delta snapshot or reset the HEARTBEAT/CREDITS clock.
   */
  cmdrKick(side) {
    if (!this.cmdr || this._cmdrTimer) return;
    const due = (this._cmdrLastAt || 0) + AgrtsMatch.CMDR_DEBOUNCE_MS - Date.now();
    const fire = () => {
      this._cmdrTimer = null;
      if (this.phase !== 'live' || this.over || !this.cmdr.hasPending({ side, seated: this._seated(side), matchNo: this.matchNo })) return;
      this._cmdrLastAt = Date.now();
      this._pushReport(side, 'CMDR');
      if (this.cmdr.hasPending({ side, seated: this._seated(side), matchNo: this.matchNo })) this.cmdrKick(side);   // more than 2 waiting
    };
    if (due <= 0) fire();
    else { this._cmdrTimer = setTimeout(fire, due); if (this._cmdrTimer.unref) this._cmdrTimer.unref(); }
  }

  _pushReport(side, event, note) {
    const offCadence = event === 'CMDR';
    const view = this._protocolView(side, event, note);
    if (event !== 'END') view.cmdr = this._cmdrFor(side);
    if (!offCadence && !note && event !== 'START' && view.note === 'autopilot acted') this.protocolAutopilotNote[side] = false;
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
    if (offCadence) { this.emit('protocol', rec); return rec; }
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
    const next = this._buysUsed(s) >= this.maxBuys || !this.queue[s][this.reinf[s]]
      ? `MAXED · ${this.reinf[s]} / ${this.maxBuys === Infinity ? '∞' : this.maxBuys}`
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
      comms: (this.comms[s] || []).slice(0, 24), // newest 24, each with msgId / exchangeId / replyTo (the page keeps full history)
      commShort: this.comms[s] && this.comms[s][0] ? CM.shortOf(this.comms[s][0]).slice(0, 60) : '',
      driver: this.drivers[s],
      plan: this.plans[s],
      // Complete arsenal: every unit type in TYPES, zeros included, so a new type shows up on its own. count = reserve (bought, not deployed).
      inventory: TYPE_IDS.filter(k => this.mortarOn || U.roleOf(k) !== 'mortar').map(k => ({ type: k, name: TYPES[k].name, glyph: TYPES[k].glyph, color: TYPES[k].color, count: this.reserve[s][k] || 0 })),
    };
  }

  _towerFrames(r1) {
    const out = [];
    if (this.posts) for (const p of this.posts) {
      if (!(p.alive || p.prog > 0 || p.cool > 0 || (p.unlockAt != null && this.elapsed - p.unlockAt < 2.5))) continue;
      out.push({ kind: 'post', side: p.side, slot: p.slot, x: r1(p.x), y: r1(p.y), zone: p.zone, hp: r1(p.hp), max: p.max, alive: p.alive,
        building: !p.alive && p.prog > 0 && !(p.cool > 0), unsafe: p.alive && !this._postSafe(p), build: p.alive ? 1 : Math.min(1, p.prog / Math.max(0.01, p.need || RULES.value('post_build_s'))), glow: !p.alive && p.unlockAt != null && this.elapsed - p.unlockAt < 2.5 ? r1(1 - (this.elapsed - p.unlockAt) / 2.5) : 0, building: !p.alive && p.prog > 0,
        rebuild: p.alive ? 0 : Math.ceil(Math.max(0, p.cool || 0)), hitFlash: p.hitFlash || 0, downAt: p.downAt });
    }
    for (const list of [this.guns, this.depots]) {
      if (!list) continue;
      for (const t of list) {
        out.push({
          kind: t.kind, side: t.side, x: r1(t.x), y: r1(t.y), zone: t.zone, hp: r1(t.hp), max: t.max, alive: t.alive,
          rebuild: t.alive ? 0 : Math.ceil(Math.max(0, t.rebuild || 0)),
          ...(t.kind === 'gun' ? { rounds: this.rangeRounds ? this.rangeRounds[t.side].gun : 0, rangeBase: this.tw.gunRange, range: this._rangeOf(t.side, 'gun', this.tw.gunRange), angle: Math.round(t.angle * 100) / 100, aim: t.aimId != null ? { x: r1(t.aimX), y: r1(t.aimY) } : null, firedAt: t.firedAt } : {}),
          hitFlash: t.hitFlash || 0, downAt: t.downAt,
        });
      }
    }
    if (this.extraGuns) for (const list of this.extraGuns) for (const t of list) {
      out.push({
        kind: 'gun', extra: true, side: t.side, x: r1(t.x), y: r1(t.y), zone: t.zone, hp: r1(t.hp), max: t.max, alive: t.alive, building: Math.ceil(Math.max(0, t.building || 0)),
        rebuild: 0, rounds: this.rangeRounds ? this.rangeRounds[t.side].gun : 0, rangeBase: this.tw.gunRange, range: this._rangeOf(t.side, 'gun', this.tw.gunRange), angle: Math.round(t.angle * 100) / 100, aim: t.aimId != null ? { x: r1(t.aimX), y: r1(t.aimY) } : null, firedAt: t.firedAt,
        hitFlash: t.hitFlash || 0, downAt: t.downAt,
      });
    }
    return out;
  }

  publicState() {
    const r1 = v => Math.round(v * 10) / 10;
    const stamp = `${String(Math.floor(this.elapsed / 60)).padStart(2, '0')}:${String(Math.floor(this.elapsed % 60)).padStart(2, '0')}`;
    const sides = [0, 1].map(s => this._sideView(s));
    return {
      mode: 'agrts', game: 'GrokBotWar', matchNo: this.matchNo, boot: this.bootId || null, seed: this.baseSeed,
      tick: this.steps, steps: this.steps, maxTicks: Math.round(this._timeLimit() / STEP),
      status: this.over ? 'over' : 'running', paused: this.paused, held: this.over && this.paused,
      phase: this.phase, countdown: this.phase === 'countdown' ? this.countdown : null, viewers: this.viewers || 0,
      gateReleased: this.phase === 'waiting' && this.gateStrict && this._gateReleased ? true : undefined, // a valid gate id / owner Start already released it (the match may still wait for plan approval); a boolean, never the id
      gated: this.phase === 'waiting' && this.gateStrict ? true : undefined, // armed behind the viewer gate: only the owner's new link releases it (the id itself is never published)
      elapsed: this.elapsed, clock: stamp, speed: SPEED, gameSpeed: C.GAME_SPEED, tickMs: 50, autoRestart: false, restartInMs: null,
      pauseAfterMatch: this.pauseAfterMatch, holdAfterMatch: this.holdNext,
      w: W, h: H, arena: { w: W, h: H }, robotRadius: 11,
      hp: this.hp.map(v => Math.max(0, v)),
      plans: this.plans.slice(),
      // Towers and Team HP (towers.js). Omitted with TOWERS off so a flag-off frame keeps its old shape.
      ...(this.tw.on ? {
        towersOn: true, timeLimit: this._timeLimit(), teamHpFloor: this.tw.floor,
        hpEvents: this.hpEvents.filter(e => this.elapsed - e.at <= 2),
        towerPts: this.towerPts.slice(),
        shield: this.depots ? this.depots.map(d => d.alive) : [false, false],
      } : {}),
      hooks: { source: this.decisions.id, drivers: this.drivers.slice(), warriorAutopilot: this.warriorAutopilot, warriorActiveS: this.warriorActiveS, npcDecisionS: this.npcDecisionS, doc: '/docs/TEAM-DECISIONS.md' },
      error: this.error || '',
      // The unit table this match runs on (units.csv). Watch pages draw and label units from it,
      // so a new row draws on the public relay page without a relay rebuild.
      unitTable: U.viewerTable().filter(row => this.mortarOn || row.role !== 'mortar'),
      unitsError: this.unitsError || '',
      // Ruleset in play (rules.js): short version (first 8 of sha256 over units.csv + economy.csv) and where it came from.
      rules: this.rulesInfo || undefined,
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
      // Base turrets (C.TURRET): drawn by the watch page. aim is the target point while it has one.
      turrets: (this.turrets || []).filter(t => t.max > 0).map(t => ({
        side: t.side, x: t.x, y: t.y, hp: r1(t.hp), max: t.max, alive: t.alive, rounds: this.rangeRounds ? this.rangeRounds[t.side].turret : 0, rangeBase: C.TURRET.range, range: this._rangeOf(t.side, 'turret', C.TURRET.range),
        angle: Math.round(t.angle * 100) / 100, aim: t.aimId != null ? { x: r1(t.aimX), y: r1(t.aimY) } : null,
        firedAt: t.firedAt, hitFlash: t.hitFlash || 0, downAt: t.downAt,
      })),
      // Field hospitals. Omitted when FIELD_HOSPITAL is off so a flag-off frame stays the old shape.
      ...(this.fieldHospital && this.hospitals ? { hospitals: this.hospitals.map(h => ({
        side: h.side, x: r1(h.x), y: r1(h.y), zone: h.zone, hp: r1(h.hp), max: h.max, alive: h.alive,
        rebuild: h.alive ? 0 : Math.ceil(Math.max(0, h.rebuild)), hitFlash: h.hitFlash || 0, downAt: h.downAt,
      })) } : {}),
      // Gun towers and depots (TOWERS=1). Hospitals stay in `hospitals`. aim is the target point while it has one.
      ...(this.tw.on ? { towers: this._towerFrames(r1) } : {}),
      units: this.units.map(u => ({
        id: u.id, tag: this._tagOf(u), side: u.side, type: u.type, x: r1(u.x), y: r1(u.y), hp: r1(u.hp), max: u.max,
        facingX: u.facingX || 0, facingY: u.facingY || 0, guard: !!u.guard, medicMode: u.medicMode || '',
        ...(u.hosp ? { hospital: u.hosp.phase } : {}),
        medicTargetId: u.medicTargetId, healing: !!u.healing, hitFlash: u.hitFlash || 0, age: u.age, spawnShield: u.spawnShield || 0,
      })),
      shots: this.shots.map(s => ({ x: s.x, y: s.y, tx: s.tx, ty: s.ty, type: s.type, side: s.side, col: s.col, life: s.life, maxLife: s.maxLife, ...(s.arc ? { arc: true } : {}) })),
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

AgrtsMatch.CMDR_DEBOUNCE_MS = 300;
module.exports = { AgrtsMatch, STEP, SPEED };
