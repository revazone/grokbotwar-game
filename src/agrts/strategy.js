'use strict';
// "Your Agent's Strategy" (docs/STRATEGY-CARD.md): the settings a player picks on the watch page before a match, and
// the pure helpers around them. No I/O. The arena validates and stores them (host.js), the loop reads them with
// `node tools/warrior-seat.js strategy`, and the watch page card uses a byte-identical copy of this file
// (relay/public/agrts-strategy-core.js; tools/test-strategy.js fails if the two differ).
(function (root, make) {
  const api = make();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.GbwStrategy = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const SLOTS = 6;          // opening units: the active cap
  const MAX_TANKS = 2;      // Breakers
  const MAX_MEDICS = 2;
  const MAX_DRONES = 4;     // units.csv max_alive for the Drone (the arena's own table overrides this when the card is given it)
  const DRAFT_BUDGET = 200; // credits an opening may spend (the arena's DRAFT_BUDGET; opening units cost their draft_cost)
  // The six units of the opening mix, in card order: arena unit id -> strategy count field.
  const UNIT_IDS = ['scout', 'rifle', 'tank', 'medic', 'drone', 'mortar', 'mine'];
  const COUNT_KEY = { scout: 'scouts', rifle: 'rifles', tank: 'tanks', medic: 'medics', drone: 'drones', mortar: 'mortars', mine: 'mines' };
  const COUNT_FIELDS = UNIT_IDS.map(id => COUNT_KEY[id]);
  // The six units as units.csv has them, for a caller with no live unit table (an older arena, a test). The arena sends its own table
  // with the card, so a ruleset change reaches the card at once; tools/test-strategy.js fails if this drifts from units.csv.
  const FALLBACK_UNITS = [
    { id: 'scout', name: 'Scout', desc: 'Fields x3. Flanker: dives past the front at mortars and medics (x2.5 dmg), shrugs off half of splash. Runner: takes zones 2x faster, builds OB/FOB twice as fast.', color: '#bafc82', draft: 12, live: 28, hp: 25, dmg: 5, range: 38, maxAlive: 0 },
    { id: 'rifle', name: 'Rifle', desc: 'Reliable ranged support.', color: '#8ee5c1', draft: 20, live: 40, hp: 40, dmg: 8, range: 100, maxAlive: 0 },
    { id: 'tank', name: 'Breaker', desc: 'Slow armor, heavy base damage.', color: '#efbd68', draft: 34, live: 70, hp: 92, dmg: 18, range: 40, maxAlive: 2 },
    { id: 'medic', name: 'Medic', desc: 'Light support with staying power.', color: '#a9c7ff', draft: 24, live: 36, hp: 34, dmg: 3, range: 58, maxAlive: 0 },
    { id: 'drone', name: 'Drone', desc: 'Fast suicide unit, splash on impact.', color: '#e59cff', draft: 10, live: 20, hp: 7, dmg: 36, range: 30, maxAlive: 4 },
    { id: 'mortar', name: 'Mortar', desc: 'Slow tube. Shells past rifle range, over walls.', color: '#e6c36a', draft: 26, live: 44, hp: 28, dmg: 14, range: 188, maxAlive: 0 },
    { id: 'mine', name: 'Mine', desc: 'Land mine pack x3. Laid hidden at your front line, arms in 3s, blasts enemy ground units that step close. Drones fly over.', color: '#c9b27a', draft: 18, live: 36, hp: 1, dmg: 30, range: 20, maxAlive: 3 },
  ];
  const DRAFT_COST = Object.fromEntries(FALLBACK_UNITS.map(u => [u.id, u.draft]));
  const NOTE_MAX = 200;
  const PLAN_IDS = ['balanced', 'aggressive', 'defensive'];
  const HOLDS = ['z3', 'z4'];
  const PUSHES = ['early', 'normal', 'late'];
  const MEDICS = ['none', 'one_early', 'two_by_t60'];
  const PUSH_T = { early: 30, normal: 60, late: 200 };               // early: from T30 when level or ahead. normal (today's loop): ahead from T30, level from T60. late: T200, only when behind on HP
  const PUSH_LABEL = { early: 'T30', normal: 'T60 if level', late: 'T200' };   // the small text under each Push timing button
  const PUSH_WHEN = { early: 'ahead', normal: 'ahead', late: 'hp' };     // late: only when behind on Team HP
  const MEDIC_TOTAL = { none: 0, one_early: 1, two_by_t60: 2 };          // medics on the roster by T60 (opening medics included)
  const MEDIC_OPEN = { none: 0, one_early: 1, two_by_t60: 1 };           // what the card puts in the opening for each option
  const ASSAULT_BEFORE_END = 42;   // the loop's last-gasp depot assault starts 42 s before the time limit (T318 of 360)
  const HOLD_Z3_UNITS = 4;         // hold z3 until this many units are fielded

  // Presets. Balanced is today's play: its opening is exactly what state/openings.json holds for the Green seat
  // (3 Rifles, 2 Breakers, buy queue rifle tank rifle, spend on), so picking it changes nothing.
  const PLANS = {
    balanced:   { id: 'balanced',   name: 'Balanced',   scouts: 0, rifles: 3, tanks: 2, medics: 0, drones: 0, mortars: 0, mines: 0, hold: 'z4', push: 'normal', medic: 'none',       queue: ['rifle', 'tank', 'rifle'] },
    aggressive: { id: 'aggressive', name: 'Aggressive', scouts: 0, rifles: 4, tanks: 1, medics: 0, drones: 0, mortars: 0, mines: 0, hold: 'z4', push: 'early',  medic: 'none',       queue: ['rifle', 'rifle', 'rifle'] },
    defensive:  { id: 'defensive',  name: 'Defensive',  scouts: 0, rifles: 3, tanks: 1, medics: 1, drones: 0, mortars: 0, mines: 0, hold: 'z3', push: 'late',   medic: 'one_early',  queue: ['rifle', 'rifle'] },
  };
  const FIELDS = ['plan', ...COUNT_FIELDS, 'hold', 'push', 'medic', 'note'];

  /** The full strategy a plan stands for (a fresh object). */
  function fromPlan(plan) {
    const p = PLANS[plan] || PLANS.balanced;
    return { plan: p.id, scouts: p.scouts, rifles: p.rifles, tanks: p.tanks, medics: p.medics, drones: p.drones, mortars: p.mortars, mines: p.mines, hold: p.hold, push: p.push, medic: p.medic, note: '' };
  }

  /** One line, no control characters, no `"` or `|` (report delimiters), at most NOTE_MAX. Never throws. */
  function cleanNote(s) {
    return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f"|]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const isCount = n => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  // Mines take no field slot (docs/MINES.md), so they are left out of the n / 6 count.
  const SLOT_FIELDS = COUNT_FIELDS.filter(k => k !== COUNT_KEY.mine);
  const slots = s => SLOT_FIELDS.reduce((n, k) => n + (s[k] | 0), 0);

  // ---------- the arena's opening limits ----------
  const CARD_CAP = { tank: MAX_TANKS, medic: MAX_MEDICS };           // card rules: 2 Breakers, 2 medics
  const DEFAULT_ALIVE = { tank: MAX_TANKS, drone: MAX_DRONES };      // units.csv max_alive, when no live table is given
  const LABEL = { scout: 'scouts', rifle: 'rifles', tank: 'breakers', medic: 'medics', drone: 'drones', mortar: 'mortars', mine: 'mines' };
  const NAME = { scout: 'Scout', rifle: 'Rifle', tank: 'Breaker', medic: 'Medic', drone: 'Drone', mortar: 'Mortar', mine: 'Mine' };

  /**
   * The rules a strategy is checked against: env = { slots, budget, units: { <id>: { draft, maxAlive, open, why } } }, every part optional.
   * The arena builds it from its live unit table (units.csv + economy.csv) and sends it with the card; without it the defaults above apply.
   * open:false marks a unit that cannot be in an opening wave (why = the short reason the card shows).
   */
  function limits(env) {
    const e = env && typeof env === 'object' ? env : {};
    const u = e.units && typeof e.units === 'object' ? e.units : {};
    const unit = id => {
      const x = u[id] && typeof u[id] === 'object' ? u[id] : {};
      const alive = Number.isFinite(x.maxAlive) ? x.maxAlive : (DEFAULT_ALIVE[id] || 0);
      const caps = [CARD_CAP[id], alive > 0 ? alive : 0].filter(n => n > 0);
      return { draft: Number.isFinite(x.draft) ? x.draft : DRAFT_COST[id], cap: caps.length ? Math.min(...caps) : 0, open: x.open !== false, why: typeof x.why === 'string' && x.why ? x.why : 'not in this ruleset' };
    };
    return { slots: Number.isFinite(e.slots) && e.slots > 0 ? Math.min(SLOTS, Math.floor(e.slots)) : SLOTS, budget: Number.isFinite(e.budget) && e.budget > 0 ? e.budget : DRAFT_BUDGET, unit };
  }

  /** Credits the opening costs: the draft cost of every unit in it. */
  function cost(s, env) { const L = limits(env); return UNIT_IDS.reduce((n, id) => n + (s[COUNT_KEY[id]] | 0) * L.unit(id).draft, 0); }

  /** Why one more of this unit (arena id) cannot be added right now, or '' when it can. Short, for the card. */
  function limit(s, id, env) {
    const L = limits(env), u = L.unit(id), k = COUNT_KEY[id];
    if (!u.open) return u.why;
    if (u.cap > 0 && (s[k] | 0) >= u.cap) return `max ${u.cap} ${LABEL[id]}`;
    if (slots(s) >= L.slots) return `${L.slots} / ${L.slots} slots full`;
    if (cost(s, env) + u.draft > L.budget) return `over the ${L.budget} CR budget`;
    return '';
  }

  /** The smallest Medic Support option that covers this many medics by T60. */
  const medicFor = n => (n >= 2 ? 'two_by_t60' : n === 1 ? 'one_early' : 'none');

  /**
   * Validate a strategy. Missing fields default from the plan (default Balanced), so { plan: 'defensive' } is valid.
   * env (optional, see limits) carries the arena's live unit table; without it the built-in limits apply.
   * Returns { ok: true, strategy } or { ok: false, error, field }.
   */
  function validate(input, env) {
    const src = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
    if (!src) return { ok: false, error: 'strategy must be an object', field: 'strategy' };
    const plan = src.plan == null ? 'balanced' : src.plan;
    if (!PLAN_IDS.includes(plan)) return { ok: false, error: `plan must be one of ${PLAN_IDS.join(', ')}`, field: 'plan' };
    const s = fromPlan(plan);
    for (const k of COUNT_FIELDS) {
      if (src[k] == null) continue;
      if (!isCount(src[k])) return { ok: false, error: `${k} must be a whole number, 0 or more`, field: k };
      s[k] = src[k];
    }
    for (const [k, list] of [['hold', HOLDS], ['push', PUSHES], ['medic', MEDICS]]) {
      if (src[k] == null) continue;
      if (!list.includes(src[k])) return { ok: false, error: `${k} must be one of ${list.join(', ')}`, field: k };
      s[k] = src[k];
    }
    if (src.note != null) {
      if (typeof src.note !== 'string') return { ok: false, error: 'note must be text', field: 'note' };
      const n = cleanNote(src.note);
      if (n.length > NOTE_MAX) return { ok: false, error: `note is at most ${NOTE_MAX} characters`, field: 'note' };
      s.note = n;
    }
    const L = limits(env);
    for (const id of UNIT_IDS) {
      const k = COUNT_KEY[id], n = s[k], u = L.unit(id);
      if (!n) continue;
      if (!u.open) return { ok: false, error: `${NAME[id]} cannot be in the opening: ${u.why}`, field: k };
      if (u.cap > 0 && n > u.cap) return { ok: false, error: `at most ${u.cap} ${LABEL[id]}${id === 'tank' ? ' (tanks)' : ''}`, field: k };
    }
    if (slots(s) > L.slots) {
      const big = COUNT_FIELDS.reduce((m, k) => (s[k] > s[m] ? k : m), COUNT_FIELDS[0]);
      return { ok: false, error: `at most ${L.slots} units in the opening (you picked ${slots(s)})`, field: big };
    }
    if (cost(s, env) > L.budget) return { ok: false, error: `the opening costs ${cost(s, env)} CR; the budget is ${L.budget} CR`, field: 'cost' };
    if (MEDIC_TOTAL[s.medic] < s.medics) s.medic = medicFor(s.medics);   // medics in the opening count toward Medic Support
    return { ok: true, strategy: s };
  }

  /**
   * A short id for a strategy (12 hex): the same plan always has the same id, any dial or the note changes it. The card shows it, the arena
   * and the audit trail record it, so "the plan I approved" can be compared by eye. Plain JS (no crypto), so the page and the arena agree.
   * It names a plan; it is not a security hash.
   */
  function hash(s) {
    const x = s && typeof s === 'object' ? s : {};
    const str = [x.plan, x.hold, x.push, x.medic, cleanNote(x.note), ...COUNT_FIELDS.map(k => x[k] | 0)].join('|');
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < str.length; i++) { const k = str.charCodeAt(i); h1 = h2 ^ Math.imul(h1 ^ k, 597399067); h2 = h3 ^ Math.imul(h2 ^ k, 2869860233); h3 = h4 ^ Math.imul(h3 ^ k, 951274213); h4 = h1 ^ Math.imul(h4 ^ k, 2716044179); }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067); h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233); h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213); h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    const hex = n => (n >>> 0).toString(16).padStart(8, '0');
    return (hex(h1 ^ h2 ^ h3 ^ h4) + hex(h2 ^ h1)).slice(0, 12);
  }

  /** True when any dial differs from what the plan stands for (the card shows a small CUSTOM tag). The note does not count. */
  function isCustom(s) {
    const p = PLANS[s.plan] || PLANS.balanced;
    return COUNT_FIELDS.some(k => (s[k] | 0) !== p[k]) || ['hold', 'push', 'medic'].some(k => s[k] !== p[k]);
  }

  /** Choosing a medic option sets the opening medics the card shows (and trims rifles if that would pass 6 slots). */
  function withMedic(s, medic) {
    const n = { ...s, medic, medics: MEDIC_OPEN[medic] };
    while (slots(n) > SLOTS && n.rifles > 0) n.rifles--;
    return n;
  }

  /** One unit count changed (n >= 0). Raising the medics also lifts Medic Support so the two never disagree. */
  function withCount(s, key, n) {
    const x = { ...s, [key]: Math.max(0, n | 0) };
    if (key === 'medics' && MEDIC_TOTAL[x.medic] < x.medics) x.medic = medicFor(x.medics);
    return x;
  }

  /** Choosing a plan resets every dial to it and keeps the note. */
  function withPlan(s, plan) { return { ...fromPlan(plan), note: s && s.note ? s.note : '' }; }

  /** Time the last-gasp assault starts, from the match time limit (seconds). Default 360 -> 318. */
  function assaultT(timeLimitS) { const t = Number(timeLimitS); return Math.round((Number.isFinite(t) && t > 60 ? t : 360) - ASSAULT_BEFORE_END); }

  /**
   * The opening command body for this strategy: { arsenal, queue, spend } (what `opening` posts). The buy queue carries the medics the
   * Medic Support dial asks for beyond the opening (second slot), so the arena buys them itself: the loop needs no medic logic.
   */
  function opening(s) {
    const p = PLANS[s.plan] || PLANS.balanced;
    let queue = p.queue.filter(x => x !== 'medic');
    if (s.tanks === 0) queue = queue.filter(x => x !== 'tank');
    const extra = Math.max(0, MEDIC_TOTAL[s.medic] - s.medics);
    queue.splice(Math.min(1, queue.length), 0, ...Array(extra).fill('medic'));
    return { arsenal: Object.fromEntries(UNIT_IDS.map(id => [id, s[COUNT_KEY[id]] | 0])), queue, spend: true };
  }

  /** Shell-safe single-quoted string. */
  const shq = v => `'${String(v).replace(/'/g, `'\\''`)}'`;

  /**
   * The strategy as key=value lines the loop can `eval`. Every value is a plain token except strategy_note (single-quoted).
   * ctx: { set (a player submitted it), approved (for this match), assaultT, applied (opening already posted for this match), overridden (always 0 now: a seat opening after lock is refused),
   * source (agent_proposal | owner_edit | default), hash, proposed (the agent proposed this match's plan), deviations (plan_deviation kinds seen this match) }.
   */
  function toKv(s, ctx) {
    const c = ctx || {};
    const lines = [
      ['plan', s.plan], ['custom', isCustom(s) ? 1 : 0], ['rifles', s.rifles], ['tanks', s.tanks], ['medics', s.medics],
      ['scouts', s.scouts | 0], ['drones', s.drones | 0], ['mortars', s.mortars | 0], ['mines', s.mines | 0], ['open_cost', cost(s, c.env)],
      ['hold', s.hold], ['hold_until_units', s.hold === 'z3' ? HOLD_Z3_UNITS : 0],
      ['push', s.push], ['push_t', PUSH_T[s.push]], ['push_when', PUSH_WHEN[s.push]],
      ['medic', s.medic], ['medic_total', MEDIC_TOTAL[s.medic]], ['medic_extra', Math.max(0, MEDIC_TOTAL[s.medic] - s.medics)],
      ['assault_t', c.assaultT != null ? c.assaultT : assaultT(360)],
      ['set', c.set ? 1 : 0], ['approved', c.approved ? 1 : 0], ['opening_applied', c.applied ? 1 : 0], ['opening_overridden', c.overridden ? 1 : 0],
      ['locked', c.approved ? 1 : 0], ['source', c.source || 'default'], ['hash', c.hash || hash(s)], ['proposed', c.proposed ? 1 : 0],
      ['plan_deviation', Array.isArray(c.deviations) && c.deviations.length ? c.deviations.join(',') : 'none'],
    ].map(([k, v]) => `strategy_${k}=${v}`);
    lines.push(`strategy_note=${shq(s.note || '')}`);
    return lines.join('\n') + '\n';
  }

  // ---------- card text (first person, the agent's voice) ----------
  const AGENT_NOTES = {
    balanced: "This is my tested default: steady, flexible, and it reads the fight as it comes.",
    aggressive: "A bigger first wave can win Z4 before Ember's medics arrive, but it costs me if they hold.",
    defensive: "Ember opens with medics, so I'd start Defensive.",
  };
  const agentNote = plan => AGENT_NOTES[plan] || AGENT_NOTES.balanced;

  /** Commander's Intent, in the agent's voice, built from the dials so it always matches what the card shows. */
  function intent(s) {
    const first = s.hold === 'z3' ? "I'll hold Z3 under our gun tower until I have four units" : "I'll take Z4 fast, hold the center";
    const med = s.medic === 'one_early' ? 'bring a medic early' : s.medic === 'two_by_t60' ? 'bring two medics by T60' : '';
    const push = s.push === 'early' ? `push early (T${PUSH_T.early}) once we're level or ahead`
      : s.push === 'late' ? `stay patient and push late (T${PUSH_T.late}) only if we're behind on HP`
      : "push when we're ahead";
    const extra = [];
    if (s.scouts) extra.push(s.scouts > 1 ? 'send scouts ahead' : 'send a scout ahead');
    if (s.mortars) extra.push(s.mortars > 1 ? 'set mortars behind the line' : 'set a mortar behind the line');
    if (s.drones) extra.push(s.drones > 1 ? 'keep drones for a splash strike' : 'keep a drone for a splash strike');
    const lead = [med, ...extra].filter(Boolean);
    return `${first}, ${lead.length ? lead.join(', ') + ', ' : ''}and ${push}.`;
  }

  /** A short line when an order is risky, else ''. */
  function risk(s) {
    if (s.mortars && !(s.rifles + s.tanks + s.scouts + s.drones)) return "I'll follow this, but a mortar with nothing in front of it is easy prey.";
    if (s.scouts >= 3) return "I'll follow this, but scouts fold fast against Rifles.";
    if (s.push === 'early') return "I'll follow this, but expect trouble against medics.";
    if (s.push === 'late') return "I'll follow this, but I may give up ground early.";
    if (s.medic === 'two_by_t60') return "I'll follow this, but two medics slow my first wave.";
    if (s.hold === 'z3' && s.push !== 'late') return "I'll follow this, but holding Z3 gives Ember the middle.";
    return '';
  }

  const ACKS = [
    [/mortar/i, "Understood, I'll save credits for a mortar."],
    [/medic|heal/i, "Understood, I'll get medics out first."],
    [/hospital/i, "Understood, I'll keep help ready for the hospital."],
    [/depot/i, "Understood, I'll go for their depot when I can reach it."],
    [/drone/i, "Understood, I'll focus their drones."],
    [/retreat|fall ?back|back off|pull back/i, "Understood, I'll fall back sooner."],
    [/save|bank/i, "Understood, I'll save credits."],
    [/spend|buy/i, "Understood, I'll spend what we have."],
    [/hold|defend/i, "Understood, I'll hold the line."],
    [/push|attack|press|forward/i, "Understood, I'll press when we're ahead."],
  ];
  /** The agent's acknowledgement of a free-text note ('' when there is none). */
  function ack(note) {
    const n = cleanNote(note);
    if (!n) return '';
    for (const [re, line] of ACKS) if (re.test(n)) return line;
    return "Understood, I'll work that in.";
  }

  /** The env (see limits) for a strategy view the arena sent: { slots, budget, units: [{ id, draft, maxAlive, open, why }] }. */
  function envFromView(v) {
    const x = v && typeof v === 'object' ? v : {};
    const units = {};
    if (Array.isArray(x.units)) for (const u of x.units) if (u && typeof u.id === 'string') units[u.id] = { draft: u.draft, maxAlive: u.maxAlive, open: u.open, why: u.why };
    return { slots: x.slots, budget: x.budget, units };
  }

  return {
    SLOTS, MAX_TANKS, MAX_MEDICS, MAX_DRONES, DRAFT_BUDGET, UNIT_IDS, FALLBACK_UNITS, COUNT_KEY, COUNT_FIELDS, DRAFT_COST, NAME, LABEL, limits, cost, limit, medicFor, withCount, envFromView, NOTE_MAX, PLAN_IDS, HOLDS, PUSHES, MEDICS, PUSH_T, PUSH_LABEL, PUSH_WHEN, MEDIC_TOTAL, MEDIC_OPEN, HOLD_Z3_UNITS, PLANS, FIELDS,
    fromPlan, validate, isCustom, hash, slots, withMedic, withPlan, assaultT, opening, toKv, shq, cleanNote, agentNote, intent, risk, ack,
  };
});
