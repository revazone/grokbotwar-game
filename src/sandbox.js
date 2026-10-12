'use strict';
// Script sandbox: each robot script runs in its OWN QuickJS runtime (compiled to WebAssembly via
// quickjs-emscripten). The guest has only the ECMAScript built-ins: no require/import, no fs, no network,
// no process, no timers, no Date (removed so matches are reproducible); Math.random is a seeded PRNG.
// Limits: per-runtime memory cap, stack cap, CPU deadline per tick (interrupt handler), script size cap,
// output size cap. A guest can only damage its own runtime; the host only ever receives a JSON string
// that it parses and validates.
const { getQuickJS } = require('quickjs-emscripten');
const { performance } = require('perf_hooks');

const LIMITS = {
  maxScriptBytes: 16 * 1024,
  memoryBytes: 8 * 1024 * 1024,
  stackBytes: 256 * 1024,
  initCpuMs: 100,     // top-level script evaluation
  tickCpuMs: 10,      // budget per tick(sense, memory) call: 3 overruns IN A ROW = 1 fault (see controllers/script.js)
  tickHardMs: 50,     // a single call is interrupted (fault, sandbox rebuilt) after this
  maxOutputBytes: 8 * 1024,
  maxMemoryBytes: 4 * 1024, // JSON-serialised `memory` returned by the script
};

let QJS = null;
async function loadQuickJS() { if (!QJS) QJS = await getQuickJS(); return QJS; }

const PRELUDE = (seed, entry) => `
"use strict";
(function () {
  var s = ${seed >>> 0};
  var rnd = function () { s = (s + 0x6D2B79F5) | 0; var t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  Object.defineProperty(Math, 'random', { value: rnd, writable: false, configurable: false });
  delete globalThis.Date;
  var P = JSON.parse, S = JSON.stringify, ENTRY = ${JSON.stringify(entry)};
  globalThis.__rw_run = function (input) {
    var a = P(input);
    var fn = globalThis[ENTRY];
    if (typeof fn !== 'function') throw new Error('script must define function ' + ENTRY + '(' + (ENTRY === 'tick' ? 'sense' : 'status') + ', memory)');
    var out = fn(a.sense, a.memory);
    return S(out === undefined ? null : out);
  };
})();
`;

class ScriptSandbox {
  /** @returns {{ok:true, sandbox:ScriptSandbox}|{ok:false, error:string}} */
  static create(source, { seed = 1, limits = {}, entry = 'tick' } = {}) {
    if (entry !== 'tick' && entry !== 'command') throw new Error('bad entry');
    if (!QJS) throw new Error('call loadQuickJS() first');
    const L = { ...LIMITS, ...limits };
    if (typeof source !== 'string') return { ok: false, error: 'script must be a string' };
    if (Buffer.byteLength(source, 'utf8') > L.maxScriptBytes) return { ok: false, error: `script too large (max ${L.maxScriptBytes} bytes)` };
    const sb = new ScriptSandbox(L);
    sb.rt = QJS.newRuntime();
    sb.rt.setMemoryLimit(L.memoryBytes);
    sb.rt.setMaxStackSize(L.stackBytes);
    sb.ctx = sb.rt.newContext();
    try {
      sb._evalOrThrow(PRELUDE(seed, entry), 'prelude.js', 1000);
      const h = sb.ctx.getProp(sb.ctx.global, '__rw_run');
      sb.runFn = h; // captured before user code runs, so the script cannot replace it
      sb._evalOrThrow(source, 'robot.js', L.initCpuMs);
      const t = sb.ctx.getProp(sb.ctx.global, entry);
      const kind = sb.ctx.typeof(t); t.dispose();
      if (kind !== 'function') throw new Error(entry === 'tick' ? 'script must define function tick(sense, memory)' : 'battle plan script must define function command(status, memory)');
    } catch (e) {
      sb.dispose();
      return { ok: false, error: String(e.message || e) };
    }
    return { ok: true, sandbox: sb };
  }

  constructor(L) { this.L = L; this.rt = null; this.ctx = null; this.runFn = null; }

  _deadline(ms) {
    const until = performance.now() + ms;
    this.rt.setInterruptHandler(() => performance.now() > until);
  }

  _evalOrThrow(code, filename, cpuMs) {
    this._deadline(cpuMs);
    const res = this.ctx.evalCode(code, filename);
    this.rt.removeInterruptHandler();
    if (res.error) { const err = this._errText(res.error); res.error.dispose(); throw new Error(err); }
    res.value.dispose();
  }

  _errText(h) {
    let d; try { d = this.ctx.dump(h); } catch { d = 'unknown error'; }
    if (d && typeof d === 'object') return `${d.name || 'Error'}: ${d.message || JSON.stringify(d)}`.slice(0, 300);
    return String(d).slice(0, 300);
  }

  /** Run tick(sense, memory). Returns {ok, out, cpuMs} or {ok:false, error, cpuMs, fatal} */
  call(sense, memory) {
    const t0 = performance.now();
    let arg;
    try {
      arg = this.ctx.newString(JSON.stringify({ sense, memory: memory === undefined ? null : memory }));
      const hard = this.L.tickHardMs || this.L.tickCpuMs;
      const t1 = performance.now();
      this._deadline(hard);
      const res = this.ctx.callFunction(this.runFn, this.ctx.undefined, arg);
      this.rt.removeInterruptHandler();
      const cpuMs = performance.now() - t1; // time inside the script call only (input encoding excluded)
      const overrun = cpuMs > this.L.tickCpuMs;
      if (res.error) {
        const err = this._errText(res.error); res.error.dispose();
        const fatal = /out of memory|stack overflow|interrupted/i.test(err);
        return { ok: false, error: /interrupted/i.test(err) ? `CPU hard limit exceeded (${hard}ms in one call)` : err, cpuMs, fatal };
      }
      const kind = this.ctx.typeof(res.value);
      if (kind !== 'string') { res.value.dispose(); return { ok: false, error: 'internal: non-string result', cpuMs }; }
      const s = this.ctx.getString(res.value); res.value.dispose();
      if (s.length > this.L.maxOutputBytes) return { ok: false, error: `command too large (max ${this.L.maxOutputBytes} bytes)`, cpuMs };
      let out;
      try { out = JSON.parse(s); } catch { return { ok: false, error: 'tick() returned something JSON cannot encode', cpuMs }; }
      return { ok: true, out, cpuMs, overrun };
    } catch (e) {
      try { this.rt.removeInterruptHandler(); } catch {}
      return { ok: false, error: 'sandbox error: ' + String(e.message || e).slice(0, 200), cpuMs: performance.now() - t0, fatal: true };
    } finally {
      if (arg) try { arg.dispose(); } catch {}
    }
  }

  dispose() {
    try { if (this.runFn) this.runFn.dispose(); } catch {}
    try { if (this.ctx) this.ctx.dispose(); } catch {}
    try { if (this.rt) this.rt.dispose(); } catch {}
    this.runFn = this.ctx = this.rt = null;
  }
}

module.exports = { loadQuickJS, ScriptSandbox, LIMITS };
