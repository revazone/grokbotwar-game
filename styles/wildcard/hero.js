// WILDCARD hero (style loadout).
// Doctrine: be hard to read. Switches moods at random (orbit, charge, zig-zag, drift) every few seconds and
// varies its shot power, but when it has a target it still leads and aims properly.
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
var MOODS = ['orbit', 'charge', 'zigzag', 'drift'];
var LINES = { orbit: 'Round and round', charge: 'Surprise!', zigzag: 'Zig. Zag.', drift: 'Who needs a plan?' };
function tick(sense, memory) {
  var m = memory || { mood: 'drift', mt: 0, dir: 1, sweep: 0, wob: 0 };
  var me = sense.self, L = sense.limits, W = sense.arena.w, H = sense.arena.h;
  if (--m.mt <= 0) { m.mood = MOODS[Math.floor(Math.random() * MOODS.length)]; m.mt = 15 + Math.floor(Math.random() * 30); m.dir = Math.random() < 0.5 ? 1 : -1; }
  if (me.damageTakenLastTick > 0 && Math.random() < 0.3) m.dir = -m.dir;
  var tg = track(sense, m);
  var cmd = { move: 0, turn: 0, fire: null }, want, spd = L.maxMove, thought = LINES[m.mood];
  m.wob = (m.wob + 1) % 8;
  var ref = tg ? tg.b : (m.tg && sense.tick - m.tg.t < 8 ? bearingTo(me.x, me.y, m.tg.x, m.tg.y) : bearingTo(me.x, me.y, W / 2, H / 2));
  var d = tg ? tg.d : 400;
  if (m.mood === 'orbit') want = norm(ref + m.dir * (d > 300 ? 60 : 100));
  else if (m.mood === 'charge') want = d > 150 ? norm(ref + m.dir * 20) : norm(ref + m.dir * 110);
  else if (m.mood === 'zigzag') want = norm(ref + (m.wob < 4 ? 50 : -50));
  else { want = norm(me.heading + (Math.random() - 0.5) * 50); spd = 30; }
  if (tg) {
    var aim = leadAngle(sense, tg, 0.6 + Math.random() * 0.4);
    var power = d < 200 ? 3 : 1 + Math.floor(Math.random() * 3);
    if (!canShoot(me, L, power)) power = 1;
    if (canShoot(me, L, power) && !allyInLine(sense, aim, d)) { cmd.fire = { angle: aim, power: power }; thought += ' Spray p' + power + '!'; }
    cmd.scan = { dir: bearingTo(me.x, me.y, tg.x + tg.vx, tg.y + tg.vy), width: 20 };
  } else if (m.tg && sense.tick - m.tg.t < 5) {
    cmd.scan = { dir: norm(ref + (Math.random() - 0.5) * 50), width: 50 };
  } else {
    m.sweep = (m.sweep + 1 + Math.floor(Math.random() * 2)) % 4;
    cmd.scan = { dir: m.sweep * 90 + Math.random() * 20, width: 90 };
  }
  var dr = drive(me, wallSafe(sense, want, 80), spd, L);
  cmd.move = dr.move; cmd.turn = dr.turn;
  cmd.thought = thought; cmd.memory = m;
  return cmd;
}
