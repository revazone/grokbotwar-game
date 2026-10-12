'use strict';
// Script controller: runs a unit SCRIPT (plain JS defining tick(sense, memory)) in a QuickJS sandbox inside the
// team's worker thread. Same contract as every controller: async (sense) => command.
// The script returns {move, turn, scan, fire, thought, memory}; memory (any JSON, <= 4 KB) is kept by the host
// and passed back next tick. Faults (throw, CPU/memory/hard time limit, bad output) => stand still that tick;
// 10 faults in a row or 30 in a match => disqualified.
const { LIMITS } = require('../sandbox');
const { validateCommand, limitsFor, validateOrders } = require('../validate');
const config = require('../config');
const { TeamWorker, dryRun } = require('../workerhost');

const FAULTS = { maxConsecutive: 10, maxTotal: 30, cpuStrikes: 3 }; // cpuStrikes: consecutive >tickCpuMs calls that make 1 fault

/**
 * @param {() => {name, version, source, hash, origin}} getScript  current script for this seat (read at unit creation)
 * @param {{worker?: TeamWorker, limits?: object}} opts  worker shared by all units of the team
 */
function makeScriptFactory(getScript, opts = {}) {  // opts.entry: 'tick' (units) or 'command' (battle plan)
  const limits = { ...LIMITS, ...(opts.limits || {}) };
  const worker = opts.worker || new TeamWorker('team');
  let unitSeq = 0;
  return function make(ctx) {
    const script = getScript();
    const unit = `m${ctx.matchNo}-u${ctx.robotId}-${++unitSeq}`;
    const meta = {
      scriptName: script.name, version: script.version, hash: script.hash, origin: script.origin,
      faults: 0, consecutiveFaults: 0, lastFault: null, disqualified: false, disqualifyReason: null, cpuMsMax: 0, cpuMsTotal: 0, ticks: 0, workerKills: 0, cpuOverruns: 0, cpuStrike: 0,
    };
    let memory = null;
    const lim = limitsFor(ctx.spec || config.unitTypes.classic, config);
    const entry = opts.entry || 'tick';
    let loading = worker.load(unit, script.source, ctx.seed, limits, entry);
    const fault = (msg) => {
      meta.faults++; meta.consecutiveFaults++; meta.lastFault = msg;
      if (meta.consecutiveFaults >= FAULTS.maxConsecutive) { meta.disqualified = true; meta.disqualifyReason = `${meta.consecutiveFaults} faults in a row (last: ${msg})`; }
      else if (meta.faults >= FAULTS.maxTotal) { meta.disqualified = true; meta.disqualifyReason = `${meta.faults} faults total (last: ${msg})`; }
      throw new Error(msg);
    };
    const controller = async function scriptController(sense) {
      meta.ticks++;
      if (loading) {
        const l = await loading;
        if (!l.ok && l.innocent) { loading = worker.reload(unit); throw new Error(l.error); } // not this script's fault
        if (!l.ok) { loading = l.killed ? worker.reload(unit) : null; if (!l.killed) loading = Promise.resolve(l); return fault(`script failed to load: ${l.error}`); }
        loading = null;
      }
      const res = await worker.tick(unit, sense, memory);
      if (res.innocent) throw new Error(res.error); // a teammate's call got the worker killed: stand still, no fault
      if (res.killed) meta.workerKills++;
      if (typeof res.cpuMs === 'number') { meta.cpuMsTotal += res.cpuMs; if (res.cpuMs > meta.cpuMsMax) meta.cpuMsMax = res.cpuMs; }
      if (!res.ok) {
        if (res.fatal && !res.killed) loading = worker.reload(unit); // fresh runtime next tick (globals reset; memory kept)
        meta.cpuStrike = 0;
        return fault(res.error);
      }
      if (res.overrun) {
        meta.cpuOverruns++;
        if (++meta.cpuStrike >= FAULTS.cpuStrikes) { meta.cpuStrike = 0; return fault(`CPU limit exceeded (${limits.tickCpuMs}ms) ${FAULTS.cpuStrikes} calls in a row`); }
      } else meta.cpuStrike = 0;
      const out = res.out;
      if (out === null || typeof out !== 'object' || Array.isArray(out)) return fault(entry === 'tick' ? 'tick() must return a command object' : 'command() must return an object');
      const { memory: newMem, ...cmd } = out;
      if (newMem !== undefined) {
        const ms = JSON.stringify(newMem);
        if (ms && ms.length > limits.maxMemoryBytes) return fault(`memory too large (${ms.length} > ${limits.maxMemoryBytes} bytes)`);
        memory = newMem;
      }
      if (entry === 'command') {
        const v = validateOrders(cmd);
        if (!v.ok) return fault(`invalid orders: ${v.error}`);
        meta.consecutiveFaults = 0;
        return v.orders;
      }
      const v = validateCommand(cmd, lim);
      if (!v.ok) return fault(`invalid command: ${v.error}`);
      meta.consecutiveFaults = 0;
      return v.cmd;
    };
    controller.meta = meta;
    controller.dispose = () => worker.dispose(unit);
    controller.getMemory = () => memory;
    return controller;
  };
}

module.exports = { makeScriptFactory, dryRun, FAULTS };
