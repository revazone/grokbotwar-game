'use strict';
// Compact text protocol (v2) between the arena and a seated warrior.
// One outbox per seat. A report is that seat's own view: our numbers first, their base second.
// The line starts with v2 so an old skill can tell. Orders are one line each, at most three per post.
// The sim clock (match seconds) drives T<sec>, the 2s debounce and the 8s heartbeat.
// Unit movement, targeting and spending rules stay in match.js. This file only
// formats lines, parses orders, and posts a report webhook without throwing.
// Orders: BUY, DEPLOY, HOLD, BANK, FOCUS, AUTOBUY (FOCUS and AUTOBUY are standing orders for the match),
// and the radio orders MOVE, ASSIST, FALLBACK, CLEAR for single units or groups (docs/RADIO-ORDERS.md).

const { TYPE_IDS, FIELD_COST, ROSTER_LIMIT, ZONES, ASSIST_RADIUS_ORDER } = require('./constants');
const CONSTANTS = require('./constants'); // MAX_BUYS is read live (BUY_CAP can change with the ruleset at a match boot)
// Unit codes come from the code column of units.csv. Live objects, refilled between matches.
const U = require('./units');
const { CODE_BY_TYPE, TYPE_BY_CODE } = U;

/** A code the seat may order. The mortar is unknown while MORTAR is off (docs/MORTAR.md). */
function orderType(code) {
  const type = TYPE_BY_CODE[code];
  if (!type) return null;
  if (U.roleOf(type) === 'mortar' && !require('./version').mortarOn()) return null;
  return type;
}
const ST = require('./stance');

const PROTOCOL_VERSION_TOWERS = 6; // 6: towers (TOWERS=1): `gun` / `dep` in res, FOCUS GUN / FOCUS DEPOT. Reports say v5 while TOWERS is off.
const PROTOCOL_VERSION = 5; // 3: base turret (`tur` in res, FOCUS TURRET). 4: commander notes (`cmdr` section, ACK order). 5: unit stances (STANCE order, `[C]` on our unit tokens)
const DEBOUNCE_S = 2;
const HEARTBEAT_S = 8;
// With per-unit IDs a 24-unit field needs about 200 characters on its own, so the line
// budget is 600. Sections still drop (their zones, then our IDs) when a line would pass it.
const REPORT_CHAR_BUDGET = 600;
const WEBHOOK_TIMEOUT_MS = 8000;
const WAKE_MIN_MS = 10000;
const WHY_MAX = 60;
const AUTOBUY_RESERVE_MAX = 999;

/** Counts as `2R 1T`. Zero types are omitted. An empty roster is `none`. */
function formatCounts(counts) {
  const parts = [];
  for (const type of TYPE_IDS) {
    const n = counts && counts[type] || 0;
    if (n > 0) parts.push(`${n}${CODE_BY_TYPE[type]}`);
  }
  return parts.length ? parts.join(' ') : 'none';
}

function cleanNote(note) {
  return String(note == null ? '' : note).replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48);
}

/** Team letter on the wire. Green is G, Ember is E. Unknown seats fall back to side. */
function teamTag(seat, side) {
  const name = String(seat || '');
  if (/ember/i.test(name)) return 'E';
  if (/green/i.test(name)) return 'G';
  return side === 0 ? 'G' : 'E';
}

/**
 * ahead / even / behind / base-threat.
 * base-threat: 4 or more enemies in our home zone, or any enemy there while our base HP is below theirs.
 * Otherwise more zones (or the same zones and a higher base HP) is ahead. The mirror is behind. The rest is even.
 */
function situationTag(view) {
  const near = view.nearBase | 0;
  const usH = view.usHp | 0;
  const themH = view.themHp | 0;
  const usL = view.usLand | 0;
  const themL = view.themLand | 0;
  if (near >= 4 || (near >= 1 && usH < themH)) return 'base-threat';
  if (usL > themL || (usL === themL && usH > themH)) return 'ahead';
  if (usL < themL || (usL === themL && usH < themH)) return 'behind';
  return 'even';
}

/**
 * The situation section. The tag, then the count of their units near our base when there is any:
 * `base-threat 4E`, `ahead 1E`. Near means inside our home zone, the same cut the tag uses.
 */
function situationText(view) {
  const tag = situationTag(view);
  const near = view.nearBase | 0;
  return near > 0 ? `${tag} ${near}${view.theirTag || 'E'}` : tag;
}

/**
 * What the bank can pay right now, priciest first, as code + live price + count: `T52x1 R40x1 M36x1 S28x2`.
 * `priceOf(type)` is the same price the arena charges when it accepts a BUY. The count is true at report send; a later BUY can still ERR if the bank moved.
 * The count is how many the bank covers, capped by the room left under the 24-unit roster and reserve cap.
 * `none` when the bank is short, or the roster or the reserve is already at 24.
 */
/** rosterTotal: living units (field + reserve), never the bought-ever count. */
// fitOf(type): how many of that buy fit on the field now (free active slots minus units already in reserve; a Drone buy is a pack and needs a slot per drone).
// When it is under the count, the token gains `(<n>fit)`, e.g. `R40x2(1fit)`; the extra buys would only wait in reserve.
function canBuyCodes(bank, rosterTotal, reserveTotal, priceOf, roomOf, fitOf) {
  const room = Math.min(ROSTER_LIMIT - (rosterTotal | 0), ROSTER_LIMIT - (reserveTotal | 0));
  if (room <= 0) return 'none';
  const price = typeof priceOf === 'function' ? priceOf : (type => FIELD_COST[type]);
  // roomOf(type): what that type's own caps still allow (units.csv max_alive, max_per_buy). A type at its cap is left out.
  const cap = typeof roomOf === 'function' ? roomOf : (() => Infinity);
  const funds = Math.max(0, Math.floor(+bank || 0));
  const playable = TYPE_IDS.filter(type => !(U.roleOf(type) === 'mortar' && !require('./version').mortarOn()));
  const items = playable.map(type => ({ type, cost: price(type), room: Math.min(room, cap(type)) }))
    .filter(item => Number.isFinite(item.cost) && item.cost > 0 && funds >= item.cost && item.room > 0)
    .sort((a, b) => b.cost - a.cost || TYPE_IDS.indexOf(a.type) - TYPE_IDS.indexOf(b.type));
  if (!items.length) return 'none';
  const fitFn = typeof fitOf === 'function' ? fitOf : (() => Infinity);
  return items.map(item => {
    const n = Math.min(item.room, Math.floor(funds / item.cost));
    const fit = Math.max(0, Math.floor(fitFn(item.type)));
    return `${CODE_BY_TYPE[item.type]}${item.cost}x${n}${fit < n ? `(${fit}fit)` : ''}`;
  }).join(' ');
}

/**
 * Our field units, one token each: ID@zone, then `*` (hurt, HP at or below half) and `!` (in combat:
 * shot, was shot or healed in the last 2 s), then the unit's radio order if any (`>z5`, `<z4`, `>M1`).
 * `R1@z4 R2@z5! T3@z5*! M1@z5`. `none` when the field is empty.
 */
function formatUnitTokens(units, stances = 'all') {
  if (!units || !units.length) return 'none';
  // Stance letter in brackets after the zone (`T2@z4[C]`). stances 'all' shows every unit's, 'diff' only the
  // ones that differ from their type's default (the shrink step), 'none' none.
  // [+] while the unit is walking to its field hospital or healing there (docs/FIELD-HOSPITAL.md).
  // It replaces the stance letter for that token, and the shrink step keeps it. HOLD stays [H].
  // Absent when the flag is off.
  const st = u => u.hospital ? '[+]' : (!u.stance || stances === 'none' || (stances === 'diff' && u.stanceDefault)) ? '' : `[${ST.LETTER[u.stance] || '?'}]`;
  return units.map(u => `${u.tag}@z${u.zone}${st(u)}${u.hurt ? '*' : ''}${u.combat ? '!' : ''}${u.order || ''}`).join(' ');
}

/** Their field units grouped by zone and type: `2R@z5 M@z6 T@z7` (a count only when above 1). `none` when empty. */
function formatGroupTokens(groups) {
  if (!groups || !groups.length) return 'none';
  return groups.map(g => `${g.n > 1 ? g.n : ''}${g.code}@z${g.zone}`).join(' ');
}

/** Contested zones (units of both sides inside), our count first: `fight z5 (G 3 v E 2) z6 (G 1 v E 1)`. Empty when none. */
function formatFights(fights, usTag, themTag) {
  if (!fights || !fights.length) return '';
  return `fight ${fights.map(f => `z${f.zone} (${usTag} ${f.us | 0} v ${themTag} ${f.them | 0})`).join(' ')}`;
}

/**
 * Field hospitals, ours first. `hosp G120 E-60 en G:R1,T2 E:2R`.
 * HP is an integer while it stands. Down is `-` plus seconds left on the rebuild timer.
 * `-0` means the timer is done and the 40 CR rebuild has not been paid yet.
 * `en` is units retreating or healing: our IDs, their counts (no enemy IDs). `-` when nobody.
 */
function formatHospital(h) {
  if (!h) return '';
  const hp = (alive, v, rb) => alive ? String(Math.max(0, v | 0)) : `-${Math.max(0, rb | 0)}`;
  const en = list => list && list.length ? list.join(',') : '-';
  const us = h.usTag || 'G';
  const them = h.themTag || 'E';
  return `hosp ${us}${hp(h.usAlive, h.usHp, h.usRebuild)} ${them}${hp(h.themAlive, h.themHp, h.themRebuild)} en ${us}:${en(h.usEn)} ${them}:${en(h.themEn)}`;
}

/**
 * One v2 report line. Delta, situation, zone totals, income and can-buy lead.
 * Our reserve and field follow. Their base is last. Field sections are dropped before the note when the line would pass 200 characters.
 * view: { t, event, delta, situation, zones ('5/2' or '4/3 c1'), income, canBuy, us:{hp,bank,reserve,field,hurt,standing?}, them:{tag,hp,field}, note? }
 */
function formatReport(view) {
  const us = view.us || {};
  const them = view.them || {};
  const tag = them.tag || 'E';
  const head = [
    `v${view.version || PROTOCOL_VERSION} T${view.t} ${view.event}`,
    view.delta || 'no change',
    view.situation || 'even',
    `z ${view.zones || '0/0'}`,
    view.income || 'income: 0 CR, need 1 more zone',
    `can buy: ${view.canBuy || 'none'}`,
  ];
  // cmdr: the owner's commander notes (docs/COMMANDER-CHAT.md). Part of head, so no shrink step ever drops it.
  if (Array.isArray(view.cmdr) && view.cmdr.length) head.push(require('./cmdr').formatCmdr(view.cmdr));
  // hosp: both hospitals, ours first, then who is retreating or healing. Part of head so a shrink never drops it.
  // Absent unless FIELD_HOSPITAL=1, so a flag-off line is unchanged. `G120` is HP; `G-60` is down, 60s to rebuild; `G-0` is waiting on the 40 CR.
  if (view.hospital) head.push(formatHospital(view.hospital));
  // b bank, h hurt, hp our base, f field. Short so the draft note still fits in 200 characters.
  // Standing orders (FOCUS, AUTOBUY) ride at the end of res: `focus M auto T r20`. Absent when none is set.
  const standing = us.standing ? ` ${us.standing}` : '';
  // act <field>/<cap>: our units counting toward the active cap (drones included). Absent with no cap.
  const act = us.cap > 0 ? ` act ${us.active | 0}/${us.cap | 0}` : '';
  // tur: both base turrets' HP, ours first: `tur G120 E80`; `-` once one is down. Absent with turrets off.
  const turTok = v => (v == null ? '-' : String(v | 0));
  const tur = us.turret !== undefined || them.turret !== undefined
    ? ` tur ${us.tag || (tag === 'E' ? 'G' : 'E')}${turTok(us.turret)} ${tag}${turTok(them.turret)}` : '';
  // gun / dep (v6, TOWERS=1): both gun towers' and depots' HP, ours first, like tur: `gun G100 E-`, `dep G160 E160`. `-` = down.
  const usTag = us.tag || (tag === 'E' ? 'G' : 'E');
  const tower = (name, a, b) => (a !== undefined || b !== undefined ? ` ${name} ${usTag}${turTok(a)} ${tag}${turTok(b)}` : '');
  const towers = tower('gun', us.gun, them.gun) + tower('dep', us.depot, them.depot) + tower('xg', us.xgun, them.xgun) + tower('rng', us.rng, them.rng); // rng = seconds of range boost left (BUY RANGE on only); // xg = bought towers alive, only with TOWER_BUY on
  const res = `res ${formatCounts(us.reserve)} b${us.bank | 0} h${us.hurt | 0} hp${us.hp | 0}${tur}${towers}${act}${standing}`;
  const field = `f ${formatCounts(us.field)}`;
  const foe = `${tag} ${them.hp | 0} f ${formatCounts(them.field)}`;
  const foeHp = `${tag} ${them.hp | 0}`;
  const note = cleanNote(view.note);
  const noted = note ? `note: ${note}` : '';
  // Unit IDs (us.units), their zones (them.groups) and the fight list are given by the arena.
  // A view without them (older callers) keeps the plain counts.
  const ids = Array.isArray(us.units) ? `f ${formatUnitTokens(us.units, 'diff')}` : field;
  // Every unit's stance letter first; the shrink order then keeps only the non-default ones.
  const idsAll = Array.isArray(us.units) ? `f ${formatUnitTokens(us.units, 'all')}` : field;
  const foeZones = Array.isArray(them.groups) ? `${tag} ${them.hp | 0} f ${formatGroupTokens(them.groups)}` : foe;
  const fight = formatFights(view.fights, us.tag || (tag === 'E' ? 'G' : 'E'), tag);
  const rich = noted ? [
    [...head, res, idsAll, fight, foeZones, noted],
    [...head, res, ids, fight, foeZones, noted],
    [...head, res, ids, fight, foe, noted],
    [...head, res, ids, fight, foeHp, noted],
    [...head, res, field, fight, foeHp, noted],
  ] : [
    [...head, res, idsAll, fight, foeZones],
    [...head, res, ids, fight, foeZones],
    [...head, res, ids, fight, foe],
    [...head, res, ids, fight, foeHp],
    [...head, res, field, fight, foeHp],
  ];
  // Keep the note when it exists. Drop their field counts, then ours, before dropping the note.
  const candidates = noted ? [
    ...rich,
    [...head, res, field, foe, noted],
    [...head, res, field, foeHp, noted],
    [...head, res, foeHp, noted],
    [...head, res, noted],
    [...head, noted],
    [...head, res, field, foe],
    [...head, res, foeHp],
    head,
  ] : [
    ...rich,
    [...head, res, field, foe],
    [...head, res, field, foeHp],
    [...head, res, foeHp],
    head,
  ];
  for (const parts of candidates) {
    const line = parts.filter(Boolean).join(' | ');
    if (line.length <= REPORT_CHAR_BUDGET) return line;
  }
  return head.join(' | ').slice(0, REPORT_CHAR_BUDGET);
}

/**
 * Standing-order tokens for the res section. focus: unit type or null. auto: { type, reserve } or null.
 * autoState: '' while the rule can fire, 'bank' while BANK pauses it, 'max' once the match's buys are used up,
 * 'cap' while that unit is at its max_alive.
 * `focus M`, `auto T`, `auto T r20`, `auto T r20 bank`, joined by spaces. Empty when neither is set.
 */
function standingText(focus, auto, autoState, scope) {
  const parts = [];
  if (focus === 'hospital') parts.push('focus H');
  else if (focus === 'turret') parts.push('focus TUR');
  else if (focus === 'gun') parts.push('focus GUN');
  else if (focus === 'depot') parts.push('focus DEP');
  else if (focus === 'post') parts.push('focus POST');
  else if (focus && CODE_BY_TYPE[focus]) {
    // A scoped FOCUS adds its units and zone: `focus M R1,R2 z6`.
    let t = `focus ${CODE_BY_TYPE[focus]}`;
    if (scope && scope.tags) t += ` ${scope.tags.length ? scope.tags.join(',') : 'none'}`;
    if (scope && scope.zone != null) t += ` z${scope.zone + 1}`;
    parts.push(t);
  }
  if (auto && CODE_BY_TYPE[auto.type]) {
    let t = `auto ${CODE_BY_TYPE[auto.type]}`;
    if (auto.reserve > 0) t += ` r${auto.reserve | 0}`;
    if (autoState) t += ` ${autoState}`;
    parts.push(t);
  }
  return parts.join(' ');
}

/** One short reason. Control characters and brackets come out. Cut at 60. */
function sanitizeWhy(text) {
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, WHY_MAX);
}

/** Sentence case of a decision label, for Ember's second line. `MEDICS HELD IN RESERVE` becomes `Medics held in reserve`. */
function reasonFromLabel(title) {
  const text = sanitizeWhy(title);
  if (!text) return '';
  const lower = text.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** `Z5` -> zone index 4. Null when it is not z1..z8. */
function parseZone(tok) {
  const m = /^Z(\d+)$/.exec(String(tok || ''));
  if (!m) return null;
  const n = +m[1];
  return n >= 1 && n <= ZONES ? n - 1 : null;
}

/**
 * One unit selector of a radio order: `ALL`, an ID (`R2`), a code group (`R` all rifles, `2R` two rifles).
 * Returns { all } | { id, type, n } | { type, count } | { error }.
 */
function parseUnitSel(tok) {
  if (tok === 'ALL') return { all: true };
  let m = /^([A-Z])(\d+)$/.exec(tok);
  if (m) {
    const type = orderType(m[1]);
    if (!type || +m[2] < 1) return { error: `unknown unit ${tok}` };
    return { id: tok, type, n: +m[2] };
  }
  m = /^(\d*)([A-Z])$/.exec(tok);
  if (m) {
    const type = orderType(m[2]);
    if (!type) return { error: `unknown unit ${tok}` };
    const count = m[1] ? +m[1] : null;
    if (count === 0 || count > ROSTER_LIMIT) return { error: `bad count ${tok}` };
    return { type, count };
  }
  return { error: `unknown unit ${tok}` };
}

/** A list of selectors. ALL stands alone. */
function parseUnitSels(tokens) {
  if (!tokens.length) return { error: 'name units: an ID like R2, a code like R or 2R, or ALL' };
  if (tokens.length > ROSTER_LIMIT) return { error: `at most ${ROSTER_LIMIT} units` };
  if (tokens.includes('ALL') && tokens.length > 1) return { error: 'ALL takes no other unit' };
  const sels = [];
  for (const t of tokens) {
    const sel = parseUnitSel(t);
    if (sel.error) return { error: sel.error };
    sels.push(sel);
  }
  return { sels };
}

/**
 * Parse one order line. Returns { skip } for blanks, or { line, op, types?, type?, error? }.
 * A `WHY <text>` line returns { why } and is not an order.
 * `line` is the normalized form echoed in `OK` / `ERR`.
 */
function parseOrder(raw) {
  const original = String(raw == null ? '' : raw).trim();
  if (!original) return { skip: true };
  // ACK <id> [NEG] <text>: the bot acknowledges a commander note. Not an order (no order slot, no act cap).
  const ackLine = original.match(/^ack\s+(c\d{1,6})(?:\s+([\s\S]*))?$/i);
  if (ackLine) return { ack: { id: ackLine[1].toLowerCase(), rest: ackLine[2] || '' } };
  if (/^ack\b/i.test(original)) return { ack: { id: '', rest: '' } };
  const whyLine = original.match(/^why(?:\s+([\s\S]*))?$/i);
  if (whyLine) {
    const why = sanitizeWhy(whyLine[1] || '');
    if (!why) return { skip: true };
    return { why };
  }
  // Zone tokens stay lower case (`z5`), like the report.
  const line = original.replace(/\s+/g, ' ').toUpperCase().replace(/(^| )Z(\d+)(?= |$)/g, '$1z$2');
  if (!line) return { skip: true };
  const parts = line.replace(/(^| )z(\d+)(?= |$)/g, '$1Z$2').split(' ');
  let op = parts[0];
  let rest = parts.slice(1);
  // MOVE_ALL <zone> is MOVE ALL <zone> (comm spec v1.1 alias).
  if (op === 'MOVE_ALL') {
    if (rest.length !== 1) return { line, error: 'like MOVE_ALL z8' };
    op = 'MOVE'; rest = ['ALL', rest[0]];
  }
  if (op === 'HOLD' || op === 'BANK') {
    if (rest.length) return { line, error: `${op} takes no argument` };
    return { line, op };
  }
  if (op === 'DEPLOY') {
    if (rest.length === 1 && rest[0] === 'ALL') return { line: 'DEPLOY ALL', op, all: true };
    if (rest[0] === 'ALL') return { line, error: 'ALL takes no other unit' };
    if (!rest.length) return { line, error: `need 1 to ${ROSTER_LIMIT} units` };
    if (rest.length > ROSTER_LIMIT) return { line, error: `at most ${ROSTER_LIMIT}` };
    const types = [];
    for (const code of rest) {
      const type = orderType(code);
      if (!type) return { line, error: `unknown unit ${code}` };
      types.push(type);
    }
    return { line, op, types };
  }
  if (op === 'BUY' && rest[0] === 'RANGE') { // BUY RANGE [TOWER|TURRET|ALL]: a timed range boost (RANGE_BUY on; `unknown unit RANGE` otherwise)
    if (rest.length > 2) return { line, error: 'like BUY RANGE, BUY RANGE TOWER or BUY RANGE TURRET' };
    const w = rest.length === 2 ? { TOWER: 'gun', GUN: 'gun', TURRET: 'turret', ALL: 'all' }[rest[1]] : 'all';
    if (!w) return { line, error: 'BUY RANGE takes TOWER, TURRET or ALL' };
    return { line: `BUY RANGE${w === 'all' ? '' : w === 'gun' ? ' TOWER' : ' TURRET'}`, op, range: true, what: w };
  }
  if (op === 'BUY' && rest[0] === 'TOWER') { // BUY TOWER [z<n>]: a bought gun tower (TOWER_BUY on; refused as `unknown unit TOWER` otherwise)
    if (rest.length > 2) return { line, error: 'like BUY TOWER or BUY TOWER z4' };
    const zm = rest.length === 2 ? /^z([1-8])$/i.exec(rest[1]) : null;
    if (rest.length === 2 && !zm) return { line, error: 'zone z1 to z8, like BUY TOWER z4' };
    return { line: zm ? `BUY TOWER z${zm[1]}` : 'BUY TOWER', op, tower: true, zone: zm ? +zm[1] : null };
  }
  if (op === 'BUY') {
    if (rest.length !== 1) return { line, error: 'one unit, like BUY M' };
    const type = orderType(rest[0]);
    if (!type) return { line, error: `unknown unit ${rest[0]}` };
    return { line, op, type };
  }
  // FOCUS <code> [units] [zone] | FOCUS NONE (OFF is the same): target priority for our units' attacks.
  // Plain FOCUS <code> is every unit, everywhere. Units and a zone narrow it.
  if (op === 'FOCUS') {
    if (!rest.length) return { line, error: 'one unit, like FOCUS M, or FOCUS NONE' };
    if (rest[0] === 'NONE' || rest[0] === 'OFF') {
      if (rest.length > 1) return { line, error: 'FOCUS NONE takes nothing else' };
      return { line: 'FOCUS NONE', op, type: null };
    }
    // FOCUS TURRET: their base turret first whenever it is in range.
    if (rest[0] === 'TURRET') {
      if (rest.length > 1) return { line, error: 'FOCUS TURRET takes nothing else' };
      return { line: 'FOCUS TURRET', op, type: 'turret' };
    }
    // FOCUS GUN / FOCUS DEPOT (v6, TOWERS=1): their gun tower or depot first whenever in reach; units near it close on it.
    // The match refuses them with `unknown unit` while TOWERS is off, the same reply the seat gave before they existed.
    if (rest[0] === 'GUN' || rest[0] === 'DEPOT' || rest[0] === 'POST') {
      if (rest.length > 1) return { line, error: `FOCUS ${rest[0]} takes nothing else` };
      return { line: `FOCUS ${rest[0]}`, op, type: rest[0].toLowerCase() };
    }
    // FOCUS H: their field hospital. Recognized only while FIELD_HOSPITAL=1; otherwise it is an unknown code,
    // the same reply the seat gave before the order existed.
    if (rest[0] === 'H' || rest[0] === 'HOSPITAL') {
      if (!require('./version').fieldHospital()) return { line, error: `unknown unit ${rest[0]}` };
      if (rest.length > 1) return { line, error: 'FOCUS H takes nothing else' };
      return { line: 'FOCUS H', op, type: 'hospital' };
    }
    const type = orderType(rest[0]);
    if (!type) return { line, error: `unknown unit ${rest[0]}` };
    if (rest.length === 1) return { line, op, type };
    let more = rest.slice(1);
    let zone = null;
    if (/^Z\d+$/.test(more[more.length - 1])) {
      zone = parseZone(more[more.length - 1]);
      if (zone == null) return { line, error: `bad zone ${more[more.length - 1].toLowerCase()}, z1 to z${ZONES}` };
      more = more.slice(0, -1);
    }
    let sels = null;
    if (more.length) {
      const p = parseUnitSels(more);
      if (p.error) return { line, error: p.error };
      sels = p.sels;
    }
    return { line, op, type, sels, zone, scoped: true };
  }
  // Radio orders. MOVE <units> <zone> | ASSIST <zone> [radius] | FALLBACK <units> | CLEAR <units>.
  if (op === 'MOVE') {
    if (rest.length < 2) return { line, error: 'like MOVE R1 R2 z5' };
    const zone = parseZone(rest[rest.length - 1]);
    if (zone == null) return { line, error: `bad zone ${rest[rest.length - 1].toLowerCase()}, z1 to z${ZONES}` };
    const p = parseUnitSels(rest.slice(0, -1));
    if (p.error) return { line, error: p.error };
    return { line, op, sels: p.sels, zone, radio: true };
  }
  if (op === 'ASSIST') {
    if (rest.length < 1 || rest.length > 2) return { line, error: 'like ASSIST z5 or ASSIST z5 1' };
    // ASSIST <unit ID> [radius]: help that unit, in whatever zone it is in when the order lands.
    if (/^[A-Z]\d+$/.test(rest[0]) && !/^Z\d+$/.test(rest[0])) {
      const sel = parseUnitSel(rest[0]);
      if (sel.error) return { line, error: sel.error };
      let radius = ASSIST_RADIUS_ORDER;
      if (rest.length === 2) {
        if (!/^\d+$/.test(rest[1]) || +rest[1] > ZONES - 1) return { line, error: `radius 0 to ${ZONES - 1}` };
        radius = +rest[1];
      }
      return { line, op, assistId: sel.id, zone: null, radius, radio: true };
    }
    const zone = parseZone(rest[0]);
    if (zone == null) return { line, error: `bad zone ${rest[0].toLowerCase()}, z1 to z${ZONES}` };
    let radius = ASSIST_RADIUS_ORDER;
    if (rest.length === 2) {
      if (!/^\d+$/.test(rest[1]) || +rest[1] > ZONES - 1) return { line, error: `radius 0 to ${ZONES - 1}` };
      radius = +rest[1];
    }
    return { line, op, zone, radius, radio: true };
  }
  if (op === 'FALLBACK' || op === 'CLEAR') {
    const p = parseUnitSels(rest);
    if (p.error) return { line, error: p.error };
    return { line, op, sels: p.sels, radio: true };
  }
  // STANCE <units> <stance>: HOLD CHARGE KITE ESCORT RUN (or DEFAULT). Standing until the next STANCE.
  // Units like the radio orders (ID, code, 2R, ALL). Drones have no stance.
  if (op === 'STANCE') {
    if (rest.length < 2) return { line, error: 'like STANCE R2 KITE or STANCE T CHARGE' };
    const stance = ST.parseStance(rest[rest.length - 1]);
    if (!stance) return { line, error: `stance ${ST.STANCES.join(' ')} or DEFAULT` };
    const p = parseUnitSels(rest.slice(0, -1));
    if (p.error) return { line, error: p.error };
    if (p.sels.every(sel => sel.type && !ST.hasStance(sel.type))) return { line, error: 'drones have no stance' };
    const norm = `STANCE ${rest.slice(0, -1).join(' ')} ${stance}`;
    return { line: norm, op, sels: p.sels, stance };
  }
  // AUTOBUY <code> [RESERVE <n>] | AUTOBUY OFF (NONE is the same): standing buy-and-deploy rule.
  if (op === 'AUTOBUY') {
    if (rest.length === 1 && (rest[0] === 'OFF' || rest[0] === 'NONE')) return { line: 'AUTOBUY OFF', op, type: null };
    if (rest.length !== 1 && rest.length !== 3) return { line, error: 'like AUTOBUY T, AUTOBUY T RESERVE 20, or AUTOBUY OFF' };
    const type = orderType(rest[0]);
    if (!type) return { line, error: `unknown unit ${rest[0]}` };
    let reserve = 0;
    if (rest.length === 3) {
      if (rest[1] !== 'RESERVE') return { line, error: 'like AUTOBUY T RESERVE 20' };
      if (!/^\d+$/.test(rest[2]) || +rest[2] > AUTOBUY_RESERVE_MAX) return { line, error: `reserve 0 to ${AUTOBUY_RESERVE_MAX}` };
      reserve = +rest[2];
    }
    return { line: reserve ? `AUTOBUY ${rest[0]} RESERVE ${reserve}` : `AUTOBUY ${rest[0]}`, op, type, reserve };
  }
  return { line, error: 'unknown order' };
}

/**
 * Named error code for an ERR reason (comm spec v1.1). Additive: the ERR line text is unchanged;
 * POST /api/seat/orders also returns errors: [{ line, code, reason }].
 */
const ERR_CODES = [
  [/bad zone|zone .*z1 to/, 'invalid_zone'],
  [/not enough|credits|cannot cover|need \d+ CR|CR\b/i, 'insufficient_credits'],
  [/reserve (is )?empty|none in reserve|no .* in reserve|nothing in reserve/i, 'reserve_empty'],
  [/active cap|cap reached|field is full|slots?|cap \d+ active/i, 'slot_full'],
  [/unit .+ is dead|\bis dead\b/i, 'unit_dead'],
  [/unknown unit|not found|no unit|no such/i, 'unknown_unit'],
  [/not hurt|none hurt/, 'not_hurt'],
  [/no enemy/, 'no_enemy'],
  [/no units within/, 'none_in_range'],
  [/match over/, 'match_over'],
  [/queue full|at most/, 'too_many'],
  [/max_alive|max per buy|cooldown|maxed|no buys left/i, 'limit'],
  [/no stance|stance HOLD/, 'bad_order'],
  [/unknown order|takes no|like |one unit|need |name units|bad count|radius|reserve 0/, 'bad_order'],
];
function errCode(reason) {
  const r = String(reason || '');
  for (const [re, code] of ERR_CODES) if (re.test(r)) return code;
  return 'rejected';
}

function reply(parsed, reason) {
  return reason ? `ERR ${parsed.line}: ${reason}` : `OK ${parsed.line}`;
}

/** Territory price of a queue type, or null when the queue has nothing left to buy. */
function nextBuyOf(queue, bought) {
  if (bought >= CONSTANTS.MAX_BUYS) return null;
  const type = queue && queue[bought];
  if (!CODE_BY_TYPE[type]) return null;
  return { type, code: CODE_BY_TYPE[type], cost: FIELD_COST[type] };
}

/** Linear quantile on an ascending list. p is 0..1. One sample returns that sample. */
function quantile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
}

/**
 * decide_ms samples are { at, decideMs } in receipt order.
 * med and p90 use quantile. avgGap is the mean wall gap between consecutive orders, or null when n < 2.
 */
function latencyStats(samples) {
  const list = (samples || []).filter(s => s && Number.isFinite(s.decideMs) && Number.isFinite(s.at));
  const n = list.length;
  if (!n) return { n: 0, min: null, med: null, p90: null, max: null, avgGap: null };
  const xs = list.map(s => s.decideMs).sort((a, b) => a - b);
  let gapSum = 0;
  for (let i = 1; i < n; i++) gapSum += list[i].at - list[i - 1].at;
  return {
    n,
    min: xs[0],
    med: quantile(xs, 0.5),
    p90: quantile(xs, 0.9),
    max: xs[n - 1],
    avgGap: n > 1 ? gapSum / (n - 1) : null,
  };
}

/** One END-note fragment. Empty when this seat posted no timed order. */
function decideSummary(stats) {
  if (!stats || !stats.n) return '';
  const sec = ms => (ms / 1000).toFixed(1);
  return `decide med ${sec(stats.med)}s p90 ${sec(stats.p90)}s n=${stats.n}`;
}

function protocolLogRecord(dir, matchNo, seat, text, now = new Date()) {
  return `${now.toISOString()} ${dir} m${matchNo} ${seat} ${text}`;
}

/** Non-negative number from the environment, or `fallback` when unset or not a number. */
function readEnvNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Whether this report is posted to the webhook. One decision, no retry.
 * ORDER and STATE are never posted: the bot just got that board from the orders reply.
 * HEARTBEAT and CREDITS wait until `minMs` since this seat's last wake.
 * START, END, a base threat, and any other event always post.
 * `sinceWakeMs` is Infinity when this seat has not been woken yet.
 */
function shouldPostWake(event, sinceWakeMs, minMs) {
  // ORDER/STATE: the bot already has that board from the orders reply; a wake would loop.
  if (event === 'ORDER' || event === 'STATE') return false;
  if (event === 'HEARTBEAT' || event === 'CREDITS') return !(sinceWakeMs < minMs);
  return true;
}

/**
 * POST {id, line, event, t, match, seat, side, sentAt} once. A dead URL is logged and swallowed.
 * When `opts.key` is set, the request carries Authorization: Bearer and X-Automation-Key.
 * The key is never written to the log. The caller must not await this on the sim tick.
 */
function postReportWebhook(url, body, log = console.log, opts = {}) {
  if (!url) return Promise.resolve(false);
  const headers = { 'Content-Type': 'application/json' };
  const key = opts && opts.key ? String(opts.key) : '';
  if (key) {
    headers.Authorization = `Bearer ${key}`;
    headers['X-Automation-Key'] = key;
  }
  const timeoutMs = opts && Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : WEBHOOK_TIMEOUT_MS;
  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: body.id, line: body.line, event: body.event, t: body.t, match: body.match, seat: body.seat, side: body.side, sentAt: body.sentAt,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }).then(r => {
    if (!r.ok) log(`[warrior] webhook ${r.status}`);
    return r.ok;
  }).catch(e => {
    log(`[warrior] webhook failed: ${e.message}`);
    return false;
  });
}

module.exports = {
  errCode,
  PROTOCOL_VERSION, PROTOCOL_VERSION_TOWERS, DEBOUNCE_S, HEARTBEAT_S, REPORT_CHAR_BUDGET, WEBHOOK_TIMEOUT_MS, WAKE_MIN_MS,
  CODE_BY_TYPE, TYPE_BY_CODE, WHY_MAX,
  parseZone, parseUnitSel, parseUnitSels,
  formatCounts, formatReport, formatUnitTokens, formatGroupTokens, formatFights, formatHospital, situationTag, situationText, canBuyCodes, parseOrder, reply, nextBuyOf, cleanNote, teamTag,
  sanitizeWhy, reasonFromLabel, standingText, AUTOBUY_RESERVE_MAX,
  quantile, latencyStats, decideSummary,
  readEnvNumber, shouldPostWake, protocolLogRecord, postReportWebhook,
};
