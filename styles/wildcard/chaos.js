// WILDCARD chaos drone (style loadout; from scripts/drones/chaos-drone.js). Random walk with sudden turns; fires
// at anything hostile it sees.
function norm(a) { a = a % 360; return a < 0 ? a + 360 : a; }
function tick(sense, memory) {
  var me = sense.self, L = sense.limits;
  var cmd = { move: L.maxMove * (0.4 + Math.random() * 0.6), turn: (Math.random() * 2 - 1) * L.maxTurn, fire: null,
              scan: { dir: Math.floor(Math.random() * 360), width: 60 }, thought: 'Wheee' };
  var res = sense.scan.result;
  if (res && !res.friendly) { if (me.canFire) cmd.fire = { angle: res.bearing, power: 1 }; cmd.scan = { dir: res.bearing, width: 30 }; cmd.thought = 'Spraying'; }
  if (me.hitWallLastTick) { cmd.move = -L.maxMove; cmd.turn = L.maxTurn; }
  return cmd;
}
