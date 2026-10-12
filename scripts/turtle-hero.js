// TURTLE HERO v2 (commander mode, spec v4)
// v2 changes (why), measured with local headless matches against the stubs:
// - All numbers come from sense.limits (hero/drone/classic stats differ in v4).
// - Friendly fire: never fires on res.friendly or on a contact that matches a known teammate position
//   (sense.allies), and holds fire when a teammate is near the line of fire (with a margin for its movement).
// - Collisions: the hero holds a wall segment of its corner, not the corner point, so it stays off the home
//   spawn spot (70,70). A 2nd hero takes the other wall of the same corner. Lower ids have right of way;
//   units never step closer to a teammate that is already near. The hero also won't drive into an enemy it sees.
// - Survival: the stubs don't lead their shots, so the hero keeps shuffling along its wall segment and,
//   per doctrine, slides along the wall to the next corner whenever it takes a hit (RELOC_HITS=1). It never
//   crosses open floor. (Holding still in the corner: ~44-74% wins; sliding on hits: ~80-88%.)
// - Scanning sweeps the half-plane in front of its wall in 30-degree arcs (the old 90-degree quadrant missed
//   enemies sitting along the far walls), then locks on with a narrow arc; leads movers a little.
// - Power: 3 under 300, 2 under 550, 1 beyond (max 2 against drones); drops power rather than skipping a shot.
// Memory: corner, role, last enemy fix (eb/ed/et + position), hits taken, recent-hit log.

var PAD = 24;
var SWEEP = [-75, -45, -15, 15, 45, 75], SWEEP_W = 30;   // arcs relative to the wall normal
var RELOC_HITS = 1, RELOC_WINDOW = 40, H_HI = 300, V_LO = 75, V_HI = 330;   // tuned by local matches
function norm(a) { a = a % 360; return a < 0 ? a + 360 : a; }
function diff(a, b) { var d = norm(b - a); return d > 180 ? d - 360 : d; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function bearing(x1, y1, x2, y2) { return norm(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI); }
function dist(x1, y1, x2, y2) { var dx = x2 - x1, dy = y2 - y1; return Math.sqrt(dx * dx + dy * dy); }
function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
function cornersOf(W, H, p) { return [[p, p], [W - p, p], [W - p, H - p], [p, H - p]]; }
function nearestCorner(x, y, W, H) { return (x < W / 2) ? (y < H / 2 ? 0 : 3) : (y < H / 2 ? 1 : 2); }

function driveTo(me, tx, ty, L) {
  var d = dist(me.x, me.y, tx, ty);
  if (d < 4) return { move: 0, turn: 0 };
  var b = bearing(me.x, me.y, tx, ty), dd = diff(me.heading, b), sign = 1;
  if (Math.abs(dd) > 90) { dd = diff(me.heading, norm(b + 180)); sign = -1; }
  var turn = clamp(dd, -L.maxTurn, L.maxTurn), rem = Math.abs(dd - turn);
  var mv = rem < 8 ? Math.min(L.maxMove, d) : rem < 40 ? Math.min(L.maxMove * 0.4, d) : 0;
  return { move: clamp(sign * mv, -L.maxMove, L.maxMove), turn: turn };
}

// is a teammate close to the shot line toward bearing b (target at distance d)?
function allyInLine(me, allies, b, d) {
  for (var i = 0; i < allies.length; i++) {
    var a = allies[i]; if (!a || typeof a.x !== 'number') continue;
    var ad = dist(me.x, me.y, a.x, a.y);
    if (ad > d + 60) continue;
    var r = a.kind === 'hero' ? 20 : 12;
    var half = Math.atan2(r + 28, Math.max(ad, 1)) * 180 / Math.PI + 3;
    if (Math.abs(diff(b, bearing(me.x, me.y, a.x, a.y))) < half) return true;
  }
  return false;
}
// does a contact match a known teammate position? (belt and braces on top of res.friendly)
function matchesAlly(me, allies, b, d) {
  var ex = me.x + Math.cos(b * Math.PI / 180) * d, ey = me.y + Math.sin(b * Math.PI / 180) * d;
  for (var i = 0; i < allies.length; i++) { var a = allies[i]; if (a && dist(ex, ey, a.x, a.y) < 45) return true; }
  return false;
}

function tick(sense, memory) {
  sense = sense || {};
  var Ls = sense.limits || {};
  var arena = sense.arena || Ls.arena || {}, W = num(arena.w, 1500), H = num(arena.h, 830); // arena size comes from sense (not square since API 4.5)
  var pw = Ls.power || [1, 3];
  var L = { maxMove: num(Ls.maxMove, 50), maxTurn: num(Ls.maxTurn, 30), maxW: num((Ls.scanWidth || [])[1], 90),
            maxP: num(pw[1], 3), hpp: num(Ls.heatPerPower, 14), maxHeat: num(Ls.maxHeat, 100), spd: num(Ls.shellSpeed, 110) };
  var s = sense.self || {};
  var me = { id: num(s.id, 0), x: num(s.x, W / 2), y: num(s.y, H / 2), heading: norm(num(s.heading, 0)),
             health: num(s.health, 100), heat: num(s.heat, 0), canFire: !!s.canFire, dmg: num(s.damageTakenLastTick, 0) };
  var now = num(sense.tick, 1);
  var allies = Array.isArray(sense.allies) ? sense.allies : [];
  var res = (sense.scan && sense.scan.result) ? sense.scan.result : null;

  var m = (memory && typeof memory === 'object') ? memory : {};
  if (typeof m.corner !== 'number') m.corner = nearestCorner(me.x, me.y, W, H);
  if (typeof m.hits !== 'number') m.hits = 0;
  if (!Array.isArray(m.hl)) m.hl = [];
  if (typeof m.sw !== 'number') m.sw = 0;
  if (typeof m.lastHp !== 'number') m.lastHp = me.health;
  var i, a;
  var cs = cornersOf(W, H, PAD), c = cs[m.corner];
  var sx = (m.corner === 0 || m.corner === 3) ? 1 : -1;   // direction along x away from the corner
  var sy = (m.corner === 0 || m.corner === 1) ? 1 : -1;

  // role (decided once): 'h' holds the horizontal wall of the corner, 'v' the vertical wall.
  // Take 'v' if another hero already sits on the horizontal segment, or if a lower-id hero exists that is not on 'v'.
  if (m.role !== 'h' && m.role !== 'v') {
    m.role = 'h';
    for (i = 0; i < allies.length; i++) {
      a = allies[i]; if (!a || a.kind !== 'hero') continue;
      var onH = Math.abs(a.y - c[1]) < 60 && (a.x - c[0]) * sx < 320;
      var onV = Math.abs(a.x - c[0]) < 60 && (a.y - c[1]) * sy < 320;
      if (onH || (num(a.id, 1e9) < me.id && !onV)) m.role = 'v';
    }
  }
  var role = m.role;

  var hurt = me.dmg > 0 || me.health < m.lastHp;
  m.lastHp = me.health;
  if (hurt) { m.hits++; m.hl.push(now); }
  while (m.hl.length && now - m.hl[0] > RELOC_WINDOW) m.hl.shift();
  if (m.hl.length > 10) m.hl = m.hl.slice(-10);

  // relocation along the wall when the corner is hot ('h' hero only, sliding along its own wall to the next corner)
  var thoughtMove = '';
  if (RELOC_HITS > 0 && role === 'h' && m.hl.length >= RELOC_HITS && !m.reloc) {
    m.corner = (m.corner === 0 || m.corner === 2) ? (m.corner + 1) % 4 : (m.corner + 3) % 4;
    m.reloc = 1; m.hl = []; m.pt = undefined;
    c = cs[m.corner]; sx = (m.corner === 0 || m.corner === 3) ? 1 : -1; sy = (m.corner === 0 || m.corner === 1) ? 1 : -1;
  }

  // patrol segment along my wall (distance from the corner)
  var lo = role === 'h' ? 0 : V_LO, hi = role === 'h' ? H_HI : V_HI;
  var onWall = role === 'h' ? Math.abs(me.y - c[1]) < 12 : Math.abs(me.x - c[0]) < 12;
  var along = role === 'h' ? (me.x - c[0]) * sx : (me.y - c[1]) * sy;
  var cmd = { move: 0, turn: 0, fire: null };
  var tx, ty;
  if (!onWall || along > hi + 40 || along < lo - 40) {
    // get to my wall first by the shortest perpendicular route, then slide along it
    if (role === 'h') { if (!onWall) { tx = clamp(me.x, PAD, W - PAD); ty = c[1]; if (Math.abs(me.x - c[0]) < Math.abs(me.y - c[1]) && Math.abs(me.x - c[0]) > 12) { tx = c[0]; ty = clamp(me.y, PAD, H - PAD); } } else { tx = c[0] + sx * (lo + 40); ty = c[1]; } }
    else { if (!onWall) { tx = c[0]; ty = clamp(me.y, PAD, H - PAD); if (Math.abs(me.y - c[1]) < Math.abs(me.x - c[0]) && Math.abs(me.y - c[1]) > 12) { tx = clamp(me.x, PAD, W - PAD); ty = c[1]; } } else { tx = c[0]; ty = c[1] + sy * (lo + 60); } }
    var dr = driveTo(me, tx, ty, L); cmd.move = dr.move; cmd.turn = dr.turn;
    thoughtMove = (m.reloc ? 'Corner hot, sliding along wall to corner ' : 'Moving along wall to corner ') + (m.corner + 1) + '. ';
  } else {
    m.reloc = 0;
    // shuffle: pick a new spot on the segment when the old one is reached
    if (typeof m.pt !== 'number' || Math.abs(along - m.pt) < 6) {
      var np = lo + Math.random() * (hi - lo), tries = 0;
      while (Math.abs(np - along) < 50 && tries++ < 6) np = lo + Math.random() * (hi - lo);
      m.pt = Math.round(np);
    }
    if (role === 'h') { tx = c[0] + sx * m.pt; ty = c[1]; } else { tx = c[0]; ty = c[1] + sy * m.pt; }
    var dr2 = driveTo(me, tx, ty, L); cmd.move = dr2.move; cmd.turn = dr2.turn;
  }
  // keep clear of teammates: never step closer to one that is already near (lower-id heroes get a wide berth)
  var nx = me.x + Math.cos((me.heading + cmd.turn) * Math.PI / 180) * cmd.move, ny = me.y + Math.sin((me.heading + cmd.turn) * Math.PI / 180) * cmd.move;
  for (i = 0; i < allies.length; i++) {
    a = allies[i]; if (!a || typeof a.x !== 'number') continue;
    var need = 20 + (a.kind === 'hero' ? 20 : 12) + (a.kind === 'hero' && num(a.id, 0) < me.id ? 55 : 8);
    var dn = dist(nx, ny, a.x, a.y);
    if (dn < need && dn < dist(me.x, me.y, a.x, a.y) + 1) { cmd.move = 0; m.pt = undefined; break; }
  }
  // don't drive into an enemy we can see right next to us (rams hurt both, and walls are where drones crawl)
  if (res && !res.friendly && typeof res.bearing === 'number' && res.distance < 90 && cmd.move !== 0) {
    var qx = me.x + Math.cos(res.bearing * Math.PI / 180) * res.distance, qy = me.y + Math.sin(res.bearing * Math.PI / 180) * res.distance;
    var mx = me.x + Math.cos((me.heading + cmd.turn) * Math.PI / 180) * cmd.move, my = me.y + Math.sin((me.heading + cmd.turn) * Math.PI / 180) * cmd.move;
    if (dist(mx, my, qx, qy) < 60 && dist(mx, my, qx, qy) < res.distance) cmd.move = 0;
  }
  cmd.move = clamp(cmd.move, -L.maxMove, L.maxMove); cmd.turn = clamp(cmd.turn, -L.maxTurn, L.maxTurn);

  // ---- scan & fire ----
  var inward = bearing(me.x, me.y, W / 2, H / 2);
  var enemy = res && !res.friendly && typeof res.bearing === 'number' && typeof res.distance === 'number' &&
              !matchesAlly(me, allies, res.bearing, res.distance);
  if (enemy) {
    var eb = norm(res.bearing), ed = Math.max(0, res.distance);
    var ex = me.x + Math.cos(eb * Math.PI / 180) * ed, ey = me.y + Math.sin(eb * Math.PI / 180) * ed;
    var aim = eb;
    if (typeof m.ex === 'number' && now - num(m.et, -99) <= 2) {
      var dt = Math.max(1, now - m.et), vx = (ex - m.ex) / dt, vy = (ey - m.ey) / dt, sp = Math.sqrt(vx * vx + vy * vy);
      if (sp < 65) {
        var tf = ed / L.spd + 1;
        var ax = clamp(ex + vx * tf, 0, W), ay = clamp(ey + vy * tf, 0, H);
        aim = bearing(me.x, me.y, ax, ay);
        if (Math.abs(diff(eb, aim)) > 20) aim = eb;
      }
    }
    m.ex = Math.round(ex); m.ey = Math.round(ey); m.et = now; m.eb = Math.round(eb); m.ed = Math.round(ed);
    var power = ed < 300 ? 3 : ed < 550 ? 2 : 1;
    if (res.kind === 'drone') power = Math.min(power, 2);   // a 40-hp drone dies to two p2 hits
    power = Math.min(power, L.maxP);
    while (power > 1 && me.heat + L.hpp * power > L.maxHeat) power--;
    var safe = !allyInLine(me, allies, aim, ed) && !allyInLine(me, allies, eb, ed);
    if (me.canFire && safe && me.heat + L.hpp * power <= L.maxHeat) cmd.fire = { angle: norm(aim), power: power };
    cmd.scan = { dir: eb, width: Math.min(L.maxW, ed < 200 ? 30 : 14) };
    cmd.thought = thoughtMove + 'Contact ' + Math.round(ed) + ' @' + Math.round(eb) + (cmd.fire ? ', firing p' + power : safe ? ', cooling' : ', ally in line - holding fire');
  } else if (typeof m.eb === 'number' && now - num(m.et, -99) <= 3 && now - num(m.et, -99) >= 0) {
    var k = clamp(Math.round(now - m.et), 0, 3);
    cmd.scan = { dir: norm(m.eb + [0, 14, -14, 28][k] ), width: Math.min(L.maxW, 30) };
    cmd.thought = thoughtMove + 'Reacquiring near ' + m.eb;
  } else {
    // sweep the open floor in front of my wall (SWEEP_N arcs), falling back to the corner quadrant when not on a wall
    var normal = role === 'h' ? (sy > 0 ? 90 : 270) : (sx > 0 ? 0 : 180);
    if (!onWall) normal = inward;
    m.sw = (m.sw + 1) % SWEEP.length;
    cmd.scan = { dir: norm(normal + SWEEP[m.sw]), width: Math.min(L.maxW, SWEEP_W) };
    cmd.thought = thoughtMove + (res && res.friendly ? 'Teammate in beam, skipping. ' : '') + 'Holding corner ' + (m.corner + 1) + ', hits ' + m.hits;
  }
  cmd.thought = String(cmd.thought).slice(0, 140);
  cmd.memory = m;
  return cmd;
}
