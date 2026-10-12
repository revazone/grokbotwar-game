'use strict';
// Worker-thread host for robot scripts. One worker per TEAM; it holds one QuickJS sandbox per UNIT.
// The main thread enforces a hard wall-clock deadline on every request and terminates this whole worker if it
// is exceeded (backstop for native built-ins that do not check the QuickJS interrupt handler).
const { parentPort } = require('worker_threads');
const { loadQuickJS, ScriptSandbox } = require('./sandbox');
const { dryRunSync } = require('./dryrun');

const units = new Map();
const ready = loadQuickJS();

parentPort.on('message', async (m) => {
  await ready;
  let reply;
  try {
    if (m.op === 'load') {
      const old = units.get(m.unit); if (old) old.dispose(); units.delete(m.unit);
      const r = ScriptSandbox.create(m.source, { seed: m.seed, limits: m.limits, entry: m.entry || 'tick' });
      if (r.ok) units.set(m.unit, r.sandbox);
      reply = { ok: r.ok, error: r.error };
    } else if (m.op === 'tick') {
      const sb = units.get(m.unit);
      if (!sb) reply = { ok: false, error: 'script not loaded', fatal: true, cpuMs: 0 };
      else {
        reply = sb.call(m.sense, m.memory);
        if (!reply.ok && reply.fatal) { sb.dispose(); units.delete(m.unit); }
      }
    } else if (m.op === 'dispose') {
      const sb = units.get(m.unit); if (sb) sb.dispose(); units.delete(m.unit); reply = { ok: true };
    } else if (m.op === 'dryrun') {
      reply = dryRunSync(m.source, m.limits, m.role);
    } else reply = { ok: false, error: 'unknown op' };
  } catch (e) { reply = { ok: false, error: 'worker error: ' + String(e.message || e), fatal: true }; }
  parentPort.postMessage({ id: m.id, ...reply });
});
