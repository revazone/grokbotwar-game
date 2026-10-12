// TURTLE BATTLE PLAN v1 (was turtle-commander.js) (standing orders, spec v4)
// v1 notes: the house basic.js often let the team be eliminated while holding <80 energy (it only bought heroes
// or kept a hero reserve); this one always deploys something during a last stand. MAX_DRONES=2: extra drones
// did not add wins in local tests (2 vs 4 vs 0 drones were within noise), heroes did.
// Doctrine: reinforce the strong position, don't chase.
// - Heroes are the best value (200 hp for 80 energy, power 3): keep 2 heroes whenever affordable and
//   always replace a lost hero first.
// - Never let the team die with energy in the bank: with no units alive (last stand) deploy whatever is affordable.
// - Spend the rest on guard drones while keeping a reserve for a replacement hero; spend everything late
//   (unspent energy scores nothing).
var USE_DRONES = true, MAX_DRONES = 2, RESERVE_EARLY = 80, RESERVE_MID = 40, LATE = 300;
function command(status, memory) {
  status = status || {};
  var m = (memory && typeof memory === 'object') ? memory : {};
  var c = status.counts || {}, e = +status.energy || 0, cost = status.costs || { hero: 80, drone: 20 };
  var caps = status.caps || { hero: 2, drone: 4 };
  var drones = (status.roster && status.roster.drones) || [];
  var left = +status.ticksLeft || 0;
  var heroes = (c.hero || 0) + (c.pendingHero || 0), dr = (c.drone || 0) + (c.pendingDrone || 0);
  var alive = (c.hero || 0) + (c.drone || 0) + (c.pendingHero || 0) + (c.pendingDrone || 0);
  var dtype = drones.indexOf('guard') >= 0 ? 'guard' : drones[0];
  var maxD = Math.min(caps.drone, MAX_DRONES);
  var deploy = [];
  if (heroes < caps.hero && e >= cost.hero) { deploy.push({ type: 'hero', count: 1 }); e -= cost.hero; heroes++; alive++; }
  if (dtype && USE_DRONES || (dtype && alive === 0)) {
    var reserve = alive === 0 ? 0 : left <= LATE ? 0 : heroes < caps.hero ? RESERVE_EARLY : RESERVE_MID;
    var n = 0;
    while (dr + n < (alive === 0 ? Math.max(1, maxD) : maxD) && e - cost.drone >= reserve) { n++; e -= cost.drone; }
    if (n > 0) deploy.push({ type: dtype, count: Math.min(4, n) });
  }
  m.runs = (m.runs || 0) + 1;
  var thought = deploy.length ? 'Reinforcing the corner: ' + deploy.map(function (d) { return d.count + 'x ' + d.type; }).join(', ') : 'Holding the corner, banking ' + Math.floor(e);
  return { deploy: deploy, thought: thought, memory: m };
}
