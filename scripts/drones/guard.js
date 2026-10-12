// GUARD drone (example). Escorts the team hero: stays 60-120 from it, sweeps around, fires power 1 at enemies
// within 450. If no hero is alive it holds near the home spot it spawned at.
function norm(a) { a = a % 360; return a < 0 ? a + 360 : a; }
function diff(a, b) { var d = norm(b - a); return d > 180 ? d - 360 : d; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function bearingTo(x1, y1, x2, y2) { return norm(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI); }
function dist(x1, y1, x2, y2) { return Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)); }
function allyInLine(sense, b, d) {
  var me = sense.self, al = sense.allies || [];
  for (var i = 0; i < al.length; i++) {
    var ad = dist(me.x, me.y, al[i].x, al[i].y);
    if (ad < d && Math.abs(diff(b, bearingTo(me.x, me.y, al[i].x, al[i].y))) < 12) return true;
  }
  return false;
}
function driveTo(me, tx, ty, L) {
  var d = dist(me.x, me.y, tx, ty); if (d < 8) return { move: 0, turn: 0 };
  var dd = diff(me.heading, bearingTo(me.x, me.y, tx, ty)), t = clamp(dd, -L.maxTurn, L.maxTurn);
  return { move: Math.abs(dd - t) < 30 ? Math.min(L.maxMove, d) : 0, turn: t };
}

function tick(sense, memory) {
  var m = memory || { sweep: 0 };
  var me = sense.self, L = sense.limits;
  if (m.hx === undefined) { m.hx = me.x; m.hy = me.y; }
  var hero = null, al = sense.allies || [];
  for (var i = 0; i < al.length; i++) if (al[i].kind === 'hero') { hero = al[i]; break; }
  var ax = hero ? hero.x : m.hx, ay = hero ? hero.y : m.hy;
  var d = dist(me.x, me.y, ax, ay);
  var cmd = { move: 0, turn: 0, fire: null };
  if (d > 120 || (!hero && d > 20)) { var dr = driveTo(me, ax, ay, L); cmd.move = dr.move; cmd.turn = dr.turn; }
  else if (hero && d < 60) { cmd.turn = clamp(diff(me.heading, bearingTo(ax, ay, me.x, me.y)), -L.maxTurn, L.maxTurn); cmd.move = 20; }
  var res = sense.scan.result;
  if (res && !res.friendly && res.distance < 450) {
    m.b = res.bearing; m.t = sense.tick;
    if (me.canFire && !allyInLine(sense, res.bearing, res.distance)) cmd.fire = { angle: res.bearing, power: 1 };
    cmd.scan = { dir: res.bearing, width: 16 };
    cmd.thought = 'Guarding: engaging at ' + Math.round(res.distance);
  } else if (m.t && sense.tick - m.t < 4) {
    cmd.scan = { dir: norm(m.b + ((sense.tick % 2) ? 20 : -20)), width: 45 };
    cmd.thought = 'Guarding: lost contact';
  } else {
    m.sweep = (m.sweep + 1) % 6;
    cmd.scan = { dir: m.sweep * 60 + 30, width: 60 };
    cmd.thought = hero ? 'Escorting hero' : 'Holding home';
  }
  cmd.memory = m;
  return cmd;
}
