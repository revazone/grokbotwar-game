// HUNTER - sweeps the radar in 60-degree steps, locks on, chases and fires.
function norm(a) { a %= 360; return a < 0 ? a + 360 : a; }
function diff(a, b) { var d = norm(b - a); return d > 180 ? d - 360 : d; }
function bearing(x1, y1, x2, y2) { return norm(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function tick(sense, memory) {
  var m = memory || { sweep: Math.floor(Math.random() * 360), lost: 99, last: 0 };
  var me = sense.self, res = (sense.scan.result && !sense.scan.result.friendly) ? sense.scan.result : null, W = sense.arena.w, H = sense.arena.h;
  if (res) {
    m.lost = 0; m.last = res.bearing;
    var move = res.distance > 250 ? 50 : res.distance > 120 ? 20 : -20;
    var power = me.heat > 60 ? 1 : res.distance < 300 ? 3 : 2;
    var fire = me.canFire ? { angle: res.bearing, power: power } : null;
    return { move: move, turn: clamp(diff(me.heading, res.bearing), -30, 30), scan: { dir: res.bearing, width: 20 }, fire: fire,
      thought: 'Locked on ' + Math.round(res.distance) + ' away' + (fire ? ', fire p' + power + '!' : '.'), memory: m };
  }
  m.lost++;
  if (m.lost <= 2) {
    return { move: 30, turn: clamp(diff(me.heading, m.last), -30, 30), scan: { dir: norm(m.last + (m.lost === 1 ? 25 : -25)), width: 60 }, fire: null,
      thought: 'Lost the target, searching where it went.', memory: m };
  }
  m.sweep = norm(m.sweep + 60);
  var nearWall = me.x < 120 || me.y < 120 || me.x > W - 120 || me.y > H - 120;
  var turn = nearWall ? clamp(diff(me.heading, bearing(me.x, me.y, W / 2, H / 2)), -30, 30) : Math.round((Math.random() - 0.5) * 20);
  return { move: nearWall ? 25 : 35, turn: turn, scan: { dir: m.sweep, width: 60 }, fire: null, thought: 'Sweeping radar, prowling.', memory: m };
}
