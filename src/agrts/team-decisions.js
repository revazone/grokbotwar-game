'use strict';
// Team-decision seam for the 2-player AgRTS match (Iteration 11).
//
// The match calls ONLY the four functions on a decision source. Unit targeting,
// movement, attacking and healing stay in src/agrts/match.js and are not decisions.
//
//   draftArsenal(ctx)         -> { <type id>: count, ... }       opening 200-credit draft (ids from units.csv)
//   reinforcementQueue(ctx)   -> [typeId x 6]                    pre-match buy queue
//   considerDeploy(ctx)       -> { deploy: null | { types, guard, medicUrgent }, title?, detail? }
//   spendCredits(ctx)         -> { types, creditsLeft, bought }  territory-credit purchases
//
// SimulatedTeam (the functions below) is the Iteration 11 agent: balanced / pressure /
// armor drafts, a six-buy queue, waves of up to 3, hold the last unit unless the base
// is threatened, hold medics until an ally has lost 20 HP, spend the queue when credits allow.
//
// Swap without rewriting the sim:
//   match.useDecisions(createDecisionSource({ considerDeploy(ctx) { ... } }))
// Omitted functions stay simulated. createDecisionSource({ id: 'warrior', ... }).
// A claimed seat does not use that brain for its opening or for a posted wave.
// Those come from the seat (POST /api/seat/opening and POST /api/seat/decision).
// An empty warrior queue may fall back to considerDeploy after one open-field cadence.

const { TYPES, TYPE_IDS, FIELD_COST, DRAFT_BUDGET, ROSTER_LIMIT, MAX_BUYS, OPENING_STYLES, cloneCounts, total, minDraftCost } = require('./constants');

// The simulated brain thinks in roles (the role column of units.csv), not unit ids, so a new
// row is drafted, bought and deployed like the built-in unit with the same role.
// fast = Scout, ranged = Rifle, armor = Breaker, healer = Medic.
const WEIGHTS = {
  pressure: { fast: 7, ranged: 2, armor: 1, healer: 2 },
  armor: { fast: 1, ranged: 3, armor: 6, healer: 3 },
  balanced: { fast: 3, ranged: 4, armor: 2, healer: 3 },
  counter: { fast: 3, ranged: 3, armor: 3, healer: 2 },
};
// What each role is countered by.
const COUNTER = { fast: 'armor', ranged: 'fast', armor: 'ranged', healer: 'armor', kamikaze: 'ranged' };
// Roles the simulated draft and queue never pick on their own. A kamikaze unit (the Drone) is
// drafted only by the Ember commander (src/agrts/commander.js draftDrones) or a seat's opening,
// so a units.csv with a Drone row rolls the same simulated drafts and queues as one without it.
const SIM_SKIP = new Set(['kamikaze']);
const simTypes = () => TYPE_IDS.filter(k => !SIM_SKIP.has(roleOf(k)));

const roleOf = k => (TYPES[k] ? TYPES[k].role : '');
const isHealer = k => roleOf(k) === 'healer';
/** Sum of counts over the types with that role. */
function roleCount(counts, role) { return TYPE_IDS.reduce((n, k) => n + (roleOf(k) === role ? (counts[k] || 0) : 0), 0); }
/** First type with that role that has a count, in table order. */
function firstWithRole(counts, role) { return TYPE_IDS.find(k => roleOf(k) === role && counts[k] > 0) || null; }
/** A type with that role. One candidate costs no rng draw, so the built-in table rolls exactly as before. */
function pickRole(role, rng) {
  const ids = TYPE_IDS.filter(k => roleOf(k) === role);
  if (ids.length <= 1) return ids[0] || null;
  return ids[Math.floor(rng() * ids.length)];
}

function normalizeStyle(style) {
  return Object.prototype.hasOwnProperty.call(WEIGHTS, style) ? style : 'balanced';
}

function rngOf(ctx) { return typeof ctx.rng === 'function' ? ctx.rng : Math.random; }

/** Opening arsenal. Spends up to 200 credits, at most 24 units, biased by style. */
function simulatedDraft(ctx) {
  const rng = rngOf(ctx);
  const weights = WEIGHTS[normalizeStyle(ctx.style)];
  let left = DRAFT_BUDGET;
  const counts = cloneCounts({});
  const pool = simTypes();
  const cheapest = pool.length ? Math.min(...pool.map(k => TYPES[k].cost)) : minDraftCost();
  while (left >= cheapest && total(counts) < ROSTER_LIMIT) {
    const options = pool.filter(k => TYPES[k].cost <= left);
    if (!options.length) break;
    const scores = options.map(k => (weights[roleOf(k)] || 1) / (1 + counts[k] * 0.42));
    let draw = rng() * scores.reduce((a, b) => a + b, 0);
    let pick = options[0];
    for (let i = 0; i < options.length; i++) { draw -= scores[i]; if (draw <= 0) { pick = options[i]; break; } }
    counts[pick]++;
    left -= TYPES[pick].cost;
  }
  return counts;
}

/** Six reinforcement purchases, decided before the first shot. */
function simulatedQueue(ctx) {
  const rng = rngOf(ctx);
  const style = normalizeStyle(ctx.style);
  const mine = cloneCounts(ctx.ours || {});
  const enemy = cloneCounts(ctx.theirs || {});
  const queue = [];
  for (let slot = 0; slot < MAX_BUYS; slot++) {
    let pick = null;
    if (style === 'pressure') pick = pickRole(slot === 0 || rng() < 0.65 ? 'fast' : (rng() < 0.5 ? 'ranged' : 'healer'), rng);
    else if (style === 'armor') pick = pickRole(slot === 0 || rng() < 0.55 ? 'armor' : (rng() < 0.5 ? 'ranged' : 'healer'), rng);
    else if (style === 'counter' && slot === 0) {
      const high = Math.max(...TYPE_IDS.map(k => enemy[k]));
      const dominant = TYPE_IDS.filter(k => enemy[k] === high);
      pick = pickRole(COUNTER[roleOf(dominant[Math.floor(rng() * dominant.length)])], rng);
    } else if (roleCount(enemy, 'armor') > 0 && roleCount(mine, 'ranged') === 0) pick = pickRole('ranged', rng);
    else if (roleCount(enemy, 'fast') > 1 && roleCount(mine, 'armor') === 0) pick = pickRole('armor', rng);
    // No type with the wanted role in units.csv: diversify like the default branch.
    if (!pick) {
      const pool = simTypes();
      const low = Math.min(...pool.map(k => mine[k]));
      const candidates = pool.filter(k => mine[k] === low);
      pick = candidates[Math.floor(rng() * candidates.length)];
    }
    queue.push(pick);
    mine[pick]++;
  }
  return queue;
}

function fillWave(reserve, preferred, style, { emergency = false, medicUrgent = false } = {}) {
  const keep = emergency || medicUrgent ? 0 : 1;
  const size = Math.min(3, Math.max(0, total(reserve) - keep));
  if (!size) return [];
  const local = cloneCounts(reserve);
  const types = [];
  if (local[preferred] > 0) { types.push(preferred); local[preferred]--; }
  if (!isHealer(preferred)) for (const k of TYPE_IDS) if (isHealer(k)) local[k] = 0;
  while (types.length < size) {
    const available = TYPE_IDS.filter(k => local[k] > 0);
    if (!available.length) break;
    let k;
    if (style === 'pressure' && firstWithRole(local, 'fast')) k = firstWithRole(local, 'fast');
    else if (style === 'armor' && firstWithRole(local, 'armor')) k = firstWithRole(local, 'armor');
    else k = available.slice().sort((a, b) => local[b] - local[a])[0];
    types.push(k);
    local[k]--;
  }
  return types;
}

/** Open-field deploy cadence. Green waits 5.2s, Ember 4.4s. Threat and medic waits are shorter. */
function openFieldWait(side) {
  return side === 0 ? 5.2 : 4.4;
}

/**
 * Deploy, hold, base-threat response, or a medic release.
 * ctx: { side, style, elapsed, lastDeployAt, width, height, reserve, units:[{side,type,x,y,hp,max}], hp, rng }
 * Returns immediately with deploy:null when the cadence has not elapsed (2.8s under threat,
 * 1.5s when a medic is needed, otherwise openFieldWait). A hold does not reset that clock;
 * the match only updates lastDeployAt after a wave actually leaves the reserve.
 */
function simulatedConsider(ctx) {
  const { side, elapsed, lastDeployAt, width, height, units } = ctx;
  const style = normalizeStyle(ctx.style);
  const rem = cloneCounts(ctx.reserve || {});
  const foeHere = u => side === 0 ? u.x < width * 0.29 : u.x > width * 0.71;
  const threat = units.some(u => u.side !== side && foeHere(u));
  const medicNeed = roleCount(rem, 'healer') > 0 && units.some(u => u.side === side && !isHealer(u.type) && u.hp <= u.max - 20);
  const wait = threat ? 2.8 : medicNeed ? 1.5 : openFieldWait(side);
  if (elapsed - lastDeployAt < wait) return { deploy: null };

  const available = TYPE_IDS.filter(k => rem[k] > 0);
  if (!available.length) return { deploy: null };
  if (medicNeed) {
    const types = fillWave(rem, firstWithRole(rem, 'healer'), style, { medicUrgent: true });
    return {
      deploy: types.length ? { types, guard: false, medicUrgent: true } : null,
      title: 'WOUNDED ALLY · RELEASE MEDIC',
      detail: 'Medic held in reserve until a teammate is badly hurt; deploying now.',
    };
  }
  const combatAvailable = available.filter(k => !isHealer(k));
  if (!combatAvailable.length) {
    return {
      deploy: null,
      title: 'MEDICS HELD IN RESERVE',
      detail: 'No ally needs urgent healing. The remaining medics stay back until one is wounded.',
    };
  }
  const foe = units.filter(u => u.side !== side).length;
  const own = units.filter(u => u.side === side).length;
  if (total(rem) <= 1 && !threat) {
    return {
      deploy: null,
      title: 'HOLDING LAST UNIT AS BASE GUARD',
      detail: 'Keeping one unit ready. It will deploy only if an enemy pushes into base territory.',
    };
  }
  let k;
  let guard = false;
  if (threat) {
    k = combatAvailable.slice().sort((a, b) => (TYPES[b].hp + TYPES[b].dmg * 3) - (TYPES[a].hp + TYPES[a].dmg * 3))[0];
    guard = true;
  } else {
    const fast = firstWithRole(rem, 'fast'), ranged = firstWithRole(rem, 'ranged'), armor = firstWithRole(rem, 'armor');
    if (style === 'pressure') k = fast || combatAvailable[0];
    else if (style === 'armor') k = armor && elapsed > 6 ? armor : ranged || combatAvailable[0];
    else if (style === 'counter') k = foe >= 2 && armor ? armor : foe > own && ranged ? ranged : fast || combatAvailable[0];
    else k = foe > own + 1 && armor ? armor : fast && elapsed < 13 ? fast : ranged || combatAvailable[0];
  }

  const types = fillWave(rem, k, style, { emergency: guard });
  if (!types.length) return { deploy: null };
  if (guard) {
    return {
      deploy: { types, guard: true, medicUrgent: false },
      title: 'BASE GUARD DEPLOYED · ' + TYPES[types[0]].name.toUpperCase(),
      detail: 'Guard has entered the field and is protected during its arrival.',
    };
  }
  const role = roleOf(k), NAME = TYPES[k].name.toUpperCase();
  const title = role === 'armor' ? `COMMITTING ${NAME}` : role === 'ranged' ? 'ADDING RANGED SUPPORT' : role === 'healer' ? 'SENDING FIELD SUPPORT' : `RELEASING ${NAME}`;
  const detail = side === 0
    ? `Plan: ${style}. ${foe > own ? 'Enemy pressure is building.' : 'Maintaining a measured advance.'}`
    : `Counter-plan reads ${foe > own ? 'enemy advantage' : 'open field'}; releasing ${TYPES[k].name.toLowerCase()}.`;
  return { deploy: { types, guard: false, medicUrgent: false }, title, detail };
}

/** Buy from the front of the queue while credits remain. Land gains stop after six purchases. */
function simulatedSpend(ctx) {
  let left = ctx.credits;
  let n = ctx.bought || 0;
  const queue = ctx.queue || [];
  const max = ctx.maxBuys || MAX_BUYS;
  const types = [];
  while (n < max && queue[n]) {
    const type = queue[n];
    const cost = FIELD_COST[type];
    if (!(left >= cost)) break;
    left -= cost;
    n++;
    types.push(type);
  }
  return { types, creditsLeft: left, bought: n };
}

function createDecisionSource(overrides = {}) {
  const replaced = ['draftArsenal', 'reinforcementQueue', 'considerDeploy', 'spendCredits'].some(k => typeof overrides[k] === 'function');
  return {
    id: overrides.id || (replaced ? 'custom' : 'simulated'),
    draftArsenal: overrides.draftArsenal || simulatedDraft,
    reinforcementQueue: overrides.reinforcementQueue || simulatedQueue,
    considerDeploy: overrides.considerDeploy || simulatedConsider,
    spendCredits: overrides.spendCredits || simulatedSpend,
  };
}

/** Seat opening: arsenal counts, up to six buy types, and whether to spend territory credits. */
function validateOpening(msg) {
  const raw = msg && msg.arsenal;
  if (!raw || typeof raw !== 'object') return { error: `arsenal must be { ${TYPE_IDS.join(', ')} }` };
  const arsenal = {};
  for (const k of TYPE_IDS) {
    const n = raw[k] == null ? 0 : raw[k];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return { error: `${k} must be a non-negative integer` };
    arsenal[k] = n;
  }
  const cost = TYPE_IDS.reduce((sum, k) => sum + arsenal[k] * TYPES[k].cost, 0);
  const n = total(arsenal);
  for (const k of TYPE_IDS) {
    const cap = TYPES[k].maxAlive | 0;
    if (cap > 0 && arsenal[k] > cap) return { error: `${k} at most ${cap} in an arsenal (max_alive)` };
  }
  if (cost > DRAFT_BUDGET) return { error: `arsenal costs ${cost} CR; budget is ${DRAFT_BUDGET}` };
  if (n > ROSTER_LIMIT) return { error: `arsenal has ${n} units; limit is ${ROSTER_LIMIT}` };
  const queue = [];
  if (msg.queue != null) {
    if (!Array.isArray(msg.queue)) return { error: 'queue must be an array of type ids' };
    if (msg.queue.length > MAX_BUYS) return { error: `queue holds at most ${MAX_BUYS} buys` };
    for (const t of msg.queue) {
      if (!TYPE_IDS.includes(t)) return { error: `unknown queue type ${t}` };
      queue.push(t);
    }
  }
  return { arsenal, queue, spend: msg.spend === true };
}

function mobileDecision(title) {
  const rules = [
    [/AWAITING WARRIOR/i, 'AWAITING WARRIOR'],
    [/WARRIOR OPENING|WARRIOR DEPLOY/i, 'WARRIOR ORDER'],
    [/WOUNDED ALLY|FIELD SUPPORT|MEDIC/i, 'MEDIC → WOUNDED'],
    [/BASE GUARD DEPLOYED/i, 'GUARD DEPLOYED'],
    [/HOLDING LAST UNIT|MEDICS HELD/i, 'HOLDING RESERVE'],
    [/BASE GUARD|THREAT|DEFEND/i, 'DEFENDING BASE'],
    [/BREAKER/i, 'DEPLOYING BREAKER'],
    [/RANGED SUPPORT/i, 'ADDING RIFLE'],
    [/SCOUT/i, 'DEPLOYING SCOUT'],
    [/RESERVE/i, 'HOLDING RESERVE'],
  ];
  return (rules.find(([re]) => re.test(title || '')) || [])[1] || String(title || 'Reading field…');
}

function describeHooks() {
  return {
    doc: 'docs/TEAM-DECISIONS.md',
    module: 'src/agrts/team-decisions.js',
    current: 'simulated until a seat is claimed',
    styles: ['balanced', 'pressure', 'armor', 'counter'],
    openingRoll: OPENING_STYLES,
    swap: 'match.useDecisions(createDecisionSource({ id, draftArsenal, reinforcementQueue, considerDeploy, spendCredits }))',
    drivers: 'Each side starts simulated. Claiming a seat sets that side to warrior. Deploy orders stay queued across a restart. An empty queue holds for one open-field cadence, then considerDeploy may field a wave unless the match was constructed with warriorAutopilot:false (arena env WARRIOR_AUTOPILOT=0), or the seat is in a report long-poll or has fetched a report or posted an order within WARRIOR_ACTIVE_S match seconds (default 20). The other side stays simulated. Ember, while simulated, is called at most once per NPC_DECISION_S match seconds (default 4.4), with the first call allowed at T0. NPC_DECISION_S=0 calls it every step. A seated Ember is not gated. While simulated, Ember is played by its commander (src/agrts/commander.js): on each of those windows it posts DEPLOY ALL, MOVE ALL (rally z6, then push together), ASSIST, FOCUS, AUTOBUY and FALLBACK through the same wire path a seat uses, with a seeded temperament per match (rally z5-z7, push nerve, focus pick, fallback HP) and small per-window dice (wait, push early, hold, regroup early); the same seed replays the same match, and considerDeploy/spendCredits are not called for it. EMBER_COMMANDER=0 brings back the wave brain; a swapped brain (useDecisions) turns the commander off. Movement, targeting, shots and healing stay on every step.',
    units: 'Unit types, prices and codes come from units.csv, re-read at the start of every match (docs/SPEC.md, Unit table).',
    seatOpening: `POST /api/seat/opening { join_token, arsenal:{${TYPE_IDS.join(',')}}, queue?:[type], spend?:true } — next match, or this match if it has not stepped`,
    seatQueue: `POST /api/seat/decision { join_token, types?: [${TYPE_IDS.join('|')}], hold?: true, guard?: true, title?, detail? } — the deploy order for a warrior seat. Kept across restart, so a post while the match is held deploys on the next match. One step ahead of the simulated brain otherwise.`,
    seatPlan: 'POST /api/seat/plan { join_token, style } — style label for the next match (this match if it has not stepped). A warrior seat still needs an opening arsenal.',
    calls: [
      { name: 'draftArsenal', when: 'match start, each side', args: '{ side, style, rng }', returns: `{ ${TYPE_IDS.join(', ')} } within 200 credits and 24 units` },
      { name: 'reinforcementQueue', when: 'match start, after both drafts', args: '{ side, ours, theirs, style, rng }', returns: '6 type ids, bought later with territory credits' },
      { name: 'considerDeploy', when: 'every 50ms sim step', args: '{ side, style, elapsed, lastDeployAt, width, height, reserve, units, hp, rng }', returns: '{ deploy: null | { types (max 3), guard, medicUrgent }, title?, detail? }' },
      { name: 'spendCredits', when: 'after a territory credit gain', args: '{ side, credits, queue, bought, maxBuys }', returns: '{ types, creditsLeft, bought }' },
    ],
    notHere: 'Target choice, movement, pathing, attacking and healing are automatic in src/agrts/match.js.',
    protocol: 'Wire protocol v2, one outbox per seat (docs/TEAM-DECISIONS.md). The line starts with v2. It leads with the delta (their medic changes are named, e.g. E +1M, now 3M), a situation tag (ahead, even, behind, base-threat) plus the count of their units near our base (base-threat 4E), zone totals (z 5/2, c1 when a zone has both sides), an income hint, and can-buy with live price and count (T52x1 S28x2, the same price a BUY is charged). The warrior long-polls GET /api/seat/report?since=&wait= (max 30s) until END. When a relay is configured, next and orders use the same calls on the relay (GET /r/<room>/seat/report and POST /r/<room>/seat/orders) with the same bearer; a relay long-poll counts as talking. POST /api/seat/orders does not emit an ORDER record. The JSON reply carries the OK/ERR lines and a fresh state line. An order after END is refused with ERR match over. READY is written while the match waits for a viewer. COUNTDOWN is not written to the seat. START is written at T0. The note is present when the other side drafts or buys, when autopilot acted, on a T0 miss, and on END. DEPLOY while armed is queued for T0. DEPLOY ALL fields the reserve up to the active cap (ACTIVE_CAP, 6 on the field, drones included; res shows act 6/6), and the rest waits in reserve. Each base pays BASE_INCOME (4) per income tick on top of zone income. fight returns at once. Orders that name a report id record decide_ms, and the END note summarizes them. An optional WHY line on the same post is the dim reason under those orders in the side-panel feed and does not count toward the 3 order lines. Ember simulated decisions show a short reason from the decision label.',
    medicRule: 'Medics stay in reserve until an ally has lost 20 HP or more.',
    economy: 'A new frontier claim pays 28 credits. Each held enemy-side zone adds 12 every 4.2s. Spending stops after 6 buys.',
  };
}

module.exports = {
  simulatedDraft, simulatedQueue, simulatedConsider, simulatedSpend, fillWave, openFieldWait,
  createDecisionSource, normalizeStyle, validateOpening, mobileDecision, describeHooks, WEIGHTS,
};
