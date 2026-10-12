'use strict';
// Decides which relay room this arena streams to, claims one when needed (SPEC 3 step 4), then runs the publisher.
// Order (first match wins):
//   1. RELAY=off, or RELAY_URL set to "" or "off"          -> no relay
//   2. RELAY_URL + RELAY_KEY + RELAY_ROOM all in the environment -> use them (explicit setup, e.g. tests, own relay)
//   3. secrets/relay.env with RELAY_URL, RELAY_KEY and RELAY_ROOM -> use it (hand-made, or saved by an earlier claim)
//   4. otherwise claim: POST <RELAY_URL or the public relay>/claim, save RELAY_URL, RELAY_ROOM and the room key to
//      secrets/relay.env (mode 600; the key is never printed), then stream. Later starts take path 3.
// A lone RELAY_KEY in the environment (no RELAY_ROOM) is ignored, so a computer that still has the old shared key
// exported never streams a fresh arena into the shared room by accident.
// If a claimed room expired or was released (the relay answers 401 with X-Relay-Room: unclaimed), the arena claims
// a new room and rewrites secrets/relay.env (the watch link changes; it is logged).
// RELAY_INVITE is sent with the claim when the relay needs invite codes (none needed for now).
// RELAY_PAUSE_RETRY_MS: retry interval while the relay admin has us switched off (default 60000; lowered by tests).
const fs = require('fs');
const path = require('path');
const { startRelayPublisher } = require('./relay-publisher');

const PUBLIC_RELAY = 'https://gbw.srv826418.hstgr.cloud';
const ROOM_RE = /^[A-Za-z0-9_-]{3,64}$/;

function parseEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2]; if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
function writeRelayEnv(file, { url, room, key }) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `# GrokBotWar relay room, claimed automatically ${new Date().toISOString()}. Secret: never share or print this file.\n` +
    `RELAY_URL=${url}\nRELAY_ROOM=${room}\nRELAY_KEY=${key}\nRELAY_CLAIMED=1\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

// -> {mode:'off', reason} | {mode:'use', source, url, key, room, claimed} | {mode:'claim', url, why}
function resolveRelay({ env = process.env, root }) {
  const file = path.join(root, 'secrets', 'relay.env');
  if (/^(off|0|false|no)$/i.test(env.RELAY || '')) return { mode: 'off', reason: 'RELAY=off' };
  if (env.RELAY_URL !== undefined && /^(|off)$/i.test(env.RELAY_URL.trim())) return { mode: 'off', reason: 'RELAY_URL is empty/off' };
  if (env.RELAY_URL && env.RELAY_KEY && env.RELAY_ROOM) return { mode: 'use', source: 'environment', url: env.RELAY_URL, key: env.RELAY_KEY, room: env.RELAY_ROOM, claimed: false, file };
  let f = null;
  if (fs.existsSync(file)) { try { f = parseEnvFile(file); } catch (e) { f = null; } }
  if (f && /^(off|0|false|no)$/i.test(f.RELAY || '')) return { mode: 'off', reason: 'RELAY=off in secrets/relay.env' };
  if (f && f.RELAY_URL && f.RELAY_KEY && f.RELAY_ROOM) return { mode: 'use', source: 'secrets/relay.env', url: f.RELAY_URL, key: f.RELAY_KEY, room: f.RELAY_ROOM, claimed: f.RELAY_CLAIMED === '1', file };
  const why = f ? 'secrets/relay.env is incomplete' : env.RELAY_KEY && !env.RELAY_ROOM ? 'RELAY_KEY in the environment has no RELAY_ROOM, so it is ignored' : 'no secrets/relay.env yet';
  return { mode: 'claim', url: (f && f.RELAY_URL) || env.RELAY_URL || PUBLIC_RELAY, why, file };
}

function startRelay(referee, { avatars, root, env = process.env, log = (...a) => console.log('[relay-pub]', ...a), pauseRetryMs, claimRetryMs = 15000 } = {}) {
  if (pauseRetryMs === undefined && +env.RELAY_PAUSE_RETRY_MS > 0) pauseRetryMs = +env.RELAY_PAUSE_RETRY_MS;   // test knob (default 60 s)
  const r = resolveRelay({ env, root });
  if (r.mode === 'off') { log(`relay off (${r.reason})`); return null; }
  let pub = null, state = 'starting', room = null, watchUrl = null, source = r.source || 'claimed', claimed = !!r.claimed, base = r.url;
  let stopped = false, timer = null, claimFails = 0, lastReclaim = 0, claimError = null;
  const hooks = { onOpen: null, onMessage: null, onClose: null };
  const watchOf = (u, rm) => u.replace(/\/+$/, '').replace(/^ws/, 'http') + '/w/' + rm;

  function run(url, key, rm) {
    base = url; room = rm; watchUrl = watchOf(url, rm); state = 'ready';
    if (!ROOM_RE.test(rm)) { log('relay room id in the config is invalid; relay off'); state = 'error'; return; }
    pub = startRelayPublisher(referee, { avatars, log, pauseRetryMs, hooks, env: { RELAY_URL: url, RELAY_KEY: key, RELAY_ROOM: rm, RELAY_FULL: env.RELAY_FULL, RELAY_PING_MS: env.RELAY_PING_MS, RELAY_DEAD_MS: env.RELAY_DEAD_MS },
      onUnclaimed: claimed ? reclaim : null });
  }
  function reclaim() {
    // our claimed room is gone on the relay (expired or released): claim a new one, at most once per 10 min
    if (Date.now() - lastReclaim < 10 * 60000) return false;
    lastReclaim = Date.now();
    log('our claimed room is no longer on the relay (expired or released); claiming a new room');
    if (pub) { pub.stop(); pub = null; }
    doClaim(base, r.file);
    return true;
  }
  function later(ms) { if (stopped) return; clearTimeout(timer); timer = setTimeout(() => doClaim(base, r.file), ms); timer.unref && timer.unref(); }
  async function doClaim(url, file) {
    if (stopped) return;
    state = 'claiming'; base = url;
    const httpBase = url.replace(/\/+$/, '').replace(/^ws/, 'http');
    let res, j = null;
    try {
      res = await fetch(httpBase + '/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: 'grokbotwar-arena', ...(env.RELAY_INVITE ? { invite: env.RELAY_INVITE } : {}) }), signal: AbortSignal.timeout(10000) });
      j = await res.json().catch(() => null);
    } catch (e) {
      claimFails++; claimError = 'relay unreachable';
      const wait = Math.min(15 * 60000, claimRetryMs * 2 ** Math.min(claimFails - 1, 6));
      if (claimFails <= 3 || claimFails % 10 === 0) log(`could not reach the relay to claim a room (${e.cause ? e.cause.code || e.cause.message : e.message}); retrying in ${Math.round(wait / 1000)} s`);
      return later(wait);
    }
    if (res.status === 201 && j && j.ok && j.room && j.key) {
      try { writeRelayEnv(file, { url, room: j.room, key: j.key }); }
      catch (e) { log(`claimed room ${j.room} but could not save secrets/relay.env (${e.message}); streaming anyway, a restart will claim again`); }
      claimed = true; source = 'claimed'; claimFails = 0; claimError = null;
      log(`claimed relay room ${j.room} (saved to secrets/relay.env); watch: ${watchOf(url, j.room)}`);
      return run(url, j.key, j.room);
    }
    const err = (j && j.error) || `HTTP ${res.status}`; claimError = err;
    const ra = +(res.headers.get('retry-after') || 0) * 1000;
    if (res.status === 423) { if (claimFails++ === 0) log('the relay is paused for maintenance; will claim a room when it is back'); return later(Math.max(ra, 5 * 60000)); }
    if (res.status === 429 || res.status === 503) { log(`relay refused the claim: ${(j && j.message) || err}`); return later(Math.min(Math.max(ra, 60000), 3600000)); }
    state = 'error';
    log(`relay refused the claim: ${(j && j.message) || err}${err === 'invite_required' ? ' (set RELAY_INVITE)' : ''}; no phone link (set RELAY=off to silence this)`);
  }

  if (r.mode === 'use') { log(`relay config from ${r.source}`); run(r.url, r.key, r.room); }
  else { log(`claiming a relay room from ${r.url} (${r.why})`); doClaim(r.url, r.file); }

  return {
    stop() { stopped = true; clearTimeout(timer); if (pub) pub.stop(); },
    send(obj) { return !!(pub && pub.send && pub.send(obj)); },
    set onOpen(fn) { hooks.onOpen = fn; },
    set onMessage(fn) { hooks.onMessage = fn; },
    set onClose(fn) { hooks.onClose = fn; },
    get connected() { return !!(pub && pub.connected); },
    get paused() { return !!(pub && pub.paused); },
    get stats() { return pub ? pub.stats : { sent: 0, dropped: 0, connects: 0 }; },
    get silentMs() { return pub ? pub.silentMs : null; },
    get watchUrl() { return watchUrl; },
    get state() { return state; },
    get room() { return room; },
    get source() { return source; },
    get claimed() { return claimed; },
    get error() { return claimError; },
  };
}

module.exports = { startRelay, resolveRelay, PUBLIC_RELAY };
