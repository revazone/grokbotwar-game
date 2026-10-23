'use strict';
// Throwaway stack for the strategy card tests and screenshots: a copy of this checkout as the arena (no state/ or secrets/, so it can
// never reach a real relay room or a real seat) plus a private relay, both on 127.0.0.1. Never port 8787.
//   const st = await startStack({ arenaPort: 8799, env: {...} });  st.relayBase, st.arenaBase, st.room, st.okey, st.cli(args), st.stop()
const { spawn, spawnSync, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000, step = 100) => { const t = Date.now() + ms; while (Date.now() < t) { try { if (await fn()) return true; } catch {} await sleep(step); } try { return !!(await fn()); } catch { return false; } };
const freePort = () => new Promise(res => { const s = require('net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// relay: true = private relay (needs relay/, dev repo only); false = arena alone with RELAY=off (public game, no relay/ shipped).
// Default: a relay only when relay/server.js exists.
async function startStack({ arenaPort = 0, env = {}, fight = true, relay: useRelay = fs.existsSync(path.join(ROOT, 'relay', 'server.js')) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbw-strategy-'));
  const arenaDir = path.join(dir, 'arena');
  fs.mkdirSync(arenaDir);
  execSync(`tar --exclude=./matches --exclude=./screenshots --exclude=./shots --exclude=./sim --exclude=./.git --exclude=./state --exclude=./secrets --exclude=./logs --exclude=./node_modules --exclude=./tools/node_modules --exclude=./relay/node_modules --exclude=./relay/state -cf - . | tar -xf - -C ${arenaDir}`, { cwd: ROOT, shell: '/bin/bash' });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(arenaDir, 'node_modules'));
  const procs = new Set();
  const logs = { relay: '', arena: '' };
  const key = crypto.randomBytes(24).toString('hex'), room = 'strategyroom1';
  let relayBase = null;
  if (useRelay) {
  const relayPort = await freePort();
  relayBase = `http://127.0.0.1:${relayPort}`;
  const relay = spawn(process.execPath, ['server.js'], { cwd: path.join(ROOT, 'relay'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, PORT: String(relayPort), HOST: '127.0.0.1', RELAY_PUBLISH_KEY: key, STATE_FILE: path.join(dir, 'relay-state.json'), CLAIMS: 'off' } });
  procs.add(relay); relay.stdout.on('data', d => { logs.relay += d; }); relay.stderr.on('data', d => { logs.relay += d; });
  if (!await until(async () => (await fetch(relayBase + '/healthz')).ok)) throw new Error('relay did not start\n' + logs.relay);
  }
  const port = arenaPort || await freePort();
  if (port === 8787) throw new Error('refusing port 8787');
  const arenaBase = `http://127.0.0.1:${port}`;
  let arena = null;
  const startArena = async () => {
    arena = spawn(process.execPath, ['server.js'], { cwd: arenaDir, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', BOTS_CONFIG: 'bots.agrts.json', WARRIOR_ACTIVE_S: '0', RULES_REMOTE: '0', ...(useRelay ? { RELAY_URL: relayBase, RELAY_KEY: key, RELAY_ROOM: room } : { RELAY: 'off' }), ...env } });
    procs.add(arena); arena.stdout.on('data', d => { logs.arena += d; }); arena.stderr.on('data', d => { logs.arena += d; });
    if (!await until(async () => { const h = await (await fetch(arenaBase + '/healthz')).json(); return useRelay ? h.relay && h.relay.connected : h.ok; }, 15000)) throw new Error('arena did not connect\n' + logs.arena);
  };
  await startArena();
  const cli = (args, extraEnv = {}) => spawnSync(process.execPath, ['tools/warrior-seat.js', ...args], { cwd: arenaDir, encoding: 'utf8', env: { PATH: process.env.PATH, ARENA: arenaBase, ...extraEnv } });
  if (cli(['join', '--name', 'Alpha']).status !== 0) throw new Error('join failed');
  const okey = JSON.parse(cli(['owner-link', '--json']).stdout).key;
  const seatTok = () => JSON.parse(fs.readFileSync(path.join(arenaDir, 'secrets', 'warrior-seat.json'), 'utf8')).join_token;
  if (fight && cli(['fight']).status !== 0) throw new Error('fight failed');
  const stop = () => { for (const p of procs) { try { p.kill('SIGTERM'); } catch {} } };
  // The live setup restarts the arena for every match (match number 1 again, state/ kept). This does the same: stop it, start it, arm a match.
  const restartArena = async (fightArgs = ['fight']) => {
    const old = arena; procs.delete(old);
    await new Promise(res => { old.once('exit', res); try { old.kill('SIGTERM'); } catch { res(); } setTimeout(res, 4000); });
    await sleep(300);
    await startArena();
    if (fight && cli(fightArgs).status !== 0) throw new Error('fight failed after restart');
  };
  return { dir, arenaDir, relayBase, relay: useRelay, arenaBase, room, okey, cli, seatTok, logs, stop, until, sleep, key, restartArena };
}
async function req(method, url, token, body) {
  const r = await fetch(url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { code: r.status, j, text };
}
module.exports = { startStack, req, sleep, until, freePort };
