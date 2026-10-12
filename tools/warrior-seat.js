#!/usr/bin/env node
// Seat helper for a player's bot (GrokBotWarrior). Keeps the join token in secrets/warrior-seat.json (mode 600)
// and never prints it. Arena: $ARENA, else the one saved at join, else localhost:<PORT in state/arena.env>, else :8787.
//   node tools/warrior-seat.js open                       list open seats
//   node tools/warrior-seat.js join [--seat S] [--agent ID]  claim an open seat named after this bot's label, save the token
//   node tools/warrior-seat.js label [--agent ID]          rename the seat to this bot's label now (name + base "<LABEL>-01")
//   node tools/warrior-seat.js load-style <style>         submit a styles/<style> loadout + its arsenal to your seat (next match)
//   node tools/warrior-seat.js arsenal [guard=3 scout=1 | more <type> | reset]   show / set the pre-match drones
//   node tools/warrior-seat.js plan [balanced|pressure|armor|counter]   AgRTS style label (next match; this match if it has not stepped)
//   node tools/warrior-seat.js opening --scout N --rifle N --tank N --medic N [--<id> N] [--queue a,b] [--spend]   AgRTS arsenal and buy queue (ids from units.csv)
//   node tools/warrior-seat.js decision <type> [type...] | hold   AgRTS deploy wave (type ids from units.csv)
//   node tools/warrior-seat.js orders "DEPLOY R R S" "BUY M" [--report id]   at most 3 lines: BUY DEPLOY HOLD BANK FOCUS AUTOBUY MOVE ASSIST FALLBACK CLEAR (+ one WHY)
//   node tools/warrior-seat.js step --report id [--timeout s] [--json] ["ORDER LINE" ...]   post those lines (the reply includes a v2 state line), then the next report
//   node tools/warrior-seat.js next [--since id] [--timeout s] [--json]   next report via the relay when configured; timeout retries; END stops
//   node tools/warrior-seat.js latency [--last N]   decide-time trend from logs/decide-latency.jsonl
//   node tools/warrior-seat.js card [--out f.png]         make the loadout card PNG (prints absolute png path, file:// URL, buttons)
//   node tools/warrior-seat.js fight                      start a paused / held arena (solo: first match, and after each debrief)
//   node tools/warrior-seat.js wait [--timeout 600] [--json]   block until the current match ends; print result + report path
//   node tools/warrior-seat.js pause [--now] [--every on|off]  hold after this match (--now: freeze at once)
//   node tools/warrior-seat.js stop                       end the arena process cleanly
//   node tools/warrior-seat.js submit <role> <file> [--type T] [--name N]   role: hero | drone | battle-plan
//   node tools/warrior-seat.js validate <role> <file>     dry run only
//   node tools/warrior-seat.js info | roster | status | report [--json] [--since id] [--match N] | watch [--wait s]   (info: version stamp, then availability, first; report: live protocol line; --match N is the finished match)
//   node tools/warrior-seat.js practice [matches]         run a practice job and wait for the summary
//   node tools/warrior-seat.js leave                      give the seat back
//   node tools/warrior-seat.js pvp-register [--relay URL] [--name N] [--force]   PvP player token from a relay with PvP on (saved in secrets/pvp-player.json)
//   node tools/warrior-seat.js pvp-whoami [--relay URL]   who the relay says this player token is
//   node tools/warrior-seat.js pvp [--relay URL] [--timeout s] [--json] [--no-opening]   random online opponent: register, prove, queue,
//     pair, host or join, start. Exit 0 started, 2 no opponent (left the queue), 3 cancelled/aborted, 4 PvP off, 1 error
//   node tools/warrior-seat.js pvp-cancel                 leave the PvP queue cleanly (or cancel a pairing that has not started)
//   node tools/warrior-seat.js pvp-status [--wait s] [--state S]   PvP state: relay pairing, this arena, the saved guest seat
//   node tools/warrior-seat.js pvp-queue [--room R] [--timeout s] [--no-wait] [--until paired] | pvp-leave   low-level (tests)
//   PvP guest: while a PvP match is active, next / orders / step / report / opening use its Ember seat on its own (through the
//   relay, secrets/pvp-seat.json); pvp sends our own opening before ready. --pvp forces that seat, --no-pvp our own.
//   --side ember (or WARRIOR_SIDE=ember) on any command: the Ember seat, token in secrets/warrior-seat-ember.json. Testing
//   only, on an arena started with GBW_TWO_SEATS=1. Without it everything is the Green seat, as before.
const fs = require('fs'), path = require('path');
const HELP_LINES = 36; // header lines printed by "help"
const sleep = ms => new Promise(z => setTimeout(z, ms));
const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2), cmd = argv[0];
const opt = k => { const i = argv.indexOf('--' + k); return i > 0 ? argv[i + 1] : undefined; };
// Remote Ember seat (docs/SPEC.md §5.4): --side ember keeps its own token file so two warriors on one computer never mix.
// --side and its value are taken out of argv here, so no command reads "ember" as an order line or a unit type.
const SIDE_ARG = (() => { const i = argv.indexOf('--side'); if (i < 1) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; })();
const SIDE = String(SIDE_ARG || process.env.WARRIOR_SIDE || 'green').toLowerCase();
if (SIDE !== 'green' && SIDE !== 'ember') { console.error('error: --side must be green or ember'); process.exit(1); }
const EMBER = SIDE === 'ember';
// PvP guest seat (PvP step 7): --pvp uses the Ember seat token the relay handed over (secrets/pvp-seat.json), relay only.
const PVP_SEAT = (() => { const i = argv.indexOf('--pvp'); if (i < 1) return false; argv.splice(i, 1); return true; })();
const NO_PVP = (() => { const i = argv.indexOf('--no-pvp'); if (i < 1) return false; argv.splice(i, 1); return true; })();
const PVP_SEAT_FILE = process.env.WARRIOR_PVP_SEAT_FILE ? path.resolve(process.env.WARRIOR_PVP_SEAT_FILE) : path.join(ROOT, 'secrets', 'pvp-seat.json');
// PvP step 8: the guest's stay-awake loop needs no flag. While the saved PvP seat is active (saved by "pvp", match not seen
// over, at most PVP_SEAT_ACTIVE_S old), next / orders / step / live report use it. "fight", END, a closed seat (401),
// "pvp-cancel" and the next "pvp" end it. --side, --no-pvp and report --match keep the old behaviour.
const PVP_SEAT_ACTIVE_MS = Math.max(60, +(process.env.PVP_SEAT_ACTIVE_S || 3600) || 3600) * 1000;
const pvpSeatSaved = () => { try { return JSON.parse(fs.readFileSync(PVP_SEAT_FILE, 'utf8')); } catch { return null; } };
const pvpSeatActive = sv => !!(sv && sv.join_token && !sv.ended && Date.now() - Date.parse(sv.startedAt || sv.savedAt || 0) < PVP_SEAT_ACTIVE_MS);
const writePvpSeat = o => { fs.mkdirSync(path.dirname(PVP_SEAT_FILE), { recursive: true }); fs.writeFileSync(PVP_SEAT_FILE, JSON.stringify(o, null, 1), { mode: 0o600 }); fs.chmodSync(PVP_SEAT_FILE, 0o600); };
const endPvpSeat = why => { const sv = pvpSeatSaved(); if (sv && !sv.ended) writePvpSeat({ ...sv, ended: why, endedAt: new Date().toISOString() }); };
const PVP_AUTO = !PVP_SEAT && !NO_PVP && SIDE_ARG === undefined && !process.env.WARRIOR_SIDE && ['next', 'orders', 'step', 'report', 'opening'].includes(cmd)
  && !(cmd === 'report' && argv.includes('--match')) && pvpSeatActive(pvpSeatSaved());
const USE_PVP_SEAT = PVP_SEAT || PVP_AUTO;
const FILE = USE_PVP_SEAT ? PVP_SEAT_FILE : path.join(ROOT, 'secrets', EMBER ? 'warrior-seat-ember.json' : 'warrior-seat.json');
const saved = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } };
// Per-bot checkouts (Oct 12): this checkout's own arena port from state/arena.env (read by start.sh), so a second bot's
// folder (tools/gbw-setup.sh) reaches its own arena with no ARENA set.
const arenaEnvPort = () => { try { const m = fs.readFileSync(path.join(ROOT, 'state', 'arena.env'), 'utf8').match(/^\s*PORT\s*=\s*["']?(\d{2,5})["']?\s*$/m); return m ? +m[1] : null; } catch { return null; } };
const ARENA = (process.env.ARENA || (saved() || {}).arena || (arenaEnvPort() ? `http://localhost:${arenaEnvPort()}` : 'http://localhost:8787')).replace(/\/$/, '');
const tok = () => { const s = saved(); if (!s || !s.join_token) die('no seat yet: run "node tools/warrior-seat.js join" first'); return s.join_token; };
// next and orders use the relay when the seat file (or RELAY_URL + RELAY_ROOM) names one. Everything else stays on the arena.
function relayTarget() {
  const s = saved() || {};
  const fromEnv = process.env.RELAY_URL != null && process.env.RELAY_URL !== '';
  const url = String(fromEnv ? process.env.RELAY_URL : (s.relay || '')).replace(/\/$/, '');
  const room = String(process.env.RELAY_ROOM != null && process.env.RELAY_ROOM !== '' ? process.env.RELAY_ROOM : (s.room || ''));
  if (!url || !room || /^(off|0|false|no)$/i.test(url)) return null;
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(room)) return null;
  return { url, room };
}
async function seatCall(localPath, relaySuffix, body, timeoutMs = 0) {
  const rel = relayTarget();
  const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok() };
  const call = async (base, p) => {
    const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined, signal: timeoutMs > 0 ? AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))) : undefined });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
    return { code: r.status, j };
  };
  if (USE_PVP_SEAT) {
    if (!rel) die('the saved PvP seat names no relay room');
    const res = await call(rel.url, `/r/${encodeURIComponent(rel.room)}${relaySuffix}`).catch(e => die(`relay not reachable at ${rel.url} (${e.message})`));
    if (res.code === 401) { endPvpSeat('seat closed'); res.j = { ...(res.j || {}), pvp: 'the PvP seat is closed (the match is over or was aborted); see pvp-status' }; }
    else if (res.code === 200 && res.j && (res.j.event === 'END' || res.j.stop)) endPvpSeat('END');
    return res;
  }
  if (!rel) return call(ARENA, localPath).catch(e => die(`arena not reachable at ${ARENA} (${e.message})`));
  let res = null, err = null;
  try { res = await call(rel.url, `/r/${encodeURIComponent(rel.room)}${relaySuffix}`); } catch (e) { err = e; }
  // The relay is up but its link to the arena is down (or the relay is unreachable): when this computer can
  // reach the arena directly, use the same call there instead of losing the order or the report.
  if (!res || (res.code === 503 && res.j && res.j.error === 'arena is not connected')) {
    const local = await call(ARENA, localPath).catch(() => null);
    if (local && local.code !== 404) {
      console.error(`note: ${res ? 'the relay says the arena is not connected' : `relay not reachable at ${rel.url}`}; used the arena at ${ARENA} directly`);
      return local;
    }
  }
  if (!res) die(`relay not reachable at ${rel.url} (${err && err.message})`);
  // A report poll: if the arena on this computer already has a newer report than the relay's copy (the relay's
  // seat cache froze because its link to the arena dropped), use that one. One quick wait=0 read, never a long-poll.
  if (!body && res.code === 200 && res.j && res.j.ok !== false) {
    const quick = localPath.replace(/([?&]wait=)[^&]*/, '$10');
    const local = await fetch(ARENA + quick, { headers: h, signal: AbortSignal.timeout(Math.max(1, Math.ceil(1500))) })
      .then(async r => (r.status === 200 ? r.json() : null)).catch(() => null);
    if (local && local.fresh && Number.isFinite(+local.id) && +local.id > (+res.j.id || 0)) {
      console.error(`note: the relay's copy is behind (report ${res.j.id || 'none'} < ${local.id}); used the arena at ${ARENA} directly`);
      return { code: 200, j: local };
    }
  }
  return res;
}
async function rememberRelay() {
  const deadline = Date.now() + 15000;
  for (;;) {
    const h = await fetch(ARENA + '/healthz').then(r => r.json()).catch(() => null);
    const rel = h && h.relay;
    const watch = rel && typeof rel.watch === 'string' ? rel.watch : '';
    const m = watch.match(/^(https?:\/\/[^/]+)\/w\/([A-Za-z0-9_-]{3,64})\/?$/);
    if (m && rel.room === m[2]) return { relay: m[1], room: rel.room };
    const st = rel && rel.state;
    if (!rel || st === 'off' || st === 'error' || (st && !/^(starting|claiming|ready)$/.test(st)) || Date.now() > deadline) return null;
    await sleep(200);
  }
}
// The seat is named after this bot's label (its profile title): name "Warrior", base "WARRIOR-01".
// --name is used only when no label is found. The agent id is kept in the seat file for later renames.
function myLabel() {
  let BN; try { BN = require('../src/agrts/base-name'); } catch { return null; }
  // The Ember seat names itself only from an explicit --agent (or the saved one): the folder search finds Green's bot.
  const p = BN.findWarriorProfile({ agentId: opt('agent') || (saved() || {}).agent, search: !EMBER });
  const label = p && p.title.trim();
  return label ? { label, agent: p.agentId } : null;
}
function rememberAgent(agent) {
  const s = saved(); if (!s || !agent || s.agent === agent) return;
  s.agent = agent; fs.writeFileSync(FILE, JSON.stringify(s, null, 1), { mode: 0o600 }); fs.chmodSync(FILE, 0o600);
}
async function syncLabel() {
  const me = myLabel();
  const body = me ? { label: me.label } : opt('name') ? { name: opt('name') } : null;
  if (!body) return { ok: false, error: 'no label found in this bot\'s profile (pass --agent <id>, or --name N)' };
  const r = await apiSoft('/api/seat/label', body);
  if (me) rememberAgent(me.agent);
  if (!r) return { ok: false, error: 'arena not reachable' };
  return r.code === 200 ? { ok: true, name: r.j.name, base: r.j.base, from: me ? 'label' : '--name' } : { ok: false, error: r.j.error || `arena replied ${r.code}` };
}
function die(m) { console.error('error: ' + m); process.exit(1); }
async function api(p, body, auth = true, raw = false, timeoutMs = 0) {
  const h = { 'Content-Type': 'application/json' }; if (auth) h.Authorization = 'Bearer ' + tok();
  const r = await fetch(ARENA + p, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined, signal: timeoutMs > 0 ? AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))) : undefined }).catch(e => die(`arena not reachable at ${ARENA} (${e.message})`));
  const t = await r.text(); if (raw) return { code: r.status, text: t };
  let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  return { code: r.status, j };
}
// like api() but returns null instead of dying when the arena is not reachable
async function apiSoft(p, body) {
  try { const r = await fetch(ARENA + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok() }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(Math.max(1, Math.ceil(10000))) }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t }; } return { code: r.status, j }; }
  catch { return null; }
}
const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 >> 3 ^ 1 && n % 10) || 0] || 'th');
const show = o => console.log(JSON.stringify(o, (k, v) => (k === 'join_token' || k === 'player_token' || k === 'playerToken') ? '<hidden>' : v, 1));
// PvP player token (docs/SPEC.md §5.4 "Player tokens", PvP step 5): one per player, kept apart from the seat token files.
// WARRIOR_PVP_FILE overrides the path (tests). Relay: --relay, else RELAY_URL, else the one saved at pvp-register, else the seat's relay.
const PVP_FILE = process.env.WARRIOR_PVP_FILE ? path.resolve(process.env.WARRIOR_PVP_FILE) : path.join(ROOT, 'secrets', 'pvp-player.json');
const pvpSaved = () => { try { return JSON.parse(fs.readFileSync(PVP_FILE, 'utf8')); } catch { return null; } };
function pvpRelay() {
  const u = opt('relay') || process.env.RELAY_URL || (pvpSaved() || {}).relay || (saved() || {}).relay || '';
  if (!u || /^(off|0|false|no)$/i.test(u)) die('no relay: pass --relay https://<relay host> (or set RELAY_URL)');
  return String(u).replace(/\/$/, '');
}
async function pvpCall(base, p, { body, token } = {}) {
  const h = { 'Content-Type': 'application/json' }; if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(Math.max(1, Math.ceil(10000))) }).catch(e => die(`relay not reachable at ${base} (${e.message})`));
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { code: r.status, j, text: t };
}
// a relay with PvP off (or older than step 5) answers these paths like any unknown path: 405/404 with no JSON "ok" field
const pvpOff = r => !r.j || typeof r.j.ok !== 'boolean';
// the version stamp of the arena this player hosts on: its healthz (what it runs), else this checkout's own stamp
async function myStamp() {
  const h = await fetch(ARENA + '/healthz', { signal: AbortSignal.timeout(Math.max(1, Math.ceil(3000))) }).then(x => x.json()).catch(() => null);
  if (h && h.version && typeof h.version.game === 'string') return { stamp: h.version, from: ARENA };
  try { return { stamp: require('../src/agrts/version').stamp(), from: 'this checkout (arena not reachable)' }; } catch { return { stamp: null, from: 'none' }; }
}

// ---- PvP step 8: the "pvp" command (docs/SPEC.md §5.4 "The pvp command") ----
const PVP_EXIT = { started: 0, error: 1, noOpponent: 2, ended: 3, off: 4 };
// a soft relay call for status views: null instead of dying
async function pvpSoft(base, p, token, method = 'GET', body) {
  try {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(Math.max(1, Math.ceil(40000))) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { code: r.status, j, off: !j || typeof j.ok !== 'boolean' };
  } catch (e) { return { code: 0, j: null, error: e.message }; }
}
// the local PvP picture for info / pvp-status: this arena's pvp view and the saved guest seat (never its token)
function pvpSeatView() {
  const sv = pvpSeatSaved(); if (!sv) return null;
  return { matchId: sv.matchId || null, seat: sv.seat || null, room: sv.room || null, relay: sv.relay || null, active: pvpSeatActive(sv), ended: sv.ended || null, savedAt: sv.savedAt || null, startedAt: sv.startedAt || null, file: path.relative(ROOT, PVP_SEAT_FILE) };
}
const pvpSide = v => (v.role === 'host' ? 'Green/host' : 'Ember/guest');
const pvpReason = v => v.status === 'cancelled' ? `cancelled by ${v.cancelledBy === 'you' ? 'us' : v.cancelledBy || 'someone'}${v.reason ? ` (${v.reason})` : ''}` : `${v.status}${v.reason ? ` (${v.reason})` : ''}`;

const read = f => { try { return fs.readFileSync(path.resolve(f), 'utf8'); } catch (e) { die(`cannot read ${f}`); } };
(async () => {
  switch (cmd) {
    case 'open': { const r = await api('/api/seat/open', null, false); return show(r.j); }
    case 'join': {
      const s = saved();
      if (s && s.join_token) {
        const r = await api('/api/seat/info');
        if (r.code === 200) {
          const extra = (!s.relay || !s.room) ? await rememberRelay() : null;
          if (extra) { s.relay = extra.relay; s.room = extra.room; fs.writeFileSync(FILE, JSON.stringify(s, null, 1), { mode: 0o600 }); fs.chmodSync(FILE, 0o600); }
          const named = await syncLabel();
          return show({ ok: true, alreadySeated: true, seat: r.j.seat, name: named.ok ? named.name : r.j.name, base: named.ok ? named.base : r.j.base, arena: ARENA, ...(s.relay && s.room ? { relay: s.relay, room: s.room } : {}), note: named.ok ? undefined : named.error });
        }
      }
      const me = myLabel();
      const r = await api('/api/seat/join', { name: me ? me.label : opt('name'), seat: opt('seat'), ...(EMBER ? { side: 'ember' } : {}) }, false);
      if (r.code !== 200) { show(r.j); process.exit(1); }
      const extra = await rememberRelay();
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify({ arena: ARENA, seat: r.j.seat, join_token: r.j.join_token, joinedAt: new Date().toISOString(), ...(me ? { agent: me.agent } : {}), ...(extra || {}) }, null, 1), { mode: 0o600 });
      fs.chmodSync(FILE, 0o600);
      const agrts = r.j.mode === 'agrts';
      return show({ ok: true, seat: r.j.seat, name: r.j.name || r.j.seat, base: r.j.base, nameFrom: me ? 'label' : opt('name') ? '--name' : 'none', color: r.j.color, ...(agrts ? {} : { style: r.j.style }), driver: r.j.driver, mode: r.j.mode, arena: ARENA, ...(extra ? { relay: extra.relay, room: extra.room } : {}), tokenSavedIn: path.relative(ROOT, FILE) });
    }
    case 'label': { tok(); const n = await syncLabel(); show(n); process.exit(n.ok ? 0 : 1); }
    case 'load-style': {
      const idx = JSON.parse(read(path.join(ROOT, 'styles', 'index.json')));
      const key = Object.keys(idx.styles).find(k => k === String(argv[1] || '').toLowerCase() || idx.styles[k].name.toLowerCase() === String(argv[1] || '').toLowerCase());
      if (!key) die(`unknown style (choose: ${idx.order.join(', ')})`);
      const st = idx.styles[key], out = { style: st.name, submitted: [], removed: [] };
      const ro = (await api('/api/seat/roster')).j.roster || { drones: {} };
      for (const t of Object.keys(ro.drones || {})) if (!st.drones[t]) { await api('/api/seat/roster', { remove: 'drone', unitType: t }); out.removed.push(t); }
      const sub = async (role, file, unitType) => { const r = await api('/api/seat/script', { role, unitType, name: path.basename(path.dirname(file)) + '-' + path.basename(file), script: read(path.join(ROOT, file)) }); if (r.code !== 200) die(`${role} ${file}: ${r.j.error}`); out.submitted.push(`${role}${unitType ? ':' + unitType : ''} v${r.j.version}`); };
      await sub('hero', st.hero);
      for (const [t, f] of Object.entries(st.drones)) await sub('drone', f, t);
      await sub('battle-plan', st.battlePlan);
      if (st.arsenal) { const r = await api('/api/seat/arsenal', { arsenal: st.arsenal }); if (r.code !== 200) die(`arsenal: ${r.j.error}`); out.arsenal = r.j.arsenal; out.startEnergy = r.j.startEnergy; }
      out.appliesFrom = 'next match'; return show(out);
    }
    case 'submit': case 'validate': {
      const role = argv[1], file = argv[2]; if (!role || !file) die(`usage: ${cmd} <hero|drone|battle-plan> <file> [--type T]`);
      const body = { role, unitType: opt('type'), name: opt('name') || path.basename(file), script: read(file) };
      const r = cmd === 'submit' ? await api('/api/seat/script', body) : await api('/api/seat/validate', body, false);
      show(r.j); process.exit(r.code === 200 ? 0 : 1);
    }
    case 'plan': {
      const style = argv[1];
      if (!style) { const info = await api('/api/seat/info'); return show({ mode: info.j.mode, driver: info.j.driver, style: info.j.style, matchStyle: info.j.matchStyle, plans: info.j.plans }); }
      const r = await api('/api/seat/plan', { style }); show(r.j); process.exit(r.code === 200 ? 0 : 1);
    }
    case 'opening': {
      // Any --<unit id> N flag (ids are the id column of units.csv on the arena); the arena checks the ids.
      const keys = [...new Set(['scout', 'rifle', 'tank', 'medic', ...argv.slice(1).filter((a, i, l) => /^--[a-z][a-z0-9_]*$/.test(a) && /^\d+$/.test(String(l[i + 1]))).map(a => a.slice(2))])].filter(k => k !== 'queue');
      const num = k => {
        const v = opt(k);
        if (v == null) return 0;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) die(`${k} must be a non-negative integer`);
        return n;
      };
      if (!keys.some(k => opt(k) != null) && opt('queue') == null && !argv.includes('--spend')) die('usage: opening --scout N --rifle N --tank N --medic N [--queue scout,rifle,...] [--spend]');
      const arsenal = {};
      for (const k of keys) arsenal[k] = num(k);
      const queue = opt('queue') ? String(opt('queue')).split(',').map(s => s.trim()).filter(Boolean) : [];
      const body = { arsenal, queue, spend: argv.includes('--spend') };
      // a PvP guest's opening goes to the host arena through the relay (before START), checked there like a local one
      const r = USE_PVP_SEAT ? await seatCall('/api/seat/opening', '/seat/opening', body, 15000) : await api('/api/seat/opening', body);
      show(r.j); process.exit(r.code === 200 ? 0 : 1);
    }
    case 'decision': {
      const args = argv.slice(1).filter(a => !a.startsWith('--'));
      if (!args.length) die('usage: decision <type id> [type type] | decision hold   (ids from units.csv, e.g. scout rifle tank medic)');
      const body = args[0] === 'hold' ? { hold: true } : { types: args };
      if (argv.includes('--guard')) body.guard = true;
      const r = await api('/api/seat/decision', body);
      show(r.j); process.exit(r.code === 202 ? 0 : 1);
    }
    case 'orders': {
      const report = opt('report');
      const lines = [];
      for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--report') { i += 1; continue; }
        if (a.startsWith('--')) continue;
        lines.push(a);
      }
      if (!lines.length) die('usage: orders "DEPLOY R R S" "BUY M" [--report id]   (at most 3 lines: BUY <code>, DEPLOY <codes>|ALL, HOLD, BANK, FOCUS <code> [units] [zone]|NONE, AUTOBUY <code> [RESERVE n]|OFF, MOVE <units> <zone>, ASSIST <zone> [radius], FALLBACK <units>, CLEAR <units>; units: R2, R, 2R or ALL; zones z1-z8; plus one WHY <text>)');
      const body = { lines };
      if (report != null && report !== '' && Number.isFinite(+report)) body.reportId = +report;
      const r = await seatCall('/api/seat/orders', '/seat/orders', body);
      const results = r.j && Array.isArray(r.j.results) ? r.j.results : null;
      if (!results) { show(r.j); process.exit(r.code === 200 ? 0 : 1); }
      for (const line of results) console.log(line);
      if (r.j.line) console.log(r.j.line);
      if (r.j.error) console.error(r.j.error);
      process.exit(r.code === 200 && results.every(line => String(line).startsWith('OK')) ? 0 : 1);
    }
    case 'step': {
      const report = opt('report');
      if (report == null || report === '' || !Number.isFinite(+report)) die('usage: step --report <id> [--timeout s] [--json] ["ORDER LINE" ...]');
      const timeoutS = opt('timeout');
      const waitS = Math.max(0, Math.min(30, timeoutS != null && timeoutS !== '' ? (+timeoutS || 0) : 30));
      const lines = [];
      for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--report' || a === '--timeout') { i += 1; continue; }
        if (a === '--json' || a.startsWith('--')) continue;
        lines.push(a);
      }
      let orders = [];
      let stateLine = null;
      if (lines.length) {
        const posted = await seatCall('/api/seat/orders', '/seat/orders', { lines, reportId: +report });
        const results = posted.j && Array.isArray(posted.j.results) ? posted.j.results : null;
        if (!results) { show(posted.j || { ok: false, error: 'no reply' }); process.exit(posted.code === 200 ? 0 : 1); }
        orders = results.length ? results : (posted.j.error ? [`ERR ${posted.j.error}`] : []);
        stateLine = posted.j.line || null;
        // Match-over still returns results (ERR match over). Keep polling so END is visible.
      }
      let since = +report;
      const deadline = Date.now() + waitS * 1000;
      let body = null;
      for (;;) {
        const wait = Math.max(0, Math.min(30, (deadline - Date.now()) / 1000));
        const q = `?since=${encodeURIComponent(String(since))}&wait=${encodeURIComponent(String(wait))}`;
        const polled = await seatCall('/api/seat/report' + q, '/seat/report' + q, null, (wait + 5) * 1000);
        if (polled.code !== 200 || !polled.j || polled.j.ok === false) {
          if (argv.includes('--json')) show({ ok: false, orders, state: stateLine, ...(polled.j || {}) });
          else { for (const line of orders) console.log(line); if (stateLine) console.log(stateLine); show(polled.j || { error: 'no reply' }); }
          process.exit(1);
        }
        if (polled.j.fresh && polled.j.event === 'ORDER' && polled.j.id > since) { since = polled.j.id; continue; }
        body = polled.j;
        break;
      }
      const showed = !!(body.fresh && body.line && body.event !== 'ORDER');
      if (argv.includes('--json')) {
        show({
          ok: orders.every(line => String(line).startsWith('OK')),
          version: body.version || 2,
          orders,
          state: stateLine,
          id: showed ? body.id : (body.id || since),
          line: body.line, event: body.event, t: body.t, match: body.match,
          fresh: !!body.fresh, timeout: !!body.timeout, stop: !!body.stop, marker: body.marker || null,
        });
        process.exit(0);
      }
      for (const line of orders) console.log(line);
      if (stateLine) console.log(stateLine);
      if (showed) console.log(`${body.id} ${body.line}`);
      else if (body.timeout || body.event === 'READY' || body.event === 'COUNTDOWN') console.log('timeout');
      else console.log('no-match');
      process.exit(0);
    }
    case 'latency': {
      const file = path.join(ROOT, 'logs', 'decide-latency.jsonl');
      let rows = [];
      try { rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
      catch (e) { if (e.code !== 'ENOENT') die(e.message); }
      const n = opt('last');
      const slice = n != null && n !== '' ? rows.slice(-Math.max(0, Math.floor(+n || 0))) : rows;
      if (argv.includes('--json')) return show(slice);
      if (!slice.length) { console.log('no decide-latency log yet'); return; }
      const sec = ms => ms == null ? '-' : (ms / 1000).toFixed(1) + 's';
      for (const row of slice) console.log(`m${row.match} ${row.seat} ${row.name}  n=${row.n}  med=${sec(row.med)}  p90=${sec(row.p90)}  min=${sec(row.min)}  max=${sec(row.max)}  avgGap=${sec(row.avgGap)}  ${row.ts}`);
      return;
    }
    case 'next': {
      const since = opt('since');
      const timeoutS = opt('timeout');
      const wait = timeoutS != null && timeoutS !== '' ? String(Math.max(0, Math.min(30, +timeoutS || 0))) : '30';
      const q = `?since=${encodeURIComponent(since != null ? since : '0')}&wait=${encodeURIComponent(wait)}`;
      const r = await seatCall('/api/seat/report' + q, '/seat/report' + q, null, (Math.max(0, +wait || 0) + 5) * 1000);
      if (r.code !== 200 || !r.j || r.j.ok === false) { show(r.j || { error: 'no reply' }); process.exit(1); }
      if (argv.includes('--json')) { show(r.j); process.exit(0); }
      if (r.j.fresh && r.j.line) { console.log(`${r.j.id} ${r.j.line}`); process.exit(0); }
      // READY and COUNTDOWN are keep-going. A poll that is not fresh yet is timeout, not a stop.
      if (r.j.timeout || r.j.event === 'READY' || r.j.event === 'COUNTDOWN') { console.log('timeout'); process.exit(0); }
      console.log('no-match');
      process.exit(0);
    }
    case 'arsenal': {
      const A = require('../src/arsenal');
      const sub = argv[1];
      const brief = (j, extra) => show({ ok: j.ok !== false, arsenal: j.arsenal, source: j.source, startEnergy: j.startEnergy, budget: j.budget, costPerDrone: j.costPerDrone, droneTypes: j.droneTypes, appliesFrom: j.appliesFrom, error: j.error, ...extra });
      if (!sub) return brief((await api('/api/seat/arsenal')).j);
      if (sub === 'reset') { const r = await api('/api/seat/arsenal', { reset: true }); brief(r.j); process.exit(r.code === 200 ? 0 : 1); }
      let want, note;
      if (sub === 'more') {
        const cur = (await api('/api/seat/arsenal')).j;
        const m = A.moreOf(cur.arsenal || {}, String(argv[2] || ''), { droneTypes: cur.droneTypes || [], budget: cur.budget, cost: cur.costPerDrone });
        if (!m.ok) die(m.error);
        want = m.arsenal; note = m.note;
      } else { try { want = A.parseArsenalArgs(argv.slice(1)); } catch (e) { die(e.message); } }
      const r = await api('/api/seat/arsenal', { arsenal: want });
      brief(r.j, note ? { change: note } : {}); process.exit(r.code === 200 ? 0 : 1);
    }
    case 'card': { // loadout-card.js prints {png (absolute path), file (file:// URL), caption, buttons, ...}
      const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'loadout-card.js'), ...argv.slice(1)], { stdio: 'inherit', env: { ...process.env, ARENA } });
      process.exit(r.status || 0);
    }
    case 'fight': case 'resume': {
      if (!EMBER) endPvpSeat('fight');
      const st = (await api('/api/seat/info')).j;
      // pick up a label change before the match starts (quiet; never blocks the fight)
      if (st && (st.status === 'over' || st.tick === 0)) { const me = myLabel(); if (me && me.label !== st.name) { const n = await syncLabel(); if (n.ok) console.error(`note: renamed to ${n.name} (${n.base})`); } }
      const r = await api('/api/seat/resume', {});
      if (r.code === 200 && r.j && r.j.waiting) {
        console.log(`Match ${r.j.match} is armed and waiting for a viewer.`);
        if (r.j.watch) console.log(`Watch: ${r.j.watch}`);
        return;
      }
      if (r.code === 200) return show({ ok: true, started: r.j.started, alreadyRunning: !r.j.started, match: r.j.match, status: r.j.status, pauseAfterMatch: r.j.pauseAfterMatch });
      // The Ember seat never controls the arena: no fallback to the plain control call (Green's player runs the arena).
      if (EMBER) { show(r.j); process.exit(1); }
      // older arena (no /api/seat/resume) or a seat without pause control: the plain control call
      if (!st.paused) return show({ ok: true, alreadyRunning: true, match: st.match, tick: st.tick });
      const c = await api('/api/control', { action: 'resume' }, false);
      return show({ ok: c.code === 200, started: true, match: st.match });
    }
    case 'wait': { // block until the match that is current NOW ends (tracked by match number, so an auto-started next match can't confuse it)
      const timeoutS = +(opt('timeout') || 600); if (!(timeoutS > 0)) die('--timeout must be a number of seconds');
      const info = await api('/api/seat/info'); if (info.code !== 200) die(info.j.error || `arena replied ${info.code}`);
      const target = opt('match') ? +opt('match') : info.j.match;
      if (info.j.status === 'running' && info.j.tick === 0 && info.j.paused) console.error(`note: match ${target} has not started (arena paused at tick 0); it starts with "fight"`);
      const t0 = Date.now(); let misses = 0;
      for (;;) {
        const r = await apiSoft(`/api/seat/report?match=${target}`);
        if (r && r.code === 200) {
          const j = r.j, w = j.winner || {};
          if (argv.includes('--json')) return show({ ok: true, match: target, id: j.match, name: j.displayName || j.name, placement: j.placement, won: j.won, score: j.score, ticks: j.ticks, winner: w.displayName || w.name, reason: w.reason, reportFile: j.reportFile, next: j.next });
          const fate = j.won ? `WON (${w.reason})` : j.eliminated ? `eliminated at tick ${j.eliminatedTick}; ${w.displayName || w.name} won (${w.reason})` : `survived; ${w.displayName || w.name} won (${w.reason})`;
          console.log(`Match ${target} over: ${j.displayName || j.name} placed ${ord(j.placement)}, ${fate}, score ${j.score}${j.ticks ? `, ${j.ticks} ticks` : ''}.`);
          console.log(`report: ${j.reportFile}`);
          const n = j.next || {};
          console.log(`next: ${n.held ? `held; match ${n.nextMatch} starts on "fight"` : n.startsInMs != null ? `match ${n.nextMatch} starts by itself in ${Math.round(n.startsInMs / 1000)} s` : n.current > target ? `match ${n.current} is ${n.status}${n.paused ? ' (paused)' : ''}` : n.how || 'no auto-start'}`);
          return;
        }
        if (!r) { if (++misses >= 5) die(`arena at ${ARENA} stopped or is not reachable (match ${target} not finished)`); }
        else {
          misses = 0;
          if (r.code === 401) die('join token not accepted (seat released?)');
          if (r.code !== 404) die(r.j.error || `arena replied ${r.code}`);
          if (r.j.current !== undefined && r.j.current < target) die(`arena restarted (now at match ${r.j.current}); match ${target} of the old run will not finish`);
          if (/not recorded|no report/.test(r.j.error || '')) die(r.j.error);
        }
        if (Date.now() - t0 > timeoutS * 1000) { console.error(`timeout: match ${target} still not over after ${timeoutS} s`); process.exit(2); }
        await sleep(1000);
      }
    }
    case 'pause': {
      const every = opt('every'); if (every !== undefined && !['on', 'off'].includes(every)) die('--every on|off');
      const r = await api('/api/seat/pause', { now: argv.includes('--now') || undefined, every: every === undefined ? undefined : every === 'on' });
      show(r.j); process.exit(r.code === 200 ? 0 : 1);
    }
    case 'stop': {
      const r = await api('/api/seat/stop', {});
      if (r.code !== 200) { show(r.j); process.exit(1); }
      let down = false;
      const gone = () => { try { process.kill(r.j.pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } }; // the process itself, when it runs on this computer
      for (let i = 0; i < 25 && !down; i++) { await sleep(200); down = await fetch(ARENA + '/healthz', { signal: AbortSignal.timeout(Math.max(1, Math.ceil(1000))) }).then(() => false, () => true) && (!r.j.pid || gone() || i >= 24); }
      show({ ok: down, stopped: down, match: r.j.match, note: r.j.note, error: down ? undefined : 'arena still answering after 5 s' }); process.exit(down ? 0 : 1);
    }
    case 'info': {
      // Version stamp (docs/SPEC.md §5.4 "Version stamp") first: { game, protocol, unitsHash, official }. An arena older than the
      // stamp has none in seat info; healthz is tried, then version:null. With a relay, the relay's copy of the
      // latest frame says what the public watch page is running (relayVersion; null when not readable).
      const r = await api('/api/seat/info');
      const j = r.j || {};
      // Availability (docs/SPEC.md §5.4 "Availability", PvP step 3) second: { state: free|busy|reserved, since, matchId? }.
      let version = j.version || null;
      let availability = j.availability || null;
      if ((!version || !availability) && r.code === 200) {
        const h = await fetch(ARENA + '/healthz', { signal: AbortSignal.timeout(Math.max(1, Math.ceil(3000))) }).then(x => x.json()).catch(() => null);
        if (!version) version = (h && h.version) || null;
        if (!availability) availability = (h && h.availability) || null;
      }
      const out = { version, availability, ...j };
      if (!version && r.code === 200) out.versionNote = 'this arena does not report a version stamp (older than PvP step 2)';
      if (!availability && r.code === 200) out.availabilityNote = 'this arena does not report availability (older than PvP step 3)';
      const rel = relayTarget();
      if (rel && r.code === 200) {
        out.relayVersion = await fetch(`${rel.url}/r/${encodeURIComponent(rel.room)}/state`, { signal: AbortSignal.timeout(Math.max(1, Math.ceil(5000))) })
          .then(x => (x.status === 200 ? x.json() : null)).then(e => { const d = e && (e.d || e); return (d && d.version) || null; }).catch(() => null);
      }
      // PvP (step 8): the arena's PvP state, the saved guest seat and, with a player token, the relay's view
      const cur = pvpSaved();
      const pv = { arena: r.code === 200 ? (j.pvp || null) : null, seat: pvpSeatView() };
      if (cur && cur.player_token && cur.relay) {
        const q = await pvpSoft(cur.relay, '/pvp/queue/wait?wait=0', cur.player_token);
        pv.player = { playerId: cur.playerId, name: cur.name, relay: cur.relay };
        pv.relay = q.code && !q.off && q.j ? { status: q.j.status || (q.j.error === 'not_queued' ? 'not_queued' : q.j.error), matchId: q.j.matchId, role: q.j.role, opponent: q.j.opponent && q.j.opponent.name, reason: q.j.reason, result: q.j.result } : (q.off ? 'PvP off on the relay' : 'relay not reachable');
      }
      if (pv.arena || pv.seat || pv.player) out.pvp = pv;
      return show(out);
    }
    case 'pvp-register': {
      const base = pvpRelay();
      const cur = pvpSaved();
      if (cur && cur.player_token && cur.relay === base && !argv.includes('--force')) {
        const w = await pvpCall(base, '/pvp/whoami', { token: cur.player_token });
        if (w.code === 200 && w.j && w.j.ok) return show({ ok: true, alreadyRegistered: true, playerId: w.j.playerId, name: w.j.name, relay: base, tokenSavedIn: path.relative(ROOT, PVP_FILE) });
        if (pvpOff(w)) die(`the relay at ${base} does not have PvP on (PVP_ENABLED=0, or older than PvP step 5)`);
        console.error(`note: the saved player token is not accepted any more (${(w.j && w.j.error) || w.code}); registering again`);
      }
      const me = myLabel();
      const name = opt('name') || (me && me.label) || (saved() || {}).seat;
      if (!name) die('no name: pass --name <name> (or set a label in this bot\'s profile)');
      const { stamp, from } = await myStamp();
      if (!stamp) die('no version stamp (arena not reachable and src/agrts/version.js not loadable)');
      const r = await pvpCall(base, '/pvp/register', { body: { name, version: stamp } });
      if (pvpOff(r)) die(`the relay at ${base} does not have PvP on (PVP_ENABLED=0, or older than PvP step 5)`);
      if (r.code !== 201 || !r.j.playerToken) { show({ ...r.j, versionFrom: from }); process.exit(1); }
      fs.mkdirSync(path.dirname(PVP_FILE), { recursive: true });
      fs.writeFileSync(PVP_FILE, JSON.stringify({ relay: base, playerId: r.j.playerId, name: r.j.name, player_token: r.j.playerToken, registeredAt: new Date().toISOString(), version: r.j.version }, null, 1), { mode: 0o600 });
      fs.chmodSync(PVP_FILE, 0o600);
      return show({ ok: true, playerId: r.j.playerId, name: r.j.name, relay: base, version: r.j.version, versionFrom: from, tokenSavedIn: path.relative(ROOT, PVP_FILE) });
    }
    case 'pvp-whoami': {
      const cur = pvpSaved();
      if (!cur || !cur.player_token) die('no player token yet: run "node tools/warrior-seat.js pvp-register --relay <url>" first');
      const base = opt('relay') ? pvpRelay() : (cur.relay || pvpRelay());
      const r = await pvpCall(base, '/pvp/whoami', { token: cur.player_token });
      if (pvpOff(r)) die(`the relay at ${base} does not have PvP on (PVP_ENABLED=0, or older than PvP step 5)`);
      show({ relay: base, ...r.j }); process.exit(r.code === 200 ? 0 : 1);
    }
    case 'pvp': {
      const asJson = argv.includes('--json');
      const say = m => { if (!asJson) console.log(m); };
      const finish = (code, o) => { if (asJson) show(o); process.exit(code); };
      const off = why => { console.error('pvp off: ' + why); finish(PVP_EXIT.off, { ok: false, status: 'off', error: why }); };
      // 1. our arena: it must run PvP (GBW_PVP=1), hold our seat, and publish to a relay room (that room is what we host)
      const h = await fetch(ARENA + '/healthz', { signal: AbortSignal.timeout(Math.max(1, Math.ceil(5000))) }).then(x => x.json()).catch(() => null);
      if (!h) die(`arena not reachable at ${ARENA}`);
      if (!h.pvp) off(`the arena at ${ARENA} does not have PvP on (start it with GBW_PVP=1)`);
      const sv = saved(); if (!sv || !sv.join_token) die('no seat yet: run "node tools/warrior-seat.js join" first');
      const room = h.relay && h.relay.room;
      const arenaRelay = ((h.relay && typeof h.relay.watch === 'string' ? h.relay.watch : '').match(/^(https?:\/\/[^/]+)\/w\//) || [])[1] || '';
      if (!room || !h.relay.connected) die(`the arena at ${ARENA} is not connected to a relay room (relay ${h.relay ? h.relay.state : 'off'})`);
      const base = String(opt('relay') || process.env.RELAY_URL || arenaRelay || (pvpSaved() || {}).relay || '').replace(/\/$/, '');
      if (!base) die('no relay: pass --relay https://<relay host>');
      if (arenaRelay && arenaRelay !== base) die(`our arena publishes to ${arenaRelay}, but PvP was asked on ${base}; both must be the same relay`);
      // 2. the player token (step 5): reuse it if this relay still accepts it, else register
      let cur = pvpSaved();
      if (cur && cur.player_token && cur.relay === base) {
        const w = await pvpSoft(base, '/pvp/whoami', cur.player_token);
        if (!w.code) die(`relay not reachable at ${base} (${w.error})`);
        if (w.off) off(`the relay at ${base} does not have PvP on (PVP_ENABLED=0, or older than PvP step 5)`);
        if (!(w.code === 200 && w.j.ok)) { console.error(`note: the saved player token is not accepted any more (${w.j.error || w.code}); registering again`); cur = null; }
      } else cur = null;
      if (!cur) {
        const me = myLabel();
        const si = me ? null : await apiSoft('/api/seat/info');
        const name = opt('name') || (me && me.label) || (si && si.code === 200 && si.j.name) || sv.seat;
        if (!name) die('no name: pass --name <name> (or set a label in this bot\'s profile)');
        const r = await pvpCall(base, '/pvp/register', { body: { name, version: h.version } });
        if (pvpOff(r)) off(`the relay at ${base} does not have PvP on (PVP_ENABLED=0, or older than PvP step 5)`);
        if (r.code !== 201 || !r.j.playerToken) { console.error(`error: registration refused (${r.j.error || r.code})`); finish(PVP_EXIT.error, { ok: false, status: 'error', ...r.j }); }
        fs.mkdirSync(path.dirname(PVP_FILE), { recursive: true });
        fs.writeFileSync(PVP_FILE, JSON.stringify({ relay: base, playerId: r.j.playerId, name: r.j.name, player_token: r.j.playerToken, registeredAt: new Date().toISOString(), version: r.j.version }, null, 1), { mode: 0o600 });
        fs.chmodSync(PVP_FILE, 0o600);
        cur = pvpSaved();
        say(`pvp: registered as ${cur.name} (${cur.playerId}) on ${base}`);
      } else say(`pvp: player ${cur.name} (${cur.playerId}) on ${base}`);
      // a PvP seat from an earlier match is over by definition: a new match brings a new token
      fs.rmSync(PVP_SEAT_FILE, { force: true });
      const call = async (method, p, body) => {
        const r = await pvpSoft(base, p, cur.player_token, method, body);
        if (!r.code) die(`relay not reachable at ${base} (${r.error})`);
        if (r.off) off(`the relay at ${base} does not have the PvP queue on (older than PvP step 6)`);
        return r;
      };
      // 3. join (with our room, stamp and availability) and prove the room through our own arena
      const j0 = await call('POST', '/pvp/queue', { room, version: h.version, availability: h.availability });
      if (j0.code !== 200 && j0.code !== 201) { console.error(`error: queue join refused (${j0.j.error || j0.code})`); finish(j0.code === 409 ? PVP_EXIT.ended : PVP_EXIT.error, { ok: false, status: 'error', ...j0.j }); }
      // no proof asked = the relay already counts the room as ours (a join that pairs at once carries no roomProven field)
      let canHost = j0.j.roomProven !== false;
      if (j0.j.proof && j0.j.proof.nonce) {
        const pr = await apiSoft('/api/pvp/prove', { nonce: j0.j.proof.nonce });
        canHost = !!(pr && pr.code === 200);
        if (!canHost) console.error(`note: room not proven (${pr ? pr.j.error || pr.code : 'arena not reachable'}); we can only be the guest`);
      }
      say(`pvp: room ${room} ${canHost ? 'proven, we can host' : 'not proven, guest only'}${h.availability && h.availability.state !== 'free' ? ` (arena ${h.availability.state}: guest until it is free)` : ''}`);
      // Ctrl-C / SIGTERM before the start: leave cleanly
      let started = false;
      const bail = async sig => { if (!started) { await pvpSoft(base, '/pvp/queue', cur.player_token, 'DELETE'); console.error(`pvp: ${sig}, left the queue`); } process.exit(130); };
      process.on('SIGINT', () => bail('interrupted')); process.on('SIGTERM', () => bail('stopped'));
      // 4. wait; host accept or guest ready; started
      const timeoutS = Math.max(5, +(opt('timeout') || 300) || 300);
      const t0 = Date.now(); let last = j0.j, hosted = false, readied = false, told = '', pairedAt = 0, lastNote = Date.now();
      let openingSent = false, army = null;
      const armyText = (o, from) => `${from}${o && o.arsenal ? ` (${Object.entries(o.arsenal).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}`;
      // Each player brings its own opening: the one we set with "opening" on our own arena goes to the host
      // through the relay seat protocol, checked there like a local one. None, refused, or --no-opening: the balanced draft.
      const sendGuestOpening = async v => {
        if (argv.includes('--no-opening')) { say('pvp: --no-opening: Ember fights with the balanced draft'); return 'balanced draft'; }
        const ro = await apiSoft('/api/seat/roster');
        const own = ro && ro.code === 200 && ro.j.roster && ro.j.roster.opening;
        if (!own || !own.arsenal || !Object.values(own.arsenal).some(n => n > 0)) { say('pvp: no opening set on our arena (warrior-seat.js opening ...): Ember fights with the balanced draft'); return 'balanced draft'; }
        const body = { arsenal: own.arsenal, queue: own.queue || [], spend: own.spend === true };
        const r = await fetch(`${base}/r/${encodeURIComponent(v.seat.room)}/seat/opening`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + v.seat.join_token }, body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, Math.ceil(15000))) })
          .then(async x => ({ code: x.status, j: await x.json().catch(() => ({})) })).catch(e => ({ code: 0, j: { error: e.message } }));
        if (r.code === 200) { say(`pvp: our opening sent to the host: ${armyText(r.j, 'our own')}`); return armyText(r.j, 'our own opening'); }
        console.error(`note: the host did not take our opening (${r.j.error || r.code}); Ember fights with the balanced draft`);
        say(`pvp: opening refused (${r.j.error || r.code}): Ember fights with the balanced draft`);
        return 'balanced draft';
      };
      const graceS = (+(h.pvp.readyS) || 60) + 90; // once paired, the handoff ends by itself (ready timeout, relay TTLs)
      say(`pvp: waiting for an opponent… (${last.queued || 1} in the queue, up to ${timeoutS} s)`);
      for (;;) {
        const v = last;
        if (v.status === 'started') break;
        if (!['waiting', 'paired', 'handoff'].includes(v.status)) {
          const why = v.status === 'not_queued' ? 'no longer in the queue (pvp-cancel, or dropped)' : !['aborted', 'cancelled', 'done'].includes(v.status) ? `relay said ${v.status}` : v.status === 'done' ? 'the match is already over' : pvpReason(v);
          say(`pvp: ${why}${v.opponent ? ` (opponent ${v.opponent.name})` : ''}; not started`);
          finish(PVP_EXIT.ended, { ok: false, status: v.status, reason: v.reason || null, cancelledBy: v.cancelledBy || null, matchId: v.matchId || null, opponent: v.opponent || null });
        }
        if (['paired', 'handoff'].includes(v.status) && told !== v.matchId) {
          told = v.matchId; pairedAt = Date.now();
          say(`pvp: paired with ${v.opponent ? v.opponent.name : '?'}, you are ${pvpSide(v)} (match ${v.matchId})`);
        }
        if (v.status === 'paired' && v.role === 'host' && !hosted) {
          hosted = true;
          const hr = await apiSoft('/api/pvp/host', { matchId: v.matchId, opponent: v.opponent && v.opponent.name });
          if (!hr) { await call('DELETE', '/pvp/queue'); say('pvp: our arena did not answer the host call; cancelled'); finish(PVP_EXIT.ended, { ok: false, status: 'cancelled', reason: 'arena_unreachable', matchId: v.matchId }); }
          if (hr.code === 200) {
            army = hr.j.armies && hr.j.armies.green === 'host opening' ? 'our own opening' : 'balanced draft';
            say(`pvp: hosting: Ember seat open for ${v.opponent ? v.opponent.name : 'the guest'}, waiting up to ${hr.j.readyS || h.pvp.readyS || 60} s for them (our army: ${army === 'balanced draft' ? 'the balanced draft, no opening set' : 'our own opening'})`);
          }
          else console.error(`note: our arena did not host (${hr.j.error || hr.code})`); // it told the relay (pvp-abort); the wait shows aborted
        }
        if (v.status === 'handoff' && v.role === 'guest' && v.seat && !readied) {
          writePvpSeat({ relay: base, room: v.seat.room, seat: v.seat.seat, side: v.seat.side, join_token: v.seat.join_token, matchId: v.matchId, savedAt: new Date().toISOString() });
          if (!openingSent) { openingSent = true; army = await sendGuestOpening(v); }
          const rr = await call('POST', '/pvp/match/ready', { matchId: v.matchId });
          if (rr.code === 200) { readied = true; say(`pvp: ${v.seat.seat} seat saved, ready sent; waiting for the host to start`); last = rr.j; continue; }
          console.error(`note: ready not delivered (${rr.j.error || rr.code}); retrying`); await sleep(1000);
        }
        const now = Date.now();
        const limit = pairedAt ? pairedAt + graceS * 1000 : t0 + timeoutS * 1000;
        if (now >= limit) {
          const r = await call('DELETE', '/pvp/queue');
          if (!pairedAt) { say(`pvp: no opponent within ${timeoutS} s; left the queue`); finish(PVP_EXIT.noOpponent, { ok: false, status: 'timeout', left: r.code === 200 }); }
          say(`pvp: the handoff did not finish within ${graceS} s; cancelled`); finish(PVP_EXIT.ended, { ok: false, status: 'cancelled', reason: 'handoff_timeout', matchId: v.matchId });
        }
        if (!pairedAt && now - lastNote > 60000) { lastNote = now; say(`pvp: still waiting (${Math.round((now - t0) / 1000)} s)…`); }
        const left = Math.max(1, Math.min(25, Math.ceil((limit - now) / 1000)));
        const r = await call('GET', `/pvp/queue/wait?wait=${left}&state=${encodeURIComponent(v.status)}`);
        last = r.j && r.j.status ? r.j : { ...(r.j || {}), status: (r.j && r.j.error) || 'error' };
      }
      started = true;
      const v = last, host = v.role === 'host';
      const watch = `${base}/w/${v.hostRoom}`;
      if (!host) { const ps = pvpSeatSaved(); if (ps) writePvpSeat({ ...ps, startedAt: new Date().toISOString(), matchNo: v.matchNo || null }); }
      say(`pvp: STARTED match ${v.matchId}${v.matchNo ? ` (arena match ${v.matchNo})` : ''} vs ${v.opponent ? v.opponent.name : '?'}: we play ${host ? 'Green (host, side 0) on our own arena' : `Ember (guest, side 1) on ${v.hostRoom} through the relay`}`);
      say(`watch: ${watch}`);
      say(`play: tools/warrior-helpers/open.sh, then gs.sh <id> (next / orders as usual${host ? '' : '; the PvP Ember seat is used on its own'})`);
      finish(PVP_EXIT.started, { ok: true, status: 'started', army, matchId: v.matchId, matchNo: v.matchNo || null, role: v.role, side: host ? 'green' : 'ember', seat: host ? sv.seat || null : (v.seat && v.seat.seat) || 'Ember', opponent: v.opponent || null, hostRoom: v.hostRoom, watch });
    }
    case 'pvp-cancel': {
      const cur = pvpSaved();
      if (!cur || !cur.player_token) { console.log('pvp: not registered, nothing to cancel'); process.exit(0); }
      const base = opt('relay') ? pvpRelay() : (cur.relay || pvpRelay());
      const r = await pvpSoft(base, '/pvp/queue', cur.player_token, 'DELETE');
      if (!r.code) die(`relay not reachable at ${base} (${r.error})`);
      if (r.off) { console.log(`pvp: the relay at ${base} does not have PvP on; nothing to cancel`); process.exit(0); }
      if (r.code === 409) { console.log(`pvp: the match has started and cannot be cancelled (${r.j.error}); the commander takes over a silent seat`); process.exit(1); }
      const ps = pvpSeatSaved(); if (ps && !ps.startedAt) fs.rmSync(PVP_SEAT_FILE, { force: true });
      console.log(r.j.cancelled ? `pvp: pairing ${r.j.cancelled} cancelled` : r.j.left ? 'pvp: left the queue' : 'pvp: not in the queue; nothing to cancel');
      process.exit(0);
    }
    case 'pvp-queue': case 'pvp-leave': case 'pvp-status': {
      const cur = pvpSaved();
      if (!cur || !cur.player_token) die('no player token yet: run "node tools/warrior-seat.js pvp-register --relay <url>" first');
      const base = opt('relay') ? pvpRelay() : (cur.relay || pvpRelay());
      const call = async (method, p, body) => {
        const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cur.player_token }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(Math.max(1, Math.ceil(40000))) }).catch(e => die(`relay not reachable at ${base} (${e.message})`));
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
        if (!j || typeof j.ok !== 'boolean') die(`the relay at ${base} does not have the PvP queue on (PVP_ENABLED=0, or older than PvP step 6)`);
        return { code: r.status, j };
      };
      const localSoft = async (p, b) => { const sv = saved(); return sv && sv.join_token ? apiSoft(p, b) : null; };
      const hide = j => { const o = { ...j }; if (o.seat && o.seat.join_token) o.seat = { ...o.seat, join_token: '<saved>' }; return o; };
      if (cmd === 'pvp-leave') { const r = await call('DELETE', '/pvp/queue'); show({ relay: base, ...r.j }); process.exit(r.code === 200 ? 0 : 1); }
      if (cmd === 'pvp-status') {
        const w = Math.max(0, Math.min(30, +(opt('wait') || 0) || 0));
        const r = await call('GET', `/pvp/queue/wait?wait=${w}${opt('state') ? `&state=${encodeURIComponent(opt('state'))}` : ''}`);
        const hz = await fetch(ARENA + '/healthz', { signal: AbortSignal.timeout(Math.max(1, Math.ceil(3000))) }).then(x => x.json()).catch(() => null);
        show({ relay: base, ...hide(r.j), arenaPvp: hz ? (hz.pvp || 'off (GBW_PVP not set)') : 'arena not reachable', pvpSeat: pvpSeatView() }); process.exit(r.j.ok ? 0 : 1);
      }
      // the host room, availability and stamp come from the arena on this computer (its relay room is what the relay sees)
      const h = await fetch(ARENA + '/healthz', { signal: AbortSignal.timeout(Math.max(1, Math.ceil(3000))) }).then(x => x.json()).catch(() => null);
      const room = opt('room') || (h && h.relay && h.relay.room) || (saved() || {}).room;
      if (!room) die('no relay room: run the arena with the relay on, or pass --room <room>');
      const body = { room };
      if (h && h.version) body.version = h.version;
      if (h && h.availability) body.availability = h.availability;
      const j0 = await call('POST', '/pvp/queue', body);
      if (j0.code !== 200 && j0.code !== 201) { show(j0.j); process.exit(1); }
      // room proof (step 7): our own arena sends the relay's nonce back on its socket. Without it we can still be a guest.
      if (j0.j.proof && j0.j.proof.nonce) {
        const pr = await localSoft('/api/pvp/prove', { nonce: j0.j.proof.nonce });
        if (!pr || pr.code !== 200) console.error(`note: room not proven (${pr ? pr.j.error || pr.code : 'arena not reachable'}); you can only be paired as the guest`);
      }
      const until = opt('until') || 'started';
      if (argv.includes('--no-wait')) { show({ relay: base, ...hide(j0.j) }); process.exit(0); }
      const timeoutS = Math.max(1, +(opt('timeout') || 120) || 120);
      const t0 = Date.now(); let last = j0.j, hosted = false, readied = false;
      const endStates = ['started', 'done', 'aborted', 'cancelled', 'not_queued'];
      while (Date.now() - t0 < timeoutS * 1000) {
        if (last.status === 'paired' && until === 'paired') break;
        if (endStates.includes(last.status)) break;
        // host: ask OUR arena to host (the relay never calls into this computer)
        if (last.status === 'paired' && last.role === 'host' && !hosted) {
          hosted = true;
          const hr = await localSoft('/api/pvp/host', { matchId: last.matchId, opponent: last.opponent && last.opponent.name });
          if (!hr || hr.code !== 200) console.error(`note: the arena did not host (${hr ? hr.j.error || hr.code : 'arena not reachable'})`);
        }
        // guest: save the Ember seat the relay handed over, then say ready
        if (last.status === 'handoff' && last.role === 'guest' && last.seat && !readied) {
          readied = true;
          fs.mkdirSync(path.dirname(PVP_SEAT_FILE), { recursive: true });
          fs.writeFileSync(PVP_SEAT_FILE, JSON.stringify({ relay: base, room: last.seat.room, seat: last.seat.seat, join_token: last.seat.join_token, matchId: last.matchId, savedAt: new Date().toISOString() }, null, 1), { mode: 0o600 });
          fs.chmodSync(PVP_SEAT_FILE, 0o600);
          const rr = await call('POST', '/pvp/match/ready', { matchId: last.matchId });
          if (rr.code !== 200) { console.error(`note: ready not delivered (${rr.j.error || rr.code}); retrying`); readied = false; await sleep(1000); continue; }
          last = rr.j;
          continue;
        }
        const left = Math.max(1, Math.min(25, Math.ceil(timeoutS - (Date.now() - t0) / 1000)));
        const r = await call('GET', `/pvp/queue/wait?wait=${left}&state=${encodeURIComponent(last.status === 'not_queued' ? 'waiting' : last.status)}`);
        last = r.j;
      }
      show({ relay: base, ...hide(last), ...(readied ? { seatSavedIn: path.relative(ROOT, PVP_SEAT_FILE), play: 'node tools/warrior-seat.js next --pvp (and orders/step --pvp)' } : {}) });
      process.exit(last.status === until || (until === 'paired' && ['handoff', 'started'].includes(last.status)) ? 0 : ['waiting', 'paired', 'handoff'].includes(last.status) ? 2 : 1);
    }
    case 'help': case undefined: break;
    case 'roster': return show((await api('/api/seat/roster')).j);
    case 'status': {
      const j = (await api('/api/seat/status')).j;
      if (j && j.mode === 'agrts') { delete j.plan; delete j.nextPlan; delete j.style; }
      return show(j);
    }
    case 'report': {
      if (opt('match')) {
        const q = `/api/seat/report?match=${encodeURIComponent(opt('match'))}${argv.includes('--json') ? '' : '&format=text'}`;
        if (argv.includes('--json')) { const r = await api(q); show(r.j); process.exit(r.code === 200 ? 0 : 1); }
        const r = await api(q, null, true, true); console.log(r.text); process.exit(r.code === 200 ? 0 : 1);
      }
      const since = opt('since');
      const qs = since != null ? `?since=${encodeURIComponent(since)}&wait=0` : '';
      const r = USE_PVP_SEAT ? await seatCall('/api/seat/report' + qs, '/seat/report' + qs, null, 10000) : await api('/api/seat/report' + (since != null ? `?since=${encodeURIComponent(since)}` : ''));
      if (r.code !== 200) { show(r.j); process.exit(1); }
      if (argv.includes('--json')) return show(r.j);
      console.log(r.j.line || '');
      return;
    }
    case 'watch': {
      // a fresh arena claims its own relay room on first start; wait a little for it (--wait <s>, default 15)
      const wi = argv.indexOf('--wait'), waitS = wi > 0 ? +argv[wi + 1] || 0 : 15;
      let h;
      for (let t0 = Date.now(); ;) {
        h = await fetch(ARENA + '/healthz').then(r => r.json()).catch(() => die('arena not reachable'));
        const st = h.relay && h.relay.state;
        if (!h.relay || (h.relay.watch && st === 'ready') || !/^(starting|claiming)$/.test(st) || Date.now() - t0 > waitS * 1000) break;
        await sleep(500);
      }
      const phone = h.relay && h.relay.watch ? h.relay.watch : null;
      return show({ phone, relayConnected: !!(h.relay && h.relay.connected), relayState: h.relay ? h.relay.state : 'off', relayError: (h.relay && h.relay.error) || undefined, local: ARENA + '/', match: h.match, tick: h.tick,
        next: phone ? 'send the phone link to the commander' : 'no phone link: open the local link in the browser on your own desktop (never send localhost links)' });
    }
    case 'practice': {
      const n = +(argv[1] || 10);
      const r = await api('/api/seat/practice', { matches: n }); if (r.code !== 202) { show(r.j); process.exit(1); }
      for (let i = 0; i < 120; i++) { await new Promise(z => setTimeout(z, 10000)); const g = await api('/api/seat/practice'); if (g.j.state !== 'running') { show({ state: g.j.state, error: g.j.error, summary: g.j.summary }); return; } }
      die('practice still running after 20 min');
    }
    case 'leave': { const r = await api('/api/seat/leave', {}); if (r.code === 200) fs.rmSync(FILE, { force: true }); return show(r.j); }
    default: console.error(`unknown command "${cmd}"`); process.exitCode = 1;
  }
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, HELP_LINES).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
})();
