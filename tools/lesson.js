#!/usr/bin/env node
// Agent-driven lessons (Ray, Oct 23): at END the bot reads `summary`, fixes the worst decisions with one `set` call (up to 3 keys).
// The change is a 'trial' judged on the next real matches (no replays) by `record`, which tools/v7node/loop.js runs after RESULT.
// Overfitting guards (each logs why it allowed or blocked):
//  (a) step: a set moves at most TUNABLES[k].step toward the target per match
//  (b) evidence: the mistake behind the key must show in >= 2 of the last 3 matches, unless severe (last match lost with the base destroyed and that mistake seen)
//  (c) judging: a trial is kept or reverted on a rolling window (3 matches after vs up to 3 before: wins, then mean base HP), never one result.
//      KEEP needs >= 2 'before' matches. With a thinner baseline the trial is extended to 6 matches and then kept only if it won at least half.
//  (d) cooldown: a reverted key can't be set again for 3 matches
//  (e) drift: a key off its default with no evidence and no set for 5 matches steps back toward the default
//  (f) at most 3 keys changed per match
// usage: node tools/lesson.js summary [--log f] | set <key> <value> [<key> <value> ...] --why "..." | record [--log f] | status | list
'use strict';
const fs = require('fs'), path = require('path');
const L = require('./v7node/lessons'); const T = L.TUNABLES; const PLAY = require('./v7node/play');
const WIN = 3, MINBEFORE = 2, LOOP_GAP = 20, COOLDOWN = 3, DRIFT = 5, MAXSETS = 3;
const histFile = () => path.join(path.dirname(L.file()), 'lessons-history.json');
const stamp = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const log = s => { const f = L.logFile(); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, `${stamp()} | ${s}\n`); console.log(s); };
const loadH = () => { try { return JSON.parse(fs.readFileSync(histFile(), 'utf8')); } catch { return { matches: [], trials: {}, cooldown: {}, justified: {}, sets: {} }; } };
const saveH = h => { fs.mkdirSync(path.dirname(histFile()), { recursive: true }); fs.writeFileSync(histFile(), JSON.stringify(h, null, 1) + '\n'); };

/** Match log (loop text or last-match.json) -> reports + accepted buys. */
function parse(txt) {
  const M = { reports: [], buys: [], result: '' }; let j = null; try { j = JSON.parse(txt); } catch {}
  const addPost = (t, lines, acks) => { const ok = new Set((acks || []).map(a => (a.match(/^ACK (\d+) OK/) || [])[1]).filter(Boolean));
    for (const ln of lines) { const m = ln.match(/^#(\d+) (.*)$/); const id = m ? m[1] : null, o = m ? m[2] : ln; if (id && acks && acks.length && !ok.has(id)) continue; const b = o.match(/^BUY ([A-Z])$/); if (b) M.buys.push({ t, u: b[1] }); if (/^MINE z\d/.test(o)) M.buys.push({ t, u: 'L' }); } };
  if (j && Array.isArray(j.reports)) { for (const l of j.reports) M.reports.push({ t: +((l.match(/ T(\d+)/) || [])[1] || 0), l }); for (const p of j.posts || []) addPost(+p.t || 0, p.lines, p.acks); M.result = j.result || ''; return M; }
  let t = 0;
  for (const raw of String(txt).split('\n')) {
    const r = raw.match(/^(?:\d+\s+)?(v7 T(\d+) .*)$/); if (r) { t = +r[2]; M.reports.push({ t, l: r[1] }); if (/ END /.test(r[1])) M.result = r[1]; continue; }
    const p = raw.match(/^\s*>> (.*?)\s+<= (.*?)(?:\s+\[[\d.]+ ms\])?$/); if (p) addPost(t, p[1].split(' ; '), p[2].split(' ; '));
    const rs = raw.match(/^RESULT (.*)$/); if (rs) M.result = rs[1];
  }
  return M;
}
// Unit letters (legend printed in every summary; never guess): S scout, R rifle, T tank, M medic, D drone, O mortar, L mine. L in a mix is a
// MINE pack, not losses (the report's 'L:' event is losses) and never a medic (M).
const UNIT = { S: 'scout', R: 'rifle', T: 'tank', M: 'medic', D: 'drone', O: 'mortar', L: 'mine' };
const LEGEND = 'legend: ' + Object.entries(UNIT).map(([k, v]) => `${k} ${v}`).join(', ');
/** Compact digest the agent decides from, plus the mistake tags (each names the keys that address it). */
function digest(M, K = L.load()) {
  const end = M.result || (M.reports.length ? M.reports[M.reports.length - 1].l : '');
  const buys = {}; for (const b of M.buys) buys[b.u] = (buys[b.u] || 0) + 1;
  const units = { ...buys }; if (units.S) units.S *= 3; if (units.D) units.D *= 3; if (units.L) units.L *= 3;
  const lost = {}, elost = {};
  for (const r of M.reports) { const ev = (r.l.split('|')[1] || ''); for (const [re, o] of [[/(?:^|\s)L:(\S+)/, lost], [/EL:(\S+)/, elost]]) { const m = ev.match(re); if (m) for (const k of m[1].matchAll(/([A-Z])(\d+)/g)) o[k[1]] = (o[k[1]] || 0) + +k[2]; } }
  const banks = M.reports.map(r => ({ t: r.t, b: +((r.l.match(/\| buy b(\d+)/) || [])[1] || 0), a: +((r.l.match(/act (\d)/) || [])[1] ?? 6) }));
  // idle-credits uses play.js's own test (free slot, bank >= spendGuardCR, an offered unit fits) and only counts reports the loop answered with no accepted BUY
  const buyT = new Set(M.buys.map(b => b.t)); let px = {}; let idle = 0;
  for (const r of M.reports) { const pm = r.l.match(/\| px ([^|]+)/); if (pm) for (const m of pm[1].matchAll(/([A-Z])(\d+)/g)) px[m[1]] = +m[2];
    if (!/ (END|READY) /.test(r.l) && PLAY.idleEligible(r.l, K.spendGuardCR, px) && !buyT.has(r.t)) idle++; }
  // loop-down: a gap of > LOOP_GAP match-seconds between reports we received means the Play Loop stopped polling (the arena autopilot played Green)
  const gaps = []; for (let i = 1; i < M.reports.length; i++) { const a = M.reports[i - 1].t, b = M.reports[i].t; if (b - a > LOOP_GAP) gaps.push({ from: a, to: b }); }
  // Starting roster: medics on the field in the first report, before any buy landed. Kept apart from buys so a roster medic is never 'no medic'.
  const r0 = M.reports[0] ? M.reports[0].l : ''; const rosterM = M.buys.some(b => b.u === 'M' && b.t <= (M.reports[0] || {}).t) ? 0 : (((r0.match(/\| f ([^|]*)/) || [])[1] || '').match(/\bM\d+@/g) || []).length;
  const medT = (M.reports.find(r => /\| f [^|]*\bM\d+@/.test(r.l)) || {}).t;
  const zs = M.reports.map(r => r.l.match(/\| z (\d+)\/(\d+)/)).filter(Boolean); const zMax = zs.length ? Math.max(...zs.map(z => +z[1])) : 0;
  const ahead = M.reports.filter(r => /\| ahead/.test(r.l)).length;
  const w = (end.match(/note: (.*?) won/) || [])[1]; const win = w && !/^E(MBER|\b)/.test(w) ? 1 : 0;
  const hp = +((end.match(/ hp(\d+)/) || [])[1] || 0), tEnd = +((end.match(/ T(\d+)/) || [])[1] || 0);
  const g = re => (end.match(re) || [])[1];
  const cause = win ? (tEnd < 360 ? 'we destroyed their base' : 'time, we led') : (hp === 0 || g(/ dep G(\S+)/) === '-' ? `base destroyed T${tEnd}` : tEnd < 360 ? `lost T${tEnd}` : 'time, they led');
  const tags = [];
  const sdBuys = (buys.S || 0) + (buys.D || 0);
  if ((buys.S || 0) >= 4) tags.push({ id: 'scout-churn', keys: ['capScoutTrios', 'sdRepMin'], why: `${buys.S} scout trios bought (${units.S} scouts), ${lost.S || 0} lost` });
  if ((buys.D || 0) >= 2 && (lost.D || 0) >= 3) tags.push({ id: 'drone-churn', keys: ['capDronePacks', 'sdRepMin'], why: `${buys.D} drone packs, ${lost.D || 0} drones lost` });
  if ((buys.L || 0) >= 3) tags.push({ id: 'mine-churn', keys: ['capMinePacks'], why: `${buys.L} mine packs bought (${buys.L * 36} CR not in the fight)` });
  if ((buys.R || 0) >= 12) tags.push({ id: 'rifle-churn', keys: ['rifleRepMin', 'capRifle'], why: `${buys.R} rifle buys` });
  if ((lost.T || 0) >= 4) tags.push({ id: 'tank-feed', keys: ['tankHotWindow', 'tankFloor', 'capTank'], why: `${lost.T} tanks lost` });
  if (idle >= 3) tags.push({ id: 'idle-credits', keys: ['spendGuardCR'], why: `${idle} reports with ${K.spendGuardCR}+ CR and a free slot` });
  if (medT === undefined || medT > 90) tags.push({ id: 'medic-late', keys: ['medicByT', 'capMedic'], why: medT === undefined ? 'no medic fielded' : `first medic on field T${medT}` });
  if (ahead >= 8 && zMax < 6 && !win) tags.push({ id: 'no-push', keys: ['pushMargin'], why: `ahead in ${ahead} reports, never held z6` });
  if (gaps.length) tags.push({ id: 'loop-down', keys: [], why: 'Play Loop down at ' + gaps.map(g => `T${g.from}-T${g.to}`).join(', ') + ' (arena autopilot played Green; report only)' });
  const severe = !win && /base destroyed/.test(cause);
  // cost = units lost tied to the mistake; idle-credits converts conservatively (4 idle reports ~ 1 unit) so it can't outrank real losses
  const COST = { 'scout-churn': lost.S || 0, 'drone-churn': lost.D || 0, 'rifle-churn': lost.R || 0, 'tank-feed': 2 * (lost.T || 0), 'idle-credits': Math.floor(idle / 4), 'medic-late': lost.M || 0, 'no-push': 0, 'loop-down': 0 };
  for (const t of tags) t.cost = COST[t.id] || 0;
  const top = Math.max(0, ...tags.map(t => t.cost)); const severeTags = severe && top > 0 ? tags.filter(t => t.cost === top).map(t => t.id) : [];
  const id = require('crypto').createHash('sha1').update(end + '|' + M.reports.length + '|' + M.buys.length).digest('hex').slice(0, 10);
  return { id, win, hp, tEnd, cause, severe, severeTags, buys, units, lost, elost, endBank: banks.length ? banks[banks.length - 1].b : 0, maxBank: Math.max(0, ...banks.map(x => x.b)), idle, gaps, medT, rosterM, zMax, zEnd: zs.length ? `${zs[zs.length - 1][1]}/${zs[zs.length - 1][2]}` : '-', tags };
}
const PACK = { S: 'scout trio', D: 'drone pack', L: 'mine pack' };
const fmtMix = (o, pack) => Object.entries(o).map(([k, v]) => `${v} ${(pack && PACK[k]) || UNIT[k] || k}${v === 1 ? '' : 's'}`).join(', ') || 'none';
function printSummary(D, H, K) {
  const out = [];
  out.push(`MATCH ${D.win ? 'WON' : 'LOST'} | end: ${D.cause} | base hp ${D.hp} | zones end ${D.zEnd}, max held ${D.zMax}`);
  out.push(`started with ${D.rosterM || 0} medic${D.rosterM === 1 ? '' : 's'} (starting roster) | medics bought: ${D.buys.M || 0}`);
  out.push(`buys (orders, roster not included): ${fmtMix(D.buys, 1)}  = units ${fmtMix(D.units)}`);
  out.push(LEGEND);
  out.push(`lost: ${fmtMix(D.lost)} | killed: ${fmtMix(D.elost)}`);
  out.push(`credits: end ${D.endBank}, max ${D.maxBank}, idle reports ${D.idle} | first medic ${D.medT === undefined ? 'never' : 'T' + D.medT}`);
  out.push('mistakes: ' + (D.tags.length ? D.tags.map(t => `${t.id} (${t.why}; cost ${t.cost}) -> ${t.keys.join('|')}`).join('; ') : 'none flagged') + (D.severe ? ` [SEVERE: base lost; exception only for ${D.severeTags.join('/') || 'none'}]` : ''));
  if (D.gaps && D.gaps.length) out.push('PLAY LOOP DOWN at ' + D.gaps.map(g => `T${g.from}-T${g.to}`).join(', ') + ' (no reports read; arena autopilot played Green)');
  const ev = evidence(H, D);
  for (const t of D.tags.filter(x => x.keys.length)) out.push(`  ${t.id}: seen in ${ev[t.id] || 0}/${Math.min(WIN, H.matches.length + (D.recorded ? 0 : 1))} recent matches`);
  out.push('tunables: ' + Object.keys(T).map(k => `${k}=${K[k]}${K[k] !== T[k].def ? '*' : ''}`).join(' '));
  out.push('trials: ' + (Object.keys(H.trials).length ? Object.entries(H.trials).map(([k, tr]) => `${k} ${tr.prev}->${tr.value} since match ${tr.start + 1} (${H.matches.length - tr.start}/${WIN} judged)`).join('; ') : 'none'));
  const cd = Object.entries(H.cooldown).filter(([, n]) => n > H.matches.length).map(([k, n]) => `${k} until match ${n + 1}`); if (cd.length) out.push('cooldown: ' + cd.join(', '));
  return out.join('\n');
}
/** How many of the last WIN matches (incl. this digest when given and not yet recorded) show each tag. */
function evidence(H, D) {
  const recent = H.matches.slice(-WIN).map(m => m.tags || []); if (D && !D.recorded) { recent.push(D.tags.map(t => t.id)); recent.splice(0, Math.max(0, recent.length - WIN)); }
  const c = {}; for (const tg of recent) for (const id of new Set(tg)) c[id] = (c[id] || 0) + 1; return c;
}
const TAG_KEYS = { 'scout-churn': ['capScoutTrios', 'sdRepMin'], 'drone-churn': ['capDronePacks', 'sdRepMin'], 'rifle-churn': ['rifleRepMin', 'capRifle'], 'tank-feed': ['tankHotWindow', 'tankFloor', 'capTank'], 'idle-credits': ['spendGuardCR'], 'medic-late': ['medicByT', 'capMedic'], 'no-push': ['pushMargin'], 'mine-churn': ['capMinePacks'] };
const tagsFor = k => Object.keys(TAG_KEYS).filter(id => TAG_KEYS[id].includes(k));

/** set: all guards; returns { ok, value, reason }. H.matches[-1] is the last recorded match (the one being debriefed). */
function set(k, target, why, o = {}) {
  const H = o.H || loadH(); const K = L.load(); const n = H.matches.length;
  if (!T[k]) return { ok: false, reason: `unknown key ${k}; keys: ${Object.keys(T).join(', ')}` };
  if (!why) return { ok: false, reason: 'needs --why "..."' };
  const tv = L.clamp(k, target); const cur = K[k];
  if (tv === cur) return { ok: false, reason: `${k} is already ${cur}` + (tv !== +target ? ` (target ${target} clamped to ${tv})` : '') };
  if ((H.cooldown[k] || 0) > n) return block(k, `cooldown (d): ${k} was reverted, blocked until match ${H.cooldown[k] + 1}`);
  if (H.trials[k]) return block(k, `trial running (c): ${k} ${H.trials[k].prev}->${H.trials[k].value} needs ${WIN} matches before judging`);
  if ((H.sets[n] || []).length >= MAXSETS) return block(k, `max changes (f): ${MAXSETS} keys already changed after match ${n}`);
  const last = H.matches[n - 1]; const tags = tagsFor(k); const ev = evidence(H); const seen = Math.max(0, ...tags.map(id => ev[id] || 0));
  const sevNow = last && last.severe && tags.some(id => (last.severeTags || []).includes(id));
  if (seen < 2 && !sevNow) return block(k, `evidence (b): ${tags.join('/') || 'its mistake'} seen in ${seen}/${Math.min(WIN, n)} recent matches (need 2, or be the costliest mistake of a base loss${last && last.severe ? ': ' + (last.severeTags || []).join('/') : ''})`);
  const st = T[k].step; const nv = L.clamp(k, cur + Math.sign(tv - cur) * Math.min(st, Math.abs(tv - cur)));
  const stepNote = nv !== tv ? `step (a): target ${tv}, moved ${cur}->${nv} (max ${st} per match)` : `step (a): ${cur}->${nv} within ${st}`;
  const V = L.load(); V[k] = nv; L.save(V);
  H.trials[k] = { prev: cur, value: nv, target: tv, why, start: n, before: H.matches.slice(-WIN).map(m => ({ win: m.win, hp: m.hp })) }; H.justified[k] = n; (H.sets[n] = H.sets[n] || []).push(k); saveH(H);
  log(`SET ${k} ${cur}->${nv} | why: ${why} | allowed: evidence ${seen}/${Math.min(WIN, n)}${sevNow ? ' + severe' : ''}; ${stepNote} | trial from match ${n + 1}`);
  return { ok: true, value: nv, prev: cur };
  function block(k, r) { log(`BLOCKED ${k} -> ${target} | why: ${why} | ${r}`); return { ok: false, reason: r }; }
}
const score = a => ({ n: a.length, wins: a.reduce((s, r) => s + r.win, 0), hp: a.length ? +(a.reduce((s, r) => s + r.hp, 0) / a.length).toFixed(1) : 0 });
/** record: after every real match (loop.js). Adds the match, judges trials whose window is full, drifts stale keys. */
function record(D, o = {}) {
  const H = o.H || loadH(); D.recorded = true;
  if (D.id && H.matches.length && H.matches[H.matches.length - 1].id === D.id) { console.log(`match ${D.id} already recorded`); return { H, lines: [] }; }
  H.matches.push({ id: D.id, n: H.matches.length + 1, at: stamp(), win: D.win, hp: D.hp, t: D.tEnd, severe: D.severe, severeTags: D.severeTags || [], tags: D.tags.map(t => t.id) }); const n = H.matches.length;
  for (const t of D.tags) for (const k of t.keys) if (H.trials[k] || L.load()[k] !== T[k].def) H.justified[k] = n;
  const lines = [...(D.gaps && D.gaps.length ? [`PLAY LOOP DOWN at ${D.gaps.map(g => `T${g.from}-T${g.to}`).join(', ')} (arena autopilot played Green)`] : []), `MATCH ${n} ${D.win ? 'won' : 'lost'} T${D.tEnd} hp ${D.hp}${D.tags.length ? ' | mistakes ' + D.tags.map(t => t.id).join(',') : ''}`];
  for (const [k, tr] of Object.entries(H.trials)) {
    const b = score(tr.before || []); const thin = b.n < MINBEFORE; const need = thin ? 2 * WIN : WIN;   // (c) thin baseline: extend, don't keep on thin evidence
    const after = H.matches.slice(tr.start, tr.start + need); if (after.length < need) { lines.push(`TRIAL ${k} ${tr.prev}->${tr.value}: ${after.length}/${need} matches${thin && after.length >= WIN ? ` (extended: only ${b.n} before match${b.n === 1 ? '' : 'es'}, need ${MINBEFORE})` : ''}`); continue; }
    const a = score(after); const r = (a.wins / a.n) - (b.n ? b.wins / b.n : 0);
    const keep = thin ? a.wins * 2 >= a.n : r > 0 || (r === 0 && a.hp >= b.hp);
    const ev = thin ? `after ${a.wins}/${a.n} wins hp ${a.hp}; thin baseline (${b.n} before), kept only on >= half wins` : `after ${a.wins}/${a.n} wins hp ${a.hp} vs before ${b.wins}/${b.n} wins hp ${b.hp} (window ${WIN})`;
    if (keep) lines.push(`KEPT ${k} ${tr.prev}->${tr.value} | ${ev} | why: ${tr.why}`);
    else { const V = L.load(); V[k] = tr.prev; L.save(V); H.cooldown[k] = n + COOLDOWN; lines.push(`REVERTED ${k} ${tr.value}->${tr.prev} | ${ev} | cooldown (d) until match ${n + COOLDOWN + 1}`); }
    delete H.trials[k];
  }
  const V = L.load(); let drift = false;
  for (const k of Object.keys(T)) { if (V[k] === T[k].def || H.trials[k]) continue; const j = H.justified[k] ?? 0; if (n - j < DRIFT) continue;
    const nv = V[k] + Math.sign(T[k].def - V[k]) * Math.min(T[k].step, Math.abs(T[k].def - V[k])); lines.push(`DRIFT (e) ${k} ${V[k]}->${nv} toward default ${T[k].def} | no evidence or set for ${n - j} matches`); V[k] = nv; H.justified[k] = n; drift = true; }
  if (drift) L.save(V);
  saveH(H); for (const s of lines) log(s); return { H, lines };
}
module.exports = { parse, digest, evidence, set, record, loadH, saveH, histFile, WIN, MINBEFORE, LOOP_GAP, COOLDOWN, DRIFT, MAXSETS };

if (require.main === module) {
  const a = process.argv.slice(2), arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const lf = arg('--log', path.join(path.dirname(L.file()), 'last-match.json'));
  const readD = () => { let txt = ''; try { txt = fs.readFileSync(lf, 'utf8'); } catch { console.error(`no match log at ${lf}`); process.exit(1); } return digest(parse(txt)); };
  switch (a[0]) {
    case 'summary': { const H = loadH(); const D = readD(); const last = H.matches[H.matches.length - 1]; if (last && last.id === D.id) D.recorded = true; console.log(printSummary(D, H, L.load())); break; }
    case 'set': { // set <key> <value> [<key> <value> ...] --why "..." (up to MAXSETS keys per match)
      const why = arg('--why', ''); const pr = []; for (let i = 1; i < a.length && a[i] !== '--why'; i += 2) pr.push([a[i], +a[i + 1]]);
      let bad = 0; for (const [k, v] of pr) { const r = set(k, v, why); if (!r.ok) { console.error(`not set ${k}: ${r.reason}`); bad++; } }
      if (!pr.length || bad === pr.length) process.exit(2); break; }
    case 'record': record(readD()); break;
    case 'status': { const H = loadH(); const K = L.load(); console.log('tunables: ' + Object.keys(T).map(k => `${k}=${K[k]}`).join(' ')); console.log('trials: ' + JSON.stringify(H.trials)); console.log('matches recorded: ' + H.matches.length); break; }
    case 'list': for (const [k, t] of Object.entries(T)) console.log(`${k}  default ${t.def}  range ${t.min}..${t.max}  step ${t.step}  ${t.why}`); break;
    default: console.log('usage: node tools/lesson.js summary [--log f] | set <key> <value> [<key> <value> ...] --why "..." | record [--log f] | status | list'); process.exit(a[0] ? 1 : 0);
  }
}
