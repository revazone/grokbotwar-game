#!/usr/bin/env node
'use strict';
// Per-bot arena setup: one checkout, one arena port, one relay room and one Green seat per bot, so several bots can
// share one computer without touching each other's seat, opening or arena. Idempotent: run it again any time.
//   node tools/gbw-setup.js --agent <agent id> [--label L] [--dir D] [--port P] [--no-start] [--json]
// What it does:
//   1. label: the bot's profile title (agents folder, as warrior-seat.js reads it); --label when there is no profile.
//   2. folder: --dir; else this checkout when it is free or already this bot's (the one-bot case: nothing is copied);
//      else a sibling "gbw-<label-slug>" next to this checkout (e.g. /workspace/gbw-little-dog), created with a local
//      git clone of this checkout (origin = this checkout's origin) plus a copy of node_modules.
//      It refuses a folder whose seat file (secrets/warrior-seat.json) belongs to another agent id.
//   3. state/arena.env: keeps what is there; adds PORT (a free port from 8787 up, never one another checkout's
//      arena.env names), GBW_PVP=1 and START_PAUSED=1 when missing.
//   4. starts the arena with that folder's ./start.sh (an arena already running there is left alone). With no
//      secrets/relay.env, the arena claims its own room on the public relay, so the bot gets its own watch link.
//   5. joins the Green seat with --agent (an existing seat of this bot is only relabelled).
//   6. prints the folder, port, arena URL, watch link, name and base. Exit 0 ok, 3 refused, 1 error.
// It never prints a token, never stops or restarts a running arena, and never touches another bot's folder.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
const flag = k => argv.includes('--' + k);
const asJson = flag('json');
const say = m => { if (!asJson) console.log(m); };
const die = (m, code = 1) => { if (asJson) console.log(JSON.stringify({ ok: false, error: m }, null, 1)); else console.error('gbw-setup: ' + m); process.exit(code); };
if (flag('help') || flag('h') || !opt('agent')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 17).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(opt('agent') || flag('help') || flag('h') ? 0 : 1);
}
const BN = require('../src/agrts/base-name');
const agent = String(opt('agent'));
if (!/^[A-Za-z0-9-]{8,64}$/.test(agent)) die('--agent must be the bot\'s agent id');
const prof = BN.readProfile(agent);
const label = String((prof && prof.title) || opt('label') || '').trim();
if (!label) die(`no label: no profile for agent ${agent} in ${BN.AGENTS_DIR}; pass --label "<the bot's label>"`);
const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'bot';

const seatOf = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'secrets', 'warrior-seat.json'), 'utf8')); } catch { return null; } };
const isCheckout = dir => fs.existsSync(path.join(dir, 'server.js')) && fs.existsSync(path.join(dir, 'tools', 'warrior-seat.js'));
const readEnvFile = dir => { try { return fs.readFileSync(path.join(dir, 'state', 'arena.env'), 'utf8'); } catch { return ''; } };
const envGet = (text, k) => { const m = text.match(new RegExp(`^\\s*${k}\\s*=\\s*["']?([^"'\\n]*)["']?\\s*$`, 'm')); return m ? m[1].trim() : null; };
const pidAlive = dir => { try { const pid = +fs.readFileSync(path.join(dir, 'logs', 'server.pid'), 'utf8'); process.kill(pid, 0); return pid; } catch { return 0; } };
const health = async port => { try { const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) }); return r.ok ? await r.json() : null; } catch { return null; } };
const portFree = port => new Promise(res => { const s = net.createServer().once('error', () => res(false)).listen(port, '0.0.0.0', () => s.close(() => res(true))); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // 2. folder
  const owner = s => s && s.agent ? s.agent : null;
  let dir;
  if (opt('dir')) dir = path.resolve(opt('dir'));
  else {
    const here = seatOf(ROOT);
    dir = !here || owner(here) === agent ? ROOT : path.join(path.dirname(ROOT), `gbw-${slug}`);
  }
  const existed = fs.existsSync(dir);
  if (existed) {
    if (!isCheckout(dir)) die(`${dir} exists but is not a GrokBotWar checkout; pass --dir <another folder>`, 3);
    const s = seatOf(dir);
    if (s && owner(s) !== agent) die(`${dir} belongs to ${owner(s) ? 'agent ' + owner(s) : 'a seat with no agent id'} (secrets/warrior-seat.json); not touching it. Pass --dir <another folder>.`, 3);
  } else {
    const origin = spawnSync('git', ['-C', ROOT, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout.trim();
    const cl = spawnSync('git', ['clone', '-q', ROOT, dir], { encoding: 'utf8' });
    if (cl.status !== 0) die(`git clone into ${dir} failed: ${(cl.stderr || '').trim()}`);
    if (origin) spawnSync('git', ['-C', dir, 'remote', 'set-url', 'origin', origin]);
    say(`folder: created ${dir} (a clone of ${ROOT})`);
  }
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    const r = fs.existsSync(path.join(ROOT, 'node_modules')) && dir !== ROOT
      ? spawnSync('cp', ['-a', path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules')])
      : spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir, stdio: asJson ? 'ignore' : 'inherit' });
    if (r.status !== 0) die('could not set up node_modules (cp / npm install failed)');
  }

  // 3. state/arena.env
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  let text = readEnvFile(dir);
  const running = pidAlive(dir);
  let port = +(opt('port') || envGet(text, 'PORT') || 0) || 0;
  if (!port && running) port = 8787;   // an arena started here before arena.env existed runs on start.sh's default
  if (!port) {
    const taken = new Set();
    for (const d of fs.readdirSync(path.dirname(dir)).map(n => path.join(path.dirname(dir), n))) {
      if (d === dir) continue;
      const p = +envGet(readEnvFile(d), 'PORT'); if (p) taken.add(p);
      if (isCheckout(d) && !envGet(readEnvFile(d), 'PORT')) taken.add(8787);   // a checkout without arena.env uses 8787
    }
    const from = +process.env.GBW_SETUP_PORT_FROM || 8787;   // tests start elsewhere
    for (let p = from; p < from + 113 && !port; p++) if (p !== 8798 && !taken.has(p) && await portFree(p)) port = p;
    if (!port) die('no free port from 8787 (113 tried)');
  }
  const add = [];
  if (envGet(text, 'PORT') == null) add.push(`PORT=${port}`);
  else if (opt('port') && +envGet(text, 'PORT') !== port) die(`state/arena.env already says PORT=${envGet(text, 'PORT')}; edit it by hand to move the arena`, 3);
  if (envGet(text, 'GBW_PVP') == null) add.push('GBW_PVP=1');
  if (envGet(text, 'START_PAUSED') == null) add.push('START_PAUSED=1');
  if (add.length) {
    text = (text && !text.endsWith('\n') ? text + '\n' : text) + add.join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'state', 'arena.env'), text, { mode: 0o600 });
    say(`state/arena.env: added ${add.join(' ')}${running ? ' (applies at the next ./stop.sh && ./start.sh in that folder; the running arena is left alone)' : ''}`);
  }

  // 4. arena
  const url = `http://localhost:${port}`;
  let h = await health(port);
  if (!running && h) die(`port ${port} already answers as an arena that was not started from ${dir}; pass --port <free port>`, 3);
  if (!running && !flag('no-start')) {
    const env = { ...process.env }; for (const k of ['PORT', 'ARENA', 'GBW_PVP', 'START_PAUSED', 'BOTS_CONFIG']) delete env[k];
    const st = spawnSync('./start.sh', [], { cwd: dir, env, encoding: 'utf8' });
    say((st.stdout || '').trim());
    if (st.status !== 0) die(`./start.sh failed in ${dir}: ${(st.stderr || st.stdout || '').trim().slice(-300)}`);
  }
  if (!flag('no-start')) {
    for (let i = 0; i < 60; i++) { h = await health(port); if (h && (!h.relay || /^(ready|off|error)$/.test(h.relay.state) || h.relay.connected)) break; await sleep(500); }
    if (!h) die(`the arena on ${url} did not answer; see ${path.join(dir, 'logs', 'server.log')}`);
  }

  // 5. seat
  const ws = (args, extra = {}) => spawnSync(process.execPath, ['tools/warrior-seat.js', ...args], { cwd: dir, env: { ...process.env, ARENA: url, ...extra }, encoding: 'utf8' });
  let seat = seatOf(dir);
  if (!flag('no-start')) {
    if (seat && owner(seat) === agent) {
      const r = ws(['label', '--agent', agent]);
      if (r.status !== 0) say(`note: relabel failed: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
    } else {
      const r = ws(['join', '--agent', agent]);
      if (r.status !== 0) die(`join failed: ${(r.stderr || r.stdout || '').replace(/rw_[0-9a-f]+/g, '<token>').trim().slice(0, 300)}`);
      say(`seat: joined Green as ${label}`);
    }
    seat = seatOf(dir);
  }
  let info = null;
  if (!flag('no-start')) { const r = ws(['info']); try { info = JSON.parse(r.stdout); } catch {} }
  h = await health(port);
  const out = {
    ok: true, agent, label, folder: dir, port, arena: url,
    watch: h && h.relay && h.relay.watch || null, room: h && h.relay && h.relay.room || null,
    name: info && info.name || null, base: info && info.base || null, seat: info && info.seat || null,
    pvp: h ? (h.pvp ? 'on' : 'off') : null, paused: h ? h.paused : null, created: !existed,
  };
  if (asJson) { console.log(JSON.stringify(out, null, 1)); return; }
  console.log(`folder: ${out.folder}`);
  console.log(`port:   ${out.port}  (arena ${out.arena}, state/arena.env)`);
  console.log(`seat:   ${out.seat || '?'} ${out.name || label} (${out.base || '?'})`);
  console.log(`watch:  ${out.watch || '(no relay room: the arena runs local only)'}`);
  console.log(`run every command from the folder: cd ${out.folder} && node tools/warrior-seat.js <command>`);
})().catch(e => die(e && e.message || String(e)));
