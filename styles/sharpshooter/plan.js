// SHARPSHOOTER battle plan (style loadout). The hero is the gun: keep it alive and replaced, screen it with two
// pickets that spot and harass at range (pre-paid reserve pickets from the arsenal go out free when there's room), bank for a replacement, spend everything in the last 300 ticks.
// Pre-paid reserve drones (arsenal, ROBOT-API 7a): already paid for, so send them whenever there's room under the cap.
function sendReserve(status, dr) {
  var rs = status.arsenal ? status.arsenal.reserve : null;
  if (rs) for (var t in rs) if (rs[t] > 0 && dr < status.caps.drone) return [{ type: t, count: Math.min(rs[t], status.caps.drone - dr) }];
  return null;
}
function command(status, memory) {
  var c = status.counts, e = status.energy, cost = status.costs, caps = status.caps, drones = status.roster.drones;
  var heroes = c.hero + c.pendingHero, dr = c.drone + c.pendingDrone, late = status.ticksLeft < 300;
  var soft = !!status.soft, type = drones[0];
  if (heroes + dr === 0) {
    if (e >= cost.hero) return { deploy: [{ type: 'hero', count: 1 }], thought: 'Last stand: new rifle up' };
    var fr = sendReserve(status, dr); if (fr) return { deploy: fr, thought: 'Reserve ' + fr[0].type + ' out (pre-paid)' };
    if (type && e >= cost.drone) return { deploy: [{ type: type, count: Math.min(4, Math.floor(e / cost.drone)) }], thought: 'Last stand: pickets out' };
    return { thought: 'Last stand, out of energy' };
  }
  if (heroes === 0 && e >= cost.hero) return { deploy: [{ type: 'hero', count: 1 }], thought: 'Replacing the rifle' };
  fr = sendReserve(status, dr); if (fr) return { deploy: fr, thought: 'Reserve ' + fr[0].type + ' out (pre-paid)' };
  if (heroes === 0) return { thought: 'Saving for a new rifle (' + Math.floor(e) + ')' };
  var want = late ? caps.drone : soft ? 1 : 2;
  var reserve = late ? 0 : cost.hero;
  if (type && dr < want && e - cost.drone >= reserve) return { deploy: [{ type: type, count: 1 }], thought: 'Picket out: ' + type };
  if (type && dr === 0 && e >= cost.drone) return { deploy: [{ type: type, count: 1 }], thought: 'Emergency picket' };
  if (heroes < caps.hero && e - cost.hero >= (late ? 0 : cost.hero)) return { deploy: [{ type: 'hero', count: 1 }], thought: 'Second rifle on the line' };
  return { thought: 'Holding reserve ' + Math.floor(e) };
}
