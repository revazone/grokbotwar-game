// FORTRESS battle plan (style loadout). Bank energy, never be caught without a replacement hero.
// 1. Last stand (nothing alive or on the way): deploy whatever is affordable.
// 2. Hero down: replace it first.
// 3. Keep a 3-guard screen, but never dip below the hero reserve (80) except late.
// 3b. Pre-paid reserve drones (arsenal) go out whenever there's room under the cap: they cost nothing.
// 4. Second hero once the bank can pay for it AND still cover a replacement. Spend everything in the last 300 ticks.
// Pre-paid reserve drones (arsenal, ROBOT-API 7a): already paid for, so send them whenever there's room under the cap.
function sendReserve(status, dr) {
  var rs = status.arsenal ? status.arsenal.reserve : null;
  if (rs) for (var t in rs) if (rs[t] > 0 && dr < status.caps.drone) return [{ type: t, count: Math.min(rs[t], status.caps.drone - dr) }];
  return null;
}
function command(status, memory) {
  var c = status.counts, e = status.energy, cost = status.costs, caps = status.caps;
  var drones = status.roster.drones, g = drones.indexOf('guard') >= 0 ? 'guard' : drones[0];
  var heroes = c.hero + c.pendingHero, dr = c.drone + c.pendingDrone, late = status.ticksLeft < 300;
  var soft = !!status.soft;
  if (heroes + dr === 0) {
    if (e >= cost.hero) return { deploy: [{ type: 'hero', count: 1 }], thought: 'Last stand: hero to the walls' };
    var fr = sendReserve(status, dr); if (fr) return { deploy: fr, thought: 'Reserve ' + fr[0].type + ' out (pre-paid)' };
    if (g && e >= cost.drone) return { deploy: [{ type: g, count: Math.min(4, Math.floor(e / cost.drone)) }], thought: 'Last stand: everything on the wall' };
    return { thought: 'Last stand, scraping energy (' + Math.floor(e) + ')' };
  }
  if (heroes === 0 && e >= cost.hero) return { deploy: [{ type: 'hero', count: 1 }], thought: 'Hero down - a new one takes the corner' };
  fr = sendReserve(status, dr); if (fr) return { deploy: fr, thought: 'Reserve ' + fr[0].type + ' out (pre-paid)' };
  if (heroes === 0) return { thought: 'Saving for a new hero (' + Math.floor(e) + '/' + cost.hero + ')' };
  var wantGuards = late ? caps.drone : soft ? 1 : 3;
  var reserve = late ? 0 : cost.hero;
  if (g && dr < wantGuards && e - cost.drone >= reserve) return { deploy: [{ type: g, count: 1 }], thought: 'Guard to the wall' };
  if (heroes < caps.hero && e - cost.hero >= (late ? 0 : cost.hero * (soft ? 1.5 : 0.75))) return { deploy: [{ type: 'hero', count: 1 }], thought: 'Second hero holds the other wall' };
  return { thought: 'Holding the corner, banking ' + Math.floor(e) };
}
