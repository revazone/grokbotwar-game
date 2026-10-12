// TURTLE - hugs corners, watches the open quadrant, fires at anything it sees, moves along the wall when hit.
function norm(a) { a %= 360; return a < 0 ? a + 360 : a; }
function diff(a, b) { var d = norm(b - a); return d > 180 ? d - 360 : d; }          // signed b - a in (-180,180]
function bearing(x1, y1, x2, y2) { return norm(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }

function tick(sense, memory) {
  var m = memory || { corner: null, sweep: 0, lastHealth: 100 };
  var me = sense.self, W = sense.arena.w, H = sense.arena.h, pad = 30;
  var corners = [[pad, pad], [W - pad, pad], [W - pad, H - pad], [pad, H - pad]];
  if (m.corner === null) {
    var best = 0, bd = 1e9;
    for (var i = 0; i < 4; i++) { var d = dist(me.x, me.y, corners[i][0], corners[i][1]); if (d < bd) { bd = d; best = i; } }
    m.corner = best;
  }
  var hurt = me.health < m.lastHealth; m.lastHealth = me.health;
  if (hurt && dist(me.x, me.y, corners[m.corner][0], corners[m.corner][1]) < 60) m.corner = (m.corner + 1) % 4;
  var tx = corners[m.corner][0], ty = corners[m.corner][1];
  var toCorner = bearing(me.x, me.y, tx, ty);
  var inward = bearing(me.x, me.y, W / 2, H / 2);
  var res = sense.scan.result;

  m.sweep = (m.sweep + 1) % 4;
  var scan = { dir: norm(inward + [-25, 0, 25, 0][m.sweep]), width: 90 };
  var fire = null, move = 0, turn = 0, thought;
  if (res) {
    scan = { dir: res.bearing, width: 40 };
    if (me.canFire) fire = { angle: res.bearing, power: res.distance < 350 ? 3 : 2 };
  }
  if (dist(me.x, me.y, tx, ty) > 40) {
    var dd = diff(me.heading, toCorner);
    if (Math.abs(dd) <= 90) { turn = clamp(dd, -30, 30); move = Math.abs(dd) < 45 ? 45 : 15; }
    else { var back = norm(toCorner + 180); turn = clamp(diff(me.heading, back), -30, 30); move = Math.abs(diff(me.heading, back)) < 45 ? -45 : -15; }
    thought = hurt ? 'Ouch! Scuttling along the wall to corner ' + (m.corner + 1) : 'Heading for corner ' + (m.corner + 1);
  } else {
    turn = clamp(diff(me.heading, inward), -10, 10);
    thought = 'Shell closed, watching the room.';
  }
  if (res) thought = (fire ? 'Snap! Firing p' + fire.power : 'Too hot to fire,') + ' at contact ' + Math.round(res.distance) + ' away';
  return { move: move, turn: turn, scan: scan, fire: fire, thought: thought, memory: m };
}
