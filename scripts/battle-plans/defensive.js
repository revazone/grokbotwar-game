// DEFENSIVE battle plan (Sniper). Keeps two guards around the hero, banks energy for a replacement hero,
// and spends everything in the last 300 ticks.
function command(status, memory) {
  var c = status.counts, e = status.energy, cost = status.costs, drones = status.roster.drones;
  if (c.hero + c.pendingHero === 0 && e >= cost.hero) return { deploy: [{ type: 'hero', count: 1 }], thought: 'Replacing hero' };
  if (!drones.length) return { thought: 'Banking' };
  var type = drones[0];
  var want = status.ticksLeft < 300 ? status.caps.drone : 2;
  var reserve = status.ticksLeft < 300 ? 0 : cost.hero;
  if (c.drone + c.pendingDrone < want && e - cost.drone >= reserve) return { deploy: [{ type: type, count: 1 }], thought: 'Escort up: ' + type };
  if (c.drone + c.pendingDrone < want && c.drone === 0 && e >= cost.drone) return { deploy: [{ type: type, count: 1 }], thought: 'Emergency escort' };
  return { thought: 'Holding reserve ' + Math.floor(e) };
}
