// SNIPER - stays still-ish, narrow 12-degree scan, full-power shots; sidesteps when hit.
function norm(a) { a %= 360; return a < 0 ? a + 360 : a; }
function diff(a, b) { var d = norm(b - a); return d > 180 ? d - 360 : d; }
function bearing(x1, y1, x2, y2) { return norm(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

var W_SCAN = 12;
function tick(sense, memory) {
  var me = sense.self, res = (sense.scan.result && !sense.scan.result.friendly) ? sense.scan.result : null, W = sense.arena.w, H = sense.arena.h;
  var center = bearing(me.x, me.y, W / 2, H / 2);
  var m = memory || { sweep: norm(center - 60), lock: null, lost: 0, relocate: 0 };
  var move = 0, turn = 0;
  if (me.damageTakenLastTick > 0) m.relocate = 3;
  if (m.relocate > 0) {
    m.relocate--;
    var side = norm(center + 90);
    turn = clamp(diff(me.heading, side), -30, 30);
    move = Math.abs(diff(me.heading, side)) < 60 ? 40 : 0;
    if (me.x < 60 || me.y < 60 || me.x > W - 60 || me.y > H - 60) { turn = clamp(diff(me.heading, center), -30, 30); move = 30; }
  }
  if (res) {
    m.lock = res.bearing; m.lost = 0;
    var fire = me.canFire ? { angle: res.bearing, power: 3 } : null;
    return { move: move, turn: turn, scan: { dir: res.bearing, width: W_SCAN }, fire: fire,
      thought: fire ? 'Target ' + Math.round(res.distance) + ' out. Full power shot.' : 'Tracking target, barrel cooling.', memory: m };
  }
  if (m.lock !== null && m.lost < 3) {
    m.lost++;
    var offs = [W_SCAN, -W_SCAN, 2 * W_SCAN][m.lost - 1];
    return { move: move, turn: turn, scan: { dir: norm(m.lock + offs), width: W_SCAN * 1.5 }, fire: null, thought: 'Lost the target in my scope, checking nearby.', memory: m };
  }
  m.lock = null;
  m.sweep = norm(m.sweep + W_SCAN);
  return { move: move, turn: turn, scan: { dir: m.sweep, width: W_SCAN }, fire: null,
    thought: m.relocate > 0 ? 'Taking fire, shifting position.' : 'Glassing the field.', memory: m };
}
