#!/usr/bin/env node
// Node Play Loop runner: plays one match to END with play.js, on report v7 (default here) or v6.
// usage: node tools/v7node/loop.js [--v6] [--last-id N]     (normally via tools/v7node/auto-node.sh)
// Seat: the same saved seat as warrior-seat.js (secrets/warrior-seat.json, or an active secrets/pvp-seat.json); relay when the seat names one,
// the arena directly otherwise (and as fallback when the relay says the arena is not connected). The token is never printed.
// Strategy card: `node tools/warrior-seat.js strategy --wait <STRATEGY_WAIT s>` once before the first report (Balanced if no card).
// Commander inject: lines in $GBW_INJECT (default /tmp/inject) are posted first on the next report, then the file is cleared.
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process'); const { Play } = require('./play'); const LESSONS = require('./lessons');
const ROOT = path.join(__dirname, '..', '..');
function parseKv(text) { const o = {}; for (const ln of String(text || '').split('\n')) { const m = ln.match(/^([a-z_]+)=(.*)$/); if (m) { let v = m[2].trim(); if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/'\\''/g, "'"); else if (/^".*"$/.test(v)) v = v.slice(1, -1); o[m[1]] = v; } } return o; }
function playOpts(kv) { const hz = +String(kv.strategy_hold || '').replace(/^z/, '') || 4; return { hold: hz, assaultT: +kv.strategy_assault_t || 318, push: kv.strategy_push || '', note: kv.strategy_note || '' }; }
function seat() {
  const rd = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const pv = rd(path.join(ROOT, 'secrets', 'pvp-seat.json')); const pvpOn = pv && pv.join_token && !pv.ended && Date.now() - Date.parse(pv.startedAt || pv.savedAt || 0) < 3600e3;
  const s = pvpOn ? pv : rd(path.join(ROOT, 'secrets', process.env.WARRIOR_SEAT_FILE || 'warrior-seat.json')) || {};
  const relayUrl = String(process.env.RELAY_URL || s.relay || '').replace(/\/$/, ''), room = String(process.env.RELAY_ROOM || s.room || '');
  const relay = relayUrl && room && !/^(off|0|false|no)$/i.test(relayUrl) ? { url: relayUrl, room } : null;
  return { token: s.join_token, arena: (process.env.ARENA || s.arena || 'http://localhost:8787').replace(/\/$/, ''), relay, pvp: !!pvpOn };
}
async function call(S, local, rel, body, ms) {
  const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token };
  const go = async u => { const r = await fetch(u, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms || 40000) }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t }; } return { code: r.status, j }; };
  if (S.relay) { let r = null; try { r = await go(`${S.relay.url}/r/${encodeURIComponent(S.relay.room)}${rel}`); } catch {} if (r && !(r.code === 503 && r.j && r.j.error === 'arena is not connected')) return r; if (S.pvp) return r || { code: 0, j: {} }; }
  return go(S.arena + local);
}
async function run(o = {}) {
  const fmt = o.fmt || 'v7', S = o.seat || seat(); if (!S.token) throw new Error('no seat yet: run "node tools/warrior-seat.js join" first');
  const say = o.log || (s => console.log(s)); const kv = o.strategyKv != null ? parseKv(o.strategyKv) : {};
  const p = new Play({ ...playOpts(kv), log: say, lessons: o.lessons || LESSONS.load() }); const inj = o.inject === undefined ? (process.env.GBW_INJECT || '/tmp/inject') : o.inject;
  const out = { fmt, strategy: playOpts(kv), reports: [], posts: [], refusals: [], lat: [], result: null }; let since = o.lastId || 0, oid = 1; const q = fmt === 'v7' ? '&v=7' : '';
  for (;;) {
    const r = await call(S, `/api/seat/report?since=${since}&wait=30${q}`, `/seat/report?since=${since}&wait=30${q}`, null, 40000).catch(() => null);
    const j = (r && r.j) || {}; if (!r || r.code !== 200) { await new Promise(z => setTimeout(z, 2000)); continue; }
    if (!j.fresh || !j.line || ['STATE', 'WAITING', 'COUNTDOWN', 'ORDER'].includes(j.event)) { if (j.id > since && j.event === 'ORDER') since = j.id; if (j.stop && !j.fresh) { out.result = 'no-match'; break; } continue; }
    since = j.id; const l = j.line; say(`${j.id} ${l}`); out.reports.push(l);
    if (j.event === 'END') { out.result = l; break; }
    if (inj) { try { const t = fs.readFileSync(inj, 'utf8'); if (t.trim()) { fs.writeFileSync(inj, ''); p.inject.push(...t.split('\n').filter(Boolean)); } } catch {} }
    const a = process.hrtime.bigint(); const d = p.decide(l); const ms = Number(process.hrtime.bigint() - a) / 1e6; out.lat.push(ms);
    for (const x of d.acks) await call(S, '/api/seat/orders', '/seat/orders', { lines: [x], reportId: since, why: 'ack-commander' }).catch(() => null);
    if (!d.post.length) continue;
    const ids = d.post.map(() => oid++); const lines = fmt === 'v7' ? d.post.map((x, i) => `#${ids[i]} ${x}`) : d.post;
    const pr = await call(S, '/api/seat/orders', '/seat/orders', { lines, reportId: since, ...(fmt === 'v7' ? { v: 7 } : {}) }).catch(() => null);
    const results = (pr && pr.j && pr.j.results) || []; const acks = (pr && pr.j && pr.j.acks) || [];
    const mapped = fmt === 'v7' && acks.length ? acks.map(k => { const m = k.match(/^ACK (\d+) (OK|ERR (\S+))/); const ord = d.post[ids.indexOf(+m[1])]; return m[2] === 'OK' ? `OK ${ord}` : `ERR ${ord} ${m[3]}`; }) : results;
    say(`  >> ${lines.join(' ; ')}  <= ${(fmt === 'v7' && acks.length ? acks : results).join(' ; ')}  [${ms.toFixed(3)} ms]`);
    out.posts.push({ t: (l.match(/ T(\d+)/) || [])[1], lines, acks, results });
    for (let i = 0; i < results.length; i++) if (!/^OK/.test(results[i])) out.refusals.push({ order: d.post[i], result: results[i], ack: acks[i] });
    p.onResults(mapped);
  }
  return out;
}
module.exports = { run, parseKv, playOpts, seat };
if (require.main === module) (async () => {
  const fmt = process.argv.includes('--v6') ? 'v6' : 'v7'; const li = process.argv.indexOf('--last-id');
  const w = String(process.env.STRATEGY_WAIT || 600);
  const st = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'warrior-seat.js'), 'strategy', '--wait', w], { cwd: ROOT, encoding: 'utf8', timeout: (+w + 30) * 1000 });
  const o = await run({ fmt, strategyKv: st.stdout || '', lastId: li > 0 ? +process.argv[li + 1] : 0 });
  const s = [...o.lat].sort((x, y) => x - y); console.log(`RESULT ${o.result}\nreports ${o.reports.length} posts ${o.posts.length} refusals ${o.refusals.length} decide median ${(s[s.length >> 1] || 0).toFixed(3)} ms`);
  for (const r of o.refusals) console.log(`  REFUSED ${r.order}: ${r.result}`);
  // Improvement Loop: record this real match and judge running trials (tools/lesson.js, instant, no replays). The agent then reads
  // `node tools/lesson.js summary` and applies one change with `lesson.js set`. GBW_IMPROVE=0 off; GBW_IMPROVE=replay also starts tools/improve.js (slow, optional).
  if (o.result && o.result !== 'no-match' && process.env.GBW_IMPROVE !== '0') {
    const sd = path.dirname(LESSONS.file()); fs.mkdirSync(sd, { recursive: true }); const mf = path.join(sd, 'last-match.json'); fs.writeFileSync(mf, JSON.stringify(o));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'lesson.js'), 'record', '--log', mf], { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
    process.stdout.write((r.stdout || '').split('\n').filter(Boolean).map(x => `LESSON ${x}\n`).join('') || `LESSON record failed: ${(r.stderr || '').slice(0, 200)}\n`);
    console.log('NEXT: node tools/lesson.js summary, then lesson.js set (up to 3 keys)');
    if (process.env.GBW_IMPROVE === 'replay') {
      const lg = fs.openSync(path.join(sd, 'improve.out'), 'a');
      require('child_process').spawn(process.execPath, [path.join(ROOT, 'tools', 'improve.js'), '--log', mf], { cwd: ROOT, detached: true, stdio: ['ignore', lg, lg] }).unref();
      console.log(`IMPROVE started (log ${path.join(sd, 'improve.out')})`);
    }
  }
})().catch(e => { console.error('loop:', e.message); process.exit(1); });
