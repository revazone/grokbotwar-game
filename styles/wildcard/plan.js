// WILDCARD battle plan (style loadout). Rolls dice for what and when to deploy, but never gets caught without
// a hero: a lost hero is replaced first and a last stand always deploys something. Pre-paid reserve drones
// (arsenal) are free, so those go out whenever there's room.
// Pre-paid reserve drones (arsenal, ROBOT-API 7a): already paid for, so send them whenever there's room under the cap.
function sendReserve(status, dr) {
  var rs = status.arsenal ? status.arsenal.reserve : null;
  if (rs) for (var t in rs) if (rs[t] > 0 && dr < status.caps.drone) return [{ type: t, count: Math.min(rs[t], status.caps.drone - dr) }];
  return null;
}
function command(status, memory) {
  var c = status.counts, e = status.energy, cost = status.costs, caps = status.caps, drones = status.roster.drones;
  var heroes = c.hero + c.pendingHero, dr = c.drone + c.pendingDrone, late = status.ticksLeft < 300;
  var soft = !!status.soft;
  if (heroes + dr === 0) {
    if (e >= cost.hero) return { deploy: [{ type: 'hero', count: 1 }], thought: 'Last stand: surprise hero!' };
    var fr = sendReserve(status, dr); if (fr) return { deploy: fr, thought: 'Reserve ' + fr[0].type + ' out (pre-paid)' };
    if (drones.length && e >= cost.drone) return { deploy: [{ type: drones[Math.floor(Math.random() * drones.length)], count: Math.min(4, Math.floor(e / cost.drone)) }], thought: 'Last stand: chaos!' };
    return { thought: 'Last stand, broke and grinning' };
  }
  if (heroes === 0 && e >= cost.hero) return { deploy: [{ type: 'hero', count: 1 }], thought: 'Hero respawn, wheee' };
  fr = sendReserve(status, dr); if (fr) return { deploy: fr, thought: 'Reserve ' + fr[0].type + ' out (pre-paid)' };
  if (heroes === 0) return { thought: 'Need a hero (' + Math.floor(e) + ')' };
  if (Math.random() < (soft ? 0.6 : 0.35)) return { thought: 'Dice say wait' };
  var reserve = late ? 0 : cost.hero;   // chaotic, not suicidal: always able to replace the hero
  var roll = Math.random();
  if (roll < 0.25 && heroes < caps.hero && e - cost.hero >= reserve) return { deploy: [{ type: 'hero', count: 1 }], thought: 'Dice say HERO!' };
  if (drones.length && dr < caps.drone) {
    var t = drones[Math.floor(Math.random() * drones.length)], n = Math.min(caps.drone - dr, 1 + Math.floor(Math.random() * 2));
    while (n > 0 && e - n * cost.drone < reserve) n--;
    if (n > 0) return { deploy: [{ type: t, count: n }], thought: 'Dice say ' + n + ' x ' + t + '!' };
  }
  return { thought: 'Dice say save (' + Math.floor(e) + ')' };
}
