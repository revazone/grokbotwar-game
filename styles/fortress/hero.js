// FORTRESS hero (style loadout).
// Doctrine: hold the home corner and let them come. Paces between two posts along the walls (a moving target,
// but never leaves the corner), watches the open quadrant, hits hard at anything that comes in range.
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
var POST = 120, SPAN = 200;   // posts 200 apart along the two walls (was 150 on the 1200-wide field)
function tick(sense, memory) {
  var me = sense.self, L = sense.limits, W = sense.arena.w, H = sense.arena.h;
  var m = memory;
  if (!m) {
    var cx = me.x < W / 2 ? POST : W - POST, cy = me.y < H / 2 ? POST : H - POST;
    var ix = me.x < W / 2 ? 1 : -1, iy = me.y < H / 2 ? 1 : -1;   // inward directions
    m = { cx: cx, cy: cy, posts: [[cx + ix * SPAN, cy], [cx, cy + iy * SPAN]], p: 0, sweep: 0 };
  }
  var tg = track(sense, m);
  var cmd = { move: 0, turn: 0, fire: null }, thought;
  var post = m.posts[m.p];
  if (dist(me.x, me.y, post[0], post[1]) < 30 || me.damageTakenLastTick > 0 && Math.random() < 0.5) m.p = 1 - m.p;
  post = m.posts[m.p];
  var want = bearingTo(me.x, me.y, post[0], post[1]), spd = Math.min(L.maxMove, 10 + dist(me.x, me.y, post[0], post[1]));
  var inward = bearingTo(m.cx, m.cy, W / 2, H / 2);
  if (tg) {
    var d = tg.d, aim = leadAngle(sense, tg, 0.85);
    var power = d < 600 ? 3 : 2;   // full power out to 600 (the 1500-wide field keeps contacts farther out)
    if (!canShoot(me, L, power)) power = canShoot(me, L, 1) && d < 250 ? 1 : 0;
    if (power && !allyInLine(sense, aim, d)) { cmd.fire = { angle: aim, power: power }; }
    cmd.scan = { dir: bearingTo(me.x, me.y, tg.x + tg.vx, tg.y + tg.vy), width: 16 };
    thought = (cmd.fire ? 'Contact ' + Math.round(d) + ', firing p' + power : 'Contact ' + Math.round(d) + ', barrel cooling') + ' from the walls';
  } else if (m.tg && sense.tick - m.tg.t < 4) {
    var k = sense.tick - m.tg.t;
    cmd.scan = { dir: norm(bearingTo(me.x, me.y, m.tg.x + m.tg.vx * k, m.tg.y + m.tg.vy * k) + (k % 2 ? 18 : -18)), width: 40 };
    thought = 'Lost contact, watching the gap';
  } else {
    m.sweep = (m.sweep + 1) % 3;
    cmd.scan = { dir: norm(inward + [-30, 0, 30][m.sweep]), width: 90 };
    thought = 'Holding the corner';
  }
  var dr = drive(me, want, spd, L);
  cmd.move = dr.move; cmd.turn = dr.turn;
  cmd.thought = thought; cmd.memory = m;
  return cmd;
}
