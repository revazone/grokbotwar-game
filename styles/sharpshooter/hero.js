// SHARPSHOOTER hero (style loadout).
// Doctrine: stay 380-620 from the target, strafe across its line of fire (never stand still), narrow scope,
// full-power shots aimed where the target will be. Backs off from anything that closes in.
// ---- shared helpers (same in every style hero) ----
function norm(a) { a %= 360; return a < 0 ? a + 360 : a; }
function diff(a, b) { var d = norm(b - a); return d > 180 ? d - 360 : d; }   // signed turn from a to b
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function bearingTo(x1, y1, x2, y2) { return norm(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI); }
function dist(x1, y1, x2, y2) { return Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)); }
function rad(a) { return a * Math.PI / 180; }
// true if a teammate is roughly on the line of fire (closer than the target)
function allyInLine(sense, b, d) {
  var me = sense.self, al = sense.allies || [];
  for (var i = 0; i < al.length; i++) {
    var ad = dist(me.x, me.y, al[i].x, al[i].y);
    if (ad < d && Math.abs(diff(b, bearingTo(me.x, me.y, al[i].x, al[i].y))) < Math.max(6, 35 * 30 / Math.max(ad, 30))) return true;
  }
  return false;
}
// Track the scanned enemy: position + velocity estimate in m.tg = {x, y, vx, vy, t, kind}
function track(sense, m) {
  var me = sense.self, r = sense.scan.result;
  if (!r || r.friendly) return null;
  var x = me.x + Math.cos(rad(r.bearing)) * r.distance, y = me.y + Math.sin(rad(r.bearing)) * r.distance;
  var p = m.tg, vx = 0, vy = 0;
  if (p && sense.tick - p.t <= 2 && p.kind === r.kind && dist(x, y, p.x, p.y) < 70 * (sense.tick - p.t)) {
    var k = sense.tick - p.t; vx = (x - p.x) / k; vy = (y - p.y) / k;
    vx = 0.6 * vx + 0.4 * (p.vx || 0); vy = 0.6 * vy + 0.4 * (p.vy || 0);   // smooth
  }
  m.tg = { x: x, y: y, vx: vx, vy: vy, t: sense.tick, kind: r.kind, d: r.distance, b: r.bearing };
  return m.tg;
}
// Lead the target: angle to where it will be when the shell arrives (lead = 0..1 how much to trust velocity)
function leadAngle(sense, tg, lead) {
  var me = sense.self, sp = sense.limits.shellSpeed, px = tg.x, py = tg.y, t = 0;
  for (var i = 0; i < 4; i++) { t = 1 + dist(me.x, me.y, px, py) / sp; px = tg.x + tg.vx * t * lead; py = tg.y + tg.vy * t * lead; }
  px = clamp(px, 10, sense.arena.w - 10); py = clamp(py, 10, sense.arena.h - 10);
  return bearingTo(me.x, me.y, px, py);
}
// Drive toward heading `want` (reverse if it is behind us), at speed `spd`
function drive(me, want, spd, L) {
  var d = diff(me.heading, want);
  if (Math.abs(d) <= 100) { var t = clamp(d, -L.maxTurn, L.maxTurn); return { turn: t, move: Math.abs(d - t) < 50 ? spd : spd * 0.3 }; }
  var back = norm(want + 180), db = diff(me.heading, back), tb = clamp(db, -L.maxTurn, L.maxTurn);
  return { turn: tb, move: Math.abs(db - tb) < 50 ? -spd : -spd * 0.3 };
}
// Keep off the walls: bend heading `want` toward the centre when close to an edge
function wallSafe(sense, want, margin) {
  var me = sense.self, W = sense.arena.w, H = sense.arena.h;
  var nx = Math.cos(rad(want)), ny = Math.sin(rad(want));
  if ((me.x < margin && nx < 0) || (me.x > W - margin && nx > 0) || (me.y < margin && ny < 0) || (me.y > H - margin && ny > 0)) {
    var c = bearingTo(me.x, me.y, W / 2, H / 2);
    return norm(c + clamp(diff(c, want), -70, 70));
  }
  return want;
}
function canShoot(me, L, power) { return me.heat + L.heatPerPower * power <= L.maxHeat; }
// ---- end helpers ----
var NEAR = 380, FAR = 620, SCOPE = 12;
function tick(sense, memory) {
  var m = memory || { sweep: 0, dir: Math.random() < 0.5 ? 1 : -1, flip: 0 };
  var me = sense.self, L = sense.limits, W = sense.arena.w, H = sense.arena.h;
  var center = bearingTo(me.x, me.y, W / 2, H / 2);
  var tg = track(sense, m);
  var cmd = { move: 0, turn: 0, fire: null }, want, spd = L.maxMove, thought;
  if (me.damageTakenLastTick > 0 || --m.flip <= 0) { m.dir = -m.dir; m.flip = 18 + Math.floor(Math.random() * 18); }
  if (tg) {
    var d = tg.d, b = tg.b;
    if (d < NEAR) { want = norm(b + 180 + m.dir * 40); thought = 'Too close (' + Math.round(d) + '), backing off'; }
    else if (d > FAR) { want = norm(b + m.dir * 50); spd = 35; thought = 'Closing to range ' + Math.round(d); }
    else { want = norm(b + m.dir * 90); spd = 40; thought = 'In range ' + Math.round(d); }
    var aim = leadAngle(sense, tg, 0.9);
    var power = d < 250 ? 2 : 3;
    if (canShoot(me, L, power) && !allyInLine(sense, aim, d)) { cmd.fire = { angle: aim, power: power }; thought += ', firing p' + power; }
    // keep the scope on where it will be next tick
    var nb = bearingTo(me.x, me.y, tg.x + tg.vx, tg.y + tg.vy);
    cmd.scan = { dir: nb, width: SCOPE };
  } else if (m.tg && sense.tick - m.tg.t < 5) {
    var k = sense.tick - m.tg.t, gx = m.tg.x + m.tg.vx * k, gy = m.tg.y + m.tg.vy * k;
    cmd.scan = { dir: norm(bearingTo(me.x, me.y, gx, gy) + [0, 14, -14, 28, -28][k % 5]), width: SCOPE * 2 };
    want = norm(bearingTo(me.x, me.y, gx, gy) + m.dir * 90); spd = 30;
    thought = 'Lost the target, checking where it went';
  } else {
    m.sweep = (m.sweep + 1) % 5;
    cmd.scan = { dir: norm(center - 80 + m.sweep * 40), width: 45 };
    if (me.x < 100 || me.y < 100 || me.x > W - 100 || me.y > H - 100) { want = center; spd = 25; }
    else { want = norm(center + m.dir * 90); spd = 20; }
    thought = 'Glassing the field';
  }
  var dr = drive(me, wallSafe(sense, want, 90), spd, L);
  cmd.move = dr.move; cmd.turn = dr.turn;
  cmd.thought = thought; cmd.memory = m;
  return cmd;
}
