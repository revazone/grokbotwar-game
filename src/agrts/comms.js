'use strict';
// Comm net renderer (Army-Speak Comm Channel v1.1, with locked overrides).
// Pure, deterministic text templates: no LLM, no game state of its own. The match feeds it
// events; it returns panel entries { from, text, short, kind } plus structured exchange fields (below).
// Layout lives in the watch page.
//
// Exchange fields (COMM NET exchanges, docs/COMMNET-EXCHANGES.md). Every template sets them from its own
// structure, never from timing:
//   to       recipient station ("Big Dog Main", "Rifle Two", "All units", "Depot")
//   body     the message without the radio header and the Over/Out prowords (same words otherwise)
//   priority 'flash' | 'priority' | 'routine'
//   subject  { unitId:'R2' } or { zone:5 } (1-based) when the message is about a battlefield subject
//   reply    true: answers the lead entry of the same batch (wilco, Negative, roger)
//   ack      true: a routine acknowledgment (wilco, roger), never featured on its own
// The match adds msgId, exchangeId and replyTo when it puts entries on the net (match.js _pushComm).
// The bot is the TOC ("<Name> Main"); field units are the stations. The human never appears.
// Never says buy, purchase or credits spent: depot / field hospital wording only.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const NAMES = { S: 'Scout', R: 'Rifle', T: 'Breaker', M: 'Medic', D: 'Drone' };

/** Small counts as words (zero..twenty), else digits read one at a time. */
function count(n) { n = Math.max(0, n | 0); return n <= 20 ? ONES[n] : digits(n); }
/** Radio style, one digit at a time: 87 -> eight-seven. */
function digits(n) { return String(Math.max(0, Math.round(n))).split('').map(d => ONES[+d]).join('-'); }
function zone(z) { return `zone ${ONES[z] || digits(z)}`; }
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function typeName(code, n = 1, names = NAMES) {
  const b = names[code] || code;
  return n === 1 ? b : `${b}s`;
}
/** R2 -> Rifle Two. */
function unitName(tag, names = NAMES) {
  const m = /^([A-Z])(\d+)$/.exec(String(tag || ''));
  return m ? `${names[m[1]] || m[1]} ${cap(count(+m[2]))}` : String(tag || '');
}
function hpWords(hp) { return hp >= 100 ? 'full strength' : `${digits(hp)} health`; }

/** "Big Dog" -> "Big Dog Main". No name -> "Main". */
function mainCall(name) { return name ? `${name} Main` : 'Main'; }

/** A selector token from an order (ALL, R2, R, 2R) as a station / addressee. */
function selWords(tok, names = NAMES) {
  if (tok === 'ALL') return 'All units';
  let m = /^([A-Z])(\d+)$/.exec(tok);
  if (m) return unitName(tok, names);
  m = /^(\d*)([A-Z])$/.exec(tok);
  if (m) return m[1] ? `${cap(count(+m[1]))} ${typeName(m[2], +m[1], names)}` : typeName(m[2], 2, names);
  return tok;
}

/** Battlefield subject of an order line: a single unit ID, else the zone it names. */
function orderSubject(line) {
  const p = String(line || '').trim().replace(/^MOVE_ALL\b/i, 'MOVE ALL').split(/\s+/);
  const z = p.map(t => /^z(\d+)$/i.exec(t)).filter(Boolean).pop();
  const ids = p.slice(1).filter(t => /^[A-Z]\d+$/.test(t));
  if (ids.length === 1) return { unitId: ids[0] };
  if (z) return { zone: +z[1] };
  return null;
}

/**
 * One order line (normalized, e.g. `MOVE D z5`) -> { to, say, short }.
 * `to` is the station that answers wilco; `say` is the order sentence.
 */
function orderWords(line, names = NAMES) {
  // MOVE_ALL <zone> is the protocol alias of MOVE ALL <zone>: say it the same way.
  const p = String(line || '').trim().replace(/^MOVE_ALL\b/i, 'MOVE ALL').split(/\s+/);
  const op = p[0];
  const rest = p.slice(1);
  const zArg = t => { const m = /^z(\d+)$/i.exec(t || ''); return m ? +m[1] : null; };
  if (op === 'BUY') {
    const c = rest[0];
    if (c === 'RANGE') { const w = rest[1] === 'TOWER' ? 'the gun tower' : rest[1] === 'TURRET' ? 'the turret' : 'the gun tower and turret'; return { to: 'Gun line', say: `Gun line, extend the reach of ${w}.`, short: 'Gun line: extend reach.' }; }
    if (c === 'TOWER') return { to: 'Depot', say: 'Depot, build us a gun tower.', short: 'Depot: new gun tower.' };
    if (c === 'M') return { to: 'Field hospital', say: 'Field hospital, get us another Medic.', short: 'Field hospital: one Medic.' };
    return { to: 'Depot', say: `Depot, release one ${typeName(c, 1, names)}.`, short: `Depot: one ${typeName(c, 1, names)}.` };
  }
  if (op === 'DEPLOY') {
    if (rest[0] === 'ALL') return { to: 'Depot', say: 'Deploy everything from reserve to base.', short: 'Deploy reserve.' };
    const n = {};
    for (const c of rest) n[c] = (n[c] || 0) + 1;
    const list = Object.keys(n).map(c => `${count(n[c])} ${typeName(c, n[c], names)}`);
    const s = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0];
    return { to: 'Depot', say: `Deploy ${s} from reserve to base.`, short: `Deploy ${s}.` };
  }
  if (op === 'HOLD') return { to: 'Depot', say: 'Keep them in reserve. Do not deploy.', short: 'Hold reserve.' };
  if (op === 'BANK') return { to: 'Depot', say: 'Hold the depot. No more releases.', short: 'Hold the depot.' };
  if (op === 'AUTOBUY') {
    if (rest[0] === 'OFF') return { to: 'Depot', say: 'Stop continuous call-up.', short: 'Call-up off.' };
    const keep = rest[1] === 'RESERVE' ? ` Hold ${count(+rest[2])} back.` : '';
    return { to: 'Depot', say: `Keep calling ${typeName(rest[0], 2, names)} from the depot.${keep}`, short: `Continuous ${typeName(rest[0], 1, names)} call-up.` };
  }
  if (op === 'FOCUS') {
    if (rest[0] === 'NONE') return { to: 'All units', say: 'Lift target priority. Engage at will.', short: 'Priority lifted.' };
    if (rest[0] === 'TURRET') return { to: 'All units', say: 'Priority target enemy turret.', short: 'Priority turret.' };
    const z = zArg(rest[rest.length - 1]);
    return { to: 'All units', say: `Priority target ${typeName(rest[0], 2, names)}${z ? ` in ${zone(z)}` : ''}.`, short: `Priority ${typeName(rest[0], 2, names)}.` };
  }
  if (op === 'MOVE') {
    const z = zArg(rest[rest.length - 1]);
    const who = rest.slice(0, -1).map(t => selWords(t, names));
    const to = who.join(', ');
    if (rest[0] === 'ALL') {
      const assault = z === 8 ? ' Base assault.' : '';
      return { to, say: `All units, push ${zone(z)}.${assault}`, short: `All units to ${zone(z)}.` };
    }
    return { to, say: `${to}, move to ${zone(z)}.`, short: `${to} to ${zone(z)}.` };
  }
  if (op === 'ASSIST') {
    const z = zArg(rest[0]);
    if (z) return { to: 'All units', say: `All units near ${zone(z)}, assist. Pull into the fight.`, short: `Assist ${zone(z)}.` };
    return { to: 'All units', say: `Assist ${unitName(rest[0], names)}. Pull nearby into the fight.`, short: `Assist ${unitName(rest[0], names)}.` };
  }
  if (op === 'FALLBACK') {
    const to = rest.map(t => selWords(t, names)).join(', ');
    return { to, say: `${to}, fall back to the Medic.`, short: `${to} fall back.` };
  }
  if (op === 'STANCE' && rest.length >= 2) {
    const to = rest.slice(0, -1).map(t => selWords(t, names)).join(', ');
    const st = String(rest[rest.length - 1]).toLowerCase();
    return { to, say: `${to}, stance ${st}.`, short: `${to} ${st}.` };
  }
  if (op === 'CLEAR') {
    const to = rest.map(t => selWords(t, names)).join(', ');
    return { to, say: `Clear standing orders on ${to}.`, short: `Clear ${to}.` };
  }
  return { to: 'All units', say: `${cap(String(line).toLowerCase())}.`, short: String(line) };
}

/** Negative wording per named error code. */
function negative(code, line, reason, names = NAMES) {
  if (code === 'unit_dead') {
    const m = /unit\s+([A-Z]\d+)/i.exec(reason || '') || /\b([A-Z]\d+)\b/.exec(String(line || ''));
    const name = m ? unitName(m[1].toUpperCase(), names) : 'Unit';
    return `Negative. ${name} is down.`;
  }
  const o = orderWords(line, names);
  const what = o.short.replace(/\.$/, '');
  const why = {
    invalid_zone: 'Zone out of range.',
    insufficient_credits: 'Depot short. Not enough credits.',
    reserve_empty: 'Reserve empty.',
    slot_full: 'No open slots.',
    unknown_unit: 'Unit not found.',
    unit_dead: 'Unit is down.',
    not_hurt: 'Not hurt.',
    no_enemy: 'No enemy there.',
    none_in_range: 'Nobody in range.',
    match_over: 'Net closed. Match over.',
    too_many: 'Too much traffic.',
    limit: 'Depot limit reached.',
    bad_order: 'Say again, garbled.',
  }[code] || 'Unable.';
  return `Negative. ${what} rejected. ${why}`;
}

/**
 * Panel entries for one order post. orders: [{ line, ok, code?, reason? }], newest-last as sent.
 * Returns entries oldest-first; the match unshifts them so the newest sits on top.
 */
function orderExchange(ctx, orders) {
  const main = mainCall(ctx.name);
  const names = ctx.names || NAMES;
  const out = [];
  for (const o of orders) {
    const w = orderWords(o.line, names);
    const subject = orderSubject(o.line);
    if (o.ok) {
      out.push({ kind: 'frago', from: main, to: w.to, text: `${w.to}, ${main}, FRAGO. ${w.say} Over.`, body: w.say, priority: 'routine', subject, label: 'ORDER' });
      out.push({ kind: 'wilco', from: w.to, to: main, text: `${w.to}, wilco. Out.`, body: 'Wilco.', short: `FRAGO: ${w.short.replace(/\.$/, '')}. Wilco.`, priority: 'routine', subject, reply: true, ack: true });
    } else {
      out.push({ kind: 'frago', from: main, to: w.to, text: `${w.to}, ${main}. ${w.say} Over.`, body: w.say, priority: 'routine', subject, label: 'ORDER' });
      const neg = negative(o.code, o.line, o.reason, names);
      out.push({ kind: 'neg', from: w.to, to: main, text: `${neg} Out.`, body: neg, short: neg, priority: 'routine', subject, reply: true });
    }
  }
  return out;
}

/** Reporting station: lowest-numbered friendly on the field, else the base. */
function station(ctx) { return ctx.station ? unitName(ctx.station, ctx.names || NAMES) : (ctx.base || 'Base'); }

function spotContact(ctx, f) {
  const enemy = ctx.enemy || 'Ember';
  const heavy = f.them > f.us ? 'Heavy contact' : 'Contact';
  const st = station(ctx);
  const text = `${heavy} ${zone(f.zone)}. ${cap(count(f.us))} of ours, ${count(f.them)} ${enemy}.`;
  return { kind: 'spot', from: st, to: mainCall(ctx.name), text: `${mainCall(ctx.name)}, ${st}, SPOTREP. ${text} Over.`, body: text, short: `SPOTREP: ${text}`, priority: f.them > f.us ? 'priority' : 'routine', subject: { zone: f.zone }, label: 'SPOTREP' };
}

function spotLoss(ctx, losses) {
  // losses: [{ tag, zone }]
  const st = station(ctx);
  const names = ctx.names || NAMES;
  const list = losses.map(l => `${unitName(l.tag, names)}${l.zone ? ` in ${zone(l.zone)}` : ''}`);
  const text = `Lost ${list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0]}.`;
  const l0 = losses.length === 1 ? losses[0] : null;
  return { kind: 'loss', from: st, to: mainCall(ctx.name), text: `${mainCall(ctx.name)}, ${st}, SPOTREP. ${text} Over.`, body: text, short: `SPOTREP: ${text}`, priority: 'routine', subject: l0 && l0.zone ? { zone: l0.zone } : null, label: 'SPOTREP' };
}

function spotBase(ctx, n, z) {
  const enemy = ctx.enemy || 'Ember';
  const b = ctx.base || 'Base';
  const text = `Base under threat. ${cap(count(n))} ${enemy} in ${zone(z)}.`;
  return { kind: 'threat', from: b, to: mainCall(ctx.name), text: `${mainCall(ctx.name)}, ${b}, flash. ${text} Immediate response. Over.`, body: `${text} Immediate response.`, short: `FLASH: ${text}`, priority: 'flash', subject: { zone: z } };
}

/** Our base turret took fire. hp: its HP now. */
function spotTurret(ctx, hp) {
  const b = ctx.base || 'Base';
  const text = `Turret under fire. Turret ${digits(hp)}.`;
  return { kind: 'threat', from: b, to: mainCall(ctx.name), text: `${mainCall(ctx.name)}, ${b}, SPOTREP. ${text} Over.`, body: text, short: `SPOTREP: ${text}`, priority: 'priority', subject: ctx.homeZone ? { zone: ctx.homeZone } : null, label: 'SPOTREP' };
}

/** A base turret is down: ours (from our base) or theirs (from our reporting station). */
function spotTurretDown(ctx, ours) {
  const enemy = ctx.enemy || 'Ember';
  const from = ours ? (ctx.base || 'Base') : station(ctx);
  const text = ours ? 'Turret down.' : `${enemy} turret down.`;
  const z = ours ? ctx.homeZone : ctx.enemyHomeZone;
  return { kind: ours ? 'loss' : 'spot', from, to: mainCall(ctx.name), text: `${mainCall(ctx.name)}, ${from}, SPOTREP. ${text} Over.`, body: text, short: `SPOTREP: ${text}`, priority: ours ? 'priority' : 'routine', subject: z ? { zone: z } : null, label: 'SPOTREP' };
}

const SIT = {
  ahead: 'We hold the initiative.',
  even: 'Situation stable. Even fight.',
  behind: 'We are behind. Losing ground.',
  'base-threat': 'Base under threat. Immediate response.',
};

/**
 * Full sitrep. v: { sit, bank, field, reserve, hp, enemyHp, enemyActive, fights:[{zone,us,them}], chg }
 * Two entries: the sitrep and Main's roger.
 */
function sitrep(ctx, v) {
  const enemy = ctx.enemy || 'Ember';
  const st = station(ctx);
  const parts = [`Sitrep. ${SIT[String(v.sit || 'even').split(' ')[0]] || SIT.even}`];
  parts.push(`Depot credits ${digits(v.bank)}. ${cap(count(v.field))} on the field, ${count(v.reserve)} in reserve.`);
  // v.turret: our turret's HP, null once down, undefined with turrets off.
  const tur = v.turret === undefined ? '' : v.turret == null ? ' Turret down.' : ` Turret ${digits(v.turret)}.`;
  parts.push(`Base ${digits(v.hp)}.${tur} ${enemy} base ${digits(v.enemyHp)}, ${count(v.enemyActive)} active.`);
  const f = (v.fights || [])[0];
  parts.push(f ? `Contact ${zone(f.zone)}. ${cap(count(f.us))} of ours, ${count(f.them)} ${enemy}.` : 'No contact.');
  if (v.chg) parts.push(`Change: ${v.chg}`);
  const main = mainCall(ctx.name);
  return [
    { kind: 'sitrep', from: st, to: main, text: `${main}, ${st}, ${parts.join(' ')} Over.`, body: parts.join(' ').replace(/^Sitrep\. /, ''), short: `SITREP: ${SIT[String(v.sit || 'even').split(' ')[0]] || SIT.even} Base ${digits(v.hp)}, ${enemy} ${digits(v.enemyHp)}.`,
      priority: String(v.sit || '').startsWith('base-threat') ? 'priority' : 'routine', subject: f ? { zone: f.zone } : null, label: 'SITREP' },
    { kind: 'roger', from: main, to: st, text: `${main}, roger. Out.`, body: 'Roger.', priority: 'routine', reply: true, ack: true },
  ];
}

/** Change since the last sitrep: { lost:{R:1}, killed:{T:2}, land:+1 } -> radio form, enemy named. */
function changeWords(c, enemy = 'Ember', names = NAMES) {
  if (!c) return '';
  const list = o => Object.keys(o || {}).filter(k => o[k] > 0).map(k => `${count(o[k])} ${typeName(k, o[k], names)}`).join(', ');
  const out = [];
  if (list(c.lost)) out.push(`Lost ${list(c.lost)}.`);
  if (list(c.killed)) out.push(`${enemy} lost ${list(c.killed)}.`);
  if (c.land > 0) out.push(`We took ${count(c.land)} zone${c.land === 1 ? '' : 's'}.`);
  if (c.land < 0) out.push(`We gave up ${count(-c.land)} zone${c.land === -1 ? '' : 's'}.`);
  return out.join(' ');
}

function offNet(ctx) {
  const main = mainCall(ctx.name);
  return { kind: 'net', from: main, to: 'All stations', text: `${main}, off net. Commander has the con.`, body: 'Off net. Commander has the con.', short: 'Main, off net. Commander has the con.', priority: 'routine' };
}
function backOnNet(ctx) {
  const main = mainCall(ctx.name);
  return { kind: 'net', from: main, to: 'All stations', text: `${main} back on net.`, body: 'Back on net.', short: 'Main back on net.', priority: 'routine' };
}

/**
 * Main acknowledges the commander's intent (docs/COMMANDER-CHAT.md). The human's note never goes on the net:
 * only the bot's own paraphrase, and in PvP only "<Name> Main, roger." (the opponent's viewers see the net).
 */
function cmdrAck(ctx, { text = '', neg = false, pvp = false } = {}) {
  const main = mainCall(ctx.name);
  const words = String(text || '').replace(/["|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
    .replace(/\bz(\d{1,2})\b/gi, (m, n) => zone(+n)).replace(/[.!?\s]+$/, '');
  // The commander is never on the net, so this has no recipient station: it is Main's own call to its stations.
  const base = { kind: 'net', from: main, to: 'All stations', priority: 'routine', label: 'INTENT' };
  if (pvp || !words) return { ...base, text: `${main}, roger.`, body: 'Roger.', short: 'Main, roger.' };
  if (neg) return { ...base, text: `${main}, copy. Unable: ${words}.`, body: `Copy. Unable: ${words}.`, short: `Main: unable, ${words}.` };
  return { ...base, text: `${main}, roger. Intent: ${words}.`, body: `Roger. Intent: ${words}.`, short: `Main: roger, ${words}.` };
}

/**
 * A field unit confirms, from a real game event, that it carried out an order of an exchange.
 * what: 'position' (reached the MOVE zone; z = zone 1-based) | 'medic' (reached its healer; via = healer tag) | 'base'.
 * The match passes the order's exchangeId / msgId, so the reply joins that exchange.
 */
function confirm(ctx, tag, what, { z, via } = {}) {
  const names = ctx.names || NAMES;
  const main = mainCall(ctx.name);
  const me = unitName(tag, names);
  let body, state;
  if (what === 'position') { body = `In position, ${zone(z)}.`; state = 'In position'; }
  else if (what === 'medic') { body = `Reached ${unitName(via, names)}.`; state = 'Reached medic'; }
  else { body = 'Reached base.'; state = 'Reached base'; }
  return { kind: 'confirm', from: me, to: main, text: `${main}, ${me}. ${body} Over.`, body, short: `${me}: ${body}`, priority: 'routine', subject: { unitId: tag }, state };
}

/** Phone one-liner for any entry. */
function shortOf(e) { return e.short || e.text; }

module.exports = {
  NAMES, count, digits, zone, unitName, mainCall, orderWords, negative, orderExchange,
  spotContact, spotLoss, spotBase, spotTurret, spotTurretDown, sitrep, changeWords, offNet, backOnNet, cmdrAck, shortOf,
  orderSubject, confirm,
};
