// FORTRESS guard drone (style loadout). A living wall: takes a post 50-70 in front of the hero (between it and
// the arena centre, where fire comes from), so enemy shells hit the cheap drone instead of the hero. Fires
// power 1 at enemies within 500 when no teammate is in the line of fire. With no hero alive it holds home.
function norm(a) { a = a % 360; return a < 0 ? a + 360 : a; }
function diff(a, b) { var d = norm(b - a); return d > 180 ? d - 360 : d; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function bearingTo(x1, y1, x2, y2) { return norm(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI); }
function dist(x1, y1, x2, y2) { return Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)); }
function rad(a) { return a * Math.PI / 180; }
function allyInLine(sense, b, d) {
  var me = sense.self, al = sense.allies || [];
  for (var i = 0; i < al.length; i++) {
    var ad = dist(me.x, me.y, al[i].x, al[i].y);
    if (ad < d && Math.abs(diff(b, bearingTo(me.x, me.y, al[i].x, al[i].y))) < Math.max(8, 30 * 30 / Math.max(ad, 30))) return true;
  }
  return false;
}
function driveTo(me, tx, ty, L) {
  var d = dist(me.x, me.y, tx, ty); if (d < 6) return { move: 0, turn: 0 };
  var dd = diff(me.heading, bearingTo(me.x, me.y, tx, ty));
  if (Math.abs(dd) > 110) { var db = diff(me.heading, norm(bearingTo(me.x, me.y, tx, ty) + 180)), tb = clamp(db, -L.maxTurn, L.maxTurn); return { move: Math.abs(db - tb) < 30 ? -Math.min(L.maxMove, d) : 0, turn: tb }; }
  var t = clamp(dd, -L.maxTurn, L.maxTurn);
  return { move: Math.abs(dd - t) < 30 ? Math.min(L.maxMove, d) : 0, turn: t };
}

function tick(sense, memory) {
  var m = memory || { sweep: 0 };
  var me = sense.self, L = sense.limits, W = sense.arena.w, H = sense.arena.h;
  if (m.hx === undefined) { m.hx = me.x; m.hy = me.y; }
  var hero = null, al = sense.allies || [], guards = [me.id];
  for (var i = 0; i < al.length; i++) { if (al[i].kind === 'hero' && !hero) hero = al[i]; if (al[i].type === me.type) guards.push(al[i].id); }
  guards.sort(function (a, b) { return a - b; });
  var slot = guards.indexOf(me.id), n = guards.length;
  var ax = hero ? hero.x : m.hx, ay = hero ? hero.y : m.hy;
  // threat direction: last enemy seen, else the arena centre
  var threat = m.t && sense.tick - m.t < 30 ? m.b : bearingTo(ax, ay, W / 2, H / 2);
  var spread = n > 1 ? (slot - (n - 1) / 2) * 32 : 0;
  var a = norm(threat + spread), r = 60;
  var px = clamp(ax + Math.cos(rad(a)) * r, 15, W - 15), py = clamp(ay + Math.sin(rad(a)) * r, 15, H - 15);
  var cmd = { move: 0, turn: 0, fire: null };
  var dr = driveTo(me, px, py, L); cmd.move = dr.move; cmd.turn = dr.turn;
  var res = sense.scan.result;
  if (res && !res.friendly && res.distance < 500) {
    var ex = me.x + Math.cos(rad(res.bearing)) * res.distance, ey = me.y + Math.sin(rad(res.bearing)) * res.distance;
    m.b = bearingTo(ax, ay, ex, ey); m.sb = res.bearing; m.t = sense.tick;
    if (me.canFire && !allyInLine(sense, res.bearing, res.distance)) cmd.fire = { angle: res.bearing, power: 1 };
    cmd.scan = { dir: res.bearing, width: 16 };
    cmd.thought = 'Wall up: engaging at ' + Math.round(res.distance);
  } else if (m.t && sense.tick - m.t < 4) {
    cmd.scan = { dir: norm(m.sb + ((sense.tick % 2) ? 20 : -20)), width: 45 };
    cmd.thought = 'Wall up: lost contact';
  } else {
    m.sweep = (m.sweep + 1) % 4;
    cmd.scan = { dir: norm(bearingTo(me.x, me.y, W / 2, H / 2) - 90 + m.sweep * 60), width: 60 };
    cmd.thought = hero ? 'Screening the hero' : 'Holding home';
  }
  cmd.memory = m;
  return cmd;
}
