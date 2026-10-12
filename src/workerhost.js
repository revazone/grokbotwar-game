'use strict';
// TeamWorker: main-thread handle on a sandbox worker (one per team). Every request has a hard wall-clock
// deadline, counted from when the worker can start on it (requests are served in order); if the worker misses
// it, the worker is terminated and transparently respawned (scripts reloaded, script globals reset; the
// host-held `memory` survives).
const path = require('path');
const { Worker } = require('worker_threads');

// Per tick request, counted from when the worker starts on it. Scripts are already bounded INSIDE the worker
// (10 ms budget, one call interrupted at 50 ms); this wall-clock backstop only has to catch a native built-in
// that ignores the interrupt. It was 150 ms, which a healthy worker exceeded routinely on a busy box (thread
// descheduled / GC). 300 ms keeps it below the referee's controllerTimeoutMs (400 ms), so a truly hung call is
// still killed and charged within the same tick.
const HARD_KILL_MS = 300;
const LOAD_KILL_MS = 3000;    // worker boot (WASM compile) + script load

class TeamWorker {
  constructor(label) {
    this.label = label; this.w = null; this.seq = 0; this.pending = new Map(); this.queue = []; this.loaded = new Map();
    this.kills = 0; this.graceRearms = 0; this.booted = false;
  }

  _spawn() {
    const w = this.w = new Worker(path.join(__dirname, 'sandbox-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
    this.booted = false;
    // Every listener is bound to ITS worker. A worker we terminated on purpose still emits 'exit' later; by then
    // this.w may already be its replacement, and treating that late event as "the current worker died" used to
    // kill the replacement too (which then killed the next one ...: the "worker exited" fault cascades).
    w.on('message', m => { if (this.w === w) this._reply(m); });
    w.on('error', e => { if (this.w === w) this._fail(`worker crashed: ${e.message}`); });
    w.on('exit', code => { if (this.w === w) this._fail(`worker exited (code ${code})`); });
    w.unref();
  }

  _reply(m) {
    const p = this.pending.get(m.id); if (!p) return;
    this.pending.delete(m.id); clearTimeout(p.timer);
    const i = this.queue.indexOf(p); if (i >= 0) this.queue.splice(i, 1);
    p.resolve(m);
    this._armHead();
  }

  // culprit: the request that blew its deadline. Only it (and any later request of the same unit) is charged
  // (fatal); teammates' requests queued behind it did nothing wrong, so they come back as `innocent` (that unit
  // stands still this tick without a fault). With no
  // known culprit (the worker crashed or exited on its own) every pending request is charged.
  _fail(msg, culprit = null) {
    const w = this.w; this.w = null;
    if (w) w.terminate().catch(() => {});
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      if (culprit && p !== culprit && p.unit !== culprit.unit) p.resolve({ ok: false, error: 'worker restarted (a teammate\'s call was killed)', killed: true, innocent: true });
      else p.resolve({ ok: false, error: msg, fatal: true, killed: true });
    }
    this.pending.clear(); this.queue = [];
  }

  // The worker answers requests one at a time, in order. A request's hard deadline therefore starts when it
  // reaches the head of the line (when the worker can actually start on it), not when it was posted: a team
  // with many units must not have its last unit killed for time spent waiting behind its teammates.
  _armHead() {
    const p = this.queue[0];
    if (!p || p.timer) return;
    p.armedAt = Date.now();
    p.timer = setTimeout(() => this._expire(p), p.timeoutMs);
  }

  _expire(p) {
    if (!this.pending.has(p.id)) return;
    // If the main thread itself was stalled (GC, sync file writes at match end, an overloaded box), this timer
    // fired late and the answer may already be waiting in the message queue. Do not blame the worker for our own
    // stall: give it a fresh window measured while the event loop is responsive (at most twice per request).
    const late = Date.now() - p.armedAt - p.timeoutMs;
    if (late > Math.max(25, p.timeoutMs / 2) && (p.rearms = (p.rearms || 0) + 1) <= 2) {
      this.graceRearms++; p.timer = null; this._armHead(); return;
    }
    // setImmediate runs after the poll phase, so an answer that is already queued gets delivered first.
    setImmediate(() => {
      if (!this.pending.has(p.id)) return;
      this.kills++;
      this._fail(`hard time limit: no answer within ${p.timeoutMs}ms (worker killed)`, p);
    });
  }

  _send(msg, timeoutMs) {
    if (!this.w) {
      // Fresh worker (first use, or replacing a killed one): it has no sandboxes yet, so replay a load for every
      // unit this team still has BEFORE this request. The worker serves requests in order, so whatever arrives
      // next (a tick, a load for a new unit, a dispose) finds the team's scripts in place. (Before, only tick()
      // restored them, and only when it happened to be the one that found the worker gone; a load or a second
      // concurrent tick could reach the new worker first and get "script not loaded".)
      this._spawn();
      for (const [u, l] of this.loaded) {
        if (msg.op === 'load' && msg.unit === u) continue;
        this._post({ op: 'load', unit: u, ...l }, LOAD_KILL_MS).then(r => { if (!r.killed) this.booted = true; });
      }
      if (!this.queue.length && msg.op === 'tick') timeoutMs = Math.max(timeoutMs, LOAD_KILL_MS); // a first request also pays the boot
    }
    return this._post(msg, timeoutMs);
  }

  _post(msg, timeoutMs) {
    const id = ++this.seq;
    return new Promise(resolve => {
      const p = { id, resolve, timer: null, timeoutMs, unit: msg.unit };
      this.pending.set(id, p); this.queue.push(p);
      this.w.postMessage({ id, ...msg });
      this._armHead();
    });
  }

  async load(unit, source, seed, limits, entry = 'tick') {
    this.loaded.set(unit, { source, seed, limits, entry });
    const r = await this._send({ op: 'load', unit, source, seed, limits, entry }, this.booted ? 1000 : LOAD_KILL_MS);
    if (!r.killed) this.booted = true;
    return r;
  }

  tick(unit, sense, memory) { return this._send({ op: 'tick', unit, sense, memory }, HARD_KILL_MS); }

  async reload(unit) { const l = this.loaded.get(unit); return l ? this._send({ op: 'load', unit, ...l }, LOAD_KILL_MS) : { ok: false, error: 'unknown unit' }; }
  dispose(unit) { this.loaded.delete(unit); if (this.w) this._send({ op: 'dispose', unit }, 1000); }
  terminate() { const w = this.w; this.w = null; if (w) w.terminate().catch(() => {}); for (const [, p] of this.pending) clearTimeout(p.timer); this.pending.clear(); this.queue = []; }
}

// One-off dry run in a throwaway worker (so a hostile submission cannot stall the server)
async function dryRun(source, limits, role = 'hero') {
  const tw = new TeamWorker('dryrun');
  try {
    const r = await tw._send({ op: 'dryrun', source, limits, role }, 1500); // boot (~70ms) + load + 3 sample ticks
    return r.killed ? { ok: false, error: 'script took too long during validation (killed)' } : (({ id, ...rest }) => rest)(r);
  } finally { tw.terminate(); }
}

module.exports = { TeamWorker, dryRun, HARD_KILL_MS };
