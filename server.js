'use strict';
// GrokBotWar referee + spectator server (robot SCRIPTS in a QuickJS sandbox; classic or COMMANDER mode).
//   GET  /                     spectator page (public/)
//   GET  /events               SSE stream of referee state (one message per tick)
//   GET  /api/state            current state snapshot
//   POST /api/control          {action: pause|resume|step|restart|speed|autorestart, tickMs?, on?}
//   POST /api/seat/script      {join_token, name, script, role?: hero|drone|battle-plan, unitType?}  -> validated
//                              (compile + sandbox dry run), used from NEXT match. role defaults to hero.
//   POST /api/seat/validate    {script, role?}             -> dry run only (no join token needed)
//                              (role "commander" = deprecated alias of "battle-plan")
//   GET  /api/seat/roster      (Bearer) team scripts;  POST /api/seat/roster {join_token, remove: drone|battle-plan, unitType?}
//   GET  /api/seat/arsenal     (Bearer) pre-match drones for the next match; POST {join_token, arsenal:{type:n}} | {reset:true}
//   GET  /api/seat/status      (Bearer) live team status (energy, units, enemies seen, events) - commander mode
//   POST /api/seat/order       {join_token, deploy: <unitType>, count}  applied next tick; 1 per 10 s per seat
//   POST /api/seat/identity    {join_token, name, avatarShape, avatarColor}  -> generated badge avatar
//   POST /api/seat/avatar      image bytes or {join_token, image_base64} | {join_token, clear: true}
//   GET  /api/seat/info        (Authorization: Bearer <join token>)  seat, current script, latest report id
//   GET  /api/seat/open        seats a new player can claim (bots.json "open": true / "player": true, not yet claimed)
//   POST /api/seat/join        {seat?, name?}  claim an open seat -> a fresh join token (only from this computer)
//   POST /api/seat/leave       {join_token}    give the seat back (token revoked, seat open again)
//   GET  /api/seat/report      (Bearer)  latest between-round report for that seat (JSON; ?format=text; ?match=N = that
//                              match of this arena run, 404 until it is over)
//   POST /api/seat/pause       {join_token, now?, every?}  hold after the current match (now: freeze at once; every:
//                              true|false = hold after every match). Control seats only (see controlSeat), this computer.
//   POST /api/seat/resume      {join_token}    start the held/paused arena (= fight), cancels a pending one-shot hold
//   POST /api/seat/stop        {join_token}    end the arena process cleanly (control seats only, this computer)
//   GET  /api/matches          recent match ids;  GET /api/matches/<id>/report[.txt]
//   GET  /docs/ROBOT-API.md    the robot scripting spec
//   GET  /healthz
// Config: bots.agrts.json by default (2-player AgRTS). BOTS_CONFIG=path overrides. GAME=classic uses bots.json.
// Env: PORT HOST TICK_MS MAX_TICKS SEED AUTO_RESTART
// START_PAUSED=1: the first match waits at tick 0 until POST /api/control {action:"resume"} (solo first card)
// PAUSE_AFTER_MATCH=1|0: hold after every match until resume/fight. Default: config "pauseAfterMatch", else ON for a
// solo style match (a seat with "player": true), OFF otherwise (shared arenas keep auto-starting matches).
// Live relay: src/relay-claim.js picks RELAY_URL+RELAY_KEY+RELAY_ROOM from the env or secrets/relay.env, else claims
// its own room on the public relay (or RELAY_URL) and saves it to secrets/relay.env. RELAY=off disables it. See relay/README.md
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Referee } = require('./src/referee');
const crypto = require('crypto');
const { loadQuickJS } = require('./src/sandbox');
const { loadConfig, buildRoster, normRole } = require('./src/roster');
const ROLES = ['hero', 'drone', 'battle-plan'];
const ROLE_ERR = 'role must be hero, drone or battle-plan ("commander" is accepted as a deprecated alias of battle-plan)';
const { dryRun } = require('./src/controllers/script');
const { MatchRecorder } = require('./src/recorder');
const { AvatarStore } = require('./src/avatars');

const PORT = +process.env.PORT || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const MATCH_DIR = path.join(__dirname, 'matches');

(async () => {
  const configFile = process.env.BOTS_CONFIG || (process.env.GAME === 'classic' ? 'bots.json' : 'bots.agrts.json');
  const { path: cfgPath, cfg } = loadConfig(__dirname, configFile);
  // 2-player AgRTS (Iteration 11). Classic commander/classic arenas stay on the path below.
  if (cfg.mode === 'agrts') {
    await require('./src/agrts/host').startAgrtsHost({ root: __dirname, cfg, cfgPath, port: PORT, host: HOST });
    return;
  }
  await loadQuickJS();
  const opts = {};
  for (const k of ['mode', 'tickMs', 'maxTicks', 'seed', 'autoRestart', 'autoRestartDelayMs', 'pauseAfterMatch', 'commander', 'unitTypes', 'softMatches']) if (cfg[k] !== undefined) opts[k] = cfg[k];
  if (process.env.TICK_MS) opts.tickMs = +process.env.TICK_MS;
  if (process.env.MAX_TICKS) opts.maxTicks = +process.env.MAX_TICKS;
  if (process.env.SEED) opts.seed = +process.env.SEED;
  if (process.env.AUTO_RESTART) opts.autoRestart = process.env.AUTO_RESTART !== '0';
  const soloStyleMatch = Object.values(cfg.seats || {}).some(sc => sc && sc.player);
  if (opts.pauseAfterMatch === undefined) opts.pauseAfterMatch = soloStyleMatch; // solo: debrief before the next match
  if (process.env.PAUSE_AFTER_MATCH) opts.pauseAfterMatch = process.env.PAUSE_AFTER_MATCH !== '0';

  const avatars = new AvatarStore(__dirname);
  const { roster, store, joinCodes } = buildRoster(__dirname, cfg, avatars);
  await Promise.all(avatars._pending || []);
  avatars.watch();
  fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
  // keep previously issued join codes across restarts (unless bots.json pins one). Codes of seats that are not in
  // the current config are kept in the file too, so starting the arena with another config (e.g. a style match)
  // does not lose them.
  const CODES_FILE = path.join(__dirname, 'logs', 'join-codes.json');
  let codesOnDisk = {};
  try { codesOnDisk = JSON.parse(fs.readFileSync(CODES_FILE, 'utf8')) || {}; } catch {}
  for (const seat of Object.keys(joinCodes)) if (codesOnDisk[seat] && !(cfg.seats && cfg.seats[seat] && cfg.seats[seat].joinToken)) joinCodes[seat] = codesOnDisk[seat];
  const seatByToken = new Map(Object.entries(joinCodes).map(([seat, tok]) => [tok, seat]));
  const saveCodes = () => { fs.writeFileSync(CODES_FILE + '.tmp', JSON.stringify({ ...codesOnDisk, ...joinCodes }, null, 2), { mode: 0o600 }); fs.renameSync(CODES_FILE + '.tmp', CODES_FILE); };
  saveCodes();
  // ---- open seats: a new player on this computer claims a seat the operator marked "open": true (or a style
  // match's "player": true seat) and gets a FRESH join token for it (the previous token of that seat stops working).
  // Claims persist in state/seats.json. Seats with a pinned joinToken, or without either flag, are never offered.
  const SEATS_FILE = path.join(__dirname, 'state', 'seats.json');
  let claims = {};
  try { claims = JSON.parse(fs.readFileSync(SEATS_FILE, 'utf8')) || {}; } catch {}
  const saveClaims = () => { fs.mkdirSync(path.dirname(SEATS_FILE), { recursive: true }); fs.writeFileSync(SEATS_FILE + '.tmp', JSON.stringify(claims, null, 1)); fs.renameSync(SEATS_FILE + '.tmp', SEATS_FILE); };
  const seatCfg = seat => (cfg.seats && cfg.seats[seat]) || {};
  const claimable = seat => { const c = seatCfg(seat); return !!(c.open || c.player) && !c.joinToken; };
  const openSeats = () => roster.filter(r => claimable(r.seat) && !claims[r.seat]).map(r => ({ seat: r.seat, color: r.color, style: seatCfg(r.seat).style || null, player: !!seatCfg(r.seat).player }));
  const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const rotateToken = seat => { seatByToken.delete(joinCodes[seat]); const tok = 'rw_' + crypto.randomBytes(12).toString('hex'); joinCodes[seat] = tok; seatByToken.set(tok, seat); saveCodes(); return tok; };

  // warrior name of a seat: the name given at join (identity), else its style's name, else the seat name
  let STYLE_NAMES = {};
  try { STYLE_NAMES = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(__dirname, 'styles', 'index.json'), 'utf8')).styles).map(([k, v]) => [k, v.name])); } catch {}
  const warriorName = seat => { const id = avatars.identity(seat); const st = seatCfg(seat).style; return (id && id.name) || (st && (STYLE_NAMES[st] || st)) || seat; };
  for (const e of roster) e.displayName = () => warriorName(e.seat);
  let recorder = null;
  const referee = new Referee(roster, { ...opts, beforeFirstMatch: ref => (recorder = new MatchRecorder(ref, { dir: MATCH_DIR, roster })) });
  // matches finished in this arena run: matchNo -> recorded match id (for GET /api/seat/report?match=N and `wait`)
  const finished = new Map();
  referee.on('matchEnd', sm => { finished.set(sm.matchNo, { id: recorder && recorder.lastId, winner: sm.winner, ticks: sm.ticks }); if (finished.size > 500) finished.delete(finished.keys().next().value); });
  // pause/stop: only from this computer, and only by a control seat: the solo player's seat ("player": true), or a
  // seat the operator marked "control": true. In a shared arena other players cannot pause or stop it.
  const controlSeat = seat => !!(seatCfg(seat).player || seatCfg(seat).control);
  if (process.env.START_PAUSED === '1') referee.paused = true; // first match waits at tick 0 (arsenal changes still land in it)
  const entryOf = seat => roster.find(r => r.seat === seat);
  const teamIdx = seat => roster.findIndex(r => r.seat === seat);
  const lastOrderAt = new Map();
  // ---- practice runs: POST /api/seat/practice {join_token, matches<=50, seeds?} -> 202 {jobId}; GET -> status/result.
  // One job at a time on the whole box (child process at lowest CPU priority), 2 min cooldown per seat after a job.
  const PRACTICE = { maxMatches: 50, cooldownMs: 120000, timeoutMs: 15 * 60000 };
  let practiceRunning = null; const practiceJobs = new Map(); const practiceLast = new Map();
  const summarize = (j) => {
    const m = j.matches || [], n = m.length, wins = m.filter(x => x.won).length, avg = k => n ? +(m.reduce((a, x) => a + x[k], 0) / n).toFixed(2) : null;
    const winners = {}; for (const x of m) winners[x.winner] = (winners[x.winner] || 0) + 1;
    return { jobId: j.id, seat: j.seat, state: j.state, error: j.error, requested: j.seeds.length, done: j.progress, startedAt: j.startedAt, finishedAt: j.finishedAt,
      scripts: j.scriptInfo, summary: n ? { matches: n, wins, winRate: +(wins / n).toFixed(3), avgPlacement: avg('placement'), avgScore: avg('score'), avgTicks: avg('ticks'),
        avgDamageDealt: avg('damageDealt'), totalFaults: m.reduce((a, x) => a + x.faults, 0), winners } : null, matches: j.state === 'done' ? m : undefined };
  };
  async function practice(req, res) {
    const msg = req.method === 'POST' ? await readBody(req, 1e4) : null;
    const seat = seatFrom(req, msg);
    if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
    if (!msg) { const j = practiceJobs.get(seat); return j ? sendJson(res, 200, { ok: true, ...summarize(j) }) : sendJson(res, 404, { ok: false, error: 'no practice job yet for this seat' }); }
    if (!referee.commanderMode) return sendJson(res, 409, { ok: false, error: 'practice runs need a commander-mode arena' });
    const n = msg.matches === undefined ? 20 : msg.matches;
    if (!Number.isInteger(n) || n < 1 || n > PRACTICE.maxMatches) return sendJson(res, 400, { ok: false, error: `matches must be an integer 1..${PRACTICE.maxMatches}` });
    let seeds = msg.seeds;
    if (seeds !== undefined && (!Array.isArray(seeds) || seeds.length > n || !seeds.every(x => Number.isInteger(x) && x >= 0 && x < 2 ** 32))) return sendJson(res, 400, { ok: false, error: `seeds must be an array of at most "matches" integers 0..2^32-1` });
    seeds = (seeds || []).concat(Array.from({ length: n - (seeds || []).length }, () => Math.floor(Math.random() * 2 ** 32)));
    if (practiceRunning) return sendJson(res, 429, { ok: false, error: `a practice run is in progress (${practiceRunning.seat}); one at a time on this box`, retryAfterMs: 30000 });
    const wait = (practiceLast.get(seat) || 0) + PRACTICE.cooldownMs - Date.now();
    if (wait > 0) { res.setHeader('Retry-After', Math.ceil(wait / 1000)); return sendJson(res, 429, { ok: false, error: `cooldown: 1 practice run per ${PRACTICE.cooldownMs / 1000}s per seat (after the previous one finishes)`, retryAfterMs: wait }); }
    const e = entryOf(seat), src = k => { const c = store.seats.get(k) && store.seats.get(k).current; return c ? { name: c.name, source: c.source } : null; };
    const scripts = { hero: src(e.key('hero')), drones: {}, battlePlan: e.hasBattlePlan() ? src(e.key('battle-plan')) : null };
    for (const t of e.droneTypes()) { const s = src(e.key('drone', t)); if (s) scripts.drones[t] = s; }
    const j = { id: crypto.randomBytes(6).toString('hex'), seat, seeds, state: 'running', progress: 0, startedAt: new Date().toISOString(), scriptInfo: e.scripts() };
    practiceJobs.set(seat, j); practiceRunning = j;
    const child = require('child_process').fork(path.join(__dirname, 'src', 'practice-run.js'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try { require('os').setPriority(child.pid, 19); } catch {}
    const finish = (state, error) => { if (j.state !== 'running') return; j.state = state; j.error = error; j.finishedAt = new Date().toISOString(); practiceRunning = null; practiceLast.set(seat, Date.now()); clearTimeout(timer); try { child.kill(); } catch {} console.log(`[grokbotwar] seat ${seat} practice ${j.id} ${state}${error ? ': ' + error : ''} (${j.progress}/${seeds.length})`); };
    const timer = setTimeout(() => finish('failed', 'timed out'), PRACTICE.timeoutMs);
    child.on('message', m => { if (m.progress) j.progress = m.progress; if (m.done) { j.matches = m.matches; finish('done'); } if (m.error) finish('failed', m.error); });
    child.on('exit', code => finish('failed', `practice process exited (${code})`));
    child.send({ cfgPath: cfgPath, seat, scripts, seeds });
    console.log(`[grokbotwar] seat ${seat} practice ${j.id} started: ${n} matches`);
    return sendJson(res, 202, { ok: true, jobId: j.id, seat, matches: n, seeds, poll: 'GET /api/seat/practice (Bearer token)', note: 'your current scripts vs the house scripts of the other 3 seats; nothing is recorded' });
  }
  const ORDER_COOLDOWN = referee.cfg.commander.orderCooldownMs;
  // the arsenal a seat will field next match + what it costs (SPEC 5.1). (Whether the arena uses arsenals at all
  // is decided at match start: any seat with one turns them on for everybody.)
  const arsenalView = seat => {
    const e = entryOf(seat), info = e.arsenalInfo(), cost = e.droneCost, budget = e.budget;
    const a = info.arsenal || {}, spent = Object.values(a).reduce((x, n) => x + n * cost, 0);
    const sc = seatCfg(seat);
    return { name: warriorName(seat), mode: referee.cfg.mode, arsenal: info.arsenal, source: info.source, budget, costPerDrone: cost, spent, startEnergy: budget - spent,
      maxDrones: Math.floor(budget / cost), droneCap: referee.cfg.commander.droneCap, droneTypes: e.droneTypes(), style: sc.style || null, color: e.color,
      arenaUsesArsenals: !!referee.arsenalsOn, match: referee.matchNo, tick: referee.tick, status: referee.status, paused: referee.paused,
      thisMatch: referee.teams && referee.teams[teamIdx(seat)] ? referee._arsenalPublic(referee.teams[teamIdx(seat)]) : null };
  };

  const clients = new Set();
  let lastJson = JSON.stringify(referee.publicState());
  referee.on('state', st => { lastJson = JSON.stringify(st); for (const res of clients) res.write(`data: ${lastJson}\n\n`); });
  // live relay (src/relay-claim.js): explicit env, secrets/relay.env, or claim our own room; RELAY=off turns it off
  const relayPub = require('./src/relay-claim').startRelay(referee, { avatars, root: __dirname });

  const PUB = path.join(__dirname, 'public');
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };
  const sendJson = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj, null, 1)); };
  const readBody = (req, max) => new Promise((resolve, reject) => {
    let body = ''; req.on('data', c => { body += c; if (body.length > max) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('bad json')); } });
  });
  const seatFrom = (req, body) => {
    const h = (req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i);
    const tok = (body && body.join_token) || (h && h[1]);
    return tok ? seatByToken.get(tok) || null : null;
  };
  const latestReportFor = seat => {
    if (!fs.existsSync(MATCH_DIR)) return null;
    const ids = fs.readdirSync(MATCH_DIR).sort().reverse();
    for (const id of ids) for (const sub of ['teams', 'robots']) { const f = path.join(MATCH_DIR, id, sub, `${seat}.json`); if (fs.existsSync(f)) return { id, file: f }; }
    return null;
  };
  const safeId = id => /^[A-Za-z0-9_-]+$/.test(id);
  // what happens after the current/last match: held until resume, auto-start in N ms, or nothing
  const nextInfo = () => referee.status === 'over'
    ? (referee.paused ? { held: true, nextMatch: referee.matchNo + 1, how: 'held: the next match starts on resume (warrior-seat.js fight)' } : referee._restartAt ? { held: false, nextMatch: referee.matchNo + 1, startsInMs: Math.max(0, referee._restartAt - Date.now()) } : { held: false, how: 'no auto-start (autoRestart off)' })
    : { held: false, current: referee.matchNo, status: referee.status, tick: referee.tick, paused: referee.paused, holdAfterMatch: referee.holdNext };
  // clean shutdown (POST /api/seat/stop, SIGINT, SIGTERM): stop ticking, end SSE streams, close the listener,
  // remove logs/server.pid if it is ours, then exit 0
  let stopping = false;
  function shutdown(why) {
    if (stopping) return; stopping = true;
    console.log(`[grokbotwar] ${why}, shutting down`);
    try { referee.pause(); clearTimeout(referee._restartTimer); } catch {}
    for (const c of clients) { try { c.end(); } catch {} }
    try { server.close(); } catch {}
    const pidFile = path.join(__dirname, 'logs', 'server.pid');
    try { if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) fs.rmSync(pidFile, { force: true }); } catch {}
    setTimeout(() => process.exit(0), 300);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    let m0;
    try {
      if (p === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`retry: 1000\ndata: ${lastJson}\n\n`);
        clients.add(res);
        const ka = setInterval(() => res.write(': ka\n\n'), 15000);
        req.on('close', () => { clearInterval(ka); clients.delete(res); });
        return;
      }
      if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (p === '/healthz') return sendJson(res, 200, { ok: true, mode: referee.cfg.mode, match: referee.matchNo, tick: referee.tick, clients: clients.size, relay: relayPub ? { state: relayPub.state, source: relayPub.source, room: relayPub.room, connected: relayPub.connected, paused: relayPub.paused, error: relayPub.error || undefined, sent: relayPub.stats.sent, silentS: relayPub.silentMs == null ? undefined : Math.round(relayPub.silentMs / 1000), reconnects: Math.max(0, (relayPub.stats.connects || 0) - 1), watch: relayPub.watchUrl } : undefined });
      if (p === '/api/state') return sendJson(res, 200, referee.publicState());
      if (p === '/api/control' && req.method === 'POST') {
        const msg = await readBody(req, 1e4);
        switch (msg.action) {
          case 'pause': referee.pause(); break;
          case 'resume': referee.resume(); break;
          case 'step': await referee.step(); break;
          case 'restart': referee.restart(); break;
          case 'speed': if (typeof msg.tickMs === 'number') referee.setTickMs(msg.tickMs); break;
          case 'autorestart': referee.setAutoRestart(msg.on); break;
          default: return sendJson(res, 400, { error: 'unknown action' });
        }
        return sendJson(res, 200, { ok: true, paused: referee.paused, tickMs: referee.cfg.tickMs, autoRestart: referee.cfg.autoRestart });
      }
      if (p === '/api/seat/validate' && req.method === 'POST') {
        const msg = await readBody(req, 64 * 1024);
        const role = normRole(msg.role || 'hero');
        if (!ROLES.includes(role)) return sendJson(res, 400, { ok: false, error: ROLE_ERR });
        const r = await dryRun(String(msg.script || ''), undefined, referee.commanderMode || role !== 'hero' ? role : 'classic');
        return sendJson(res, r.ok ? 200 : 422, r);
      }
      if (p === '/api/seat/practice') return practice(req, res);
      if (p === '/api/seat/roster') {
        const msg = req.method === 'POST' ? await readBody(req, 1e4) : null;
        const seat = seatFrom(req, msg);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        const e = entryOf(seat);
        if (msg && msg.remove) {
          const what = normRole(msg.remove);
          const ok = what === 'drone' ? e.removeDrone(String(msg.unitType || '')) : what === 'battle-plan' ? e.removeBattlePlan() : false;
          if (!ok) return sendJson(res, 404, { ok: false, error: 'nothing to remove (remove: "drone" with unitType, or "battle-plan")' });
          console.log(`[grokbotwar] seat ${seat} removed ${msg.remove} ${msg.unitType || ''}`);
        }
        return sendJson(res, 200, { ok: true, seat, mode: referee.cfg.mode, roster: e.scripts(), arsenal: e.arsenalInfo().arsenal, maxDroneTypes: referee.cfg.commander.rosterMaxDrones, appliesFrom: 'next match' });
      }
      if (p === '/api/seat/arsenal') {
        const msg = req.method === 'POST' ? await readBody(req, 1e4) : null;
        const seat = seatFrom(req, msg);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        const e = entryOf(seat);
        let note = null;
        if (msg && msg.reset === true) { e.resetArsenal(); note = 'back to the default arsenal'; console.log(`[grokbotwar] seat ${seat} arsenal reset`); }
        else if (msg) {
          if (msg.arsenal === undefined) return sendJson(res, 400, { ok: false, error: 'send {arsenal: {droneType: count}} or {reset: true}' });
          try { e.setArsenal(msg.arsenal); } catch (err) { return sendJson(res, 422, { ok: false, seat, error: err.message, arsenal: e.arsenalInfo().arsenal }); }
          console.log(`[grokbotwar] seat ${seat} arsenal set ${JSON.stringify(e.seatArsenal)}`);
        }
        const now = msg && referee.rearmArsenals(); // match not started yet (paused at tick 0): applies to it
        return sendJson(res, 200, { ok: true, seat, ...arsenalView(seat), appliesFrom: now ? 'this match (it has not started yet)' : msg ? 'next match' : undefined, note: note || undefined });
      }
      if (p === '/api/seat/status') {
        const seat = seatFrom(req, null);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        const st = referee.teamStatus(teamIdx(seat));
        const wait = Math.max(0, (lastOrderAt.get(seat) || 0) + ORDER_COOLDOWN - Date.now());
        return sendJson(res, 200, { ok: true, seat, name: warriorName(seat), ...st, orderCooldownMs: wait, tickMs: referee.cfg.tickMs, paused: referee.paused, held: referee.status === 'over' && referee.paused, holdAfterMatch: referee.holdNext, pauseAfterMatch: !!referee.cfg.pauseAfterMatch });
      }
      if (p === '/api/seat/order' && req.method === 'POST') {
        const msg = await readBody(req, 1e4);
        const seat = seatFrom(req, msg);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join_token' });
        if (!referee.commanderMode) return sendJson(res, 409, { ok: false, error: 'arena is not in commander mode' });
        const type = String(msg.deploy || ''); const count = msg.count === undefined ? 1 : msg.count;
        if (!/^[a-z][a-z0-9_-]{0,15}$/.test(type)) return sendJson(res, 400, { ok: false, error: 'deploy must be a unit type name ("hero" or one of your drone types)' });
        if (!Number.isInteger(count) || count < 1 || count > 4) return sendJson(res, 400, { ok: false, error: 'count must be an integer 1..4' });
        const wait = (lastOrderAt.get(seat) || 0) + ORDER_COOLDOWN - Date.now();
        if (wait > 0) { res.setHeader('Retry-After', Math.ceil(wait / 1000)); return sendJson(res, 429, { ok: false, error: `rate limited: 1 order per ${ORDER_COOLDOWN / 1000}s`, retryAfterMs: wait }); }
        const q = referee.queueOrder(teamIdx(seat), type, count, 'api');
        if (!q.ok) return sendJson(res, 409, q);
        lastOrderAt.set(seat, Date.now());
        console.log(`[grokbotwar] seat ${seat} order: deploy ${type} x${count} (tick ${q.appliesAtTick})`);
        return sendJson(res, 202, { ok: true, seat, deploy: type, count, ...q, note: 'applied at the start of that tick if affordable and under the caps; check GET /api/seat/status lastOrders' });
      }
      if (p === '/api/seat/identity') {
        const msg = req.method === 'POST' ? await readBody(req, 1e4) : null;
        const seat = seatFrom(req, msg);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        if (msg) { await avatars.setIdentity(seat, { name: msg.name, avatarShape: msg.avatarShape, avatarColor: msg.avatarColor }); referee._emit(); console.log(`[grokbotwar] seat ${seat} identity set (${JSON.stringify(avatars.identity(seat).name)})`); }
        return sendJson(res, 200, { ok: true, seat, identity: avatars.identity(seat), avatarUrl: avatars.url(seat), showing: avatars.avatarSource(seat), supportedShapes: require('./src/badges').SHAPES });
      }
      if (p === '/api/seat/script' && req.method === 'POST') {
        const msg = await readBody(req, 64 * 1024);
        const seat = seatFrom(req, msg);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join_token' });
        const role = normRole(msg.role || 'hero');
        const unitType = role === 'drone' ? String(msg.unitType || msg.type || '') : undefined;
        if (!ROLES.includes(role)) return sendJson(res, 400, { ok: false, error: ROLE_ERR });
        const name = String(msg.name || `${seat}-${role}${unitType ? '-' + unitType : ''}.js`).replace(/[^\w.\- ]/g, '').slice(0, 60) || `${seat}.js`;
        const r = await dryRun(String(msg.script || ''), undefined, referee.commanderMode || role !== 'hero' ? role : 'classic');
        if (!r.ok) return sendJson(res, 422, { ok: false, seat, role, error: r.error });
        let cur;
        try { cur = entryOf(seat).submit(role, unitType, name, String(msg.script)); } catch (e) { return sendJson(res, 422, { ok: false, seat, role, error: e.message }); }
        console.log(`[grokbotwar] seat ${seat} submitted ${role}${unitType ? ':' + unitType : ''} ${name} v${cur.version} (${cur.hash}); used from next match`);
        return sendJson(res, 200, { ok: true, seat, role, unitType, name, version: cur.version, hash: cur.hash, appliesFrom: 'next match', roster: entryOf(seat).scripts(), dryRun: r.results,
          deprecated: String(msg.role || '').toLowerCase() === 'commander' ? 'role "commander" is a deprecated alias; use "battle-plan"' : undefined,
          note: role !== 'hero' && !referee.commanderMode ? 'stored, but this arena runs classic mode (drones/battle plan unused)' : undefined });
      }
      if (p === '/api/seat/avatar' && req.method === 'POST') {
        // either raw image bytes (Content-Type: image/png|jpeg|webp + Authorization: Bearer <join token>)
        // or JSON {join_token, image_base64}
        const ct = String(req.headers['content-type'] || '');
        let seat, buf, clear = false;
        if (/^image\//.test(ct)) {
          seat = seatFrom(req, null);
          buf = await new Promise((resolve, reject) => { const chunks = []; let n = 0; req.on('data', c => { n += c.length; if (n > 300 * 1024) { reject(new Error('image too large (max 256 KB)')); req.destroy(); } else chunks.push(c); }); req.on('end', () => resolve(Buffer.concat(chunks))); });
        } else {
          const msg = await readBody(req, 400 * 1024);
          seat = seatFrom(req, msg); clear = msg.clear === true;
          buf = Buffer.from(String(msg.image_base64 || '').replace(/^data:image\/\w+;base64,/, ''), 'base64');
        }
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        if (clear) { avatars.clearImage(seat); referee._emit(); return sendJson(res, 200, { ok: true, seat, cleared: true, url: avatars.url(seat), showing: avatars.avatarSource(seat) }); }
        try { const r = await avatars.upload(seat, buf); console.log(`[grokbotwar] seat ${seat} uploaded avatar (${r.bytes} bytes after re-encode)`); referee._emit(); return sendJson(res, 200, { ok: true, seat, url: avatars.url(seat), ...r }); }
        catch (e) { return sendJson(res, 422, { ok: false, seat, error: e.message }); }
      }
      m0 = p.match(/^\/avatars\/([^/]+?)(\.badge)?\.png$/);
      if (m0) {
        const f = avatars.filePath(decodeURIComponent(m0[1]), !!m0[2]);
        if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
        return res.end(fs.readFileSync(f));
      }
      if (p === '/api/seat/open') return sendJson(res, 200, { ok: true, open: openSeats(), claimed: Object.keys(claims).filter(s => entryOf(s)), mode: referee.cfg.mode, join: 'POST /api/seat/join {seat?, name?} from this computer' });
      if (p === '/api/seat/join' && req.method === 'POST') {
        if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'seats can only be claimed from the computer the arena runs on' });
        const msg = await readBody(req, 1e4);
        const open = openSeats();
        const want = msg.seat ? open.find(o => o.seat === String(msg.seat)) : (open.find(o => o.player) || open[0]);
        if (!want) return sendJson(res, 409, { ok: false, error: msg.seat ? `seat "${msg.seat}" is not open` : 'no open seat in this arena', open: open.map(o => o.seat) });
        const tok = rotateToken(want.seat);
        const name = msg.name ? String(msg.name).replace(/[\u0000-\u001f\u007f<>"`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || null : null;
        claims[want.seat] = { claimedAt: new Date().toISOString(), name }; saveClaims();
        const prev = avatars.identity(want.seat) || {};
        // the name sticks to the seat (identity); without a name, a previous player's name is cleared so the seat
        // shows its style name
        if (name || prev.name) { await avatars.setIdentity(want.seat, { name: name || '', avatarShape: prev.avatarShape, avatarColor: prev.avatarColor }); referee._emit(); }
        console.log(`[grokbotwar] seat ${want.seat} claimed${name ? ' by ' + JSON.stringify(name) : ''} (new join token issued)`);
        return sendJson(res, 200, { ok: true, seat: want.seat, name: warriorName(want.seat), join_token: tok, color: want.color, style: want.style, mode: referee.cfg.mode, roster: entryOf(want.seat).scripts(), appliesFrom: 'next match', apiDoc: '/docs/ROBOT-API.md', note: 'keep join_token private: store it in a file, never in chat or memory text' });
      }
      if (p === '/api/seat/leave' && req.method === 'POST') {
        const msg = await readBody(req, 1e4);
        const seat = seatFrom(req, msg);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        if (!claims[seat]) return sendJson(res, 409, { ok: false, error: 'this seat was not claimed with /api/seat/join' });
        rotateToken(seat); delete claims[seat]; saveClaims();
        console.log(`[grokbotwar] seat ${seat} released (token revoked)`);
        return sendJson(res, 200, { ok: true, seat, released: true });
      }
      if (p === '/api/seat/info') {
        const seat = seatFrom(req, null);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token (Authorization: Bearer <join token>)' });
        const rep = latestReportFor(seat);
        return sendJson(res, 200, { ok: true, seat, name: warriorName(seat), mode: referee.cfg.mode, pauseAfterMatch: !!referee.cfg.pauseAfterMatch, holdAfterMatch: referee.holdNext, canControl: controlSeat(seat), lastFinished: finished.size ? [...finished.keys()].pop() : null, roster: entryOf(seat).scripts(), arsenal: entryOf(seat).arsenalInfo().arsenal, style: seatCfg(seat).style || null, identity: avatars.identity(seat), avatarUrl: avatars.url(seat), match: referee.matchNo, tick: referee.tick, status: referee.status, paused: referee.paused, latestReport: rep && rep.id, apiDoc: '/docs/ROBOT-API.md' });
      }
      if (p === '/api/seat/report') {
        const seat = seatFrom(req, null);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        let rep;
        if (url.searchParams.has('match')) {
          const n = +url.searchParams.get('match'), f = finished.get(n);
          if (!f) return sendJson(res, 404, { ok: false, match: n, current: referee.matchNo, status: referee.status, error: n > referee.matchNo ? 'that match has not started' : n === referee.matchNo && referee.status === 'running' ? 'match still running' : 'no report for that match in this arena run' });
          const file = f.id && ['teams', 'robots'].map(sub => path.join(MATCH_DIR, f.id, sub, `${seat}.json`)).find(x => fs.existsSync(x));
          if (!file) return sendJson(res, 404, { ok: false, match: n, error: 'match over but its report was not recorded' });
          rep = { id: f.id, file, extra: { matchNo: n, ticks: f.ticks, winner: f.winner } };
        } else rep = latestReportFor(seat);
        if (!rep) return sendJson(res, 404, { ok: false, error: 'no finished match yet' });
        if (url.searchParams.get('format') === 'text') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(fs.readFileSync(rep.file.replace(/\.json$/, '.txt'))); }
        return sendJson(res, 200, { ...JSON.parse(fs.readFileSync(rep.file, 'utf8')), ...(rep.extra || {}), reportFile: rep.file.replace(/\.json$/, '.txt'), next: nextInfo() });
      }
      if ((p === '/api/seat/pause' || p === '/api/seat/resume' || p === '/api/seat/stop') && req.method === 'POST') {
        const msg = await readBody(req, 1e4);
        const seat = seatFrom(req, msg);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'pause/resume/stop only work from the computer the arena runs on' });
        if (!controlSeat(seat)) return sendJson(res, 403, { ok: false, seat, error: 'only the solo player seat (or a seat marked "control": true in the arena config) may pause, resume or stop this arena' });
        if (p === '/api/seat/stop') {
          console.log(`[grokbotwar] seat ${seat} stopped the arena`);
          sendJson(res, 200, { ok: true, seat, stopping: true, pid: process.pid, match: referee.matchNo, status: referee.status, note: referee.status === 'running' && referee.tick > 0 ? 'the match in progress was not finished (no report for it)' : undefined });
          return shutdown('stop requested by seat ' + seat);
        }
        if (p === '/api/seat/resume') {
          const was = referee.paused;
          if (!was) referee.holdNext = false; // fight during a running match = cancel a pending "pause after this match"
          referee.resume();
          console.log(`[grokbotwar] seat ${seat} resume${was ? '' : ' (was not paused)'}`);
          return sendJson(res, 200, { ok: true, seat, started: was, match: referee.matchNo, status: referee.status, paused: referee.paused, pauseAfterMatch: !!referee.cfg.pauseAfterMatch });
        }
        let did = null;
        if (msg.every !== undefined) referee.setPauseAfterMatch(msg.every === true || msg.every === 'on' || msg.every === 1);
        if (msg.now === true) { referee.pause(); did = 'now'; }
        else if (msg.every === undefined || msg.every === true || msg.every === 'on' || msg.every === 1) did = referee.holdAfterMatch();
        console.log(`[grokbotwar] seat ${seat} pause ${did || ''}${msg.every !== undefined ? ' every=' + !!referee.cfg.pauseAfterMatch : ''}`);
        return sendJson(res, 200, { ok: true, seat, pause: did, match: referee.matchNo, status: referee.status, tick: referee.tick, paused: referee.paused, holdAfterMatch: referee.holdNext, pauseAfterMatch: !!referee.cfg.pauseAfterMatch,
          note: referee.status === 'over' && referee.paused ? 'held between matches: the next match starts on resume (warrior-seat.js fight)'
            : did === 'now' ? 'arena frozen mid-match; resume (warrior-seat.js fight) continues it'
            : did === 'after-match' ? `match ${referee.matchNo} plays to the end, then the arena waits for resume (warrior-seat.js fight)` : undefined });
      }
      if (p === '/api/matches') {
        const ids = fs.existsSync(MATCH_DIR) ? fs.readdirSync(MATCH_DIR).sort().reverse().slice(0, 50) : [];
        return sendJson(res, 200, { matches: ids });
      }
      let m = p.match(/^\/api\/matches\/([^/]+)\/report(\.txt)?$/);
      if (m && safeId(m[1])) {
        const f = path.join(MATCH_DIR, m[1], m[2] ? 'report.txt' : 'report.json');
        if (!fs.existsSync(f)) return sendJson(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': m[2] ? 'text/plain; charset=utf-8' : 'application/json' }); return res.end(fs.readFileSync(f));
      }
      if (p === '/docs/ROBOT-API.md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, 'docs', 'ROBOT-API.md')));
      }
      if (p === '/api/ui-version') {
        const h = f => require('crypto').createHash('sha1').update(fs.readFileSync(path.join(PUB, f))).digest('hex').slice(0, 10);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ app: h('app.js'), css: h('style.css') }));
      }
      // spectator page: cache-bust the JS/CSS includes with their content hash, and never cache the HTML
      if (p === '/' || p === '/index.html') {
        const ver = f => require('crypto').createHash('sha1').update(fs.readFileSync(path.join(PUB, f))).digest('hex').slice(0, 10);
        const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8')
          .replace(/(href|src)="(style\.css|app\.js)"/g, (m, a, f) => `${a}="${f}?v=${ver(f)}"`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' });
        return res.end(html);
      }
      // static
      const file = path.normalize(path.join(PUB, p === '/' ? '/index.html' : p));
      if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(data);
      });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`[grokbotwar] listening on http://${HOST}:${PORT} tickMs=${referee.cfg.tickMs} maxTicks=${referee.cfg.maxTicks} config=${cfgPath || '(defaults)'} mode=${referee.cfg.mode} seats=${roster.map(r => r.seat + '=' + Object.entries(r.scripts()).filter(([k]) => k !== 'commander').map(([, v]) => v).flatMap(v => v && v.name ? [v.name] : Object.values(v || {}).map(x => x.name)).join('+')).join(', ')}`);
    console.log(`[grokbotwar] join codes written to logs/join-codes.json (0600)`);
    referee.start();
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));
})().catch(e => { console.error('[grokbotwar] fatal', e); process.exit(1); });
