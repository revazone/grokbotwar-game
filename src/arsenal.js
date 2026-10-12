'use strict';
// Arsenal (docs/SPEC.md 5.1, ROBOT-API v4.7): before each match a team spends a budget (config
// commander.arsenalBudget, default 120) on drones of its own drone types, 20 energy each (unit drone cost).
// Unspent budget = starting energy. Shape: {droneType: count}, in launch order.
const config = require('./config');

const budgetOf = cc => (cc && Number.isFinite(cc.arsenalBudget) ? cc.arsenalBudget : config.commander.arsenalBudget);
const droneCostOf = ut => (ut && ut.drone && Number.isFinite(ut.drone.cost) ? ut.drone.cost : config.unitTypes.drone.cost);
const costOf = (a, cost) => Object.values(a || {}).reduce((s, n) => s + n * cost, 0);
const countOf = a => Object.values(a || {}).reduce((s, n) => s + n, 0);

/**
 * Strict check for a submitted arsenal (API / config). Returns {ok, arsenal, cost, left} or {ok:false, error}.
 * @param {object} a {type: count}
 * @param {{droneTypes: string[], budget: number, cost: number}} o
 */
function validateArsenal(a, { droneTypes, budget, cost }) {
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return { ok: false, error: 'arsenal must be an object like {"guard": 3}' };
  const out = {};
  const max = Math.floor(budget / cost);
  for (const [type, n] of Object.entries(a)) {
    if (type === 'hero') return { ok: false, error: 'heroes are not in the arsenal (your hero is free at the start; buy extra heroes during the match)' };
    if (!droneTypes.includes(type)) return { ok: false, error: `"${type}" is not one of your drone types (${droneTypes.join(', ') || 'none yet'})` };
    if (!Number.isInteger(n) || n < 0 || n > max) return { ok: false, error: `count for "${type}" must be a whole number 0..${max}` };
    if (n > 0) out[type] = n;
  }
  const total = costOf(out, cost);
  if (total > budget) return { ok: false, error: `arsenal costs ${total} but the budget is ${budget} (${cost} per drone, so at most ${max} drones)` };
  return { ok: true, arsenal: out, cost: total, left: budget - total, drones: countOf(out) };
}

/**
 * Lenient fit used at match start: drops types not in this match's roster and trims drones from the LAST listed
 * type first until the arsenal fits the (possibly soft-scaled) budget. Returns {arsenal, cost, notes}.
 */
function fitArsenal(a, { droneTypes, budget, cost }) {
  const out = {}, notes = [];
  for (const [type, n] of Object.entries(a || {})) {
    if (!droneTypes.includes(type)) { notes.push(`dropped ${type} x${n} (not in the roster)`); continue; }
    if (Number.isInteger(n) && n > 0) out[type] = n;
  }
  const types = Object.keys(out);
  const trimmed = {};
  while (costOf(out, cost) > budget && types.length) {
    const t = types[types.length - 1];
    out[t]--; trimmed[t] = (trimmed[t] || 0) + 1;
    if (!out[t]) { delete out[t]; types.pop(); }
  }
  for (const [t, n] of Object.entries(trimmed)) notes.push(`trimmed ${t} x${n} to fit the budget of ${budget}`);
  return { arsenal: out, cost: costOf(out, cost), notes };
}

/** parse "guard=3 scout=1" / ["guard=3","scout=1"] / "guard:3,scout:1" into {guard:3, scout:1} */
function parseArsenalArgs(args) {
  const out = {};
  for (const part of [].concat(args).join(' ').split(/[\s,]+/).filter(Boolean)) {
    const m = part.match(/^([a-z][a-z0-9_-]{0,15})[=:](\d+)$/);
    if (!m) throw new Error(`cannot read "${part}" (use type=count, e.g. guard=3)`);
    out[m[1]] = +m[2];
  }
  return out;
}

/**
 * "More <type>": +1 drone of that type. Paid from the leftover budget if there is room, else by taking one
 * drone of the other type with the most drones. Returns {ok, arsenal, note} or {ok:false, error}.
 */
function moreOf(a, type, { droneTypes, budget, cost }) {
  if (!droneTypes.includes(type)) return { ok: false, error: `"${type}" is not one of your drone types (${droneTypes.join(', ')})` };
  const out = { ...(a || {}) };
  let note;
  if (costOf(out, cost) + cost <= budget) note = `+1 ${type}, paid from the starting energy`;
  else {
    const other = Object.keys(out).filter(t => t !== type && out[t] > 0).sort((x, y) => out[y] - out[x])[0];
    if (!other) return { ok: false, error: `the budget is full of ${type} already (${Math.floor(budget / cost)} max)` };
    out[other]--; if (!out[other]) delete out[other];
    note = `+1 ${type}, -1 ${other} (budget full)`;
  }
  out[type] = (out[type] || 0) + 1;
  return { ok: true, arsenal: out, note };
}

module.exports = { validateArsenal, fitArsenal, parseArsenalArgs, moreOf, budgetOf, droneCostOf, costOf, countOf };
