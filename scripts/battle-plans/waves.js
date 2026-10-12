// WAVES battle plan (Hunter). Saves up and launches drones in waves of 3 so they arrive together.
function command(status, memory) {
  var m = memory || { wave: 0 };
  var c = status.counts, e = status.energy, cost = status.costs, drones = status.roster.drones;
  if (c.hero + c.pendingHero === 0 && e >= cost.hero) return { deploy: [{ type: 'hero', count: 1 }], thought: 'Hero lost - new hero', memory: m };
  var room = status.caps.drone - c.drone - c.pendingDrone;
  var n = Math.min(3, room);
  if (drones.length && n >= 1 && (n >= 2 || c.drone === 0) && e >= n * cost.drone) {
    m.wave++;
    var type = drones[m.wave % drones.length];
    return { deploy: [{ type: type, count: n }], thought: 'Wave ' + m.wave + ': ' + n + ' x ' + type, memory: m };
  }
  return { thought: 'Massing for wave ' + (m.wave + 1) + ' (' + Math.floor(e) + '/' + (3 * cost.drone) + ')', memory: m };
}
