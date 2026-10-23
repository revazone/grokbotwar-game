'use strict';
// Opt-in outbound publisher: streams the spectator state to a GrokBotWar relay over WebSocket.
// Enabled only when RELAY_URL, RELAY_KEY and RELAY_ROOM are all set. It never blocks the referee: the 'state'
// listener only stores the latest frame; serialisation and sending happen later (setImmediate), frames are
// dropped (latest wins) when the socket is slow or down, and every error is swallowed and logged.
//   RELAY_URL   https://gbw.example.com (or wss://, http://localhost:8080 for tests)
//   RELAY_KEY   the relay's RELAY_PUBLISH_KEY
//   RELAY_ROOM  room id, [A-Za-z0-9_-]{3,64}; viewers open <RELAY_URL>/w/<room>
//   RELAY_FULL=1  send the full public state (default: a slim copy without debug fields; same shape)
// Seat play (warrior protocol) shares this socket. The arena sends seat-sync / seat-auth / seat-report /
// seat-flags / seat-orders-result. The relay sends seat-wait and seat-orders back. Those are not spectator frames.
// Admin switch: when the relay admin switches this room (or the whole relay) off, the relay refuses the upgrade with
// HTTP 423 or closes the socket with 4423. The publisher then retries quietly about once a minute, logs the pause
// once (and a reminder every 10 minutes), and logs when it is back on.
const fs = require('fs');

const MIN_INTERVAL_MS = 45;          // at most ~22 frames/s (relay default allows 30/s)
const MAX_BUFFERED = 512 * 1024;     // skip frames while this much is still queued on the socket
// Link watchdog. A socket can stay "open" here after the relay end is gone (an egress proxy or NAT that keeps our
// TCP leg up while the upstream leg died): the relay drops the publisher, but this side never gets a close, keeps
// queueing frames and seat records into a dead socket, and reports connected:true. The relay pings every 25 s and
// answers our pings, so silence means the link is dead: we ping every PING_MS and terminate after DEAD_MS without
// any inbound frame (ping, pong or message). The close handler then reconnects and re-syncs the seat cache.
const PING_MS = 15000, DEAD_MS = 45000;

const r1 = v => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);

// Same shape as Referee.publicState(), minus the debug-only fields the phone page never reads.
// An AgRTS frame also keeps the Iteration 11 field (terrain, bases, land, glyphs, HUD).
function slim(st) {
  if (st && st.mode === 'agrts') return slimAgrts(st);
  return {
    matchNo: st.matchNo, seed: st.seed, tick: st.tick, maxTicks: st.maxTicks, status: st.status, mode: st.mode,
    paused: st.paused, held: st.held, tickMs: st.tickMs, autoRestart: st.autoRestart, restartInMs: st.restartInMs,
    arena: st.arena, robotRadius: st.robotRadius, winner: st.winner,
    teams: st.teams.map(t => ({
      id: t.id, name: t.name, color: t.color, seat: t.seat, avatar: t.avatar, avatarKind: t.avatarKind, displayName: t.displayName,
      energy: t.energy, energyMax: t.energyMax, heroes: t.heroes, drones: t.drones, pending: t.pending, eliminated: t.eliminated, score: r1(t.score),
      hasBattlePlan: t.hasBattlePlan, battlePlanThought: typeof t.battlePlanThought === 'string' ? t.battlePlanThought.slice(0, 160) : null, // one-line HUD text
    })),
    robots: st.robots.map(r => ({
      id: r.id, name: r.name, color: r.color, team: r.team, kind: r.kind, type: r.type, radius: r.radius, maxHealth: r.maxHealth,
      x: r1(r.x), y: r1(r.y), heading: r1(r.heading), health: r1(r.health), heat: r1(r.heat), alive: r.alive,
      lastCmd: r.lastCmd && r.lastCmd.fire ? { fire: { angle: r1(r.lastCmd.fire.angle) } } : null,
      kills: r.kills,
    })),
    shells: st.shells.map(s => ({ id: s.id, owner: s.owner, power: s.power, small: s.small, x: r1(s.x), y: r1(s.y), vx: r1(s.vx), vy: r1(s.vy) })),
    events: st.events,
  };
}

const pickAvail = a => { const o = { state: a.state, since: a.since }; if (a.matchId) o.matchId = a.matchId; if (a.expiresAt) o.expiresAt = a.expiresAt; return o; };
function slimAgrts(st) {
  const teams = st.teams || [], robots = st.robots || [], shells = st.shells || [];
  return {
    mode: 'agrts', game: st.game, matchNo: st.matchNo, boot: st.boot || undefined, seed: st.seed,   // boot: the arena start id; the page keys its message panels on boot + match number
    tick: st.tick, steps: st.steps, maxTicks: st.maxTicks, status: st.status,
    paused: st.paused, held: st.held, phase: st.phase || 'live', countdown: st.countdown == null ? null : st.countdown, viewers: st.viewers || 0, gated: st.gated ? true : undefined, gateReleased: st.gateReleased ? true : undefined,
    elapsed: r1(st.elapsed || 0), clock: st.clock, speed: st.speed, gameSpeed: st.gameSpeed,
    tickMs: st.tickMs, autoRestart: st.autoRestart, restartInMs: st.restartInMs,
    w: st.w, h: st.h, arena: st.arena, robotRadius: st.robotRadius,
    hp: (st.hp || []).map(v => r1(Math.max(0, v))),
    winner: st.winner, sides: st.sides || [],
    unitTable: st.unitTable || [],   // units.csv rows the watch page draws from (shape, color, glyph, radius)
    rules: st.rules ? { version: String(st.rules.version || '').slice(0, 8), source: String(st.rules.source || '').slice(0, 8) } : undefined, // ruleset in play (src/agrts/rules.js): short version + remote|cache|local
    // Locked unit table (docs/SPEC.md §5.4): the table's sha256 and whether it is the official one.
    unitsLock: st.unitsLock ? { hash: st.unitsLock.hash, official: st.unitsLock.official } : undefined,
    // Version stamp (docs/SPEC.md §5.4 "Version stamp"): { game, protocol, unitsHash, official }. The relay keeps the latest frame
    // as-is, so GET <relay>/r/<room>/state shows it with no relay change.
    version: st.version ? { ...st.version } : undefined,
    // Availability (docs/SPEC.md §5.4 "Availability", PvP step 3): { state: free|busy|reserved, since, matchId?, expiresAt? }.
    // Rides the same frame, so GET <relay>/r/<room>/state shows it with no relay change.
    availability: st.availability ? pickAvail(st.availability) : undefined,
    land: (st.land || []).map(v => r1(v)), walls: st.walls || [], rough: st.rough || [],
    cameraShake: r1(st.cameraShake || 0),
    turrets: st.turrets || [],   // base turrets: { side, x, y, hp, max, alive, range, angle, aim, firedAt, hitFlash, downAt }
    ...(st.hospitals && st.hospitals.length ? { hospitals: st.hospitals } : {}), // FIELD_HOSPITAL=1 only
    // TOWERS=1 only (src/agrts/towers.js): gun towers and depots, the base shield flags, the last 2 s of Team HP events, tie-break points.
    ...(st.towersOn ? { towersOn: true, timeLimit: st.timeLimit, teamHpFloor: st.teamHpFloor, towers: st.towers || [], shield: st.shield || [false, false], hpEvents: st.hpEvents || [], towerPts: st.towerPts || [0, 0] } : {}),
    units: st.units || [],
    shots: (st.shots || []).map(s => ({ x: r1(s.x), y: r1(s.y), tx: r1(s.tx), ty: r1(s.ty), type: s.type, side: s.side, col: s.col, life: r1(s.life), maxLife: s.maxLife, ...(s.arc ? { arc: true } : {}) })),
    sparks: (st.sparks || []).map(p => ({ x: r1(p.x), y: r1(p.y), life: r1(p.life), col: p.col })),
    combatFx: st.combatFx || [], spawnFx: st.spawnFx || [], capturePulses: st.capturePulses || [],
    spendPulses: st.spendPulses || [], healPopups: st.healPopups || [],
    notices: (st.notices || []).slice(-3), logs: st.logs || [],
    teams: teams.map(t => ({
      id: t.id, name: t.name, color: t.color, seat: t.seat, avatar: t.avatar, avatarKind: t.avatarKind, displayName: t.displayName,
      energy: t.energy, energyMax: t.energyMax, heroes: t.heroes, drones: t.drones, pending: t.pending, eliminated: t.eliminated, score: r1(t.score),
      hasBattlePlan: t.hasBattlePlan, battlePlanThought: typeof t.battlePlanThought === 'string' ? t.battlePlanThought.slice(0, 160) : null,
    })),
    robots: robots.map(r => ({
      id: r.id, name: r.name, color: r.color, team: r.team, kind: r.kind, type: r.type, radius: r.radius, maxHealth: r.maxHealth,
      x: r1(r.x), y: r1(r.y), heading: r1(r.heading), health: r1(r.health), heat: r1(r.heat), alive: r.alive,
      lastCmd: r.lastCmd && r.lastCmd.fire ? { fire: { angle: r1(r.lastCmd.fire.angle) } } : null,
      kills: r.kills,
    })),
    shells: shells.map(s => ({ id: s.id, owner: s.owner, power: s.power, small: s.small, x: r1(s.x), y: r1(s.y), vx: r1(s.vx), vy: r1(s.vy) })),
    events: st.events || [],
  };
}

function startRelayPublisher(referee, { avatars, env = process.env, log = (...a) => console.log('[relay-pub]', ...a), pauseRetryMs = 60000, onUnclaimed = null, hooks = {} } = {}) {
  const base = env.RELAY_URL, key = env.RELAY_KEY, room = env.RELAY_ROOM;
  if (!base || !key || !room) return null;
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(room)) { log(`RELAY_ROOM must match [A-Za-z0-9_-]{3,64}; publisher disabled`); return null; }
  let WebSocket;
  try { WebSocket = require('ws'); } catch { WebSocket = globalThis.WebSocket; }
  if (!WebSocket) { log('no WebSocket implementation (npm install ws); publisher disabled'); return null; }
  const full = env.RELAY_FULL === '1';
  const wsUrl = base.replace(/\/+$/, '').replace(/^http/, 'ws') + '/pub/' + encodeURIComponent(room);
  const watchUrl = base.replace(/\/+$/, '').replace(/^ws/, 'http') + '/w/' + room;

  let ws = null, connected = false, stopped = false, backoff = 1000, retryTimer = null, openedAt = 0;
  let latest = null, scheduled = false, lastSent = 0, sentAssets = new Set(), stats = { sent: 0, dropped: 0, connects: 0 };
  const PAUSE_RETRY_MS = pauseRetryMs, PAUSE_LOG_EVERY_MS = 10 * 60000;   // pauseRetryMs is only lowered by tests
  let pausedSince = 0, pauseLoggedAt = 0;
  const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);
  const pingMs = num(env.RELAY_PING_MS, PING_MS), deadMs = Math.max(num(env.RELAY_DEAD_MS, DEAD_MS), pingMs * 2);
  let lastRx = 0, watchdog = null;
  function stopWatchdog() { if (watchdog) { clearInterval(watchdog); watchdog = null; } }
  function startWatchdog(sock) {
    stopWatchdog();
    lastRx = Date.now();
    watchdog = setInterval(() => {
      if (stopped || ws !== sock || sock.readyState !== 1) return stopWatchdog();
      const silent = Date.now() - lastRx;
      if (silent >= deadMs) {
        stats.stale = (stats.stale || 0) + 1;
        log(`relay link silent for ${Math.round(silent / 1000)} s (${sock.bufferedAmount} bytes unsent); dropping it and reconnecting`);
        stopWatchdog();
        try { sock.terminate(); } catch {}
        return;
      }
      try { sock.ping(); } catch {}
    }, pingMs);
    watchdog.unref && watchdog.unref();
  }
  function onPaused(why) {
    const now = Date.now();
    if (!pausedSince) { pausedSince = now; pauseLoggedAt = now; log(`relay paused by its admin (${why}); retrying quietly about every ${PAUSE_RETRY_MS / 1000} s`); }
    else if (now - pauseLoggedAt >= PAUSE_LOG_EVERY_MS) { pauseLoggedAt = now; log(`relay still paused (${why}) for ${Math.round((now - pausedSince) / 60000)} min; still retrying`); }
    backoff = PAUSE_RETRY_MS;
  }

  function connect() {
    if (stopped) return;
    try {
      ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 10000, perMessageDeflate: true });
    } catch (e) { log('connect error:', e.message); return retry(); }
    const sock = ws;
    const alive = () => { lastRx = Date.now(); };
    ws.on('ping', alive);
    ws.on('pong', alive);
    ws.on('open', () => {
      connected = true; openedAt = Date.now(); stats.connects++; sentAssets = new Set();
      startWatchdog(sock);
      if (pausedSince) { log(`relay switched back on after ${Math.round((Date.now() - pausedSince) / 60000)} min paused`); pausedSince = 0; }
      log(`connected to ${base} room=${room}; watch: ${watchUrl}`);
      if (hooks.onOpen) hooks.onOpen();
      latest = latest || referee.publicState(); schedule();
    });
    ws.on('unexpected-response', (req, res) => {
      if (res.statusCode === 423) onPaused(`HTTP 423, ${res.headers['x-relay-paused'] === 'all' ? 'whole relay' : 'this room'} off`);
      else if (res.statusCode === 401 && res.headers['x-relay-room'] === 'unclaimed' && onUnclaimed && onUnclaimed()) { try { req.destroy(); } catch {} ws = null; return; }   // relay-claim.js claims a new room
      else log(`relay refused the connection: HTTP ${res.statusCode}${res.statusCode === 401 ? ' (wrong RELAY_KEY?)' : ''}`);
      if (res.statusCode === 401) backoff = Math.max(backoff, 60000);
      try { req.destroy(); } catch {}
      // ws emits no 'close' after a refused upgrade when we handle the response ourselves, so retry here
      connected = false; ws = null; retry();
    });
    ws.on('close', (code, reason) => {
      if (ws !== sock) return;   // an old socket we already replaced
      stopWatchdog();
      const was = connected; connected = false; ws = null;
      if (was && hooks.onClose) hooks.onClose();
      if (code === 4423) onPaused(`closed 4423: ${String(reason || 'paused')}`);
      else if (code === 4401) { log(`relay closed the connection: ${String(reason || 'room released')}`); backoff = 2000; }
      else {
        if (was) log(`disconnected (${code}); reconnecting`);
        if (was && Date.now() - openedAt > 10000) backoff = 1000;
      }
      retry();
    });
    ws.on('error', e => { if (!connected && !stopped) log('connect failed:', e.message); });
    ws.on('message', data => {
      lastRx = Date.now();
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (hooks.onMessage) hooks.onMessage(msg);
    });
  }
  function retry() {
    if (stopped || retryTimer) return;
    const wait = Math.round(backoff * (0.75 + Math.random() * 0.5));
    backoff = Math.min(60000, backoff * 2);
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, wait);
    retryTimer.unref && retryTimer.unref();
  }
  function schedule() {
    if (scheduled || !connected) return;
    scheduled = true;
    const wait = Math.max(0, lastSent + MIN_INTERVAL_MS - Date.now());
    const go = () => { scheduled = false; flush(); };
    if (wait) setTimeout(go, wait); else setImmediate(go);
  }
  function flush() {
    if (!connected || !latest || !ws || ws.readyState !== 1) return;
    if (ws.bufferedAmount > MAX_BUFFERED) { stats.dropped++; return schedule(); }
    const st = latest; latest = null;
    try {
      pushAssets(st);
      ws.send(JSON.stringify({ t: 'state', d: full ? st : slim(st) }));
      lastSent = Date.now(); stats.sent++;
    } catch (e) { log('send failed:', e.message); }
  }
  // team avatars live on the arena box; push each image once per connection so the phone page can show it
  function pushAssets(st) {
    if (!avatars) return;
    for (const t of st.teams || []) {
      const u = t.avatar; if (!u || sentAssets.has(u)) continue;
      sentAssets.add(u);
      const m = u.match(/^\/avatars\/([^/?]+?)(\.badge)?\.png(\?|$)/); if (!m) continue;
      const f = avatars.filePath(decodeURIComponent(m[1]), !!m[2]); if (!f) continue;
      fs.promises.readFile(f).then(buf => {
        if (buf.length > 280 * 1024 || !connected || !ws) return;
        ws.send(JSON.stringify({ t: 'asset', url: u, mime: 'image/png', b64: buf.toString('base64') }));
      }).catch(() => {});
    }
  }
  const onState = st => { latest = st; if (connected) schedule(); };
  referee.on('state', onState);
  log(`enabled: ${wsUrl.replace(/\/pub\/.*/, '')} room=${room}${full ? ' (full state)' : ''}`);
  connect();
  function send(obj) {
    if (stopped || !connected || !ws || ws.readyState !== 1 || obj == null) return false;
    try { ws.send(JSON.stringify(obj)); return true; }
    catch (e) { log('send failed:', e.message); return false; }
  }
  return {
    stop() {
      const was = connected; stopped = true; connected = false; referee.off('state', onState); clearTimeout(retryTimer); stopWatchdog();
      try { ws && ws.close(); } catch {}
      if (was && hooks.onClose) hooks.onClose();
    },
    send,
    get connected() { return connected; }, get paused() { return !!pausedSince; }, stats, watchUrl,
    get silentMs() { return connected && lastRx ? Date.now() - lastRx : null; },
  };
}

module.exports = { startRelayPublisher, slim };
