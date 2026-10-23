'use strict';
// Plan audit trail (docs/PLAN-AUDIT.md): an append-only JSONL file per match that records what the owner was shown, what they chose,
// what they approved, what the arena applied, what the seat's loop read and every order it sent, then a "plan vs actual" summary at the
// end. Nothing here ever throws into the game: a failed write is counted and printed once, the match goes on.
//
// File: <dir>/<boot>-m<match>.jsonl   (the arena restarts with match number 1 every time, so the boot stamp keeps files apart)
// Every line: { seq, at (ISO), ms (since the first record of this match file), match, boot, ev, ...data, prev, h }
//   h = first 16 hex of sha256(prev + canonical line without h): each line commits to the one before, so an edited or removed line breaks
//   the chain (`verify`). It is tamper evidence for the owner, not a security boundary.
// Secrets: join tokens, owner keys, gate ids, relay keys and authorization headers are never written (scrub: key names AND value shapes).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COUNT_FIELDS = ['scouts', 'rifles', 'tanks', 'medics', 'drones', 'mortars'];
const UNIT_CODE = { scout: 'S', rifle: 'R', tank: 'T', medic: 'M', drone: 'D', mortar: 'O' };
const UNIT_ID_BY_FIELD = { scouts: 'scout', rifles: 'rifle', tanks: 'tank', medics: 'medic', drones: 'drone', mortars: 'mortar' };

// ---------- scrub: no secrets in the trail ----------
const SECRET_KEY = /(token|owner.?key|okey|gate|secret|authorization|password|rules.?key|relay.?key|publish.?key|cookie|bearer|^key$|^ok$|^g$)/i;
const SECRET_VALUE = [
  [/ok_[0-9a-f]{48}/gi, 'ok_<hidden>'],
  [/\bg=[0-9a-f]{32}\b/gi, 'g=<hidden>'],
  [/Bearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, 'Bearer <hidden>'],
  [/\b[0-9a-f]{40,}\b/gi, '<hidden>'],               // any long hex run: join tokens, keys, gate ids, hashes of secrets
];
function scrubString(s) { let t = String(s); for (const [re, to] of SECRET_VALUE) t = t.replace(re, to); return t; }
/** A deep copy with secret-named keys dropped and secret-shaped strings masked. Depth and size limited; never throws. */
function scrub(v, depth = 0) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return scrubString(v).slice(0, 2000);
  if (depth > 6) return '<deep>';
  if (Array.isArray(v)) return v.slice(0, 200).map(x => scrub(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).slice(0, 80)) { if (SECRET_KEY.test(k) || v[k] === undefined || typeof v[k] === 'function') continue; o[k] = scrub(v[k], depth + 1); }
    return o;
  }
  return String(v).slice(0, 200);
}

// ---------- hashing ----------
function canon(v) {
  if (v == null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
/** The plan id the card shows (src/agrts/strategy.js hash): 12 hex, any dial or the note changes it. */
function planHash(s) { return s && typeof s === 'object' ? require('./strategy').hash(s) : null; }
/** Short stable hash of an opening ({ arsenal, queue, spend }). */
function openingHash(o) {
  if (!o || typeof o !== 'object') return null;
  const a = o.arsenal || {}, ids = Object.keys(UNIT_CODE);
  return sha(canon({ arsenal: Object.fromEntries(ids.map(id => [id, a[id] | 0])), queue: (o.queue || []).slice(), spend: o.spend === true })).slice(0, 12);
}

// ---------- the writer ----------
function create(dir, opts = {}) {
  const now = opts.now || Date.now;
  const boot = opts.boot || new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');   // 20261017T151028
  const state = new Map();   // match -> { seq, prev, t0 }
  let failed = 0;
  const file = n => path.join(dir, `${boot}-m${n}.jsonl`);
  function open(n) {
    let s = state.get(n);
    if (s) return s;
    s = { seq: 0, prev: '0'.repeat(16), t0: now() };
    state.set(n, s);
    for (const k of [...state.keys()]) if (k < n - 20) state.delete(k);
    return s;
  }
  /** Append one record. Returns the record written, or null when the write failed (never throws). */
  function log(match, ev, data) {
    try {
      const s = open(match | 0);
      const t = now();
      const rec = { seq: ++s.seq, at: new Date(t).toISOString(), ms: t - s.t0, match: match | 0, boot, ev, ...scrub(data || {}) };
      rec.prev = s.prev;
      rec.h = sha(s.prev + canon(rec)).slice(0, 16);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file(match | 0), JSON.stringify(rec) + '\n');
      s.prev = rec.h;
      return rec;
    } catch (e) {
      if (!failed++) console.log('[audit] could not write the plan audit trail: ' + (e && e.message || e));
      return null;
    }
  }
  return { dir, boot, file, log, get failed() { return failed; } };
}

// ---------- reading ----------
function parseFile(f) {
  let text; try { text = fs.readFileSync(f, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { out.push({ ev: 'corrupt_line', raw: line.slice(0, 80) }); } }
  return out;
}
/** Files for a match number, newest boot first. */
function filesFor(dir, match) {
  let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(n => new RegExp(`-m${match | 0}\\.jsonl$`).test(n)).sort().reverse().map(n => path.join(dir, n));
}
/** Match numbers that have a file, newest boot first then highest match first: [{ match, boot, file }]. */
function list(dir) {
  let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  return names.map(n => { const m = n.match(/^(.+)-m(\d+)\.jsonl$/); return m ? { boot: m[1], match: +m[2], file: path.join(dir, n) } : null; }).filter(Boolean)
    .sort((a, b) => (a.boot < b.boot ? 1 : a.boot > b.boot ? -1 : b.match - a.match));
}
/** The chain check: { ok, lines, bad: seq of the first broken line or null }. */
function verify(records) {
  let prev = '0'.repeat(16), n = 0;
  for (const r of records) {
    n++;
    const { h, ...rest } = r;
    if (r.prev !== prev || sha(prev + canon(rest)).slice(0, 16) !== h) return { ok: false, lines: n, bad: r.seq || n };
    prev = h;
  }
  return { ok: true, lines: n, bad: null };
}

// ---------- plan vs actual ----------
const countsText = c => { const o = []; for (const f of COUNT_FIELDS) if ((c[f] | 0) > 0) o.push(`${c[f]}${UNIT_CODE[UNIT_ID_BY_FIELD[f]]}`); return o.join(' ') || 'none'; };
const arsenalText = a => { const o = []; for (const id of Object.keys(UNIT_CODE)) if ((a[id] | 0) > 0) o.push(`${a[id]}${UNIT_CODE[id]}`); return o.join(' ') || 'none'; };
const clock = s => { s = Math.max(0, Math.round(+s || 0)); return `T${s}`; };
const hhmmss = iso => { const d = new Date(iso); return Number.isNaN(+d) ? '?' : d.toTimeString().slice(0, 8); };
const PUSH_T = { early: 30, normal: 60, late: 200 };            // the times the card shows
const PUSH_FROM = { early: 30, normal: 30, late: 200 };         // the earliest an order to Z6+ is in line with the plan (normal: ahead from T30, level from T60)
const planName = s => s ? `${String(s.plan || '?').replace(/^./, c => c.toUpperCase())}${s.custom ? ' (custom)' : ''}` : '?';
const SOURCE_TEXT = { agent_proposal: 'your agent\'s proposal, approved as shown', owner_edit: 'owner edit', default: 'the default plan, approved as shown' };
// plan_deviation kinds the arena raises while the match runs, and the summary check each one is the same finding as
const DEV_CHECK = { opening: 'opening', loop_read: 'read', read_stale: 'read', never_read: 'read', push: 'push', medics: 'medics', hold: 'hold' };

/**
 * The plan contract for one match, from its records. Pure. Returns
 * { match, approved, proposed, locked: { plan, hash, source, at, shownAt }, plan, hash, checks: [{ id, ok, text }], deviations: [text], bought, lines }.
 * Lines start with the contract: what the agent proposed, what the owner locked (and who wrote it), then the mismatches.
 * `ok: null` on a check means "nothing to compare" (shown as a dash, not as a pass).
 */
function summarize(records) {
  const R = Array.isArray(records) ? records : [];
  const by = ev => R.filter(r => r.ev === ev);
  const last = ev => { const l = by(ev); return l[l.length - 1] || null; };
  const match = (R[0] && R[0].match) || 0;
  const approvals = by('approve').filter(r => r.ready);
  const ap = approvals[approvals.length - 1] || null;
  const live = last('match_live');
  const planned = ap ? ap.normalized : null;
  const proposals = by('proposal').filter(r => !ap || r.seq < ap.seq);
  const prop = proposals[proposals.length - 1] || null;
  const shown = by('card_shown').filter(r => !ap || r.seq < ap.seq);
  const shownLast = shown[shown.length - 1] || null;
  const checks = [];
  const add = (id, ok, text) => checks.push({ id, ok, text });

  // 1. the contract: proposed -> shown -> locked
  if (!ap) add('locked', false, 'The plan was never locked: no APPROVE PLAN on the card for this match.');
  else {
    const src = ap.source || 'owner_edit';
    add('locked', true, `${planName(ap.normalized)} locked at ${hhmmss(ap.at)} (${SOURCE_TEXT[src] || src}, hash ${ap.hash}).`);
    if (!shownLast) add('shown', false, 'The card was never recorded as shown before the plan was locked.');
  }
  const edits = by('edit').filter(e => e.strategy_hash && (!ap || e.seq < ap.seq));
  const lastEdit = edits[edits.length - 1];
  if (ap && lastEdit) {
    if (lastEdit.strategy_hash === ap.hash) add('card', true, `The last card edit (${lastEdit.ctl || 'edit'}) is what was locked.`);
    else add('card', false, `The last card edit was ${lastEdit.strategy && lastEdit.strategy.plan ? lastEdit.strategy.plan : '?'} (${lastEdit.strategy_hash}) but the lock carried ${ap.normalized.plan} (${ap.hash}).`);
  }
  const resets = by('card_reset');
  if (resets.length) add('reset', false, `The card page replaced the owner's selection ${resets.length} time(s) with the proposal/default (first at ${hhmmss(resets[0].at)}: ${resets[0].from_plan} -> ${resets[0].to_plan}).`);
  const stale = by('card_stale');
  if (stale.length) add('stale', false, `The card page still showed "approved" from an earlier arena start (${stale.length} time(s)); it was unlocked from the arena's answer.`);
  if (ap && ap.raw_strategy) {
    const chg = COUNT_FIELDS.concat(['plan', 'hold', 'push', 'medic', 'note']).filter(k => ap.raw_strategy[k] !== undefined && ap.raw_strategy[k] !== ap.normalized[k]);
    if (chg.length) add('normalized', false, `The arena changed what the card sent: ${chg.map(k => `${k} ${JSON.stringify(ap.raw_strategy[k])} -> ${JSON.stringify(ap.normalized[k])}`).join(', ')}.`);
  }

  // 2. what the arena did with it
  if (ap) {
    if (ap.applied) add('applied', true, `Opening ${ap.applied === 'unchanged' ? 'already matched, left alone' : 'applied'}: ${arsenalText((ap.opening || {}).arsenal || {})}, queue ${((ap.opening || {}).queue || []).join('>') || 'none'}.`);
    else add('applied', false, 'The arena did not apply the locked opening (see the arena log for "strategy opening refused").');
    const refused = by('opening_refused').filter(o => o.seq > ap.seq);
    if (refused.length) add('refused', true, `${refused.length} seat opening(s) after the lock were refused (the locked plan stayed in force): ${arsenalText(refused[0].arsenal || {})} via ${refused[0].src}.`);
    const ap0 = ap.opening_hash;
    const over = by('opening_set').filter(o => o.src !== 'card' && o.seq > ap.seq && ap0 && o.hash !== ap0 && !o.refused);
    if (over.length) { const o = over[over.length - 1]; add('override', false, `An opening posted after the lock (${o.src}) replaced the card's: ${arsenalText(o.arsenal || {})}${(o.queue || []).length ? ', queue ' + o.queue.join('>') : ''}, at ${hhmmss(o.at)}.`); }
  }

  // 3. what the seat's loop read
  const reads = by('strategy_out'), seen = by('strategy_read');
  if (ap) {
    const after = reads.filter(r => r.seq > ap.seq), before = reads.filter(r => r.seq < ap.seq);
    if (reads.length === 0 && seen.filter(r => r.seq > ap.seq).length === 0) add('read', false, 'Nothing read the locked plan after the lock: the loop ran without it (Balanced numbers).');
    else if (after.length === 0 && reads.length) add('read', false, `The loop read the plan only BEFORE the lock (${before.length} read, plan ${((before[before.length - 1] || {}).plan) || '?'}), so it may have run on a stale plan.`);
    else if (after.length) {
      const r = after[0], bad = (r.mismatch || []);
      add('read', bad.length === 0, bad.length ? `The loop read ${r.plan} but the locked plan is ${ap.normalized.plan}: differs in ${bad.join(', ')}.` : `The loop read the locked plan (${r.plan}, ${clock(r.t)}).`);
    } else add('read', null, `The arena served the plan to the seat (${seen.length} read) but the CLI did not report what it printed.`);
  }

  // 4. what the opening really was, medics by T60
  if (planned && live && live.opening_actual) {
    const want = ap && ap.opening ? ap.opening.arsenal : null, got = live.opening_actual;
    if (want) {
      const diff = Object.keys(UNIT_CODE).filter(id => (want[id] | 0) !== (got[id] | 0));
      add('opening', diff.length === 0, diff.length === 0 ? `The match started with the locked opening (${arsenalText(got)}).` : `Planned ${arsenalText(want)}, started with ${arsenalText(got)} (${diff.map(id => `${UNIT_CODE[id]} ${want[id] | 0} -> ${got[id] | 0}`).join(', ')}).`);
    }
  }
  const t60 = last('t60');
  if (planned && t60) {
    const need = { none: 0, one_early: 1, two_by_t60: 2 }[planned.medic] | 0, have = (t60.owned || {}).medic | 0;
    add('medics', have >= need, `Medics by T60: planned ${need}, had ${have}${have < need ? ' (the second medic never came)' : ''}.`);
  }

  // 5. hold and push, from the orders the loop sent
  const orders = by('order').filter(o => (o.results || []).some(x => /^OK/.test(String(x))));
  const moveZone = o => { const m = (o.lines || []).map(l => String(l).match(/\bMOVE(?:_ALL)?\b[^z]*\bz(\d)\b/i)).filter(Boolean).map(x => +x[1]); return m.length ? m : null; };
  const moves = orders.map(o => ({ o, z: moveZone(o) })).filter(x => x.z);
  if (planned) {
    const hz = planned.hold === 'z3' ? 3 : 4;
    const first = moves.find(x => x.o.t >= 0);
    if (first) add('hold', first.z.includes(hz) || first.z.some(z => z <= hz), `Planned hold ${planned.hold.toUpperCase()}; the first move order sent the army to Z${first.z.join('/')} at ${clock(first.o.t)}.`);
    const from = PUSH_FROM[planned.push];
    const push = moves.find(x => x.z.some(z => z >= 6));
    if (push) add('push', push.o.t >= from - 8, `Plan: push ${planned.push} (from ${clock(from)}). First order to Z${push.z.find(z => z >= 6)} at ${clock(push.o.t)}${push.o.t < from - 8 ? ', earlier than planned' : ''}.`);
    else add('push', null, `Plan: push ${planned.push} (from ${clock(from)}). The loop never sent an army to Z6 or beyond.`);
  }
  const untagged = orders.filter(o => !o.why).length;
  if (orders.length) add('orders', null, `${orders.length} orders accepted (${orders.length - untagged} with a reason tag, ${untagged} untagged).`);

  // runtime plan_deviation records the arena raised, when they are not already one of the findings above
  const failing = new Set(checks.filter(c => c.ok === false).map(c => c.id));
  const devRecs = by('plan_deviation').filter(d => !failing.has(DEV_CHECK[d.kind]));
  const seenDev = new Set();
  for (const d of devRecs) { const k = d.kind + '|' + (d.detail || ''); if (seenDev.has(k)) continue; seenDev.add(k); add('dev:' + d.kind, false, `plan_deviation ${d.kind}: ${d.detail || ''}`); }

  // 6. bought
  const end = last('match_end');
  let bought = null;
  if (live && live.roster && end && end.roster) {
    bought = {}; for (const id of Object.keys(UNIT_CODE)) { const d = (end.roster[id] | 0) - (live.roster[id] | 0); if (d > 0) bought[id] = d; }
  }
  const deviations = checks.filter(c => c.ok === false).map(c => c.text);
  const lines = [`Plan contract, match ${match}`];
  const dflt = shownLast && !shownLast.proposal_hash ? shownLast : null;
  if (prop) lines.push(`  Proposed:   ${planName(prop.strategy)} [${prop.hash}] by your agent at ${hhmmss(prop.at)}${prop.unlocks ? ' (re-proposed after a lock)' : ''}`);
  else lines.push(`  Proposed:   none (the card opened on the Default plan${dflt ? ` [${dflt.hash}]` : ''})`);
  if (ap) lines.push(`  Locked:     ${planName(ap.normalized)} [${ap.hash}] by ${(ap.source || 'owner_edit').replace('_', ' ')}, at ${hhmmss(ap.at)}${shownLast ? `, card shown ${hhmmss(shownLast.at)}` : ', card shown: NOT RECORDED'}${ap.source === 'owner_edit' && prop ? `, edited from the proposal [${prop.hash}]` : ''}`);
  else lines.push('  Locked:     NOT LOCKED');
  lines.push(deviations.length ? `  Mismatches: ${deviations.length}` : '  Mismatches: none');
  for (const c of checks) if (c.ok === false) lines.push(`    - ${c.text}`);
  if (!deviations.length && !checks.some(c => c.ok === true)) lines.push('    (nothing recorded to compare)');
  if (planned) lines.push(`  Plan:       ${countsText(planned)} · hold ${planned.hold} · push ${planned.push} (${clock(PUSH_T[planned.push])}) · medic ${planned.medic}${planned.note ? ` · note "${String(planned.note).slice(0, 60)}"` : ''}`);
  if (live && live.opening_actual) lines.push(`  Ran:        opening ${arsenalText(live.opening_actual)}${bought && Object.keys(bought).length ? ` · bought ${arsenalText(bought)}` : ''}${end && end.orders != null ? ` · ${end.orders} orders` : ''}`);
  if (deviations.length) lines.push(`  Details:    node tools/warrior-seat.js audit --match ${match}`);
  return {
    match, approved: !!ap, proposed: prop ? { plan: prop.strategy && prop.strategy.plan, hash: prop.hash, at: prop.at } : null,
    locked: ap ? { plan: ap.normalized.plan, hash: ap.hash, source: ap.source || 'owner_edit', at: ap.at, shownAt: shownLast ? shownLast.at : null } : null,
    plan: planned, hash: ap ? ap.hash : null, checks, deviations, bought, lines,
  };
}

// ---------- reading it ----------
const STR = s => (s == null ? '' : String(s));
/** One timeline line per record (orders only with `full`). */
function timeline(records, full) {
  const out = []; let nOrders = 0;
  for (const r of records) {
    const at = hhmmss(r.at), tag = `${at} #${String(r.seq).padStart(3, '0')}`;
    let t = null;
    switch (r.ev) {
      case 'card_shown': t = `CARD SHOWN   ${planName({ plan: r.strategy && r.strategy.plan, custom: r.custom })} ${r.proposal_hash ? '(proposed by your agent)' : '(default)'} [${r.hash}] boot ${r.boot}`; break;
      case 'edit': t = `EDIT         ${STR(r.ctl)}${r.val != null ? ' = ' + STR(r.val) : ''} -> ${r.strategy ? planName(r.strategy) + ' ' + countsText(r.strategy) : '?'} [${STR(r.strategy_hash)}]`; break;
      case 'card_reset': t = `CARD RESET   page replaced its selection ${STR(r.from_plan)} -> ${STR(r.to_plan)} (${STR(r.why)})`; break;
      case 'card_stale': t = `CARD STALE   page said approved, arena said not (${STR(r.why)})`; break;
      case 'approve': t = `APPROVE      ${r.ready ? 'LOCKED (' + STR(r.source) + ') ' : '(draft only) '}sent ${JSON.stringify(r.raw_strategy || {})} -> ${planName(r.normalized)} [${r.hash}] opening ${r.applied || 'NOT applied'} phase ${STR(r.phase)}`; break;
      case 'proposal': t = `PROPOSAL     your agent proposed ${planName(r.strategy)} ${countsText(r.strategy || {})} [${r.hash}]${r.unlocks ? '  (this UNLOCKED the plan: it needs approving again)' : ''}`; break;
      case 'plan_deviation': t = `DEVIATION    ${STR(r.kind)}: ${STR(r.detail)}`; break;
      case 'lock_refused': t = `LOCK REFUSED ${STR(r.error)}`; break;
      case 'opening_refused': t = `OPENING REFUSED via ${STR(r.src)}: ${arsenalText(r.arsenal || {})} (the plan is locked: ${STR(r.plan)} [${STR(r.locked_hash || r.hash)}])`; break;
      case 'approve_late': t = `APPROVE LATE ${STR(r.note)} -> saved ${planName(r.normalized)} [${r.hash}]`; break;
      case 'rejected': t = `REJECTED     ${STR(r.error)} (${STR(r.field)})`; break;
      case 'opening_set': t = `OPENING      via ${STR(r.src)}: ${arsenalText(r.arsenal || {})} queue ${(r.queue || []).join('>') || 'none'} spend ${r.spend ? 'on' : 'off'} (${STR(r.appliesFrom)})${r.overrides_card ? '  ** REPLACES THE APPROVED CARD OPENING **' : ''}`; break;
      case 'strategy_read': t = `SEAT READ    plan ${STR(r.plan)} [${STR(r.hash)}] set=${r.set ? 1 : 0} approved=${r.approved ? 1 : 0} applied=${r.applied ? 1 : 0} card=${r.card ? 1 : 0}`; break;
      case 'strategy_out': t = `LOOP READ    ${STR(r.plan)} tanks=${STR(r.tanks)} medics=${STR(r.medics)} rifles=${STR(r.rifles)} hold=${STR(r.hold)} push=${STR(r.push)} approved=${STR(r.approved)}${(r.mismatch || []).length ? '  ** DIFFERS FROM APPROVAL: ' + r.mismatch.join(',') + ' **' : ''}`; break;
      case 'match_live': t = `MATCH LIVE   opening ${arsenalText(r.opening_actual || {})} queue ${(r.queue || []).join('>') || 'none'}`; break;
      case 't60': t = `T60          owned ${arsenalText(r.owned || {})}`; break;
      case 'match_end': t = `MATCH END    ${STR(r.winner)} ${STR(r.reason)} at ${STR(r.clock)}; roster ${arsenalText(r.roster || {})}`; break;
      case 'summary': t = 'SUMMARY      ' + (r.deviations || []).length + ' deviation(s)'; break;
      case 'order': nOrders++; if (full) t = `ORDER ${clock(r.t)}  ${(r.lines || []).join(' ; ')}  => ${(r.results || []).map(x => String(x).split(' ')[0]).join(',')}  why=${r.why || '-'}`; break;
      default: t = `${String(r.ev).toUpperCase()} ${JSON.stringify(r).slice(0, 120)}`;
    }
    if (t) out.push(`${tag}  ${t}`);
  }
  if (!full && nOrders) out.push(`(${nOrders} order records hidden; add --full to list them)`);
  return out;
}

module.exports = { create, scrub, scrubString, planHash, openingHash, canon, verify, parseFile, filesFor, list, summarize, timeline, countsText, arsenalText, UNIT_CODE, COUNT_FIELDS };
