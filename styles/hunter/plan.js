// HUNTER battle plan (style loadout). Pressure: launch drones in waves so they arrive together, keep the hero
// in the fight, and keep just enough in the bank to replace a lost hero. Pre-paid reserve drones (arsenal) go out
// as soon as there's room: they cost nothing.
// Pre-paid reserve drones (arsenal, ROBOT-API 7a): already paid for, so send them whenever there's room under the cap.
function sendReserve(status, dr) {
  var rs = status.arsenal ? status.arsenal.reserve : null;
  if (rs) for (var t in rs) if (rs[t] > 0 && dr < status.caps.drone) return [{ type: t, count: Math.min(rs[t], status.caps.drone - dr) }];
  return null;
}
function command(status, memory) {
  var m = memory || { wave: 0 };
  var c = status.counts, e = status.energy, cost = status.costs, caps = status.caps, drones = status.roster.drones;
  var heroes = c.hero + c.pendingHero, dr = c.drone + c.pendingDrone, late = status.ticksLeft < 300;
  var soft = !!status.soft;
  if (heroes + dr === 0) {
    if (e >= cost.hero) return { deploy: [{ type: 'hero', count: 1 }], thought: 'Last stand: back into the hunt', memory: m };
    var fr = sendReserve(status, dr); if (fr) return { deploy: fr, thought: 'Reserve ' + fr[0].type + ' out (pre-paid)', memory: m };
    if (drones.length && e >= cost.drone) return { deploy: [{ type: drones[0], count: Math.min(4, Math.floor(e / cost.drone)) }], thought: 'Last stand: release the pack', memory: m };
    return { thought: 'Last stand, broke', memory: m };
  }
  if (heroes === 0 && e >= cost.hero) return { deploy: [{ type: 'hero', count: 1 }], thought: 'New hero, the hunt goes on', memory: m };
  fr = sendReserve(status, dr); if (fr) return { deploy: fr, thought: 'Reserve ' + fr[0].type + ' out (pre-paid)', memory: m };
  if (heroes === 0) return { thought: 'Saving for a hero (' + Math.floor(e) + ')', memory: m };
  var reserve = late ? 0 : cost.hero;   // waves come out of the surplus: always cover a new hero
  var room = caps.drone - dr, n = Math.min(soft ? 2 : 3, room);
  if (drones.length && n >= 1 && (n >= 2 || dr === 0 || late) && e - n * cost.drone >= reserve) {
    m.wave++;
    var type = drones[m.wave % drones.length];
    return { deploy: [{ type: type, count: n }], thought: 'Wave ' + m.wave + ': ' + n + ' x ' + type + ' - go!', memory: m };
  }
  if (heroes < caps.hero && e >= cost.hero + (late ? 0 : 60)) return { deploy: [{ type: 'hero', count: 1 }], thought: 'Second hunter joins the chase', memory: m };
  return { thought: 'Massing for wave ' + (m.wave + 1) + ' (' + Math.floor(e) + ')', memory: m };
}
