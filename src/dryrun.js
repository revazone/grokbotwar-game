'use strict';
// Synchronous dry run of a script on sample inputs (runs INSIDE a sandbox worker; see workerhost.dryRun).
// role: 'classic' | 'hero' | 'drone' (unit scripts: tick(sense, memory)) or 'battle-plan' (command(status, memory); 'commander' is a deprecated alias).
const { ScriptSandbox, LIMITS } = require('./sandbox');
const { validateCommand, limitsFor, validateOrders } = require('./validate');
const config = require('./config');

function sampleSenses(role = 'classic') {
  const spec = config.unitTypes[role] || config.unitTypes.classic;
  const base = (tick, self, extra) => ({
    tick, ticksLeft: 600 - tick, unitsAlive: 6, teamsAlive: 4, arena: { ...config.arena },
    limits: { maxMove: spec.maxMove, maxTurn: spec.maxTurn, scanWidth: [2, spec.scanMaxWidth], power: [1, spec.maxPower], maxHeat: spec.maxHeat, shellSpeed: spec.shellSpeed, heatPerPower: spec.heatPerPower, coolPerTick: spec.coolPerTick, arena: { ...config.arena } },
    self: { id: 0, name: 'Test', team: 0, kind: role === 'drone' ? 'drone' : 'hero', type: role === 'drone' ? 'scout' : 'hero', radius: spec.radius, maxHealth: spec.health,
            x: 200, y: 300, heading: 45, health: spec.health, heat: 0, canFire: true, damageTakenLastTick: 0, hitWallLastTick: false, ...self },
    team: { energy: 55, unitsAlive: 2 },
    allies: [{ id: 1, type: 'hero', kind: 'hero', x: 120, y: 140, heading: 0, health: 150 }],
    scan: { dir: 0, width: 45, result: null }, ...extra,
  });
  return [
    base(1, {}),
    base(2, {}, { scan: { dir: 30, width: 45, result: { bearing: 32.5, distance: 410.2, relBearing: -12.5, team: 2, friendly: false, kind: 'drone' } } }),
    base(3, { x: 985, y: 15, heading: 270, health: Math.round(spec.health * 0.1), heat: 95, canFire: false, damageTakenLastTick: 16, hitWallLastTick: true }, { allies: [] }),
  ];
}

function sampleStatuses() {
  const c = config.commander, ut = config.unitTypes;
  const base = (tick, extra) => ({
    tick, ticksLeft: c.maxTicks - tick, mode: 'commander', team: { id: 0, name: 'Test' },
    energy: 45, energyMax: c.energyMax, energyPerTick: c.energyPerTick,
    costs: { hero: ut.hero.cost, drone: ut.drone.cost }, caps: { hero: c.heroCap, drone: c.droneCap }, spawnDelayTicks: c.spawnDelayTicks,
    roster: { hero: 'hero.js', drones: ['scout', 'guard'] },
    units: [{ id: 0, name: 'Test', type: 'hero', kind: 'hero', x: 150, y: 150, heading: 0, health: 150, maxHealth: 150, heat: 0 }],
    counts: { hero: 1, drone: 0, pendingHero: 0, pendingDrone: 0 }, pending: [],
    enemiesSeen: [], teams: [{ id: 0, name: 'Test', units: 1, heroes: 1, drones: 0, health: 150, eliminated: false }],
    recentEvents: [], lastOrders: [], arsenal: null, ...extra,
  });
  return [
    base(13),
    base(26, { energy: 120, enemiesSeen: [{ id: 5, team: 2, kind: 'hero', x: 700, y: 650, tick: 24 }], recentEvents: [{ tick: 20, text: 'Test-scout1 was destroyed by Other' }] }),
    base(39, { arsenal: { budget: c.arsenalBudget, bought: { guard: 5 }, spent: 100, reserveEnergy: 20, launched: { guard: 4 }, reserve: { guard: 1 } }, energy: 3, units: [], counts: { hero: 0, drone: 0, pendingHero: 0, pendingDrone: 1 }, pending: [{ type: 'scout', kind: 'drone', readyTick: 45 }] }),
  ];
}

function dryRunSync(source, extra = {}, role = 'classic') {
  const limits = { ...LIMITS, ...(extra || {}) };
  if (role === 'commander') role = 'battle-plan'; // deprecated alias
  const isCmd = role === 'battle-plan';
  const r = ScriptSandbox.create(source, { seed: 12345, limits, entry: isCmd ? 'command' : 'tick' });
  if (!r.ok) return { ok: false, error: r.error };
  const sb = r.sandbox; const results = []; let memory = null;
  const spec = config.unitTypes[role] || config.unitTypes.classic;
  try {
    for (const input of isCmd ? sampleStatuses() : sampleSenses(role)) {
      const res = sb.call(input, memory);
      const label = `sample ${isCmd ? 'status' : 'tick'} ${input.tick}`;
      if (!res.ok) return { ok: false, error: `${label}: ${res.error}` };
      const out = res.out;
      if (out === null || typeof out !== 'object' || Array.isArray(out)) return { ok: false, error: `${label}: ${isCmd ? 'command()' : 'tick()'} must return an object` };
      const { memory: m, ...cmd } = out;
      if (m !== undefined && JSON.stringify(m).length > limits.maxMemoryBytes) return { ok: false, error: `${label}: memory too large (max ${limits.maxMemoryBytes} bytes as JSON)` };
      if (m !== undefined) memory = m;
      const v = isCmd ? validateOrders(cmd) : validateCommand(cmd, limitsFor(spec, config));
      if (!v.ok) return { ok: false, error: `${label}: invalid ${isCmd ? 'orders' : 'command'}: ${v.error}` };
      results.push({ tick: input.tick, [isCmd ? 'orders' : 'command']: isCmd ? v.orders : v.cmd, cpuMs: +res.cpuMs.toFixed(2) });
    }
  } finally { sb.dispose(); }
  return { ok: true, role, results };
}

module.exports = { dryRunSync, sampleSenses, sampleStatuses };
