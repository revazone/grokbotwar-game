// SHARPSHOOTER picket drone (style loadout). Spotter and harasser: sweeps wide, circles contacts at ~300
// (out of easy reach) firing power 1, which also drags enemy attention off the hero.
// Holds fire if a teammate is in the line of fire. Memory: last contact {b, d, t}, orbit direction.
function norm(a) { a = a % 360; return a < 0 ? a + 360 : a; }
function diff(a, b) { var d = norm(b - a); return d > 180 ? d - 360 : d; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function bearingTo(x1, y1, x2, y2) { return norm(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI); }
function dist(x1, y1, x2, y2) { return Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)); }
// true if any ally is roughly on the line from me toward bearing b, closer than d
function allyInLine(sense, b, d) {
  var me = sense.self, al = sense.allies || [];
  for (var i = 0; i < al.length; i++) {
    var ad = dist(me.x, me.y, al[i].x, al[i].y);
    if (ad < d && Math.abs(diff(b, bearingTo(me.x, me.y, al[i].x, al[i].y))) < 12) return true;
  }
  return false;
}
function steer(me, want, maxTurn) { return clamp(diff(me.heading, want), -maxTurn, maxTurn); }

function tick(sense, memory) {
  var m = memory || { dir: Math.random() < 0.5 ? 1 : -1, sweep: 0 };
  var me = sense.self, L = sense.limits, W = sense.arena.w, H = sense.arena.h;
  var res = sense.scan.result;
  var cmd = { move: L.maxMove, turn: 0, fire: null };
  // wall avoidance: steer toward centre when close to an edge
  var nearWall = me.x < 70 || me.y < 70 || me.x > W - 70 || me.y > H - 70;
  if (res && !res.friendly) {
    m.b = res.bearing; m.d = res.distance; m.t = sense.tick;
    // orbit: keep target at ~90 degrees, drift in/out to hold ~300
    var want = norm(res.bearing + m.dir * (res.distance > 340 ? 45 : res.distance < 260 ? 120 : 90));
    cmd.turn = steer(me, want, L.maxTurn);
    if (me.canFire && !allyInLine(sense, res.bearing, res.distance)) cmd.fire = { angle: res.bearing, power: 1 };
    cmd.scan = { dir: res.bearing, width: 20 };
    cmd.thought = 'Orbiting contact at ' + Math.round(res.distance);
  } else if (m.t && sense.tick - m.t < 6) {
    cmd.turn = steer(me, m.b, L.maxTurn);
    cmd.scan = { dir: norm(m.b + ((sense.tick % 2) ? 25 : -25)), width: 50 };
    cmd.thought = 'Re-acquiring';
  } else {
    m.sweep = (m.sweep + 1) % 6;
    cmd.scan = { dir: norm(me.heading + m.sweep * 60), width: 60 };
    cmd.turn = steer(me, bearingTo(me.x, me.y, W / 2, H / 2), 8);
    cmd.thought = 'Patrolling';
  }
  if (nearWall) { cmd.turn = steer(me, bearingTo(me.x, me.y, W / 2, H / 2), L.maxTurn); m.dir = -m.dir; }
  if (me.hitWallLastTick) cmd.move = -L.maxMove / 2;
  cmd.memory = m;
  return cmd;
}
