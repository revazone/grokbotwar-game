// HUNTER swarm drone (style loadout; from scripts/drones/swarm.js). Charges the nearest enemy it scans and fires
// point blank (holds fire if a teammate is in the way). Cheap and reckless: the pressure in every wave.
function norm(a) { a = a % 360; return a < 0 ? a + 360 : a; }
function diff(a, b) { var d = norm(b - a); return d > 180 ? d - 360 : d; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function bearingTo(x1, y1, x2, y2) { return norm(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI); }
function allyInLine(sense, b, d) {
  var me = sense.self, al = sense.allies || [];
  for (var i = 0; i < al.length; i++) {
    var dx = al[i].x - me.x, dy = al[i].y - me.y, ad = Math.sqrt(dx * dx + dy * dy);
    if (ad < d && Math.abs(diff(b, bearingTo(me.x, me.y, al[i].x, al[i].y))) < 12) return true;
  }
  return false;
}

function tick(sense, memory) {
  var m = memory || { sweep: 0 };
  var me = sense.self, L = sense.limits, W = sense.arena.w, H = sense.arena.h;
  var res = sense.scan.result;
  var cmd = { move: L.maxMove, turn: 0, fire: null };
  if (res && !res.friendly) {
    m.b = res.bearing; m.t = sense.tick;
    cmd.turn = clamp(diff(me.heading, res.bearing), -L.maxTurn, L.maxTurn);
    if (res.distance < 70) cmd.move = 0;
    if (me.canFire && !allyInLine(sense, res.bearing, res.distance)) cmd.fire = { angle: res.bearing, power: 1 };
    cmd.scan = { dir: res.bearing, width: 24 };
    cmd.thought = 'Charging ' + Math.round(res.distance);
  } else if (m.t && sense.tick - m.t < 8) {
    cmd.turn = clamp(diff(me.heading, m.b), -L.maxTurn, L.maxTurn);
    cmd.scan = { dir: norm(m.b + ((sense.tick % 2) ? 30 : -30)), width: 60 };
    cmd.thought = 'Chasing last contact';
  } else {
    m.sweep = (m.sweep + 1) % 6;
    cmd.scan = { dir: m.sweep * 60, width: 60 };
    cmd.turn = clamp(diff(me.heading, bearingTo(me.x, me.y, W / 2, H / 2)), -15, 15);
    cmd.move = 30;
    cmd.thought = 'Hunting';
  }
  if (me.x < 40 || me.y < 40 || me.x > W - 40 || me.y > H - 40) cmd.turn = clamp(diff(me.heading, bearingTo(me.x, me.y, W / 2, H / 2)), -L.maxTurn, L.maxTurn);
  cmd.memory = m;
  return cmd;
}
