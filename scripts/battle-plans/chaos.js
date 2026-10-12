// CHAOS battle plan. Rolls dice: sometimes deploys a random affordable unit, sometimes does nothing.
function command(status, memory) {
  var types = ['hero'].concat(status.roster.drones);
  if (Math.random() < 0.4) return { thought: 'Dice say wait' };
  var t = types[Math.floor(Math.random() * types.length)];
  var cost = t === 'hero' ? status.costs.hero : status.costs.drone;
  if (status.energy >= cost) return { deploy: [{ type: t, count: 1 }], thought: 'Dice say ' + t + '!' };
  return { thought: 'Dice say ' + t + ' but broke' };
}
