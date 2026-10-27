#!/usr/bin/env node
// Improvement Loop (Ray's "AgRTS Games Need Loops"): runs by itself after every match END (tools/v7node/loop.js starts it).
// 1. Read the match log. 2. Pick the single worst decision with the rule table below. 3. Propose ONE bounded tunable change (tools/v7node/lessons.js).
// 4. Replay N games vs Ember in the bench harness (tools/v7node/live-bench.js, private ports, never 8787) with candidate and current.
// 5. Keep the change only if it is not worse (wins first, then mean team HP); else revert. 6. Append a dated lesson line to state/lessons.log.
// usage: node tools/improve.js --log <auto.log | last-match.json> [--n 5] [--par 4] [--speed 10] [--dry]
'use strict';
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const LESSONS = require('./v7node/lessons'); const T = LESSONS.TUNABLES;
const ROOT = path.join(__dirname, '..');

/** Match log (loop text log or run() JSON) -> { reports: [{t, l}], buys: [{t, u}] (accepted buys only) }. */
function parseLog(txt) {
  const M = { reports: [], buys: [], moves: [] };
  let j = null; try { j = JSON.parse(txt); } catch {}
  const addPost = (t, lines, acks) => {
    const ok = new Set((acks || []).map(a => (a.match(/^ACK (\d+) OK/) || [])[1]).filter(Boolean));
    for (const ln of lines) { const m = ln.match(/^#(\d+) (.*)$/); const id = m ? m[1] : null, o = m ? m[2] : ln; if (id && acks && acks.length && !ok.has(id)) continue;
      const b = o.match(/^BUY ([A-Z])$/); if (b) M.buys.push({ t, u: b[1] }); if (/^MINE z\d/.test(o)) M.buys.push({ t, u: 'L' }); const mv = o.match(/^MOVE_ALL z(\d)/); if (mv) M.moves.push({ t, z: +mv[1] }); }
  };
  if (j && Array.isArray(j.reports)) {
    for (const l of j.reports) M.reports.push({ t: +((l.match(/ T(\d+)/) || [])[1] || 0), l });
    for (const p of j.posts || []) addPost(+p.t || 0, p.lines, p.acks);
    M.result = j.result || '';
    return M;
  }
  let t = 0;
  for (const raw of String(txt).split('\n')) {
    const r = raw.match(/^(?:\d+\s+)?(v7 T(\d+) .*)$/); if (r) { t = +r[2]; M.reports.push({ t, l: r[1] }); if (/ END /.test(r[1])) M.result = r[1]; continue; }
    const p = raw.match(/^\s*>> (.*?)\s+<= (.*?)(?:\s+\[[\d.]+ ms\])?$/); if (p) addPost(t, p[1].split(' ; '), p[2].split(' ; '));
    const rs = raw.match(/^RESULT (.*)$/); if (rs) M.result = rs[1];
  }
  return M;
}

/** Rule table, worst first. Each rule: does it fire on this match, and which ONE tunable change would fix it. */
const RULES = [
  { id: 'medic-missing', key: 'medicByT',
    fires: M => { const by = M.reports.filter(r => r.t >= 30 && r.t <= 60); const fielded = by.some(r => /\| f [^|]*\bM\d+@/.test(r.l)); const bought = M.buys.some(b => b.u === 'M' && b.t <= 60); return by.length && !fielded && !bought ? 'no medic on the field T30-T60' : null; },
    next: v => (v === 0 ? 60 : Math.max(30, v - 30)) },
  { id: 'rifle-churn', key: 'rifleRepMin',
    fires: M => { const n = M.buys.filter(b => b.u === 'R').length; return n >= 12 ? `${n} rifle buys (mostly replacements)` : null; },
    next: v => (v === 0 ? 3 : Math.max(1, v - 1)) },
  { id: 'tank-feed', key: 'tankHotWindow',
    fires: M => { let n = 0; for (const r of M.reports) { const m = r.l.match(/\| (?:[^|]* )?L:(\S+)/); if (m) for (const k of m[1].matchAll(/T(\d+)/g)) n += +k[1]; } return n >= 4 ? `${n} tanks lost` : null; },
    next: v => v + 30 },
  { id: 'idle-credits', key: 'spendGuardCR',
    fires: (M, K) => { const n = M.reports.filter(r => { const a = +((r.l.match(/act (\d)/) || [])[1] ?? 6), b = +((r.l.match(/\| buy b(\d+)/) || [])[1] || 0); return a < 6 && b >= K.spendGuardCR; }).length; return n >= 3 ? `${n} reports with ${K.spendGuardCR}+ CR and a free slot` : null; },
    next: v => v - 10 },
  { id: 'no-push-when-ahead', key: 'pushMargin',
    fires: M => { const ah = M.reports.filter(r => /\| ahead/.test(r.l)).length; const deep = M.moves.some(m => m.z >= 6); return ah >= 8 && !deep && !scoreEnd(M.result || '').win ? `ahead in ${ah} reports, never pushed past z5` : null; },
    next: v => v - 1 },
];

function recentReverts(logF, n = 3) { try { return fs.readFileSync(logF, 'utf8').trim().split('\n').slice(-n).filter(l => /REVERTED/.test(l)).map(l => (l.match(/\| (\w+) \S+->(\S+) \|/) || []).slice(1).join('=')); } catch { return []; } }

/** The single worst decision whose fix is still inside bounds and was not just reverted. */
function pick(M, K, reverted = []) {
  for (const R of RULES) {
    const why = R.fires(M, K); if (!why) continue;
    const to = LESSONS.clamp(R.key, R.next(K[R.key])); if (to === K[R.key]) continue;
    if (reverted.includes(`${R.key}=${to}`)) continue;
    return { rule: R.id, key: R.key, from: K[R.key], to, why };
  }
  return null;
}

/** One bench game vs Ember with the given lessons: { win, hp } (hp = our team HP at END). */
function benchGame(lessons, tag, speed) {
  return new Promise(res => {
    const lf = `/tmp/v7node/lessons-${tag}.json`; fs.mkdirSync('/tmp/v7node', { recursive: true }); LESSONS.save(lessons, lf);
    const ch = spawn(process.execPath, [path.join(ROOT, 'tools', 'v7node', 'live-bench.js')], { cwd: ROOT, env: { ...process.env, GBW_LESSONS: lf, LIVE_TAG: tag, GAME_SPEED: String(speed), GBW_IMPROVE: '0' } });
    let out = ''; ch.stdout.on('data', d => (out += d)); ch.stderr.on('data', d => (out += d));
    const kill = setTimeout(() => ch.kill('SIGKILL'), 900e3);
    ch.on('close', () => { clearTimeout(kill); const l = (out.match(/^RESULT (.*)$/m) || [])[1] || ''; res(scoreEnd(l)); });
  });
}
function scoreEnd(l) { const w = (l.match(/note: (.*?) won/) || [])[1]; return { win: w && !/^E(MBER|\b)/.test(w) ? 1 : 0, hp: +((l.match(/ hp(\d+)/) || [])[1] || 0), ok: / END /.test(l) }; }

async function replay(cur, cand, n, par, runner, speed) {
  const jobs = []; for (let i = 0; i < n; i++) jobs.push(['cur', cur, i], ['cand', cand, i]);
  const out = { cur: [], cand: [] }; let k = 0;
  await Promise.all(Array.from({ length: Math.max(1, par) }, async () => { while (k < jobs.length) { const [w, L, i] = jobs[k++]; const r = await runner(L, `imp-${process.pid}-${w}${i}`, speed); if (r.ok !== false) out[w].push(r); } }));
  const sum = a => ({ games: a.length, wins: a.reduce((s, r) => s + r.win, 0), hp: a.length ? +(a.reduce((s, r) => s + r.hp, 0) / a.length).toFixed(1) : 0 });
  return { cur: sum(out.cur), cand: sum(out.cand) };
}
/** Keep only if not worse: win rate first, then mean team HP. */
function notWorse(r) { if (!r.cand.games || !r.cur.games) return false; const wc = r.cand.wins / r.cand.games, wu = r.cur.wins / r.cur.games; return wc > wu || (wc === wu && r.cand.hp >= r.cur.hp); }

function stamp(d = new Date()) { const p = x => String(x).padStart(2, '0'); const tz = (new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d).find(x => x.type === 'timeZoneName') || {}).value || ''; return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${tz}`.trim(); }

async function improve(o = {}) {
  const lf = o.lessonsFile || LESSONS.file(), logF = o.logFile || LESSONS.logFile(); const say = o.say || console.log;
  const K = LESSONS.load(lf); const M = parseLog(o.text);
  const P = pick(M, K, recentReverts(logF));
  if (!P) { say('IMPROVE nothing to change (no rule fired inside bounds)'); fs.mkdirSync(path.dirname(logF), { recursive: true }); fs.appendFileSync(logF, `${stamp()} | none | no rule fired inside bounds | - | -\n`); return { picked: null }; }
  say(`IMPROVE picked ${P.rule}: ${P.key} ${P.from}->${P.to} (${P.why}; ${T[P.key].why})`);
  const cand = { ...K, [P.key]: P.to };
  let r = null, kept = false;
  if (o.dry) say('IMPROVE dry run: no replay, nothing changed');
  else {
    r = await replay(K, cand, o.n || 5, o.par || 4, o.runner || benchGame, o.speed || 10);
    kept = notWorse(r);
    if (kept) LESSONS.save(cand, lf);
    const line = `${stamp()} | ${P.key} ${P.from}->${P.to} | why: ${P.rule}, ${P.why} | evidence: cand ${r.cand.wins}/${r.cand.games} wins hp ${r.cand.hp} vs cur ${r.cur.wins}/${r.cur.games} wins hp ${r.cur.hp} | ${kept ? 'KEPT' : 'REVERTED'}`;
    fs.mkdirSync(path.dirname(logF), { recursive: true }); fs.appendFileSync(logF, line + '\n'); say('IMPROVE ' + line);
  }
  return { picked: P, result: r, kept };
}
module.exports = { parseLog, RULES, pick, notWorse, replay, improve, scoreEnd };

if (require.main === module) (async () => {
  const a = process.argv.slice(2), arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const lg = arg('--log'); if (!lg) { console.error('usage: improve.js --log <file> [--n 5] [--par 4] [--speed 10] [--dry]'); process.exit(2); }
  const lock = path.join(path.dirname(LESSONS.file()), 'improve.lock'); fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { const pid = +fs.readFileSync(lock, 'utf8'); if (pid && pid !== process.pid) { process.kill(pid, 0); console.log('IMPROVE already running (pid ' + pid + '), skipped'); process.exit(0); } } catch {}
  fs.writeFileSync(lock, String(process.pid));
  try { await improve({ text: fs.readFileSync(lg, 'utf8'), n: Math.max(5, +arg('--n', 5)), par: +arg('--par', 4), speed: +arg('--speed', 10), dry: a.includes('--dry') }); }
  finally { try { fs.unlinkSync(lock); } catch {} }
  process.exit(0);
})();
