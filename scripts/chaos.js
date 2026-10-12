// CHAOS - random-ish everything. Fires at anything seen, sometimes at nothing.
function norm(a) { a %= 360; return a < 0 ? a + 360 : a; }
function diff(a, b) { var d = norm(b - a); return d > 180 ? d - 360 : d; }
function bearing(x1, y1, x2, y2) { return norm(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
var MOODS = ['WHEEE', 'Spin to win', 'Who needs a plan?', 'Zig. Zag.', 'Bzzt.', 'I am the storm'];

function tick(sense, memory) {
  var m = memory || { bias: 0 };
  var me = sense.self, res = (sense.scan.result && !sense.scan.result.friendly) ? sense.scan.result : null;
  if (Math.random() < 0.15) m.bias = (Math.random() - 0.5) * 50;
  var turn = Math.round(clamp(m.bias + (Math.random() - 0.5) * 20, -30, 30));
  var move = Math.round(clamp((Math.random() * 1.4 - 0.4) * 50, -50, 50));
  if (me.hitWallLastTick) { turn = Math.round(clamp(diff(me.heading, bearing(me.x, me.y, sense.arena.w / 2, sense.arena.h / 2)), -30, 30)); move = 40; }
  var fire = null, thought = MOODS[Math.floor(Math.random() * MOODS.length)];
  if (res && me.canFire) { fire = { angle: Math.round(norm(res.bearing + (Math.random() - 0.5) * 10)), power: 1 + Math.floor(Math.random() * 3) }; thought += ' Something there! Spray p' + fire.power + '!'; }
  else if (me.canFire && Math.random() < 0.12) { fire = { angle: Math.round(Math.random() * 360), power: 1 }; thought += ' Random shot, why not.'; }
  return { move: move, turn: turn, scan: { dir: Math.round(Math.random() * 360), width: Math.round(30 + Math.random() * 60) }, fire: fire, thought: thought, memory: m };
}
