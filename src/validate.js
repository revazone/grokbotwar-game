'use strict';
// Validate / normalise a controller COMMAND. Returns {ok, cmd, error}.
// Invalid => caller substitutes STAND_STILL (no move, no turn, no fire, keep previous scan).
const { norm360 } = require('./geom');

function num(v) { return typeof v === 'number' && Number.isFinite(v); }

function validateCommand(raw, cfg) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'command is not an object' };
  const cmd = { move: 0, turn: 0, scan: null, fire: null, thought: '' };
  if (raw.move !== undefined) {
    if (!num(raw.move) || Math.abs(raw.move) > cfg.maxMove) return { ok: false, error: `move must be number in [-${cfg.maxMove},${cfg.maxMove}]` };
    cmd.move = raw.move;
  }
  if (raw.turn !== undefined) {
    if (!num(raw.turn) || Math.abs(raw.turn) > cfg.maxTurn) return { ok: false, error: `turn must be number in [-${cfg.maxTurn},${cfg.maxTurn}]` };
    cmd.turn = raw.turn;
  }
  if (raw.scan !== undefined && raw.scan !== null) {
    const s = raw.scan;
    if (typeof s !== 'object' || !num(s.dir) || !num(s.width)) return { ok: false, error: 'scan must be {dir:number, width:number}' };
    if (s.width < cfg.scanMinWidth || s.width > cfg.scanMaxWidth) return { ok: false, error: `scan.width must be in [${cfg.scanMinWidth},${cfg.scanMaxWidth}]` };
    cmd.scan = { dir: norm360(s.dir), width: s.width };
  }
  if (raw.fire !== undefined && raw.fire !== null) {
    const f = raw.fire;
    const maxP = cfg.maxPower || 3;
    if (typeof f !== 'object' || !num(f.angle) || !num(f.power)) return { ok: false, error: `fire must be {angle:number, power:1..${maxP}} or null` };
    if (f.power < 1 || f.power > maxP) return { ok: false, error: `fire.power must be in [1,${maxP}]` };
    cmd.fire = { angle: norm360(f.angle), power: f.power };
  }
  if (raw.thought !== undefined) {
    if (typeof raw.thought !== 'string') return { ok: false, error: 'thought must be a string' };
    cmd.thought = raw.thought.replace(/[\r\n]+/g, ' ').slice(0, 140);
  }
  if (raw.memory !== undefined && raw.memory !== null) {
    if (typeof raw.memory !== 'string') return { ok: false, error: 'memory must be a string' };
    cmd.memory = raw.memory.replace(/[\r\n]+/g, ' ').slice(0, 200);
  }
  return { ok: true, cmd };
}

// limits object for a unit spec (validateCommand reads maxMove/maxTurn/scanMinWidth/scanMaxWidth/maxPower)
function limitsFor(spec, base) { return { maxMove: spec.maxMove, maxTurn: spec.maxTurn, scanMinWidth: base.scanMinWidth || 2, scanMaxWidth: spec.scanMaxWidth || base.scanMaxWidth, maxPower: spec.maxPower || 3 }; }

// battle plan output (command(status, memory)): {deploy: [{type, count}], thought, memory}
function validateOrders(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'command() must return an object' };
  const out = { deploy: [], thought: '' };
  if (raw.deploy !== undefined && raw.deploy !== null) {
    if (!Array.isArray(raw.deploy) || raw.deploy.length > 5) return { ok: false, error: 'deploy must be an array of at most 5 {type, count}' };
    for (const d of raw.deploy) {
      if (!d || typeof d.type !== 'string' || d.type.length > 32) return { ok: false, error: 'deploy[].type must be a unit type name' };
      const c = d.count === undefined ? 1 : d.count;
      if (!Number.isInteger(c) || c < 0 || c > 4) return { ok: false, error: 'deploy[].count must be an integer 0..4' };
      if (c > 0) out.deploy.push({ type: d.type, count: c }); // count 0 = no-op (not applied, not logged)
    }
  }
  if (raw.thought !== undefined) { if (typeof raw.thought !== 'string') return { ok: false, error: 'thought must be a string' }; out.thought = raw.thought.replace(/[\r\n]+/g, ' ').slice(0, 140); }
  return { ok: true, orders: out };
}

module.exports = { validateCommand, limitsFor, validateOrders };
