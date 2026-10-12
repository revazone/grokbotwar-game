// TURTLE GUARD drone v1 (commander mode, spec v4)
// v1 notes: slots sit 420-560 out along the walls; persistent slot per drone (picked free at spawn) so drones
// don't swap places and ram each other; leaves the spawn area by a per-slot diagonal waypoint; yields to
// heroes and lower-id units (allowing for their next step); sidesteps instead of pushing.
// Screens the hero's corner from guard slots out along the two walls (well clear of the hero's patrol
// segment and of the home spawn spot), so drones no longer bump into or block the hero.
// - Slots 0/2 on the hero's horizontal wall, 1/3 on the vertical one.
// - Shuffles a little along its wall to dodge, sweeps the open floor, fires power 1 at confirmed enemies only,
//   holds fire when any teammate (sense.allies) is near the line of fire.
// - If the hero is gone, it guards the home corner. Memory: corner, last enemy fix, hits taken.
function norm(a) { a = a % 360; return a < 0 ? a + 360 : a; }
function diff(a, b) { var d = norm(b - a); return d > 180 ? d - 360 : d; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function bearing(x1, y1, x2, y2) { return norm(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI); }
function dist(x1, y1, x2, y2) { var dx = x2 - x1, dy = y2 - y1; return Math.sqrt(dx * dx + dy * dy); }
function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
function nearestCorner(x, y, W, H) { return (x < W / 2) ? (y < H / 2 ? 0 : 3) : (y < H / 2 ? 1 : 2); }
function driveTo(me, tx, ty, L) {
  var d = dist(me.x, me.y, tx, ty);
  if (d < 4) return { move: 0, turn: 0 };
  var b = bearing(me.x, me.y, tx, ty), dd = diff(me.heading, b), sign = 1;
  if (Math.abs(dd) > 90) { dd = diff(me.heading, norm(b + 180)); sign = -1; }
  var turn = clamp(dd, -L.maxTurn, L.maxTurn), rem = Math.abs(dd - turn);
  var mv = rem < 10 ? Math.min(L.maxMove, d) : rem < 45 ? Math.min(L.maxMove * 0.4, d) : 0;
  return { move: clamp(sign * mv, -L.maxMove, L.maxMove), turn: turn };
}
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
function matchesAlly(me, allies, b, d) {
  var ex = me.x + Math.cos(b * Math.PI / 180) * d, ey = me.y + Math.sin(b * Math.PI / 180) * d;
  for (var i = 0; i < allies.length; i++) { var a = allies[i]; if (a && dist(ex, ey, a.x, a.y) < 35) return true; }
  return false;
}

var SLOTS = [[0, 420], [1, 440], [0, 540], [1, 560]];   // [wall 0=horizontal 1=vertical, distance from corner]

function tick(sense, memory) {
  sense = sense || {};
  var Ls = sense.limits || {};
  var arena = sense.arena || Ls.arena || {}, W = num(arena.w, 1500), H = num(arena.h, 830); // arena size comes from sense (not square since API 4.5)
  var L = { maxMove: num(Ls.maxMove, 60), maxTurn: num(Ls.maxTurn, 45), maxW: num((Ls.scanWidth || [])[1], 60),
            hpp: num(Ls.heatPerPower, 20), maxHeat: num(Ls.maxHeat, 100), spd: num(Ls.shellSpeed, 130) };
  var s = sense.self || {};
  var me = { id: num(s.id, 0), x: num(s.x, W / 2), y: num(s.y, H / 2), heading: norm(num(s.heading, 0)),
             heat: num(s.heat, 0), canFire: !!s.canFire, dmg: num(s.damageTakenLastTick, 0), r: num(s.radius, 12) };
  var now = num(sense.tick, 1);
  var allies = Array.isArray(sense.allies) ? sense.allies : [];
  var res = (sense.scan && sense.scan.result) ? sense.scan.result : null;
  var m = (memory && typeof memory === 'object') ? memory : {};
  if (typeof m.home !== 'number') m.home = nearestCorner(me.x, me.y, W, H);
  if (typeof m.hits !== 'number') m.hits = 0;
  if (typeof m.sw !== 'number') m.sw = Math.floor(Math.random() * 6);
  if (me.dmg > 0) m.hits++;

  // corner to guard: the lead hero's corner, else home
  var lead = null, rank = 0, i;
  for (i = 0; i < allies.length; i++) {
    var a = allies[i]; if (!a) continue;
    if (a.kind === 'hero' && (!lead || a.id < lead.id)) lead = a;
    if (a.kind === 'drone' && num(a.id, 1e9) < me.id) rank++;
  }
  var corner = lead ? nearestCorner(lead.x, lead.y, W, H) : m.home;
  m.corner = corner;
  var cx = (corner === 0 || corner === 3) ? 0 : W, cy = (corner === 0 || corner === 1) ? 0 : H;
  var sx = cx === 0 ? 1 : -1, sy = cy === 0 ? 1 : -1;
  var off = me.r + 10;
  function slotPos(k) { var sl = SLOTS[k]; return sl[0] === 0 ? [cx + sx * sl[1], cy + sy * off] : [cx + sx * off, cy + sy * sl[1]]; }
  // keep a persistent slot; pick a free one on the first tick (or if a teammate has clearly taken mine)
  var mine = typeof m.slot === 'number' ? slotPos(m.slot) : null, taken = false;
  if (mine) for (i = 0; i < allies.length; i++) { var q = allies[i]; if (q && q.kind === 'drone' && q.id < me.id && dist(q.x, q.y, mine[0], mine[1]) < 60 && dist(me.x, me.y, mine[0], mine[1]) > 80) taken = true; }
  if (typeof m.slot !== 'number' || taken) {
    var free = [], peers = 0;
    for (var k = 0; k < SLOTS.length; k++) {
      var sp = slotPos(k), ok = true;
      for (i = 0; i < allies.length; i++) { var q2 = allies[i]; if (q2 && q2.kind === 'drone' && dist(q2.x, q2.y, me.x, me.y) > 150 && dist(q2.x, q2.y, sp[0], sp[1]) < 90) ok = false; }
      if (ok) free.push(k);
    }
    for (i = 0; i < allies.length; i++) { var q3 = allies[i]; if (q3 && q3.kind === 'drone' && q3.id < me.id && dist(q3.x, q3.y, me.x, me.y) <= 150) peers++; }
    m.slot = free.length ? free[peers % free.length] : rank % SLOTS.length;
  }
  var slot = SLOTS[m.slot];
  if (typeof m.j !== 'number' || now % 12 === 0) m.j = Math.round((Math.random() * 2 - 1) * 45);
  var tx, ty;
  if (slot[0] === 0) { tx = cx + sx * (slot[1] + m.j); ty = cy + sy * off; }
  else { tx = cx + sx * off; ty = cy + sy * (slot[1] + m.j); }
  tx = clamp(tx, off, W - off); ty = clamp(ty, off, H - off);

  // leave the spawn area diagonally (clear of the heroes' wall segments) before heading to the slot
  var dCorner = Math.max(Math.abs(me.x - cx), Math.abs(me.y - cy));
  var onMyWall = slot[0] === 0 ? Math.abs(me.y - ty) < 20 : Math.abs(me.x - tx) < 20;
  if (dCorner < 250 && !onMyWall) {
    var wx = cx + sx * (slot[0] === 0 ? 190 : 100), wy = cy + sy * (slot[0] === 0 ? 100 : 190);
    if (dist(me.x, me.y, wx, wy) > 30 && Math.min(Math.abs(me.x - cx), Math.abs(me.y - cy)) < 110) { tx = wx; ty = wy; }
    else { if (slot[0] === 0) { ty = cy + sy * off; tx = cx + sx * slot[1]; } else { tx = cx + sx * off; ty = cy + sy * slot[1]; } }
  }
  var cmd = { move: 0, turn: 0, fire: null };
  var dr = driveTo(me, tx, ty, L);
  // give heroes a wide berth: if one is close, back straight away from it
  var yieldTo = null;
  for (i = 0; i < allies.length; i++) { var h2 = allies[i]; if (h2 && h2.kind === 'hero' && dist(me.x, me.y, h2.x, h2.y) < me.r + 20 + 45) { yieldTo = h2; break; } }
  if (yieldTo) {
    var away = bearing(yieldTo.x, yieldTo.y, me.x, me.y);
    // slide away but not into a wall: bias toward the open floor
    var ax2 = clamp(me.x + Math.cos(away * Math.PI / 180) * 80, 40, W - 40), ay2 = clamp(me.y + Math.sin(away * Math.PI / 180) * 80, 40, H - 40);
    dr = driveTo(me, ax2, ay2, L);
  }
  function clear(nx2, ny2) {
    for (var j = 0; j < allies.length; j++) {
      var b2 = allies[j]; if (!b2 || typeof b2.x !== 'number') continue;
      var dn = dist(nx2, ny2, b2.x, b2.y), dc = dist(me.x, me.y, b2.x, b2.y);
      var pri = b2.kind === 'hero' || b2.id < me.id;   // they have right of way
      var rr = me.r + (b2.kind === 'hero' ? 20 : 12) + 6;
      if (pri) {
        // they may move a full step along their heading this tick: stay clear of that spot as well
        var st = b2.kind === 'hero' ? 50 : 60, hb = num(b2.heading, 0) * Math.PI / 180;
        var fx = b2.x + Math.cos(hb) * st, fy = b2.y + Math.sin(hb) * st;
        if (dist(nx2, ny2, fx, fy) < rr + 4 && dist(nx2, ny2, fx, fy) < dist(me.x, me.y, fx, fy) + 1) return false;
        if (dist(nx2, ny2, b2.x - Math.cos(hb) * st * 0.5, b2.y - Math.sin(hb) * st * 0.5) < rr) return false;
      }
      var need = rr + (pri ? 20 : 0);
      if (dn < need && dn < dc + 1) return false;
    }
    return true;
  }
  var nh = me.heading + dr.turn;
  if (dr.move !== 0 && !clear(me.x + Math.cos(nh * Math.PI / 180) * dr.move, me.y + Math.sin(nh * Math.PI / 180) * dr.move)) {
    // try a sidestep (turn as far as allowed either way, half speed), else wait
    var alt = null, tries2 = [L.maxTurn, -L.maxTurn];
    for (var t2 = 0; t2 < 2 && !alt; t2++) {
      var h3 = me.heading + tries2[t2], mv3 = L.maxMove * 0.5;
      var x3 = me.x + Math.cos(h3 * Math.PI / 180) * mv3, y3 = me.y + Math.sin(h3 * Math.PI / 180) * mv3;
      if (x3 > 16 && y3 > 16 && x3 < W - 16 && y3 < H - 16 && clear(x3, y3)) alt = { move: mv3, turn: tries2[t2] };
    }
    dr = alt || { move: 0, turn: dr.turn };
  }
  cmd.move = clamp(dr.move, -L.maxMove, L.maxMove); cmd.turn = clamp(dr.turn, -L.maxTurn, L.maxTurn);

  var enemy = res && !res.friendly && typeof res.bearing === 'number' && typeof res.distance === 'number' &&
              !matchesAlly(me, allies, res.bearing, res.distance);
  if (enemy) {
    var eb = norm(res.bearing), ed = Math.max(0, res.distance);
    var ex = me.x + Math.cos(eb * Math.PI / 180) * ed, ey = me.y + Math.sin(eb * Math.PI / 180) * ed, aim = eb;
    if (typeof m.ex === 'number' && now - num(m.et, -99) <= 2) {
      var dt = Math.max(1, now - m.et), vx = (ex - m.ex) / dt, vy = (ey - m.ey) / dt;
      if (vx * vx + vy * vy < 65 * 65) { var tf = ed / L.spd + 1; aim = bearing(me.x, me.y, ex + vx * tf, ey + vy * tf); if (Math.abs(diff(eb, aim)) > 20) aim = eb; }
    }
    m.ex = Math.round(ex); m.ey = Math.round(ey); m.et = now; m.eb = Math.round(eb); m.ed = Math.round(ed);
    var safe = !allyInLine(me, allies, aim, ed) && !allyInLine(me, allies, eb, ed);
    if (me.canFire && safe && ed < 650 && me.heat + L.hpp <= L.maxHeat) cmd.fire = { angle: norm(aim), power: 1 };
    cmd.scan = { dir: eb, width: Math.min(L.maxW, 20) };
    cmd.thought = 'Guard slot ' + m.slot + ': contact ' + Math.round(ed) + (cmd.fire ? ', firing' : safe ? '' : ', ally in line');
  } else if (typeof m.eb === 'number' && now - num(m.et, -99) <= 3) {
    cmd.scan = { dir: norm(m.eb + ((now % 2) ? 20 : -20)), width: Math.min(L.maxW, 40) };
    cmd.thought = 'Guard slot ' + m.slot + ': reacquiring';
  } else {
    // sweep away from the wall I sit on (180 degrees of open floor, 4 arcs)
    var inward = bearing(me.x, me.y, W / 2, H / 2);
    m.sw = (m.sw + 1) % 4;
    cmd.scan = { dir: norm(inward + [-67, -22, 22, 67][m.sw]), width: Math.min(L.maxW, 46) };
    cmd.thought = 'Guard slot ' + m.slot + ' screening corner ' + (corner + 1);
  }
  cmd.memory = m;
  return cmd;
}
