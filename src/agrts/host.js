'use strict';
// HTTP host for the 2-player AgRTS match. Same start.sh / seat / relay shape as the classic arena:
//   GET  /                      Iteration 11 spectator (desktop, portrait, landscape)
//   GET  /events                SSE of match.publicState()
//   GET  /api/state             same snapshot
//   GET  /healthz
//   POST /api/control           {action: pause|resume|restart|step}
//   GET  /api/seat/open         POST /api/seat/join|leave|label|pause|resume|stop|plan|opening|decision|orders
//   GET  /api/seat/info|status|roster|report   (report: live wire line; ?match=N is the finished match)
//   GET  /api/agrts/hooks       the team-decision seam (docs/TEAM-DECISIONS.md)
//   POST /api/pvp/reserve|release  {matchId, ttlS} PvP reservation (local + solo seat token)
//   POST /api/pvp/prove {nonce}   GBW_PVP=1: send the relay's room-proof nonce back on our publisher socket (PvP step 7)
//   POST /api/pvp/host {matchId, opponent}   GBW_PVP=1: host a paired PvP match (reserve, Ember seat for it, start on guest ready)
//   GET  /api/pvp/status          the PvP handoff in progress, if any (solo seat token)
// Classic script upload, arsenal edits and practice runs answer 409: this match does not use them.
// A claimed seat drives its own opening, buy queue and deploy. The other side stays simulated.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AgrtsMatch } = require('./match');
const { describeHooks, normalizeStyle, validateOpening } = require('./team-decisions');
const { TYPES, TYPE_IDS, FIELD_COST, STYLES } = require('./constants');
const U = require('./units');
const V = require('./version');
const { postReportWebhook, protocolLogRecord, shouldPostWake, readEnvNumber, WAKE_MIN_MS, PROTOCOL_VERSION } = require('./protocol');

const { cleanBase, baseFromLabel } = require('./base-name');

const PUB = path.join(__dirname, '..', '..', 'public', 'agrts');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };

function startAgrtsHost({ root, cfg, cfgPath, port, host }) {
  const seats = Object.keys(cfg.seats || {});
  if (seats.length !== 2) throw new Error('bots agrts config must define exactly 2 seats (the first is the left side)');
  const seatCfg = seat => (cfg.seats && cfg.seats[seat]) || {};
  const labels = seats.map((seat, i) => {
    const sc = seatCfg(seat);
    return {
      seat, index: i,
      label: sc.label || (i === 0 ? 'GREEN COMMAND' : 'EMBER COMMAND'),
      base: sc.base || (i === 0 ? 'HAVEN-01' : 'CINDER-09'),
      color: sc.color || (i === 0 ? '#bafc82' : '#ff7768'),
      role: sc.role || (i === 0 ? 'AUTO-DRAFTED · AGENT COMMAND' : 'RIVAL AGENT · COUNTER-BUILD'),
      defaultRole: sc.role || (i === 0 ? 'AUTO-DRAFTED · AGENT COMMAND' : 'RIVAL AGENT · COUNTER-BUILD'),
    };
  });
  const sideOf = seat => seats.indexOf(seat);
  // Remote Ember seat (PvP step 4, docs/SPEC.md §5.4 "Remote Ember seat"). Off unless the person running this arena
  // sets GBW_TWO_SEATS=1 in its environment (not a player setting). Then the second seat (Ember) is claimable too,
  // and a silent Ember warrior is played by the built-in commander after EMBER_TAKEOVER_S match seconds (20).
  const twoSeats = process.env.GBW_TWO_SEATS === '1';
  const takeoverS = twoSeats ? Math.max(1, readEnvNumber('EMBER_TAKEOVER_S', 20)) : 0;
  const claimable = seat => { const c = seatCfg(seat); return !!(c.open || c.player || (twoSeats && sideOf(seat) === 1)) && !c.joinToken; };
  const controlSeat = seat => !!(seatCfg(seat).player || seatCfg(seat).control);
  // PvP handoff (PvP step 7, docs/SPEC.md §5.4 "Match handoff"). Off unless the person running this arena sets GBW_PVP=1.
  // Then a paired match (relay queue, step 6) can open the Ember seat for that one match, without GBW_TWO_SEATS.
  const pvpOn = process.env.GBW_PVP === '1';
  const PVP_READY_S = Math.max(5, readEnvNumber('PVP_READY_S', 60));
  const pvpTakeoverS = Math.max(1, readEnvNumber('EMBER_TAKEOVER_S', 20));
  let pvp = null;   // { matchId, opponent, state: 'waiting-guest' | 'live', at, readyTimer, matchNo }

  const CODES_FILE = path.join(root, 'logs', 'join-codes.json');
  const SEATS_FILE = path.join(root, 'state', 'seats.json');
  const MATCH_DIR = path.join(root, 'matches');
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  let codesOnDisk = {};
  try { codesOnDisk = JSON.parse(fs.readFileSync(CODES_FILE, 'utf8')) || {}; } catch {}
  const joinCodes = {};
  for (const seat of seats) joinCodes[seat] = seatCfg(seat).joinToken || codesOnDisk[seat] || ('rw_' + crypto.randomBytes(12).toString('hex'));
  const seatByToken = new Map(Object.entries(joinCodes).map(([seat, tok]) => [tok, seat]));
  const saveCodes = () => {
    fs.writeFileSync(CODES_FILE + '.tmp', JSON.stringify({ ...codesOnDisk, ...joinCodes }, null, 2), { mode: 0o600 });
    fs.renameSync(CODES_FILE + '.tmp', CODES_FILE);
  };
  saveCodes();
  let claims = {};
  try { claims = JSON.parse(fs.readFileSync(SEATS_FILE, 'utf8')) || {}; } catch {}
  const saveClaims = () => {
    fs.mkdirSync(path.dirname(SEATS_FILE), { recursive: true });
    fs.writeFileSync(SEATS_FILE + '.tmp', JSON.stringify(claims, null, 1));
    fs.renameSync(SEATS_FILE + '.tmp', SEATS_FILE);
  };
  // A claim on a seat this arena does not open (an Ember claim left from a GBW_TWO_SEATS=1 run) is dropped at start,
  // and that seat's token is replaced, so the side stays simulated exactly as before and the old token stops working.
  {
    // a PvP Ember claim (claims[seat].pvp) never outlives the arena run that made it
    const stale = Object.keys(claims).filter(seat => seats.includes(seat) && (!claimable(seat) || claims[seat].pvp));
    for (const seat of stale) {
      const was = claims[seat];
      delete claims[seat];
      seatByToken.delete(joinCodes[seat]);
      joinCodes[seat] = 'rw_' + crypto.randomBytes(12).toString('hex');
      seatByToken.set(joinCodes[seat], seat);
      console.log(`[grokbotwar] seat ${seat} claim dropped: ${was && was.pvp ? `it was for PvP match ${was.pvp}, which ended with the last run` : 'this arena runs one seat (GBW_TWO_SEATS is not 1)'}; token replaced`);
    }
    if (stale.length) { saveClaims(); saveCodes(); }
  }
  const identities = {};
  for (const seat of seats) if (claims[seat] && claims[seat].name) identities[seat] = claims[seat].name;
  const displayName = seat => identities[seat] || labels[sideOf(seat)].label;
  const defaultBase = labels.map(l => l.base);
  const cleanName = v => (v ? String(v).replace(/[\u0000-\u001f\u007f<>"`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || null : null);
  // A claimed seat's base: the one it sent, else "<NAME>-01" (Green) / "<NAME>-09" (Ember, like CINDER-09) from its
  // name (the bot's label), else the config base (HAVEN-01 / CINDER-09).
  const baseSuffix = seat => (sideOf(seat) === 1 ? '09' : '01');
  const baseOf = seat => { const c = claims[seat]; return (c && (cleanBase(c.base) || baseFromLabel(c.name, baseSuffix(seat)))) || defaultBase[sideOf(seat)]; };
  const applyNames = () => {
    labels.forEach(l => {
      l.base = baseOf(l.seat);
      const warrior = match.drivers[l.index] === 'warrior';
      l.role = identities[l.seat] ? `${warrior ? 'WARRIOR' : 'SEATED'} · ${identities[l.seat]}` : l.defaultRole;
    });
  };

  const match = new AgrtsMatch({
    seed: Number.isInteger(cfg.seed) ? cfg.seed : undefined,
    labels,
    styles: seats.map(s => seatCfg(s).style || null),
    pauseAfterMatch: cfg.pauseAfterMatch !== false,
    warriorAutopilot: process.env.WARRIOR_AUTOPILOT !== '0',
    awaitViewer: process.env.AWAIT_VIEWER !== '0',
    emberTakeoverS: takeoverS,
    realtimeX: readEnvNumber('SIM_REALTIME_X', 1),
  });
  for (const seat of seats) if (claims[seat]) match.setDriver(sideOf(seat), 'warrior');
  applyNames();
  // A claimed solo seat keeps match 1 paused until fight, including after an arena
  // restart while relay viewers are still connected. START_PAUSED=1 is the same hold
  // for an arena that sets it. An unclaimed seat is unchanged.
  const OPENINGS_FILE = path.join(root, 'state', 'openings.json');
  let openings = {};
  try { openings = JSON.parse(fs.readFileSync(OPENINGS_FILE, 'utf8')) || {}; } catch {}
  const saveOpenings = () => {
    fs.mkdirSync(path.dirname(OPENINGS_FILE), { recursive: true });
    fs.writeFileSync(OPENINGS_FILE + '.tmp', JSON.stringify(openings, null, 1));
    fs.renameSync(OPENINGS_FILE + '.tmp', OPENINGS_FILE);
  };
  for (const seat of seats) {
    if (!claims[seat] || !openings[seat]) continue;
    const opening = validateOpening(openings[seat]);
    if (!opening.error) match.setOpening(sideOf(seat), opening);
  }
  const soloClaimed = seats.some(seat => claims[seat] && (seatCfg(seat).player || seatCfg(seat).control));
  if (process.env.START_PAUSED === '1' || soloClaimed) match.paused = true;

  // Wire-protocol outbox. The stay-awake loop reads it with a long-poll.
  // The webhook is an optional backup: one try, never awaited on the sim tick.
  const PROTOCOL_LOG = path.join(root, 'logs', 'warrior-protocol.log');
  const webhookUrl = process.env.WARRIOR_REPORT_WEBHOOK || '';
  const webhookKey = process.env.WARRIOR_REPORT_WEBHOOK_KEY || '';
  const wakeMinMs = readEnvNumber('WARRIOR_WAKE_MIN_MS', WAKE_MIN_MS);
  const lastWakeAt = [0, 0];
  const seenReport = new Map();
  let relayBridge = null;
  const writeProtocol = (dir, matchNo, seat, text) => {
    const rec = protocolLogRecord(dir, matchNo, seat, text);
    try { fs.appendFileSync(PROTOCOL_LOG, rec + '\n'); }
    catch (e) { console.log('[warrior] log failed: ' + (e && e.message || e)); }
    console.log(`[warrior] ${dir} m${matchNo} ${seat} ${text}`);
  };
  const deliverReport = (rep) => {
    if (!rep) return;
    const rev = rep.rev || 1;
    const seenKey = `${rep.side}:${rep.id}`;
    if (seenReport.get(seenKey) === rev) return;
    seenReport.set(seenKey, rev);
    writeProtocol('OUT', rep.match, rep.seat, rep.line);
    if (relayBridge) relayBridge.report(rep);
    if (!webhookUrl) return;
    const sinceWake = lastWakeAt[rep.side] ? Date.now() - lastWakeAt[rep.side] : Infinity;
    if (!shouldPostWake(rep.event, sinceWake, wakeMinMs)) return;
    lastWakeAt[rep.side] = Date.now();
    postReportWebhook(webhookUrl, rep, console.log, { key: webhookKey });
  };
  match.on('protocol', deliverReport);
  for (const list of match.protocolReports) for (const rep of list) deliverReport(rep);

  const roundMs = v => v == null || !Number.isFinite(v) ? null : Math.round(v);
  const roundDecide = stats => ({
    n: stats.n || 0,
    min: roundMs(stats.min),
    med: roundMs(stats.med),
    p90: roundMs(stats.p90),
    max: roundMs(stats.max),
    avgGap: roundMs(stats.avgGap),
  });
  const DECIDE_LOG = path.join(root, 'logs', 'decide-latency.jsonl');
  const appendDecideLog = (row) => {
    try { fs.appendFileSync(DECIDE_LOG, JSON.stringify(row) + '\n'); }
    catch (e) { console.log('[warrior] decide log failed: ' + (e && e.message || e)); }
  };
  const finished = new Map();
  match.on('matchEnd', st => {
    const id = `agrts-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-m${st.matchNo}`;
    const dir = path.join(MATCH_DIR, id, 'teams');
    fs.mkdirSync(dir, { recursive: true });
    const winner = st.winner || { side: null, name: 'NOBODY', reason: 'time limit' };
    // Report names: a claimed seat shows its name and base, e.g. "Big Dog (BIG-DOG-01)"; in PvP the
    // guest's name is on Ember's claim. An unclaimed side keeps GREEN COMMAND / EMBER COMMAND.
    const seatAt = side => seats.find(x => sideOf(x) === side);
    const who = side => { const seat = seatAt(side); return seat && identities[seat] ? { name: identities[seat], base: baseOf(seat), seat } : { name: st.sides[side].label, base: null, seat }; };
    const sideNames = [0, 1].map(who);
    const full = n => n.base ? `${n.name} (${n.base})` : n.name;
    const winnerName = winner.side == null ? winner.name : sideNames[winner.side].name;
    for (const seat of seats) {
      const side = sideOf(seat);
      const won = winner.side === side;
      const decide = roundDecide(match.decideStats(side));
      const body = {
        ok: true, match: id, matchNo: st.matchNo, name: seat, displayName: displayName(seat),
        placement: winner.side == null ? 1 : won ? 1 : 2, won, score: Math.max(0, Math.ceil(st.hp[side])),
        ticks: st.tick, eliminated: st.hp[side] <= 0, eliminatedTick: st.hp[side] <= 0 ? st.tick : null,
        plan: st.plans[side], arsenal: st.sides[side],
        winner: { name: winner.seat || winner.name, displayName: winnerName, reason: winner.reason, side: winner.side },
        sides: sideNames.map(n => ({ seat: n.seat, name: n.name, base: n.base })),
        decide,
        reportFile: path.join(MATCH_DIR, id, 'teams', `${seat}.txt`),
      };
      fs.writeFileSync(path.join(dir, `${seat}.json`), JSON.stringify(body, null, 1));
      const lines = [
        `GrokBotWar AgRTS match ${st.matchNo}`,
        `${full(sideNames[0])} vs ${full(sideNames[1])}`,
        `Result: ${winnerName} (${winner.reason}) at ${st.clock}`,
        `${seat}: ${won ? 'won' : 'lost'}, base ${body.score} HP, plan ${st.plans[side]}`,
        `Field at the end: ${st.sides.map((s, i) => `${sideNames[i].name} ${s.hp} HP, ${s.field} units`).join(' · ')}`,
        `Decide: n=${decide.n} med=${decide.med} p90=${decide.p90} min=${decide.min} max=${decide.max} avgGap=${decide.avgGap}`,
      ];
      fs.writeFileSync(path.join(dir, `${seat}.txt`), lines.join('\n') + '\n');
      if (decide.n > 0) appendDecideLog({ match: st.matchNo, seat, name: displayName(seat), ...decide, ts: new Date().toISOString() });
    }
    fs.writeFileSync(path.join(MATCH_DIR, id, 'report.txt'), fs.readFileSync(path.join(dir, `${seats[0]}.txt`)));
    finished.set(st.matchNo, { id, winner, ticks: st.tick });
    if (finished.size > 500) finished.delete(finished.keys().next().value);
    console.log(`[grokbotwar] agrts match ${st.matchNo} over: ${winnerName} (${winner.reason})`);
    if (pvp && pvp.state === 'live' && pvp.matchNo === st.matchNo) pvpFinish('end', { winner: { side: winner.side, reason: winner.reason } });
  });

  const clients = new Set();
  let lastJson = JSON.stringify(match.publicState());
  match.on('state', st => {
    lastJson = JSON.stringify(st);
    for (const res of clients) res.write(`data: ${lastJson}\n\n`);
  });
  const relayPub = require('../relay-claim').startRelay(match, { root });

  const sendJson = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj, null, 1)); };
  const readBody = (req, max) => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > max) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('bad json')); } });
  });
  const readRaw = (req, max) => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > max) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
  const publicReport = rep => ({ id: rep.id, line: rep.line, event: rep.event, t: rep.t, match: rep.match, seat: rep.seat, side: rep.side, sentAt: rep.sentAt, version: PROTOCOL_VERSION });
  const protocolPayload = (side, why = 'latest') => {
    const list = match.protocolReports[side] || [];
    const recent = list.slice(-12).map(publicReport);
    const cur = list[list.length - 1] || null;
    const fresh = why === 'fresh' || (why === 'latest' && !!cur);
    const timeout = why === 'timeout';
    const stop = why === 'stop' || (fresh && cur && cur.event === 'END');
    const marker = stop ? (fresh && cur && cur.event === 'END' ? 'END' : 'no-match') : (timeout ? 'timeout' : null);
    return {
      ok: true,
      version: PROTOCOL_VERSION,
      seat: seats[side],
      side,
      line: cur ? cur.line : null,
      event: cur ? cur.event : null,
      t: cur ? cur.t : null,
      match: cur ? cur.match : match.matchNo,
      id: cur ? cur.id : 0,
      sentAt: cur ? cur.sentAt : null,
      fresh, timeout, stop, marker,
      paused: !!match.paused,
      ended: !!match.over,
      recent,
    };
  };
  let sentFlags = null;
  const tokenHash = tok => crypto.createHash('sha256').update(String(tok)).digest('hex');
  const seatAuthList = () => labels.map(l => ({ seat: l.seat, side: l.index, hash: tokenHash(joinCodes[l.seat]) }));
  const seatRecords = () => {
    const out = [];
    for (const list of match.protocolReports) for (const rep of list) out.push(publicReport(rep));
    return out;
  };
  const watchUrl = (req) => {
    if (relayPub && relayPub.watchUrl) return relayPub.watchUrl;
    const named = (req && req.headers && req.headers.host) || `${host}:${port}`;
    return `http://${named}/`;
  };
  const seatFlags = () => ({ match: match.matchNo, paused: !!match.paused, over: !!match.over, waiting: match.phase !== 'live' });
  const pushSeatAuth = () => { if (relayPub) relayPub.send({ t: 'seat-auth', seats: seatAuthList() }); };
  const runOrders = (seat, lines, reportId) => {
    const side = sideOf(seat);
    const receivedAt = Date.now();
    let decideMs = null;
    let reportRec = null;
    if (reportId != null) {
      const id = +reportId;
      if (Number.isFinite(id)) {
        reportRec = match.reportRecord(side, id);
        const sentAt = reportRec && typeof reportRec.sentAt === 'number' ? reportRec.sentAt : null;
        if (sentAt != null) decideMs = Math.max(0, receivedAt - sentAt);
      }
    }
    const withRtt = (line) => {
      if (reportId == null) return line;
      if (decideMs == null) return `${line} rtt_ms=?`;
      return `${line} rtt_ms=${decideMs}`;
    };
    const out = match.applyProtocolOrders(side, lines, { decideMs });
    const results = Array.isArray(out.results) ? out.results : [];
    // One sample per post. Skip READY/COUNTDOWN (opening arm) and all-ERR posts (late re-posts).
    const liveReport = reportRec && reportRec.event !== 'READY' && reportRec.event !== 'COUNTDOWN';
    const scored = results.some(r => String(r).startsWith('OK'));
    if (!match.over && liveReport && scored && decideMs != null) match.noteDecide(side, decideMs, receivedAt);
    if (out.error) {
      const errResults = results.length ? results : [`ERR ${out.error}`];
      for (const line of errResults) writeProtocol('IN', match.matchNo, seat, withRtt(line));
      return { status: out.error === 'match over' ? 200 : 400, body: { ok: false, seat, side, error: out.error, results: errResults } };
    }
    for (const result of results) writeProtocol('IN', match.matchNo, seat, withRtt(result));
    return {
      status: 200,
      body: {
        ok: results.every(r => r.startsWith('OK')), seat, side, results,
        version: out.version, line: out.line, event: out.event, t: out.t, id: out.id, match: out.match,
      },
    };
  };
  if (relayPub) {
    relayBridge = { report(rep) { relayPub.send({ t: 'seat-report', d: publicReport(rep) }); } };
    const syncSeats = () => {
      const flags = seatFlags();
      sentFlags = flags;
      relayPub.send({ t: 'seat-sync', seats: seatAuthList(), reports: seatRecords(), ...flags });
    };
    relayPub.onOpen = syncSeats;
    relayPub.onMessage = (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'viewers') {
        match.setRelayViewers(msg.n);
        return;
      }
      if (msg.t === 'seat-wait') {
        const side = sideOf(msg.seat);
        if (side < 0 || side !== msg.side) return;
        match.setRelayPolls(side, msg.n);
        return;
      }
      if (pvpOn && (msg.t === 'pvp-guest-ready' || msg.t === 'pvp-cancel')) {
        if (!pvp || msg.matchId !== pvp.matchId) return;
        if (msg.t === 'pvp-guest-ready' && pvp.state === 'waiting-guest') pvpStart();
        else if (msg.t === 'pvp-cancel' && pvp.state === 'waiting-guest') pvpFinish('abort', { reason: msg.reason === 'expired' ? 'expired' : 'cancelled' });
        else if (msg.t === 'pvp-cancel') console.log(`[grokbotwar] pvp ${pvp.matchId}: cancel ignored, the match has started and plays to the end`);
        return;
      }
      if (msg.t === 'seat-opening') {
        const seat = typeof msg.seat === 'string' ? msg.seat : '';
        const side = sideOf(seat);
        const result = side < 0 || side !== msg.side ? { status: 400, body: { ok: false, error: 'bad seat' } } : runOpening(seat, msg.opening);
        relayPub.send({ t: 'seat-opening-result', req: msg.req, status: result.status, body: result.body });
        return;
      }
      if (msg.t !== 'seat-orders') return;
      const seat = typeof msg.seat === 'string' ? msg.seat : '';
      const side = sideOf(seat);
      if (side < 0 || side !== msg.side) {
        relayPub.send({ t: 'seat-orders-result', req: msg.req, status: 400, body: { ok: false, error: 'bad seat', results: [] } });
        return;
      }
      const lines = Array.isArray(msg.lines) ? msg.lines.map(String) : [];
      const reportId = msg.reportId != null && msg.reportId !== '' ? msg.reportId : null;
      const result = runOrders(seat, lines, reportId);
      relayPub.send({ t: 'seat-orders-result', req: msg.req, status: result.status, body: result.body });
    };
    relayPub.onClose = () => { match.setRelayPolls(0, 0); match.setRelayPolls(1, 0); };
    // A pre-T0 reboot dropped a stale READY: replace the relay's seat cache so a remote poll never reads it.
    match.on('protocolReset', () => { if (relayPub.connected) syncSeats(); });
    if (relayPub.connected) syncSeats();
    match.on('state', () => {
      const next = seatFlags();
      if (sentFlags && sentFlags.match === next.match && sentFlags.paused === next.paused && sentFlags.over === next.over && sentFlags.waiting === next.waiting) return;
      sentFlags = next;
      relayPub.send({ t: 'seat-flags', ...next });
    });
  }
  const waitForReport = (side, sinceId, ms, req) => new Promise(resolve => {
    let settled = false;
    const newer = () => (match.protocolReports[side] || []).some(r => r.id > sinceId);
    const finish = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      match.off('protocol', onRep);
      match.off('state', onState);
      req.off('close', onClose);
      resolve(why);
    };
    const onRep = (rep) => { if (rep && rep.side === side && rep.id > sinceId) finish('fresh'); };
    const onState = () => {
      if (newer()) finish('fresh');
      else if (match.reportStop()) finish('stop');
    };
    const onClose = () => finish('closed');
    const timer = setTimeout(() => finish(newer() ? 'fresh' : 'timeout'), ms);
    match.on('protocol', onRep);
    match.on('state', onState);
    req.on('close', onClose);
    if (newer()) finish('fresh');
    else if (match.reportStop()) finish('stop');
  });
  const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const seatFrom = (req, body) => {
    const h = (req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i);
    const tok = (body && body.join_token) || (h && h[1]);
    return tok ? seatByToken.get(tok) || null : null;
  };
  const rotateToken = seat => {
    seatByToken.delete(joinCodes[seat]);
    const tok = 'rw_' + crypto.randomBytes(12).toString('hex');
    joinCodes[seat] = tok; seatByToken.set(tok, seat); saveCodes(); pushSeatAuth(); return tok;
  };
  // ---------- PvP handoff (GBW_PVP=1 only; docs/SPEC.md §5.4 "Match handoff") ----------
  const { MATCH_ID_RE } = require('./availability');
  const pvpView = () => (pvp ? { matchId: pvp.matchId, state: pvp.state, opponent: pvp.opponent, since: new Date(pvp.at).toISOString(), matchNo: pvp.matchNo || null, readyS: PVP_READY_S, armies: { ...pvp.armies } } : null);
  const pvpSend = msg => !!(relayPub && relayPub.send(msg));
  // The standard balanced draft for a PvP side with no opening of its own, with dice seeded from the matchId.
  function pvpDraft(matchId) {
    let h = 2166136261; for (const c of matchId) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    const rng = () => { h = (h + 0x6D2B79F5) >>> 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const arsenal = match.decisions.draftArsenal({ side: 0, style: 'balanced', rng });
    const queue = match.decisions.reinforcementQueue({ side: 0, ours: arsenal, theirs: arsenal, style: 'balanced', rng });
    return { arsenal, queue: (queue || []).slice(0, 6) };
  }
  // POST /api/seat/opening, locally or from the relay seat protocol (seat-opening; the relay already checked the seat token
  // against this room). Same validation and cost rules for every seat. A PvP guest seat: only for its own match, only
  // before START, and never saved to state/ (the seat is gone after the match).
  function runOpening(seat, msg) {
    if (!claims[seat]) return { status: 409, body: { ok: false, error: 'claim this seat with /api/seat/join before posting an opening' } };
    const side = sideOf(seat);
    const pvpSeat = claims[seat].pvp;
    const unstepped = match.elapsed === 0 && match.steps === 0 && !match.over;
    if (pvpSeat) {
      if (!pvp || pvp.matchId !== pvpSeat) return { status: 409, body: { ok: false, error: 'this PvP seat has no open match' } };
      if (!unstepped) return { status: 409, body: { ok: false, error: `PvP match ${pvp.matchId} has started: an opening applies before START only` } };
    }
    const opening = validateOpening(msg || {});
    if (opening.error) return { status: 400, body: { ok: false, error: opening.error } };
    const appliesFrom = match.setOpening(side, opening);
    const own = { arsenal: opening.arsenal, queue: opening.queue, spend: opening.spend };
    if (!pvpSeat) { openings[seat] = own; saveOpenings(); }
    if (pvp) {
      // a host opening posted during a PvP match is its own for later matches too (the end puts prevOrders back)
      if (!pvpSeat && side === 0) pvp.prevOrders[0] = { arsenal: { ...own.arsenal }, queue: own.queue.slice(), spend: own.spend };
      if (appliesFrom === 'this match') pvp.armies[side === 0 ? 'green' : 'ember'] = side === 0 ? 'host opening' : 'guest opening';
      // the reboot puts an awaiting-viewer match back to waiting; a started PvP match does not wait for a watcher
      if (pvp.state === 'live' && match.phase === 'waiting' && !match.paused) match._beginCountdown();
    }
    console.log(`[grokbotwar] seat ${seat} opening (${appliesFrom}) spend=${opening.spend}${pvpSeat ? ` pvp ${pvpSeat}` : ''}`);
    return { status: 200, body: { ok: true, seat, driver: match.drivers[side], arsenal: opening.arsenal, queue: opening.queue, spend: opening.spend, appliesFrom } };
  }
  function pvpHost(seat, msg) {
    const matchId = typeof msg.matchId === 'string' ? msg.matchId.trim() : '';
    if (!MATCH_ID_RE.test(matchId)) return { status: 400, body: { ok: false, error: 'matchId must be 1 to 64 characters of A-Z a-z 0-9 . _ : -' } };
    if (pvp) return pvp.matchId === matchId ? { status: 200, body: { ok: true, again: true, ...pvpView() } } : { status: 409, body: { ok: false, error: `already hosting PvP match ${pvp.matchId}` } };
    if (!relayPub || !relayPub.connected) return { status: 503, body: { ok: false, error: 'this arena is not connected to the relay (the guest plays through it)' } };
    const em = seats[1];
    if (claims[em]) return { status: 409, body: { ok: false, error: `the ${em} seat is already claimed on this arena` } };
    const res = match.availability.reserve(match, matchId, PVP_READY_S + 30);
    if (!res.ok) {
      // the relay hears it on our own socket, so the guest learns at once (host went busy between pairing and reserve)
      pvpSend({ t: 'pvp-abort', matchId, reason: /busy/.test(res.error) ? 'host_busy' : 'host_reserved' });
      console.log(`[grokbotwar] pvp host refused for ${matchId}: ${res.error}`);
      const { status, ...body } = res;
      return { status, body };
    }
    const name = cleanName(msg.opponent) || 'PVP GUEST';
    const wasPaused = match.paused;
    match.paused = true;   // hold here: nothing starts until the guest is ready (solo starts are refused meanwhile)
    claims[em] = { claimedAt: new Date().toISOString(), name, pvp: matchId }; saveClaims();
    identities[em] = name;
    const tok = rotateToken(em);   // also pushes the new seat hashes to the relay (seat-auth)
    match.setDriver(1, 'warrior');
    match.emberTakeoverS = pvpTakeoverS;
    // Each player brings its own opening. The host keeps its own; Ember starts on the standard balanced
    // draft (dice seeded from the matchId; the match rng is not touched) until the guest posts its own opening through the
    // relay seat protocol (POST /r/<room>/seat/opening -> runOpening). A host with no opening gets the same draft.
    // Both are put back at the end, abort or timeout.
    const prevOrders = [match.warriorOrders[0] || null, match.warriorOrders[1] || null];
    const hasOwn = !!(prevOrders[0] && prevOrders[0].arsenal && Object.values(prevOrders[0].arsenal).some(n => n > 0));
    const draft = pvpDraft(matchId);
    if (!hasOwn) match.warriorOrders[0] = { arsenal: { ...draft.arsenal }, queue: draft.queue.slice(), spend: false };
    match.warriorOrders[1] = { arsenal: { ...draft.arsenal }, queue: draft.queue.slice(), spend: false };
    applyNames();
    match.rearm();
    match._emit();
    pvp = { matchId, opponent: name, state: 'waiting-guest', at: Date.now(), wasPaused, matchNo: null, by: seat, prevOrders, armies: { green: hasOwn ? 'host opening' : 'balanced draft', ember: 'balanced draft' } };
    pvp.readyTimer = setTimeout(() => { if (pvp && pvp.matchId === matchId && pvp.state === 'waiting-guest') pvpFinish('abort', { reason: 'guest_timeout' }); }, PVP_READY_S * 1000);
    if (pvp.readyTimer.unref) pvp.readyTimer.unref();
    pvpSend({ t: 'pvp-seat', matchId, seat: em, token: tok, readyS: PVP_READY_S });
    console.log(`[grokbotwar] pvp hosting ${matchId}: ${em} seat opened for ${JSON.stringify(name)} (guest has ${PVP_READY_S} s to say ready)`);
    return { status: 200, body: { ok: true, ...pvpView(), ember: { seat: em, name, base: baseOf(em) } } };
  }
  function pvpStart() {
    clearTimeout(pvp.readyTimer);
    pvp.state = 'live';
    match.resume();   // over -> the next match boots with Ember seated; held before T0 -> this match
    if (match.phase === 'waiting') match._beginCountdown();   // PvP does not wait for a watcher
    pvp.matchNo = match.matchNo;
    pvpSend({ t: 'pvp-started', matchId: pvp.matchId, matchNo: pvp.matchNo });
    console.log(`[grokbotwar] pvp ${pvp.matchId} started: match ${pvp.matchNo}, ${seats[0]} vs ${JSON.stringify(pvp.opponent)}`);
  }
  // end, abort or timeout: release the reservation, give Ember back to the built-in commander, back to free and solo
  function pvpFinish(kind, extra = {}) {
    if (!pvp) return;
    const p = pvp; pvp = null;
    clearTimeout(p.readyTimer);
    match.availability.release(match, p.matchId);
    const em = seats[1];
    if (claims[em] && claims[em].pvp === p.matchId) { delete claims[em]; delete identities[em]; saveClaims(); }
    rotateToken(em);
    match.setDriver(1, 'simulated');
    match.emberTakeoverS = takeoverS;
    match.takeover[1] = false;
    match.warriorOrders[0] = p.prevOrders[0]; match.warriorOrders[1] = p.prevOrders[1];
    applyNames();
    if (kind !== 'end') { match.rearm(); match.paused = p.wasPaused; }
    match._emit();
    pvpSend(kind === 'end' ? { t: 'pvp-end', matchId: p.matchId, matchNo: p.matchNo, ...extra } : { t: 'pvp-abort', matchId: p.matchId, reason: extra.reason || 'aborted' });
    console.log(`[grokbotwar] pvp ${p.matchId} ${kind === 'end' ? 'over' : `aborted (${extra.reason || 'aborted'})`}: reservation released, ${em} back to the built-in commander`);
  }
  const pvpHolds = () => !!(pvp && pvp.state === 'waiting-guest');
  const pvpRefuse = res => sendJson(res, 409, { ok: false, error: `reserved for PvP match ${pvp.matchId}: waiting for the guest (solo starts are refused until it starts or is called off)`, availability: match.availability.view(match), pvp: pvpView() });
  const openSeats = () => labels.filter(l => claimable(l.seat) && !claims[l.seat]).map(l => ({ seat: l.seat, color: l.color, style: match.plans[l.index], player: !!seatCfg(l.seat).player }));
  const notThisGame = (res) => sendJson(res, 409, {
    ok: false,
    error: 'this arena is the 2-player AgRTS match. A seated warrior sends the opening and deploy orders (docs/TEAM-DECISIONS.md, src/agrts/team-decisions.js). Unit scripts are not used.',
    doc: '/docs/TEAM-DECISIONS.md',
  });
  const nextInfo = () => match.over
    ? (match.paused ? { held: true, nextMatch: match.matchNo + 1, how: 'held: the next match starts on resume (warrior-seat.js fight)' } : { held: false, how: 'match over' })
    : { held: false, current: match.matchNo, status: match.over ? 'over' : 'running', tick: match.steps, paused: match.paused, holdAfterMatch: match.holdNext };
  const statusFor = seat => {
    const side = sideOf(seat);
    const st = match.publicState();
    const sd = st.sides[side];
    return {
      ok: true, seat, name: displayName(seat), mode: 'agrts', tick: st.tick, tickMs: 50, paused: st.paused,
      held: st.held, status: st.status, elapsed: st.elapsed, clock: st.clock,
      driver: match.drivers[side],
      plan: sd.plan, nextPlan: match.styleOverride[side] || null,
      baseHp: sd.hp, field: sd.field, reserve: sd.reserve, bank: sd.bank, land: sd.land, next: sd.next,
      posture: sd.posture, decision: { title: sd.decision, detail: sd.explain },
      queue: match.queue[side], reinf: match.reinf[side], hooks: st.hooks,
      pauseAfterMatch: match.pauseAfterMatch, holdAfterMatch: match.holdNext,
    };
  };

  let stopping = false;
  function shutdown(why) {
    if (stopping) return; stopping = true;
    console.log(`[grokbotwar] ${why}, shutting down`);
    try { match.stop(); } catch {}
    for (const c of clients) { try { c.end(); } catch {} }
    try { if (relayPub) relayPub.stop(); } catch {}
    try { server.close(); } catch {}
    const pidFile = path.join(root, 'logs', 'server.pid');
    try { if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) fs.rmSync(pidFile, { force: true }); } catch {}
    setTimeout(() => process.exit(0), 300);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`retry: 1000\ndata: ${lastJson}\n\n`);
        clients.add(res);
        match.setLocalViewers(clients.size);
        const ka = setInterval(() => res.write(': ka\n\n'), 15000);
        req.on('close', () => { clearInterval(ka); clients.delete(res); match.setLocalViewers(clients.size); });
        return;
      }
      if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (p === '/healthz') {
        return sendJson(res, 200, {
          ok: true, mode: 'agrts', match: match.matchNo, tick: match.steps, status: match.over ? 'over' : 'running', paused: match.paused,
          clients: clients.size,
          // Locked unit table (docs/SPEC.md §5.4): sha256 of the table in play and whether it is the official one.
          units: U.lockStatus(),
          // Version stamp (version.js, docs/SPEC.md §5.4 "Version stamp"): { game, protocol, unitsHash, official }.
          version: V.stamp(U.lockStatus()),
          // Remote Ember seat (docs/SPEC.md §5.4): only with GBW_TWO_SEATS=1, so a one-seat arena keeps its old healthz.
          ...(twoSeats ? { twoSeats: { on: true, ember: match.drivers[1], takeover: match.takeover[1], takeoverS } } : {}),
          // Availability (availability.js, docs/SPEC.md §5.4 "Availability"): { state: free|busy|reserved, since, matchId? }.
          availability: match.availability.view(match),
          // PvP handoff (GBW_PVP=1 only, so an arena without it keeps its old healthz)
          ...(pvpOn ? { pvp: pvpView() || { state: 'idle' } } : {}),
          relay: relayPub ? { state: relayPub.state, source: relayPub.source, room: relayPub.room, connected: relayPub.connected, paused: relayPub.paused, error: relayPub.error || undefined, sent: relayPub.stats.sent, silentS: relayPub.silentMs == null ? undefined : Math.round(relayPub.silentMs / 1000), reconnects: Math.max(0, (relayPub.stats.connects || 0) - 1), watch: relayPub.watchUrl } : undefined,
        });
      }
      if (p === '/api/state') return sendJson(res, 200, match.publicState());
      if (p === '/api/agrts/hooks') return sendJson(res, 200, { ok: true, ...describeHooks(), active: match.decisions.id, drivers: match.drivers.slice(), seats: labels.map(l => ({ seat: l.seat, side: l.index, driver: match.drivers[l.index] })) });
      if (p === '/api/control' && req.method === 'POST') {
        const msg = await readBody(req, 1e4);
        if (pvpHolds() && ['resume', 'restart', 'step'].includes(msg.action)) return pvpRefuse(res);
        switch (msg.action) {
          case 'pause': match.pause(); break;
          case 'resume': match.resume(); break;
          case 'restart': match.restart(); break;
          case 'step': match.paused = false; match.update(0.05); match.paused = true; match._emit(); break;
          default: return sendJson(res, 400, { error: 'unknown action' });
        }
        return sendJson(res, 200, { ok: true, paused: match.paused, status: match.over ? 'over' : 'running', match: match.matchNo });
      }
      if (p === '/api/seat/open') return sendJson(res, 200, { ok: true, open: openSeats(), claimed: Object.keys(claims).filter(s => seats.includes(s)), mode: 'agrts', join: 'POST /api/seat/join {seat?, name?} from this computer' });
      if (p === '/api/seat/join' && req.method === 'POST') {
        if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'seats can only be claimed from the computer the arena runs on' });
        const msg = await readBody(req, 1e4);
        const open = openSeats();
        // {side: "ember"|1} names the second seat (warrior-seat.js join --side ember); it is open only with GBW_TWO_SEATS=1.
        const sideAsk = msg.side == null || msg.side === '' ? null : String(msg.side).toLowerCase();
        const sideIdx = sideAsk == null ? -1 : (sideAsk === '1' || sideAsk === 'ember' || sideAsk === String(seats[1]).toLowerCase()) ? 1 : (sideAsk === '0' || sideAsk === 'green' || sideAsk === String(seats[0]).toLowerCase()) ? 0 : -2;
        if (sideIdx === -2) return sendJson(res, 400, { ok: false, error: 'side must be green or ember' });
        const askSeat = msg.seat ? String(msg.seat) : sideIdx >= 0 ? seats[sideIdx] : null;
        const want = askSeat ? open.find(o => o.seat === askSeat) : (open.find(o => seatCfg(o.seat).player) || open[0]);
        if (!want) return sendJson(res, 409, { ok: false, error: askSeat ? `seat "${askSeat}" is not open${sideOf(askSeat) === 1 && !twoSeats ? ' (this arena runs one seat: Ember is the built-in commander)' : ''}` : 'no open seat in this arena', open: open.map(o => o.seat) });
        const tok = rotateToken(want.seat);
        const name = cleanName(msg.name);
        claims[want.seat] = { claimedAt: new Date().toISOString(), name, ...(cleanBase(msg.base) ? { base: cleanBase(msg.base) } : {}) }; saveClaims();
        identities[want.seat] = name || '';
        if (!name) delete identities[want.seat];
        const side = sideOf(want.seat);
        match.setDriver(side, 'warrior');
        applyNames();
        match._emit();
        console.log(`[grokbotwar] seat ${want.seat} claimed${name ? ' by ' + JSON.stringify(name) : ''} (warrior decisions, new join token issued)`);
        return sendJson(res, 200, {
          ok: true, seat: want.seat, name: displayName(want.seat), base: baseOf(want.seat), join_token: tok, color: labels[side].color,
          style: match.plans[side], driver: 'warrior', mode: 'agrts',
          appliesFrom: 'deploy holds until a decision; opening applies on the next match',
          apiDoc: '/docs/TEAM-DECISIONS.md',
          note: 'keep join_token private: store it in a file, never in chat or memory text. Post an opening and decisions; Ember stays simulated.',
        });
      }
      // Rename a claimed seat to the bot's label without dropping the claim, the opening or the token.
      // {label} sets the name to the label and the base to "<LABEL>-01"; {name, base} set either one.
      if (p === '/api/seat/label' && req.method === 'POST') {
        const msg = await readBody(req, 1e4);
        const seat = seatFrom(req, msg);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        if (!claims[seat]) return sendJson(res, 409, { ok: false, error: 'this seat was not claimed with /api/seat/join' });
        const name = cleanName(msg.label != null ? msg.label : msg.name);
        if (!name && msg.base == null) return sendJson(res, 400, { ok: false, error: 'send {label} (or {name} and/or {base})' });
        if (name) { claims[seat].name = name; identities[seat] = name; }
        if (msg.base != null) { const b = cleanBase(msg.base); if (b) claims[seat].base = b; else delete claims[seat].base; }
        else if (name) delete claims[seat].base;
        saveClaims();
        applyNames();
        match._emit();
        console.log(`[grokbotwar] seat ${seat} renamed to ${JSON.stringify(displayName(seat))}, base ${baseOf(seat)}`);
        return sendJson(res, 200, { ok: true, seat, name: displayName(seat), base: baseOf(seat) });
      }
      if (p === '/api/seat/leave' && req.method === 'POST') {
        const msg = await readBody(req, 1e4);
        const seat = seatFrom(req, msg);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        if (!claims[seat]) return sendJson(res, 409, { ok: false, error: 'this seat was not claimed with /api/seat/join' });
        rotateToken(seat); delete claims[seat]; delete identities[seat]; saveClaims();
        match.setDriver(sideOf(seat), 'simulated');
        applyNames();
        match._emit();
        console.log(`[grokbotwar] seat ${seat} released (simulated brain restored, token revoked)`);
        return sendJson(res, 200, { ok: true, seat, released: true });
      }
      if (p === '/api/seat/info') {
        const seat = seatFrom(req, null);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token (Authorization: Bearer <join token>)' });
        const side = sideOf(seat);
        const rep = [...finished.keys()].pop();
        return sendJson(res, 200, {
          ok: true, seat, name: displayName(seat), base: baseOf(seat), mode: 'agrts', pauseAfterMatch: match.pauseAfterMatch, holdAfterMatch: match.holdNext,
          canControl: controlSeat(seat), lastFinished: finished.size ? rep : null, driver: match.drivers[side], style: match.styleOverride[side] || match.plans[side],
          matchStyle: match.plans[side], plans: STYLES, identity: identities[seat] ? { name: identities[seat] } : null,
          match: match.matchNo, tick: match.steps, status: match.over ? 'over' : 'running', paused: match.paused,
          apiDoc: '/docs/TEAM-DECISIONS.md',
          // This match's unit table (units.csv): id for opening/decision, code for BUY/DEPLOY, draft and live prices.
          units: TYPE_IDS.map(k => ({ id: k, code: TYPES[k].code, name: TYPES[k].name, draft: TYPES[k].cost, live: FIELD_COST[k], role: TYPES[k].role })),
          unitsError: match.unitsError || '',
          // Version stamp of this arena and match (docs/SPEC.md §5.4 "Version stamp"); warrior-seat.js info prints it.
          version: V.stamp(match.unitsLock),
          // Availability (docs/SPEC.md §5.4 "Availability"); warrior-seat.js info prints it.
          availability: match.availability.view(match),
          // Remote Ember seat: true while the built-in commander plays this silent seat (GBW_TWO_SEATS=1 only).
          ...(twoSeats || pvp ? { takeover: !!match.takeover[side], takeoverS: side === 1 ? match.emberTakeoverS : 0 } : {}),
          ...(pvp ? { pvp: pvpView() } : {}),
        });
      }
      if (p === '/api/seat/status') {
        const seat = seatFrom(req, null);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        return sendJson(res, 200, statusFor(seat));
      }
      if (p === '/api/seat/roster') {
        const seat = seatFrom(req, null);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        const side = sideOf(seat);
        return sendJson(res, 200, {
          ok: true, seat, mode: 'agrts',
          roster: { plan: match.plans[side], driver: match.drivers[side], arsenal: match.rosters[side], reserve: match.reserve[side], queue: match.queue[side], opening: match.warriorOrders[side] },
          note: match.drivers[side] === 'warrior'
            ? 'Deploy with POST /api/seat/decision. POST /api/seat/opening sets the next arsenal and buy queue (this match if it has not stepped).'
            : 'This side is still simulated. Claim the seat, then post an opening and decisions.',
        });
      }
      if (p === '/api/seat/plan' && req.method === 'POST') {
        const msg = await readBody(req, 1e4);
        const seat = seatFrom(req, msg);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        if (!STYLES.includes(msg.style)) return sendJson(res, 400, { ok: false, error: `style must be one of ${STYLES.join(', ')}` });
        const appliesFrom = match.setStyle(sideOf(seat), msg.style);
        console.log(`[grokbotwar] seat ${seat} plan ${normalizeStyle(msg.style)} (${appliesFrom})`);
        return sendJson(res, 200, { ok: true, seat, style: normalizeStyle(msg.style), appliesFrom, driver: match.drivers[sideOf(seat)], plans: STYLES });
      }
      if (p === '/api/seat/opening' && req.method === 'POST') {
        const msg = await readBody(req, 1e4);
        const seat = seatFrom(req, msg);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        const out = runOpening(seat, msg);
        return sendJson(res, out.status, out.body);
      }
      if (p === '/api/seat/decision' && req.method === 'POST') {
        const msg = await readBody(req, 1e4);
        const seat = seatFrom(req, msg);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        const side = sideOf(seat);
        if (msg.hold === true) {
          if (!match.pushDecision(side, { hold: true, title: msg.title, detail: msg.detail })) return sendJson(res, 429, { ok: false, error: 'decision queue is full (8)' });
          return sendJson(res, 202, { ok: true, seat, hold: true, driver: match.drivers[side], note: match.drivers[side] === 'warrior' ? 'consumed on the next sim step, including a decision posted while the match is held. A seated warrior holds when the queue is empty.' : 'consumed on the next sim step, ahead of the simulated brain. A decision posted while the match is held is kept.' });
        }
        const types = Array.isArray(msg.types) ? msg.types.map(String) : (msg.deploy ? [String(msg.deploy)] : []);
        if (!types.length || types.some(t => !TYPE_IDS.includes(t))) return sendJson(res, 400, { ok: false, error: `types must be 1 to 3 of ${TYPE_IDS.join(', ')}, or {hold:true}` });
        if (types.length > 3) return sendJson(res, 400, { ok: false, error: 'at most 3 units in a wave' });
        if (!match.pushDecision(side, { types, guard: msg.guard === true, medicUrgent: msg.medicUrgent === true, title: msg.title, detail: msg.detail })) return sendJson(res, 429, { ok: false, error: 'decision queue is full (8)' });
        const warrior = match.drivers[side] === 'warrior';
        return sendJson(res, 202, { ok: true, seat, types, driver: match.drivers[side], note: warrior ? 'consumed on the next sim step if those units are in reserve, including a decision posted while the match is held. Otherwise this side holds.' : 'consumed on the next sim step if those units are still in reserve, including after a restart; otherwise the simulated brain runs' });
      }
      if (p === '/api/seat/orders' && req.method === 'POST') {
        const raw = await readRaw(req, 8000);
        const text = (req.headers['content-type'] || '').includes('text/plain');
        let msg = null, lines;
        if (text) lines = raw.split(/\r?\n/);
        else {
          try { msg = JSON.parse(raw || '{}'); }
          catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
          if (Array.isArray(msg.lines)) lines = msg.lines.map(String);
          else if (typeof msg.line === 'string') lines = msg.line.split(/\r?\n/);
          else lines = [];
        }
        const seat = seatFrom(req, msg);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        const reportId = !text && msg && msg.reportId != null && msg.reportId !== '' ? msg.reportId : null;
        const result = runOrders(seat, lines, reportId);
        if (text) {
          const plain = result.body.error ? `ERR ${result.body.error}\n` : result.body.results.join('\n') + '\n';
          res.writeHead(result.status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(plain);
        }
        return sendJson(res, result.status, result.body);
      }
      if (p === '/api/seat/report') {
        const seat = seatFrom(req, null);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        // ?match=N stays the finished-match report so `warrior-seat.js wait` keeps working.
        if (!url.searchParams.has('match')) {
          const side = sideOf(seat);
          match.beginReportWait(side);
          try {
            const sinceRaw = url.searchParams.get('since');
            if (sinceRaw != null && sinceRaw !== '' && !Number.isFinite(+sinceRaw)) return sendJson(res, 400, { ok: false, error: 'since must be a report id' });
            const since = sinceRaw != null && sinceRaw !== '' ? +sinceRaw : null;
            let why = 'latest';
            if (since != null) {
              const asked = url.searchParams.has('wait') ? +url.searchParams.get('wait') : 30;
              const waitS = Math.max(0, Math.min(30, Number.isFinite(asked) ? asked : 30));
              const cur = (match.protocolReports[side] || [])[(match.protocolReports[side] || []).length - 1];
              if (cur && cur.id > since) why = 'fresh';
              else if (match.reportStop()) why = 'stop';
              else if (waitS > 0) why = await waitForReport(side, since, waitS * 1000, req);
              else why = 'timeout';
            }
            if (why === 'closed' || res.writableEnded) return;
            const body = protocolPayload(side, why);
            if (url.searchParams.get('format') === 'text') {
              const text = body.fresh && body.line ? body.line : (body.timeout ? 'timeout' : (body.stop ? 'no-match' : (body.line || '')));
              res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
              return res.end(text + '\n');
            }
            return sendJson(res, 200, body);
          } finally {
            match.endReportWait(side);
          }
        }
        let rec;
        if (url.searchParams.has('match')) {
          const n = +url.searchParams.get('match');
          const f = finished.get(n);
          if (!f) return sendJson(res, 404, { ok: false, match: n, current: match.matchNo, status: match.over ? 'over' : 'running', error: n > match.matchNo ? 'that match has not started' : n === match.matchNo && !match.over ? 'match still running' : 'no report for that match in this arena run' });
          rec = f;
        } else {
          const n = [...finished.keys()].pop();
          if (n == null) return sendJson(res, 404, { ok: false, error: 'no finished match yet' });
          rec = finished.get(n);
        }
        const file = path.join(MATCH_DIR, rec.id, 'teams', `${seat}.json`);
        if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: 'match over but its report was not recorded' });
        if (url.searchParams.get('format') === 'text') {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(fs.readFileSync(file.replace(/\.json$/, '.txt')));
        }
        const body = JSON.parse(fs.readFileSync(file, 'utf8'));
        return sendJson(res, 200, { ...body, next: nextInfo() });
      }
      if ((p === '/api/seat/pause' || p === '/api/seat/resume' || p === '/api/seat/stop') && req.method === 'POST') {
        const msg = await readBody(req, 1e4);
        const seat = seatFrom(req, msg);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'pause/resume/stop only work from the computer the arena runs on' });
        if (!controlSeat(seat)) return sendJson(res, 403, { ok: false, seat, error: 'only the solo player seat (or a seat marked "control": true) may pause, resume or stop this arena' });
        if (p === '/api/seat/stop') {
          console.log(`[grokbotwar] seat ${seat} stopped the arena`);
          sendJson(res, 200, { ok: true, seat, stopping: true, pid: process.pid, match: match.matchNo, status: match.over ? 'over' : 'running', note: !match.over && match.steps > 0 ? 'the match in progress was not finished (no report for it)' : undefined });
          return shutdown('stop requested by seat ' + seat);
        }
        if (p === '/api/seat/resume') {
          if (pvpHolds()) return pvpRefuse(res);
          const was = match.paused || match.over;
          match.resume();
          console.log(`[grokbotwar] seat ${seat} resume${was ? '' : ' (was not paused)'}`);
          const waiting = match.phase === 'waiting' || match.phase === 'countdown';
          return sendJson(res, 200, {
            ok: true, seat, started: was, match: match.matchNo, status: match.over ? 'over' : 'running',
            paused: match.paused, phase: match.phase, waiting, countdown: match.countdown,
            watch: watchUrl(req), pauseAfterMatch: match.pauseAfterMatch,
          });
        }
        if (msg.every !== undefined) match.pauseAfterMatch = msg.every === true || msg.every === 'on' || msg.every === 1;
        let did = null;
        if (msg.now === true) { match.pause(); did = 'now'; }
        else if (msg.every === undefined || msg.every === true || msg.every === 'on' || msg.every === 1) {
          if (match.over) { match.pause(); did = 'now'; } else { match.holdNext = true; did = 'after-match'; }
        }
        match._emit();
        console.log(`[grokbotwar] seat ${seat} pause ${did || ''}`);
        return sendJson(res, 200, {
          ok: true, seat, pause: did, match: match.matchNo, status: match.over ? 'over' : 'running', tick: match.steps, paused: match.paused,
          holdAfterMatch: match.holdNext, pauseAfterMatch: match.pauseAfterMatch,
          note: match.over && match.paused ? 'held between matches: the next match starts on resume (warrior-seat.js fight)'
            : did === 'now' ? 'arena frozen mid-match; resume (warrior-seat.js fight) continues it'
            : did === 'after-match' ? `match ${match.matchNo} plays to the end, then the arena waits for resume (warrior-seat.js fight)` : undefined,
        });
      }
      // PvP reservation (availability.js, docs/SPEC.md §5.4 "Availability", PvP step 3). Inert for now: nothing calls it.
      // Guarded like pause/resume/stop: from this computer only, with the join token of the solo player seat (or a
      // seat marked "control": true). It never pauses, stops or blocks a match: solo play works exactly as today.
      if ((p === '/api/pvp/reserve' || p === '/api/pvp/release') && req.method === 'POST') {
        const msg = await readBody(req, 1e4);
        const seat = seatFrom(req, msg);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'reserve/release only work from the computer the arena runs on' });
        if (!controlSeat(seat)) return sendJson(res, 403, { ok: false, seat, error: 'only the solo player seat (or a seat marked "control": true) may reserve or release this arena' });
        const out = p === '/api/pvp/reserve' ? match.availability.reserve(match, msg.matchId, msg.ttlS) : match.availability.release(match, msg.matchId);
        if (out.ok && (out.reserved && !out.again || out.released)) console.log(`[grokbotwar] pvp ${out.reserved ? `reserved for ${out.matchId} (${out.ttlS} s)` : `reservation ${out.matchId} released`} by seat ${seat}`);
        const { status, ...body } = out;
        return sendJson(res, status, body);
      }
      if (p === '/api/pvp/prove' || p === '/api/pvp/host' || p === '/api/pvp/status') {
        if (!pvpOn) return sendJson(res, 404, { ok: false, error: 'PvP hosting is off on this arena (the person running it sets GBW_PVP=1)' });
        const msg = req.method === 'POST' ? await readBody(req, 1e4) : null;
        const seat = seatFrom(req, msg);
        if (!seat) return sendJson(res, 401, { ok: false, error: 'missing or unknown join token' });
        if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: 'PvP hosting only works from the computer the arena runs on' });
        if (!controlSeat(seat)) return sendJson(res, 403, { ok: false, seat, error: 'only the solo player seat (or a seat marked "control": true) may host PvP' });
        if (p === '/api/pvp/status') return sendJson(res, 200, { ok: true, pvp: pvpView(), availability: match.availability.view(match), room: relayPub ? relayPub.room : null });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST' });
        if (p === '/api/pvp/prove') {
          // room proof: the relay gave our player a nonce; it goes back on the socket only this arena can open for this room
          if (typeof msg.nonce !== 'string' || !/^pf_[0-9a-f]{32}$/.test(msg.nonce)) return sendJson(res, 400, { ok: false, error: 'nonce must be the relay\'s pf_<32 hex>' });
          if (!relayPub || !relayPub.connected) return sendJson(res, 503, { ok: false, error: 'this arena is not connected to the relay' });
          pvpSend({ t: 'pvp-prove', nonce: msg.nonce });
          return sendJson(res, 200, { ok: true, sent: true, room: relayPub.room });
        }
        const out = pvpHost(seat, msg);
        return sendJson(res, out.status, out.body);
      }
      if (['/api/seat/script', '/api/seat/validate', '/api/seat/arsenal', '/api/seat/order', '/api/seat/practice'].includes(p)) return notThisGame(res);
      if (p === '/docs/TEAM-DECISIONS.md' || p === '/docs/AGENTS.md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(root, 'docs', 'TEAM-DECISIONS.md')));
      }
      if (p === '/' || p === '/index.html') {
        const ver = f => crypto.createHash('sha1').update(fs.readFileSync(path.join(PUB, f))).digest('hex').slice(0, 10);
        const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/(href|src)="(style\.css|app\.js|draw\.js)"/g, (m, a, f) => `${a}="${f}?v=${ver(f)}"`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' });
        return res.end(html);
      }
      const file = path.normalize(path.join(PUB, p));
      if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(data);
      });
    } catch (e) {
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      console.log(`[grokbotwar] listening on http://${host}:${port} mode=agrts config=${cfgPath || '(defaults)'} seats=${seats.join(',')} hooks=${match.decisions.id} drivers=${match.drivers.join('/')}`);
      { const v = V.stamp(U.lockStatus()); console.log(`[grokbotwar] version ${v.game} pvp-protocol ${v.protocol} units ${v.unitsHash.slice(0, 12) || 'built-in'} ${v.official === true ? 'official' : v.official === false ? 'NOT official' : 'unchecked'} (git: ${V.BUILD.source})`); }
      match.start();
      for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));
      resolve(server);
    });
  });
}

module.exports = { startAgrtsHost };
