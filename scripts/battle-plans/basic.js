// BASIC battle plan (example standing orders). Runs every ~2 s with the team status.
// 1. No hero alive or on the way and we can afford one -> redeploy the hero.
// 2. Otherwise keep buying drones (cycling through the roster's drone types) whenever affordable,
//    but keep a reserve for a replacement hero once the match is past its first third.
function command(status, memory) {
  var m = memory || { next: 0 };
  var c = status.counts, e = status.energy, cost = status.costs, drones = status.roster.drones;
  if (c.hero + c.pendingHero === 0 && e >= cost.hero) return { deploy: [{ type: 'hero', count: 1 }], thought: 'Hero down - redeploying', memory: m };
  if (!drones.length) return { thought: 'No drones in roster; banking ' + Math.floor(e), memory: m };
  var reserve = status.tick > 500 && c.hero > 0 ? cost.hero : 0;
  if (c.drone + c.pendingDrone < status.caps.drone && e - cost.drone >= reserve) {
    var type = drones[m.next % drones.length]; m.next++;
    return { deploy: [{ type: type, count: 1 }], thought: 'Reinforcing with ' + type, memory: m };
  }
  return { thought: 'Banking energy (' + Math.floor(e) + ')', memory: m };
}
