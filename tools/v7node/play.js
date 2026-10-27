// Node Play Loop (experiment). One long-lived process; state in memory; no per-field subprocesses.
// Port of gbw-dev/auto.sh (Oct 20, incl. the empty-reserve DEPLOY guard). Reads v6 or v7 reports.
// Bash quirks are kept on purpose so decisions match auto.sh 1:1 (see docs/V7-NODE-BENCH.md "Quirks kept").
'use strict';
const awkNum = s => { const m = String(s).match(/^\s*[-+]?\d+(\.\d+)?/); return m ? +m[0] : 0; };
const sumDigits = (s, re = /\d+/g) => { let n = 0; for (const m of String(s || '').matchAll(re)) n += +(m[1] !== undefined ? m[1] : m[0]); return n; };
const g1 = (l, re) => { const m = l.match(re); return m ? m[1] : ''; };
const LESSONS = require('./lessons');   // per-bot tunables the Improvement Loop adjusts (defaults = shipped behavior)
const PX_DEFAULT = { T: 70, O: 44, R: 40, M: 36, S: 28, D: 20, L: 36 };

/** Parse once per report into the fields the rules read. Sections v7 left unchanged are read with the same patterns for both. */
function view(l, px) {
  const v7 = /^v7 /.test(l);
  const V = { l, v7 };
  V.t = g1(l, / T(\d+)/);
  V.act = g1(l, /act (\d)/); V.act = V.act === '' ? 6 : +V.act;
  V.res = g1(l, /res (\S+)/);
  const rf = v7 ? l.match(/res (.*?)(?= h\d)/) : l.match(/res (.*?)(?= b\d)/); V.resAll = rf ? rf[1] : '';
  V.bank = v7 ? g1(l, /\| buy b(\d+)/) : g1(l, / b(\d+)(?= h)/);
  V.buy = []; // [{u, price, n}] priciest first, as the arena orders them
  if (v7) { const b = g1(l, /\| buy b\d+ ([^|]*)/); for (const m of b.matchAll(/\b([A-Z])(\d+)(?:\(\d+fit\))?(?= |$)/g)) V.buy.push({ u: m[1], n: +m[2], price: px[m[1]] }); }
  else { const b = g1(l, /can buy: ([^|]*)/); for (const m of b.matchAll(/\b([A-Z])(\d+)x(\d+)/g)) V.buy.push({ u: m[1], price: +m[2], n: +m[3] }); }
  V.f = g1(l, /\| f ([^|]+)/); V.hasF = /\| f [^|]+/.test(l);
  V.ef = g1(l, /\| E \d+ f ([^|]+)/).replace(/ *$/, '');
  V.ahead = /\| ahead/.test(l); V.even = /\| even/.test(l); V.behind = /\| (behind|base-threat)/.test(l);
  // Forward posts (The Range port): v6 `posts OB up FOB 40% · E posts FOB`, v7 `post OB:up FOB:40% E:FOB`. '' when posts are off.
  { const m = v7 ? l.match(/\| post OB:(\S+) FOB:(\S+) E:(\S+)/) : l.match(/posts OB (\S+) FOB (\S+) · E posts (\S+)/); V.ob = m ? m[1] : ''; V.fob = m ? m[2] : ''; V.epost = m ? m[3] : ''; }
  V.boughtD = v7 ? /\b(EB|AB):D\d/.test(l) || /bought \dD/.test(l) : /bought \dD/.test(l);
  return V;
}
const has = (V, u) => V.buy.some(b => b.u === u);
// Counter buy (fix/counter-buy): pick the reinforcement that trades best per credit against what Ember fields now.
// Matchup numbers come from the arena's own src/agrts/red-buy.js (units.csv dmg, cooldown, bonus_vs, range, splash) -- the same table Ember buys with.
let MU = null; try { const RB = require('../../src/agrts/red-buy'); const id = { T: 'tank', R: 'rifle', S: 'scout', O: 'mortar', M: 'medic', D: 'drone', L: 'mine' }; MU = (c, e) => { try { return RB.matchup(id[c], id[e]); } catch { return 1; } }; } catch {}
const FIELD_CAP = { T: 2, S: 3, O: 2, R: 6 };   // own-field caps per type (a scout buy fields 3)
function enemyMix(ef) { const o = {}; for (const m of String(ef || '').matchAll(/\b(\d*)([A-Z])@z\d/g)) o[m[2]] = (o[m[2]] || 0) + (m[1] === '' ? 1 : +m[1]); return o; }
function ownMix(f, res) { const o = {}; for (const m of String(f || '').matchAll(/\b([A-Z])(\d*)@/g)) o[m[1]] = (o[m[1]] || 0) + 1; for (const m of String(res || '').matchAll(/(\d+)([A-Z])\b/g)) o[m[2]] = (o[m[2]] || 0) + +m[1]; return o; }
/** Best affordable unit among cands vs the enemy field; null when nothing is affordable. Rifles when Ember fields nothing (the old default). */
function counterPick(V, cands, bank, opts = {}) {
  const em = enemyMix(V.ef), om = ownMix(V.f, V.res === 'none' ? '' : V.resAll); const en = Object.values(em).reduce((a, b) => a + b, 0);
  if (!en) { const r = V.buy.find(x => x.u === 'R'); if (cands.includes('R') && r && r.price <= bank) return 'R'; }
  let best = null, bs = -1;
  for (const u of cands) {
    const b = V.buy.find(x => x.u === u); if (!b || !(b.price <= bank)) continue;
    if ((om[u] || 0) + (u === 'S' ? 3 : 1) > (opts.cap || FIELD_CAP)[u]) continue;
    let sc = 1; if (en && MU) { sc = 0; for (const [e, n] of Object.entries(em)) sc += n * MU(u, e); sc /= en; }
    sc /= 1 + 0.35 * (om[u] || 0);            // spread the mix: each one we already field cuts its score
    if (u === 'R') sc *= 1.15;                  // rifles stay the tie-break default
    if (sc > bs) { bs = sc; best = u; }
  }
  return best;
}

// Buy list (feat/buy-list, Ray-approved Oct 22): every unit has a job, a field cap and a skip rule.
// Order per pick: medic if needed -> tank floor 2 -> counter pick (red-buy matchup per credit) under the caps.
const LIST_CAP = { R: 6, T: 3, S: 3, O: 2, M: 2, D: 3 };   // own units (field + reserve); a scout buy fields 3, a drone pack 3
function listCtx(V) {
  const l = V.l || '';
  const em = enemyMix(V.ef), om = ownMix(V.f, V.res === 'none' ? '' : V.resAll);
  const en = Object.values(em).reduce((a, b) => a + b, 0), army = Object.values(om).reduce((a, b) => a + b, 0);
  const ez = {}; for (const m of String(V.ef || '').matchAll(/\b(\d*)[A-Z]@z(\d)/g)) ez[m[2]] = (ez[m[2]] || 0) + (m[1] === '' ? 1 : +m[1]);
  const clump = Math.max(0, ...Object.values(ez));
  const turtle = en >= 3 && (ez[8] || 0) === en;   // every Ember unit sits on its base zone
  const ehs = g1(l, /hosp G\S+ E(-?\d+)/); const bareHosp = /^\d+$/.test(ehs) && +ehs > 0 && en <= 2;
  const hurt = +(g1(l, / h(\d+)/) || 0);
  const fighters = army - (om.M || 0);
  const finish = /\| (ahead)/.test(l) && (g1(l, / gun G\S+ E(\S+)/) === '-' || g1(l, / tur G\S+ E(\S+)/) === '-');
  return { em, om, en, army, clump, turtle, bareHosp, hurt, fighters, finish };
}
/** One unit from the buy list, or null. fr = free field slots, bank = credits we may spend. */
function listPick(V, fr, bank, opts = {}) {
  const C = listCtx(V), { em, om, en } = C; const n = u => om[u] || 0;
  const LC = opts.caps || LIST_CAP, TF = opts.tankFloor ?? 2;
  const can = u => { if (u === 'R' && opts.noR) return false; if ((u === 'S' || u === 'D') && opts.noSD) return false; const b = V.buy.find(x => x.u === u); return !!b && b.price <= bank && fr >= (u === 'S' || u === 'D' ? 3 : 1) && n(u) + (u === 'S' || u === 'D' ? 3 : 1) <= LC[u]; };
  const skip = {
    R: () => n('R') * 2 > C.army && C.army >= 4,
    T: () => (em.S || 0) >= 3 && n('T') >= 2,
    S: () => n('S') >= 1 || (en >= 2 && (em.R || 0) * 2 >= en) || !((em.O || 0) + (em.M || 0) >= 1 || en === 0),
    O: () => n('T') + n('R') < 2 || !(C.clump >= 3 || C.turtle),
    M: () => C.hurt < 2 || C.fighters < 3,
    D: () => opts.noD || n('D') >= 1 || (em.R || 0) >= 3 || !(C.clump >= 5 || C.turtle || C.bareHosp),
  };
  const ok = u => can(u) && !skip[u]();
  if (ok('M')) return 'M';                                   // 1. medic when 2+ fighters are badly hurt
  if (!opts.tankHot && n('T') < TF && can('T') && !((em.S || 0) >= 3 && n('T') >= 1)) return 'T';   // 2. tank floor of 2 (vs a scout swarm: just 1)
  if (ok('D')) return 'D';                                   // drones: their trigger (clump 5+, turtle, bare hospital) is the reason to buy
  const cands = ['R', 'T', 'S', 'O'].filter(u => ok(u) && !(u === 'T' && opts.tankHot));   // tankHot: 2+ tanks died in the last 60 s, so no tank refills
  if (n('T') >= 2 && !((em.O || 0) + (em.M || 0) >= 1 || C.finish)) { const i = cands.indexOf('T'); if (i >= 0 && cands.length > 1) cands.splice(i, 1); }   // 3rd tank only vs mortars/medics or to finish structures
  if (!cands.length) return null;
  if (!en) return cands.includes('R') ? 'R' : cands[0];
  let best = null, bs = -1;
  for (const u of cands) {
    let sc = 1; if (MU) { sc = 0; for (const [e, k] of Object.entries(em)) sc += k * Math.min(MU(u, e), 2); sc /= en; }   // per-type score, 3.0 cap trimmed to 2 so scouts stop winning everything
    sc /= 1 + 0.35 * n(u);
    if (u === 'R') sc *= 1.15;
    if (u === 'D' || u === 'O') sc *= 1.3;                   // their trigger (clump/turtle) already passed: favour them
    if (sc > bs) { bs = sc; best = u; }
  }
  return best;
}
const slotsOf = u => (u === 'S' || u === 'D' ? 3 : u === 'L' ? 0 : 1);   // mines take no field slot (docs/MINES.md)
const SPEND_ORDER = ['R', 'O', 'M', 'T', 'S', 'D'];   // spend-guard fallback, cheapest useful first. No L: mines come only from the mine rule (lesson mineByT), laid in the hold zone
/** Shared with tools/lesson.js (idle-credits): a report is idle-eligible when a field slot is free, bank >= guard, and some offered unit is affordable and fits. */
function idleEligible(l, guard, px = PX_DEFAULT) {
  const V = view(l, { ...PX_DEFAULT, ...px }); const act = V.act, bank = V.bank === '' ? 0 : +V.bank;
  return act < 6 && bank >= guard && V.buy.some(b => b.price <= bank && 6 - act >= slotsOf(b.u));
}
// Rule ids (bot/skills/grokbotwar-ttp/SKILL.md lists each; tools/test-ttp-sync.js checks both ways):
// deploy-reserve, buy-list, medic-first, tank-floor, counter-pick, second-pick, field-full-reserve, mortar-keep, focus-drones,
// finish-push, zone-push, fall-back, focus-structures, autobuy-scouts, buy-range, regroup, fob-push, scout-raid, commander-notes,
// medic-want, rifle-cap, save-for-tank, spend-guard, medic-by-t, lesson-caps, rifle-rate, autobuy-off, tank-bank-check, deploy-guard, mine-hold

// Unit names a commander can say in chat (singular, plural, nicknames) -> buy code and display name.
const UNIT_WORD = [[/scout|flanker|raider/, 'S', 'scout trio'], [/rifle|trooper|infantry/, 'R', 'rifle'], [/tank|breaker/, 'T', 'tank'], [/mortar|artillery|tube/, 'O', 'mortar'], [/drone/, 'D', 'drone pack'], [/\bmines?\b|land ?mine/, 'L', 'mine pack']];
class Play {
  constructor(o = {}) {
    this.S_hz = o.hold || 4; this.zone = this.S_hz; this.S_at = o.assaultT || 318; this.S_pt = 30; this.S_pe = 60; this.S_hp = 0;
    if (o.push === 'early') this.S_pe = 30; if (o.push === 'late') { this.S_pt = 200; this.S_pe = 200; this.S_hp = 1; }
    Object.assign(this, { fd: 0, fg: 0, fdp: 0, fin: 0, first: 1, mbank: 0, prevab: '', ghs: '', ar: 0, rbn: 0, bn: 0, las: null, asb: {}, pg: 0, ph: 0, pd: 0, mdone: '' });
    this.medicWant = null; this.acked = new Set(); this.inject = []; this.px = Object.assign({}, PX_DEFAULT); this.raid = !!o.raid; this.S_note = o.note || ''; this.rd = 0; this.log = o.log || (() => {});
    this.K = LESSONS.normalize(o.lessons || {}); this.rbuys = []; this.sdbuys = []; this.caps = LESSONS.caps(this.K);   // lessons: read once per match
  }
  cmdrMap(id, text) {
    const t = text.toLowerCase(); const o = [];
    if (/medic|heal/.test(t)) { this.medicWant = 2; o.push(`ACK ${id} saving for 2 medics, fielding them as slots open`); }
    else if (/drone/.test(t) && !/buy|more|get|build|field|need|want/.test(t)) o.push(`ACK ${id} focusing their drones`, 'FOCUS D');
    else if (/turret/.test(t)) o.push(`ACK ${id} massing then hitting turret`, 'FOCUS TURRET');
    else if (UNIT_WORD.some(([re]) => re.test(t)) && !/hold|defend|back|retreat|save|bank|push|attack|press|forward/.test(t)) {   // commander names a unit: buy and field one next (60 s)
      const [, u, nm] = UNIT_WORD.find(([re]) => re.test(t)); this.wantU = u; this.wantT = null; o.push(`ACK ${id} saving for a ${nm}, fielding it as soon as a slot is open`); }
    else if (/hold|defend|back|retreat/.test(t)) o.push(`ACK ${id} holding the line at z4`, 'MOVE_ALL z4');
    else if (/push|forward|attack|press|base/.test(t)) o.push(`ACK ${id} pressing forward when we are ahead`);
    else if (/save|bank/.test(t)) o.push(`ACK ${id} saving credits for now`, 'AUTOBUY T RESERVE 100');
    else if (/spend|buy/.test(t)) o.push(`ACK ${id} spending everything we have`, 'AUTOBUY T RESERVE 0');
    else o.push(`ACK ${id} copy, working it in`);
    return o;
  }
  /** One report in, { acks, post } out. post is what goes on the wire (max 3). */
  decide(l) {
    const px = l.match(/\| px ([^|]+)/); if (px) for (const m of px[1].matchAll(/([A-Z])(\d+)/g)) this.px[m[1]] = +m[2];
    const V = view(l, this.px); const S = this; S._saving = 0; const bt = /\| base-threat/.test(l); const mw0 = S.medicWant !== null && !bt;   // medic-want never holds reinforcements while the base is threatened
    let ord = [];
    const act = V.act, res = V.res;
    const tw = / gun G/.test(l) ? 1 : 0;
    // Tank deaths (L:T1 in the event list): 2+ in the last 60 s suspends the tank floor; credits go to the counter mix instead.
    { const tn = +(V.t || 0); S.tdead = (S.tdead || []).filter(x => tn - x < S.K.tankHotWindow); const lm = g1(l, /\| (?:[^|]* )?L:(\S+)/); const k = sumDigits(lm, /T(\d+)/g); for (let i = 0; i < k; i++) S.tdead.push(tn);
      const hot = S.tdead.length >= 2; if (hot && !S.tankHot) S.log(`  TANK floor off T${tn}: ${S.tdead.length} tanks lost in 60 s`); S.tankHot = hot; }
    const TH = S.tankHot;
    // Lesson rifleRepMin: at most N rifle buys per 60 s (never while the base is threatened); listPick skips rifles, other units get the credits.
    { const tn = +(V.t || 0); S.rbuys = S.rbuys.filter(x => tn - x < 60); }
    const RC = S.K.rifleRepMin > 0 && !bt && S.rbuys.length >= S.K.rifleRepMin;
    // Lesson sdRepMin: at most N scout-trio + drone-pack buys per 60 s (churn guard).
    { const tn = +(V.t || 0); S.sdbuys = S.sdbuys.filter(x => tn - x < 60); }
    const SD = S.K.sdRepMin > 0 && S.sdbuys.length >= S.K.sdRepMin;
    const LO = { caps: S.caps, tankFloor: S.K.tankFloor, noSD: SD };
    const fT = (V.f.match(/\bT\d+@/g) || []).length, resT = sumDigits(res, /(\d+)(?=T)/g);
    if (act < 6 && res !== 'none') ord.push('DEPLOY ALL');
    else if (act < 6 && !mw0 && V.buy.some(b => b.u === 'T' || b.u === 'R')) {
      const bk1 = V.bank === '' ? 0 : +V.bank; const fr = 6 - act;
      const lo = { ...LO, noD: V.t !== '' && +V.t - (S.lastD ?? -99) < 30, tankHot: TH, noR: RC };   // drones: one pack, then 30 s before the next
      let u = listPick(V, fr, bk1, lo) || counterPick(V, ['T', 'R'], bk1) || V.buy.find(b => b.u === 'T' || b.u === 'R').u;
      const pb = V.buy.find(b => b.u === u); const pu = pb ? pb.price : 999; const left = bk1 - pu; const slots = fr - slotsOf(u);
      // spend down to under 30 CR: a second buy-list pick when a slot is free
      const V2 = { ...V, res: 'none', resAll: '', f: V.f + ` ${u}1@z1`.repeat(slotsOf(u)) };
      const u2 = slots >= 1 && left >= 30 ? listPick(V2, slots, left, { ...LO, noD: true, noR: RC }) : null;
      if (u === 'D' || u2 === 'D') S.lastD = +V.t || 0;
      if (u2) ord.push(`BUY ${u}`, `BUY ${u2}`, 'DEPLOY ALL'); else ord.push(`BUY ${u}`, slotsOf(u) === 3 ? `DEPLOY ${u} ${u} ${u}` : `DEPLOY ${u}`);
    } else if (act >= 6 && !mw0) {
      const bk0 = V.bank === '' ? 0 : +V.bank; let rn0 = sumDigits(res); if (res === 'none') rn0 = 0;
      if (bk0 >= 100 && rn0 < 2) { const nm = (V.f.match(/\bM\d+@/g) || []).length; const u = listPick(V, 3, bk0, { ...LO, noD: true, tankHot: TH, noR: RC }); if (nm < 1 && has(V, 'M') && bk0 >= 200) ord.push('BUY M'); else if (u) ord.push(`BUY ${u}`); }   // field full: bank a counter in reserve (was >= 200, T/M/R only)
    }
    const mineW = V.hasF ? V.f.trim().split(/\s+/).filter(Boolean).length : 0;
    S.ghs = '';   // no reinforcement group hold with a free slot: units deploy as they are bought (the field-full branch above still banks a reserve)
    const no = (l.match(/O\d+@z/g) || []).length;
    // mortar-keep slot check (Oct 20): a DEPLOY ALL already in this post fields the reserve first; skip BUY O/DEPLOY O when that leaves no free slot
    const freeAfter = 6 - act - (ord.includes('DEPLOY ALL') ? sumDigits(V.resAll === 'none' ? '' : V.resAll, /\b(\d+)(?=[A-Z]\b)/g) : 0);
    if (act < 6 && no < 2 && (fT + (V.f.match(/\bR\d+@/g) || []).length) >= 2 && (listCtx(V).clump >= 3 || listCtx(V).turtle) && has(V, 'O') && freeAfter >= 1) { ord = ord.filter(x => !['BUY T', 'BUY R', 'DEPLOY T', 'DEPLOY R'].includes(x)); ord.push('BUY O', 'DEPLOY O'); }
    if (S.fd === 0 && (V.boughtD || /D@z/.test(l))) { ord.push('FOCUS D'); S.fd = 1; }
    const ef = V.ef, mine = mineW;
    const rn = sumDigits(res);
    let en = 0; for (const tok of ef.split(' ')) { if (/none/.test(tok)) continue; let x = tok.replace(/^(\d*)[A-Z].*/, '$1'); if (x === '') x = '1'; en += awkNum(x); }
    const t = V.t === '' ? 0 : +V.t; let hold = 0, pushm = 0, lead = 0, ahead = 1, foelow = 9;
    const efTok = ef.split(' ').filter(x => /^\d*[A-Z]@z\d/.test(x) && !/^\d*[SM]@/.test(x));
    let ogn = '', edp = '', ohs = '';
    if (tw === 1) {
      const myhp = g1(l, / hp(\d+)/), ehp = g1(l, /\| E (\d+)/); lead = (myhp === '' ? 100 : +myhp) - (ehp === '' ? 100 : +ehp);
      const egn = g1(l, / gun G\S+ E(\S+)/); ogn = g1(l, / gun G(\S+)/); const odp = g1(l, / dep G(\S+)/); edp = g1(l, / dep G\S+ E(\S+)/);
      ohs = g1(l, /hosp G(-?\d+)/); const ehs = g1(l, /hosp G\S+ E(-?\d+)/);
      let pts = 0, epts = 0; if (egn === '-') pts += 2; if (edp === '-') pts += 3; if (/^-/.test(ehs)) pts += 1;
      if (ogn === '-') epts += 2; if (odp === '-') epts += 3; if (/^-/.test(ohs)) epts += 1;
      const zg = +(g1(l, /\| z (\d+)/) || 0), ze = +(g1(l, /\| z \d+\/(\d+)/) || 0);
      ahead = 0; if (lead > 0 || (lead === 0 && (pts > epts || (pts === epts && zg > ze)))) ahead = 1;
      const zs = efTok.map(x => +(x.match(/@z(\d)/) || [])[1]).filter(n => !isNaN(n)); foelow = zs.length ? Math.min(...zs) : 9;
      if (t >= 200 && lead >= 1) hold = 1;
      if (t >= 240 && ahead === 0) pushm = 1;
    }
    if (S.fin === 0 && mine >= 3 && t >= 30 && ((ef === 'none' || /[A-Z]\d+@z6/.test(l)) && mine - en >= 3)) { ord = ['FOCUS TURRET', 'MOVE_ALL z8', ...ord]; S.fin = 1; }
    else if (S.fin === 0 && ef !== '' && (V.ahead || (V.even && t >= S.S_pe)) && t >= S.S_pt && (S.S_hp === 0 || ahead === 0) && mine >= 4 && mine - en >= S.K.pushMargin && S.zone < 6 && hold === 0) { S.zone++; ord.push(`MOVE_ALL z${S.zone}`); }
    else if (S.fin === 0 && V.behind && S.zone > S.S_hz && pushm === 0) { S.zone--; ord.push(`MOVE_ALL z${S.zone}`); }
    const eg = g1(l, / gun G\S+ E(\S+)/), ed = g1(l, / dep G\S+ E(\S+)/), et = g1(l, / tur G\S+ E(\S+)/);
    if (eg !== '' && ord.length < 3) {
      if (S.fin === 0 && S.fg === 0 && S.zone >= 6 && eg !== '-') { ord.push('FOCUS GUN'); S.fg = 1; }
      else if (S.fin === 0 && S.fg === 1 && eg === '-') { ord.push('FOCUS NONE'); S.fg = 2; }
      else if (S.fin === 1 && S.fdp === 0 && ed !== '' && ed !== '-' && et === '-' && /@z8/.test(V.f)) { ord.push('FOCUS DEPOT'); S.fdp = 1; }
      else if (S.fdp === 1 && ed === '-') { ord.push('FOCUS NONE'); S.fdp = 2; }
    }
    let sc = 0; for (const m of ef.matchAll(/(\d*)S(?=@|\b)/g)) sc += m[1] === '' ? 1 : +m[1];
    if (S.ar === 0 && en >= 3 && sc * 2 >= en) { ord.unshift('AUTOBUY R'); S.ar = 1; }
    if (S.ar === 1 && rn >= 4) { ord.unshift('AUTOBUY OFF'); S.ar = 2; } else if (S.ar === 2 && rn < 4) { ord.unshift('AUTOBUY R'); S.ar = 1; }
    if (rn >= 4 && act >= 6) {
      ord = ord.filter(x => x !== 'BUY R'); const ntc = fT + resT; const noc = (V.f.match(/\bO\d+@/g) || []).length + sumDigits(res, /(\d+)(?=O)/g);
      if (ntc < S.K.tankFloor && tw !== 1 && !TH && has(V, 'T')) ord.push('BUY T'); else if (noc < 2 && has(V, 'O')) ord.push('BUY O');
    }
    const rg = g1(l, / rng G(\d+)/);
    if (rg !== '' && tw === 1 && rg === '0' && act >= 6 && t <= 300 && S.rbn < 3 && !ord.some(x => /^BUY/.test(x)) && V.bank !== '' && +V.bank >= 80) { ord.push('BUY RANGE'); S.rbn++; S.log(`  BUYRANGE T${t} (${S.rbn} of 3)`); }
    if (S.fin === 0 && S.zone > S.S_hz && mine < 4 && !(pushm === 1 && mine >= 3)) { S.zone = S.S_hz; ord.push(`MOVE_ALL z${S.S_hz}`); }
    let fz = 2; const og = ogn === '' ? '-' : ogn; if (tw === 1 && og !== '-' && awkNum(og) > 0) fz = 3;
    if (S.fin === 0 && mine <= 2 && S.zone > fz && V.behind) { S.zone = fz; ord.push(`MOVE_ALL z${fz}`); }
    else if (S.fin === 0 && S.zone < 4 && mine >= 4 && (S.S_hz === 4 || ahead === 1)) { S.zone = 4; ord.push('MOVE_ALL z4'); }
    if (tw === 1 && S.fin === 0) {
      let hm = '';
      if (hold === 1 && S.zone > S.S_hz) { S.zone = S.S_hz; hm = `MOVE_ALL z${S.S_hz}`; }
      else if (pushm === 1 && mine >= 3 && S.zone < 6 && foelow > 3) { S.zone = 6; hm = 'MOVE_ALL z6'; }
      else if (t >= S.S_at && lead < 0 && lead >= -30 && edp !== '' && edp !== '-' && mine >= 3 && S.bn === 0) { S.bn = 1; S.fin = 1; S.fdp = 1; hm = 'FOCUS DEPOT'; ord = ['MOVE_ALL z8', ...ord]; }
      if (hm) { ord = [hm, ...ord.filter(x => !/^MOVE_ALL/.test(x) || hm === 'FOCUS DEPOT')]; }
      const cg = g1(l, / gun G(\d+)/), ch = /^\d+$/.test(ohs) ? ohs : '', cd = g1(l, / dep G(\d+)/);
      for (const [sw, cur, prev] of [[3, cg, S.pg], [4, ch, S.ph], [1, cd, S.pd]]) {
        const c = cur === '' ? 0 : +cur;
        if (c > 0 && t - (S.asb[sw] ?? -99) >= 20 && c < prev && mine >= 2 && t - (S.las ?? -99) >= 6 && efTok.some(x => x.includes(`@z${sw}`))) { ord = [`ASSIST z${sw}`, ...ord]; S.las = t; break; }
      }
      S.pg = cg === '' ? 0 : +cg; S.ph = ch === '' ? 0 : +ch; S.pd = cd === '' ? 0 : +cd;
    }
    // FOB push (Range port): the FOB at z4 needs z4 AND z5 held. With our FOB not standing, 4+ on the field and not behind, hold z5 instead of z4.
    if (V.fob && !/^up/.test(V.fob) && S.fin === 0 && S.zone === 4 && mine >= 4 && !V.behind && !ord.some(x => /^MOVE_ALL/.test(x))) { S.zone = 5; ord.push('MOVE_ALL z5'); S.log(`  FOB push T${t}: FOB ${V.fob}`); }
    const bk = V.bank === '' ? 0 : +V.bank; if (S.raid && S.rd === 0 && t >= 20 && act <= 3 && bk >= 84) { ord = ['BUY S', 'BUY S', 'BUY S', 'DEPLOY S S S', 'MOVE S z8']; S.rd = 1; }
    if (S.first === 1) { if (S.raid) ord.push('MOVE R z4', 'MOVE T z4'); else ord.push(`MOVE_ALL z${S.S_hz}`); S.first = 0; }
    for (const m of l.matchAll(/cmdr (\S+) "([^"]*)"/g)) { const cid = m[1]; if (S.acked.has(cid)) continue; S.acked.add(cid); ord = [...S.cmdrMap(cid, m[2].trim()), ...ord]; }
    if (S.S_note) { ord = [...S.cmdrMap('strategy', S.S_note).filter(x => !/^ACK/.test(x)), ...ord]; if (/medic|heal/i.test(S.S_note)) S.medicWant = null; S.S_note = ''; }   // strategy card note, once
    const mw = S.medicWant || 0; let mo = [];
    const ab = g1(l, /\bauto ([A-Z]+)/); if (ab && ab !== 'OFF' && ab !== 'none') S.prevab = ab;
    if (mw > 0 && bt) { S.mbank = 0; }
    else if (mw > 0) {
      ord = ord.map(x => x.replace('DEPLOY ALL', '')).filter(Boolean);
      if (act < 6 && /(^|[^A-Z])\d*M/.test(res)) mo.push('DEPLOY M'); else if (act < 6 && res !== 'none' && res !== '') mo.push('DEPLOY ALL');
      if (V.buy.some(b => b.u === 'M')) { mo.push('BUY M'); if (mw > 1) mo.push('BANK'); } else if (S.mbank === 0) { mo.push('BANK'); S.mbank = 1; }
    } else if (S.mdone) { mo.push(`AUTOBUY ${S.prevab || 'R'}`); S.mdone = ''; S.ar = 1; }
    if (mo.length) { const moD = mo.some(x => x.includes('DEPLOY')); const ak0 = [], r0 = []; for (const x of ord) { if (/^ACK/.test(x)) ak0.push(x); else if (!(/^DEPLOY/.test(x) && moD)) r0.push(x); } ord = [...ak0, ...mo, ...r0]; }
    // Buy-list caps on every buy path (group hold, autobuy, fallbacks): rifles stop at 6, tanks are brought up to 2 first.
    {
      const om = ownMix(V.f, V.res === 'none' ? '' : V.resAll); const rC = om.R || 0, tC = om.T || 0; const bkC = V.bank === '' ? 0 : +V.bank;
      const tb = V.buy.find(b => b.u === 'T'); const tPx = S.px.T || 70; let nR = 0, swapped = 0;
      ord = ord.filter(x => {
        if (x !== 'BUY R') return true;
        if (!swapped && !TH && tC < S.K.tankFloor && tb && tb.price <= bkC) { swapped = 1; return true; }   // replaced below
        if (rC + nR >= S.caps.R) { S.log(`  CAP: dropped BUY R (rifles ${rC})`); return false; }
        if (!bt && !TH && tC < S.K.tankFloor && bkC >= tPx - 25 && bkC < tPx && (6 - act) >= 1 && rC >= 3) { S._saving = 1; S.log(`  SAVE for tank T${t} (b${bkC})`); return false; }   // a tank is a few seconds away
        nR++; return true;
      });
      if (swapped) { const i = ord.indexOf('BUY R'); ord[i] = 'BUY T'; ord = ord.map(x => (x === 'DEPLOY R' ? 'DEPLOY T' : x)); }
      const abNow = g1(l, /\bauto ([A-Z]+)/);
      if (rC >= S.caps.R) {
        ord = ord.filter(x => x !== 'AUTOBUY R');
        if (abNow === 'T' && S.capAB && tC >= S.K.tankFloor) ord.unshift('AUTOBUY OFF');
        else if (abNow === 'R') { ord.unshift(tC < S.K.tankFloor ? 'AUTOBUY T' : 'AUTOBUY OFF'); S.capAB = 1; S.log(`  CAP: autobuy R off at ${rC} rifles`); }
      } else if (S.capAB && rC <= S.caps.R - 2 && abNow !== 'R') { ord.unshift('AUTOBUY R'); S.capAB = 0; }
    }
    // Lesson medicByT: the opening medic must be on the field by T<medicByT>; buy and deploy one in the 30 s before the deadline (once).
    { const md = S.K.medicByT, bkM = V.bank === '' ? 0 : +V.bank, mb = V.buy.find(b => b.u === 'M');
      if (md > 0 && !S.medForced && !bt && t >= Math.max(0, md - 30) && t <= md + 60 && act < 6 && !/\bM\d+@/.test(V.f) && !/\d+M\b/.test(V.resAll) && mb && mb.price <= bkM) {
        ord = ord.filter(x => !/^(BUY|DEPLOY) /.test(x)); ord.unshift('BUY M', 'DEPLOY ALL'); S.medForced = 1; S.log(`  LESSON medic by T${md}: BUY M at T${t}`); } }
    // caps + churn guard on every path (fallbacks, mortar-keep, raid): drop BUY S/D/O/M/T over the lesson caps
    { const om = ownMix(V.f, V.res === 'none' ? '' : V.resAll); const add = { S: 3, D: 3 }; const seen = {};
      ord = ord.filter(x => { const m = /^BUY ([SDOMT])$/.exec(x); if (!m) return true; const u = m[1]; if ((u === 'S' || u === 'D') && SD) { S.log(`  LESSON churn: dropped BUY ${u} (${S.sdbuys.length} in 60 s)`); return false; }
        const nn = (om[u] || 0) + (seen[u] || 0) + (add[u] || 1); if (nn > S.caps[u] && !(u === 'T' && (om.T || 0) < S.K.tankFloor)) { S.log(`  LESSON cap: dropped BUY ${u} (cap ${S.caps[u]})`); return false; } seen[u] = (seen[u] || 0) + (add[u] || 1); return true; }); }
    if (RC) { const n0 = ord.length; ord = ord.filter(x => x !== 'BUY R'); if (ord.length < n0) S.log(`  LESSON rifle rate: dropped BUY R (${S.rbuys.length} in 60 s)`); }
    // Spend guard (rule spend-guard): never leave spendGuardCR+ CR (lesson, default 40) unspent with a free field slot. Runs AFTER the cap,
    // churn and rifle-rate filters so nothing later drops its buy; the fallback only names units that pass those same caps (Oct 23 fix:
    // it used to pick S past the scout cap, the cap filter dropped it, and the bank sat idle).
    { const bkF = V.bank === '' ? 0 : +V.bank, free = 6 - act;
      if (act < 6 && !mw0 && !S._saving && bkF >= S.K.spendGuardCR && !ord.some(x => /^BUY /.test(x))) {
        const om = ownMix(V.f, V.res === 'none' ? '' : V.resAll);
        const fits = k => { const b = V.buy.find(x => x.u === k); return !!b && b.price <= bkF && free >= slotsOf(k) && (om[k] || 0) + slotsOf(k) <= S.caps[k] && !(k === 'R' && RC) && !((k === 'S' || k === 'D') && SD); };
        const lp = listPick(V, free, bkF, { ...LO, noD: true, tankHot: TH, noR: RC });
        const u = lp && fits(lp) ? lp : SPEND_ORDER.find(fits);
        if (u) { ord = ord.filter(x => !/^DEPLOY/.test(x)); ord.unshift(`BUY ${u}`, 'DEPLOY ALL'); if (u === 'D') S.lastD = t; S.log(`  SPEND T${t}: b${bkF} free ${free} -> BUY ${u}`); }
        else S.log(`  SPEND T${t}: b${bkF} free ${free}, nothing affordable fits the caps`); } }
    // Mine rule (lesson mineByT, cap capMinePacks): once per match, after the opening medic is out, when we hold our hold zone and the
    // bank covers a pack with nothing else bought this report: MINE z<hold> buys a pack and lays it in that zone (owned, behind the fight),
    // not at the contested front where Ember's scouts/drones clear it at once (match 7: BUY L at T24 went to contested z5 and was gone unseen).
    { const md = S.K.mineByT, bkM = V.bank === '' ? 0 : +V.bank, pxL = S.px.L || 36, zG = +((l.match(/\| z (\d+)\//) || [])[1] || 0);
      const medOk = /\bM\d+@/.test(V.f) || /\d+M\b/.test(V.resAll) || !!S.mdone;
      if (md > 0 && S.caps.L >= 3 && !S.mineDone && !bt && !mw0 && !S._saving && t >= md && zG >= S.S_hz && medOk && act >= 4 && bkM >= pxL
          && V.buy.some(b => b.u === 'L') && !ord.some(x => /^(BUY|MINE) /.test(x))) { ord.unshift(`MINE z${S.S_hz}`); S.log(`  MINE T${t}: b${bkM} -> MINE z${S.S_hz} (hold zone)`); } }
    // Commander named a unit in chat (cmdrMap): buy it as soon as it is affordable with room for it, else bank (no other buys). Expires after 60 s.
    if (S.wantU) { const wu = S.wantU, wb = V.buy.find(x => x.u === wu), wp = wb ? wb.price : S.px[wu], bkW = V.bank === '' ? 0 : +V.bank; if (S.wantT == null) S.wantT = t;   // the buy list only names affordable units, so an unaffordable one is priced from px
      if (!wp || t - S.wantT > 60) { S.log(`  WANT ${wu} dropped T${t}: ${wp ? 'expired' : 'no price'}`); S.wantU = null; }
      else if (!bt) {
        if (wb && wp <= bkW && 6 - act >= slotsOf(wu)) { ord = ord.filter(x => !/^(BUY|DEPLOY|MINE) /.test(x)); if (wu === 'L') ord.unshift(`MINE z${S.S_hz}`); else ord.unshift(`BUY ${wu}`, 'DEPLOY ALL'); if (wu === 'D') S.lastD = t; S.log(`  WANT T${t}: BUY ${wu}`); }
        else { ord = ord.filter(x => !/^BUY /.test(x)); S._saving = 1; } } }
    // Autobuy defers to the buy list: turn it off once, drop the loop's own AUTOBUY R/T toggles (commander RESERVE orders stay).
    { const abNow = g1(l, /\bauto ([A-Z]+)/); ord = ord.filter(x => !/^AUTOBUY (R|T|O|M|S|D)$/.test(x));
      if (abNow && abNow !== 'OFF' && abNow !== 'none' && !S.abOff) { ord.unshift('AUTOBUY OFF'); S.abOff = 1; S.log(`  AUTOBUY OFF T${t}: buy list governs`); } }
    // Never send a BUY T the bank can't cover (counts what earlier buys in this post spend).
    { let bkL = V.bank === '' ? 0 : +V.bank; const tPx = S.px.T || 70;
      ord = ord.filter(x => { const m = /^BUY ([A-Z])$/.exec(x); if (!m) return true; const pr = S.px[m[1]] || 0;
        if (m[1] === 'T' && bkL < tPx) { S.log(`  SKIP BUY T: bank ${bkL} < ${tPx}`); return false; } bkL -= pr; return true; }); }
    if (S.inject.length) { ord = [...S.inject, ...ord]; S.inject = []; }
    const acks = [], rest = []; for (const x of ord) { if (!x) continue; (/^ACK/.test(x) ? acks : rest).push(x); }
    let pool = sumDigits(V.resAll, /\b(\d+)(?=[A-Z]\b)/g); const post = [];
    for (const x of rest.slice(0, 3)) {
      if (x === 'BUY D') pool += 3; else if (/^BUY [A-Z]$/.test(x)) pool += 1;
      else if (/^DEPLOY/.test(x)) { if (pool <= 0) { S.log(`  GUARD: dropped ${x} (reserve empty)`); continue; } pool = x === 'DEPLOY ALL' ? 0 : pool - x.slice(7).trim().split(/\s+/).length; }
      post.push(x);
    }
    this._t = t; this._post = post;
    return { acks, post };
  }
  /** Results for the last post, as "OK <order>" / "ERR <order>: reason" (v6) or mapped from ACK id lines (v7). */
  onResults(results) {
    const S = this;
    if (results.some(r => /^OK (BUY L$|MINE )/.test(r))) { S.mineDone = 1; S.log(`  MINE pack bought T${S._t}`); }
    if (S.wantU && results.some(r => r === `OK BUY ${S.wantU}` || (S.wantU === 'L' && /^OK MINE /.test(r)))) { S.log(`  WANT ${S.wantU} bought T${S._t}`); S.wantU = null; }
    if (results.some(r => /^OK BUY M/.test(r))) { let mw = (S.medicWant ?? 1) - 1; S.mbank = 0; S.log(`  MEDIC bought T${S._t}, ${mw} left`); if (mw <= 0) { S.medicWant = null; S.mdone = 1; } else S.medicWant = mw; }
    if (results.some(r => /^OK BANK/.test(r))) S.mbank = 1;
    for (const r of results) if (/^OK BUY R$/.test(r)) S.rbuys.push(S._t || 0);
    for (const r of results) if (/^OK BUY [SD]$/.test(r)) S.sdbuys.push(S._t || 0);
    for (const r of results) { const m = r.match(/^ERR ASSIST z(\d+)[^:]*: no enemy/) || r.match(/^ERR ASSIST z(\d+) no_enemy/); if (m) { S.asb[+m[1]] = S._t; break; } }
  }
}
module.exports = { idleEligible, slotsOf, SPEND_ORDER, listPick, listCtx, counterPick, enemyMix, Play, view };
