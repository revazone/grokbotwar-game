// Circle-strafer: orbits the arena centre, sweeps the radar, locks on and fires with power based on range.
function norm(a) { a %= 360; return a < 0 ? a + 360 : a; }
function diff(a, b) { var d = norm(b - a); return d > 180 ? d - 360 : d; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function bearing(x1, y1, x2, y2) { return norm(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI); }

function tick(sense, memory) {
  var m = memory || { sweep: 0, lostFor: 99, lastBearing: 0 };
  var me = sense.self, res = sense.scan.result;
  // Movement: keep the centre on our right-hand side (heading = bearing to centre - 90) and stay off the walls.
  var toCenter = bearing(me.x, me.y, sense.arena.w / 2, sense.arena.h / 2);
  var desired = norm(toCenter - 90);
  var nearWall = me.x < 80 || me.y < 80 || me.x > sense.arena.w - 80 || me.y > sense.arena.h - 80;
  if (nearWall) desired = toCenter;
  var cmd = { move: 40, turn: clamp(diff(me.heading, desired), -30, 30), fire: null };

  if (res && !res.friendly) {
    m.lostFor = 0; m.lastBearing = res.bearing;
    cmd.scan = { dir: res.bearing, width: 16 };            // stay locked with a narrow arc
    var power = res.distance < 250 ? 3 : res.distance < 500 ? 2 : 1;
    if (me.heat + 14 * power <= 100) cmd.fire = { angle: res.bearing, power: power };
    cmd.thought = "Target " + Math.round(res.distance) + " away at " + Math.round(res.bearing) + " deg" + (cmd.fire ? ", firing p" + power : ", cooling");
  } else if (m.lostFor < 3) {
    m.lostFor++;                                            // re-acquire around the last known bearing
    cmd.scan = { dir: m.lastBearing + (m.lostFor % 2 ? 20 : -20), width: 50 };
    cmd.thought = "Lost contact, searching near " + Math.round(m.lastBearing) + " deg";
  } else {
    m.sweep = norm(m.sweep + 60);                           // full sweep in 6 ticks
    cmd.scan = { dir: m.sweep, width: 60 };
    cmd.thought = "Sweeping radar at " + m.sweep + " deg";
  }
  cmd.memory = m;
  return cmd;
}
