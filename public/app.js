'use strict';
// Spectator client: SSE state stream -> interpolated canvas render.
(() => {
  const DEG = Math.PI / 180;
  const cv = document.getElementById('arena');
  const ctx = cv.getContext('2d');
  const $ = id => document.getElementById(id);
  const norm = a => ((a % 360) + 360) % 360;
  const angDiff = (a, b) => { let d = norm(b - a); return d > 180 ? d - 360 : d; };
  const lerp = (a, b, t) => a + (b - a) * t;

  let cur = null;          // latest server state
  let prevPos = new Map(); // robot id -> {x,y,heading} at the moment cur arrived (what we were displaying)
  let shellAnims = [];     // {from:{x,y}, to:{x,y}, power, color, endT, explode}
  let fx = [];             // {x,y,t0,dur,r,color,kind}
  let tArrive = 0;
  let selected = null;
  let sweep = 0;
  let view = { k: 1, ox: 0, oy: 0, aw: 1500, ah: 830 }; // world -> canvas pixels (set every frame)
  // DEBUG visibility: ONE source of truth (debugOn, persisted in localStorage 'rw.debug'). applyDebug() pushes it to
  // the DOM and is called after every render, every new match, every SSE (re)connect and on cross-tab changes.
  let debugOn = false;
  try { debugOn = localStorage.getItem('rw.debug') === '1'; } catch {}
  // KILLS (kill feed) uses the same pattern: killsOn, localStorage 'rw.kills', OFF by default.
  let killsOn = false;
  try { killsOn = localStorage.getItem('rw.kills') === '1'; } catch {}
  function applyToggle(panelId, btnId, on) {
    const d = $(panelId), b = $(btnId);
    if (d) { d.classList.toggle('hidden', !on); d.hidden = !on; }
    if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
  }
  function applyDebug() { applyToggle('debug', 'btnDebug', debugOn); applyToggle('killfeed', 'btnKills', killsOn); }
  let deadAt = new Map(); // robot id -> performance.now() when first seen dead (dead drones fade out)
  let thinking = null; // {tick, skew, robots: Map(id -> {thinking, since})}
  setInterval(() => { if (thinking && cur && [...thinking.robots.values()].some(r => r.thinking)) renderPanel(); }, 200);

  // ---------- networking ----------
  function connect() {
    const es = new EventSource('events');
    es.onopen = () => applyDebug();
    es.onmessage = e => onState(JSON.parse(e.data));
    es.addEventListener('thinking', e => {
      const t = JSON.parse(e.data);
      if (!cur || t.matchNo !== cur.matchNo) return;
      thinking = { tick: t.tick, skew: Date.now() - t.now, robots: new Map(t.robots.map(r => [r.id, r])) };
      renderPanel();
    });
    es.onerror = () => { $('status').textContent = 'connection lost - retrying...'; };
  }
  function control(action, extra = {}) {
    return fetch('api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
  }

  function displayed(id, now) {
    // current interpolated pose of robot id
    if (!cur) return null;
    const r = cur.robots[id]; const p = prevPos.get(id);
    const a = alpha(now);
    if (!p) return { x: r.x, y: r.y, heading: r.heading };
    return { x: lerp(p.x, r.x, a), y: lerp(p.y, r.y, a), heading: norm(p.heading + angDiff(p.heading, r.heading) * a) };
  }
  function alpha(now) { return cur ? Math.min(1, (now - tArrive) / Math.max(50, cur.tickMs * 0.9)) : 1; }

  let arKey = '';
  function setAspect(st) { // the page lays the canvas out at the arena's aspect (CSS var --ar)
    const a = st && st.arena; if (!a || !a.w || !a.h) return;
    const key = a.w + 'x' + a.h; if (key === arKey) return; arKey = key;
    document.documentElement.style.setProperty('--ar', (a.w / a.h).toFixed(4));
  }
  function onState(st) {
    setAspect(st);
    const now = performance.now();
    const newMatch = !cur || cur.matchNo !== st.matchNo;
    const sameTick = cur && !newMatch && cur.tick === st.tick;
    // remember what we were showing so motion continues smoothly from there
    const np = new Map();
    if (cur && !newMatch) for (const r of cur.robots) np.set(r.id, displayed(r.id, now));
    const prevShells = new Map();
    if (cur && !newMatch) for (const s of cur.shells) prevShells.set(s.id, s);
    if (sameTick) { cur = { ...st, robots: st.robots }; renderPanel(); return; } // control-only update (pause etc.)
    cur = st; prevPos = np; tArrive = now;
    if (newMatch) { shellAnims = []; fx = []; deadAt = new Map(); $('killfeed').innerHTML = ''; selected = null; applyDebug(); }

    const dur = Math.max(50, st.tickMs * 0.9);
    const colorOf = id => (st.robots[id] || {}).color || '#39ff14';
    const fireEv = new Map(), endEv = new Map();
    for (const e of st.events) {
      if (e.type === 'fire') fireEv.set(e.shell, e);
      if (e.type === 'hit' || e.type === 'miss') endEv.set(e.shell, e);
    }
    shellAnims = [];
    const start = id => prevShells.get(id) || fireEv.get(id);
    // live shells: animate from previous pos (or muzzle) to current
    for (const s of st.shells) {
      const f = start(s.id) || s;
      shellAnims.push({ from: { x: f.x, y: f.y }, to: { x: s.x, y: s.y }, power: s.small ? 0.3 : s.power, color: colorOf(s.owner), endT: dur });
    }
    // shells that ended this tick: animate to the impact point, then explode
    for (const [id, e] of endEv) {
      const f = start(id); if (!f) continue;
      const frac = Math.min(1, Math.hypot(e.x - f.x, e.y - f.y) / Math.max(1, Math.hypot(f.vx || 110, f.vy || 0)));
      const owner = (prevShells.get(id) || fireEv.get(id) || {}).owner;
      shellAnims.push({ from: { x: f.x, y: f.y }, to: { x: e.x, y: e.y }, power: e.power, color: colorOf(owner), endT: dur * frac });
      fx.push({ x: e.x, y: e.y, t0: now + dur * frac, dur: e.type === 'hit' ? 550 : 300, r: e.type === 'hit' ? 18 + 10 * e.power : 10, color: e.type === 'hit' ? '#ffffff' : '#39ff14', kind: e.type });
    }
    for (const e of st.events) {
      if (e.type === 'fire') fx.push({ x: e.x, y: e.y, t0: now, dur: 180, r: 8 + 3 * e.power, color: colorOf(e.id), kind: 'muzzle' });
      if (e.type === 'death') fx.push({ x: e.x, y: e.y, t0: now + dur * 0.6, dur: 2000, r: 90, color: '#ffd24d', kind: 'death' });
      if (e.type === 'wall') fx.push({ x: e.x, y: e.y, t0: now + dur * 0.8, dur: 250, r: 14, color: '#39ff14', kind: 'wall' });
      if (e.type === 'ram') fx.push({ x: e.x, y: e.y, t0: now, dur: 300, r: 22, color: '#ffffff', kind: 'ram' });
      if (e.type === 'spawn') fx.push({ x: e.x, y: e.y, t0: now, dur: 900, r: e.kind === 'hero' ? 60 : 38, color: (st.teams[e.team] || {}).color || '#39ff14', kind: 'spawn' });
      if (e.type === 'death') feed('kill', e, st);
      if (e.type === 'order' && e.source === 'api') feed('order', e, st);
      if (e.type === 'eliminated') feed('elim', e, st);
    }
    for (const r of st.robots) if (!r.alive && !deadAt.has(r.id)) deadAt.set(r.id, newMatch ? -1e9 : now);
    renderPanel();
  }

  // ---------- canvas ----------
  function resize() {
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(r.width * dpr)), ph = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  }

  function draw(now) {
    resize();
    const W = cv.width, Hc = cv.height;
    const aw = cur ? cur.arena.w : 1500, ah = cur ? cur.arena.h : 830;
    // uniform scale, world centred in the canvas (the page sizes the canvas box to the arena's aspect, so this fills it)
    const k = Math.min(W / aw, Hc / ah), ox = (W - aw * k) / 2, oy = (Hc - ah * k) / 2;
    view = { k, ox, oy, aw, ah };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, Hc);
    ctx.setTransform(k, 0, 0, k, ox, oy);

    // grid + range rings (rings out to the far corners of the field)
    ctx.lineWidth = 1 / k;
    ctx.strokeStyle = 'rgba(57,255,20,0.12)';
    ctx.beginPath();
    for (let i = 100; i < aw; i += 100) { ctx.moveTo(i, 0); ctx.lineTo(i, ah); }
    for (let i = 100; i < ah; i += 100) { ctx.moveTo(0, i); ctx.lineTo(aw, i); }
    ctx.stroke();
    const cx0 = aw / 2, cy0 = ah / 2, rMax = Math.hypot(aw, ah) / 2;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, aw, ah); ctx.clip();
    ctx.strokeStyle = 'rgba(57,255,20,0.18)';
    for (let rr = 125; rr <= rMax; rr += 125) { ctx.beginPath(); ctx.arc(cx0, cy0, rr, 0, Math.PI * 2); ctx.stroke(); }
    // decorative sweep
    sweep = (sweep + 0.6) % 360;
    const g = ctx.createConicGradient ? ctx.createConicGradient((sweep - 40) * DEG, cx0, cy0) : null;
    if (g) {
      g.addColorStop(0, 'rgba(57,255,20,0)'); g.addColorStop(40 / 360, 'rgba(57,255,20,0.10)'); g.addColorStop(40.5 / 360, 'rgba(57,255,20,0)'); g.addColorStop(1, 'rgba(57,255,20,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx0, cy0, rMax, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(57,255,20,0.6)'; ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, aw, ah);
    if (!cur) { requestAnimationFrame(draw); return; }

    const R = cur.robotRadius;

    // selected robot: scan arc + detection
    if (debugOn && selected !== null && cur.robots[selected] && cur.robots[selected].alive) {
      const r = cur.robots[selected], p = displayed(selected, now);
      const s = r.scan, a0 = (s.dir - s.width / 2) * DEG, a1 = (s.dir + s.width / 2) * DEG;
      ctx.save();
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.arc(p.x, p.y, 1500, a0, a1); ctx.closePath();
      ctx.fillStyle = hexA(r.color, 0.13); ctx.fill();
      ctx.strokeStyle = hexA(r.color, 0.8); ctx.lineWidth = 2; ctx.setLineDash([10, 8]); ctx.stroke(); ctx.setLineDash([]);
      if (r.scanResult) {
        const t = displayed(r.scanResult.targetId, now);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(t.x, t.y); ctx.stroke();
        ctx.beginPath(); ctx.arc(t.x, t.y, (cur.robots[r.scanResult.targetId].radius || R) + 10, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = 'bold 18px Courier New, monospace';
        const mx = (p.x + t.x) / 2, my = (p.y + t.y) / 2;
        ctx.textAlign = mx > cur.arena.w - 320 ? 'right' : 'left';
        ctx.fillText(`DETECT ${cur.robots[r.scanResult.targetId].name} d=${Math.round(r.scanResult.distance)} b=${Math.round(r.scanResult.bearing)}°`, mx + (ctx.textAlign === 'right' ? -8 : 8), Math.max(24, my - 8));
      } else {
        ctx.fillStyle = hexA(r.color, 0.9); ctx.font = 'bold 16px Courier New, monospace';
        ctx.fillText('scan: nothing', p.x + Math.cos(s.dir * DEG) * 120, p.y + Math.sin(s.dir * DEG) * 120);
      }
      ctx.restore();
    }

    // shells
    for (const sa of (cur.status === 'over' ? [] : shellAnims)) {
      const t = Math.min(1, (now - tArrive) / Math.max(1, sa.endT));
      if (now - tArrive > sa.endT && sa.endT < Math.max(50, cur.tickMs * 0.9)) continue; // ended (exploded)
      const x = lerp(sa.from.x, sa.to.x, t), y = lerp(sa.from.y, sa.to.y, t);
      const dx = sa.to.x - sa.from.x, dy = sa.to.y - sa.from.y, L = Math.hypot(dx, dy) || 1;
      ctx.save();
      ctx.shadowColor = sa.color; ctx.shadowBlur = 12;
      ctx.strokeStyle = hexA(sa.color, 0.5); ctx.lineWidth = 2 + sa.power;
      ctx.beginPath(); ctx.moveTo(x - dx / L * 25, y - dy / L * 25); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 3 + sa.power, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // robots (dead drones fade out after ~2.25 s; dead heroes stay as an X)
    for (const r of cur.robots) {
      const isDrone = r.kind === 'drone';
      if (!r.alive && isDrone && now - (deadAt.get(r.id) || now) > 2250) continue;
      const R = r.radius || cur.robotRadius, hpFrac = Math.max(0, r.health / (r.maxHealth || 100));
      const p = displayed(r.id, now);
      ctx.save();
      ctx.translate(p.x, p.y);
      if (!r.alive && isDrone) ctx.globalAlpha = Math.max(0, 1 - (now - (deadAt.get(r.id) || now)) / 2250);
      const tm = teamOf(r), av = avatarImg(tm && tm.avatar);
      const badgeR = isDrone ? R + 1 : R + 6;
      if (isDrone && r.alive) {
        // drone: small team-ringed badge (or chevron), short health bar, no name label
        if (av) drawBadge(av, r, p, badgeR, tm.avatarKind === 'badge');
        else {
          ctx.shadowColor = r.color; ctx.shadowBlur = 10; ctx.rotate(p.heading * DEG);
          ctx.fillStyle = hexA(r.color, 0.35); ctx.strokeStyle = r.color; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(R + 6, 0); ctx.lineTo(-R, -R * 0.8); ctx.lineTo(-R * 0.4, 0); ctx.lineTo(-R, R * 0.8); ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.rotate(-p.heading * DEG);
        }
        if (r.id === selected) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(0, 0, badgeR + 9, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(57,255,20,0.15)'; ctx.fillRect(-14, badgeR + 6, 28, 4);
        ctx.fillStyle = hpFrac > 0.5 ? r.color : hpFrac > 0.25 ? '#ffb000' : '#ff3030'; ctx.fillRect(-14, badgeR + 6, 28 * hpFrac, 4);
        ctx.restore(); continue;
      }
      if (!r.alive && isDrone) {
        ctx.strokeStyle = hexA(r.color, 0.6); ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(-R, -R); ctx.lineTo(R, R); ctx.moveTo(R, -R); ctx.lineTo(-R, R); ctx.stroke();
        ctx.restore(); continue;
      }
      if (av) {
        drawBadge(av, r, p, badgeR, tm.avatarKind === 'badge');
        if (r.id === selected) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.arc(0, 0, badgeR + 12, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
        if (!r.alive) {
          ctx.strokeStyle = hexA(r.color, 0.7); ctx.lineWidth = 4;
          ctx.beginPath(); ctx.moveTo(-R, -R); ctx.lineTo(R, R); ctx.moveTo(R, -R); ctx.lineTo(-R, R); ctx.stroke();
        }
        if (r.alive && r.lastCmd && r.lastCmd.fire) {
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; const fa = r.lastCmd.fire.angle * DEG;
          ctx.beginPath(); ctx.moveTo(Math.cos(fa) * (badgeR + 4), Math.sin(fa) * (badgeR + 4)); ctx.lineTo(Math.cos(fa) * (badgeR + 12), Math.sin(fa) * (badgeR + 12)); ctx.stroke();
        }
        ctx.shadowColor = r.color; ctx.shadowBlur = 6;
        ctx.fillStyle = r.alive ? r.color : hexA(r.color, 0.5); ctx.font = 'bold 18px Courier New, monospace';
        ctx.textAlign = p.x < 70 ? 'left' : p.x > cur.arena.w - 70 ? 'right' : 'center';
        ctx.fillText(r.name.toUpperCase() + (r.alive ? '' : ' [X]'), p.x < 70 ? -R : p.x > cur.arena.w - 70 ? R : 0, p.y < 60 ? badgeR + 40 : -badgeR - 12);
        if (r.alive) {
          ctx.shadowBlur = 0;
          const hy = p.y < 60 ? badgeR + 46 : badgeR + 8;
          ctx.fillStyle = 'rgba(57,255,20,0.15)'; ctx.fillRect(-25, hy, 50, 6);
          ctx.fillStyle = hpFrac > 0.5 ? r.color : hpFrac > 0.25 ? '#ffb000' : '#ff3030'; ctx.fillRect(-25, hy, 50 * hpFrac, 6);
        }
        ctx.restore(); continue;
      }
      if (!r.alive) {
        ctx.strokeStyle = hexA(r.color, 0.45); ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(-R, -R); ctx.lineTo(R, R); ctx.moveTo(R, -R); ctx.lineTo(-R, R); ctx.stroke();
        ctx.fillStyle = hexA(r.color, 0.5); ctx.font = '16px Courier New, monospace'; ctx.textAlign = 'center';
        ctx.fillText(r.name + ' [X]', 0, -R - 10);
        ctx.restore(); continue;
      }
      ctx.shadowColor = r.color; ctx.shadowBlur = 16;
      if (r.id === selected) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.arc(0, 0, R + 9, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
      ctx.rotate(p.heading * DEG);
      // body: chevron/tank
      ctx.fillStyle = hexA(r.color, 0.25); ctx.strokeStyle = r.color; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(R + 8, 0); ctx.lineTo(-R, -R * 0.85); ctx.lineTo(-R * 0.5, 0); ctx.lineTo(-R, R * 0.85); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.rotate(-p.heading * DEG);
      // turret: last fire angle
      if (r.lastCmd && r.lastCmd.fire) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(r.lastCmd.fire.angle * DEG) * (R + 12), Math.sin(r.lastCmd.fire.angle * DEG) * (R + 12)); ctx.stroke();
      }
      ctx.shadowBlur = 6;
      ctx.fillStyle = r.color; ctx.font = 'bold 18px Courier New, monospace'; ctx.textAlign = 'center';
      ctx.textAlign = p.x < 70 ? 'left' : p.x > cur.arena.w - 70 ? 'right' : 'center';
      ctx.fillText(r.name.toUpperCase(), p.x < 70 ? -R : p.x > cur.arena.w - 70 ? R : 0, p.y < 60 ? R + 34 : -R - 14);
      // mini health bar
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(57,255,20,0.15)'; ctx.fillRect(-25, p.y < 60 ? R + 40 : R + 8, 50, 6);
      ctx.fillStyle = hpFrac > 0.5 ? r.color : hpFrac > 0.25 ? '#ffb000' : '#ff3030'; ctx.fillRect(-25, p.y < 60 ? R + 40 : R + 8, 50 * hpFrac, 6);
      ctx.restore();
    }

    // effects
    fx = fx.filter(f => now < f.t0 + f.dur);
    for (const f of fx) {
      if (now < f.t0) continue;
      const t = (now - f.t0) / f.dur;
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.shadowColor = f.color; ctx.shadowBlur = 25;
      if (f.kind === 'spawn') {
        // warp-in: two rings collapsing onto the spawn point + a vertical beam
        ctx.strokeStyle = f.color; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (1 - t) + 4, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r * 0.6 * (1 - t) + 2, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = hexA(f.color, 0.25); ctx.fillRect(f.x - 3, f.y - f.r * 1.4 * (1 - t), 6, f.r * 2.8 * (1 - t));
      } else if (f.kind === 'hit' || f.kind === 'death') {
        ctx.fillStyle = f.kind === 'death' ? '#ffd24d' : '#ffffff';
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (0.3 + t), 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = f.kind === 'death' ? '#ff5020' : '#ffb000'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (0.5 + 1.2 * t), 0, Math.PI * 2); ctx.stroke();
      } else {
        ctx.strokeStyle = f.color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (0.5 + t), 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }
    requestAnimationFrame(draw);
  }

  // ---------- team avatars ----------
  const imgCache = new Map();
  function avatarImg(url) {
    if (!url) return null;
    let im = imgCache.get(url);
    if (!im) { im = new Image(); im.src = url; imgCache.set(url, im); }
    return im.complete && im.naturalWidth ? im : null;
  }
  function teamOf(r) { return cur && cur.teams ? cur.teams[r.team] : null; }
  // circular avatar badge with team ring, phosphor tint + scanlines, and a heading tick
  function drawBadge(img, r, p, rad, generated) {
    ctx.save();
    ctx.shadowColor = r.color; ctx.shadowBlur = 14;
    ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(0, 0, rad + 4, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    if (generated) {
      // identity badge (shape + color + initials): draw as-is, slightly inset so the shape fits the ring
      ctx.globalAlpha = r.alive ? 1 : 0.35;
      ctx.drawImage(img, -rad * 0.92, -rad * 0.92, rad * 1.84, rad * 1.84);
      ctx.globalAlpha = 1;
    } else {
    ctx.save();
    ctx.beginPath(); ctx.arc(0, 0, rad, 0, Math.PI * 2); ctx.clip();
    ctx.globalAlpha = r.alive ? 0.92 : 0.35;
    ctx.drawImage(img, -rad, -rad, rad * 2, rad * 2);
    ctx.globalAlpha = 1;
    ctx.fillStyle = r.alive ? 'rgba(20,120,20,0.18)' : 'rgba(0,0,0,0.5)'; ctx.fillRect(-rad, -rad, rad * 2, rad * 2);  // phosphor tint
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; for (let y = -rad; y < rad; y += 3) ctx.fillRect(-rad, y, rad * 2, 1);        // scanlines
    ctx.restore();
    }
    // team ring
    ctx.strokeStyle = r.alive ? r.color : hexA(r.color, 0.4); ctx.lineWidth = r.kind === 'drone' ? 2.5 : 4;
    ctx.beginPath(); ctx.arc(0, 0, rad + 2, 0, Math.PI * 2); ctx.stroke();
    if (r.alive) {
      const big = r.kind !== 'drone' ? 1 : 0.6;
      // heading tick: a bright pointer outside the ring
      const h = p.heading * DEG, c = Math.cos(h), s = Math.sin(h);
      ctx.fillStyle = '#fff'; ctx.shadowColor = r.color; ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(c * (rad + 16 * big), s * (rad + 16 * big));
      ctx.lineTo(c * (rad + 3) - s * 7 * big, s * (rad + 3) + c * 7 * big);
      ctx.lineTo(c * (rad + 3) + s * 7 * big, s * (rad + 3) - c * 7 * big);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // ---------- kill feed ----------
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function feed(kind, e, st) {
    const kf = $('killfeed'), d = document.createElement('div');
    const nm = id => { const r = st.robots[id]; return r ? `<span style="color:${r.color}">${esc(r.name.toUpperCase())}</span>` : '?'; };
    if (kind === 'kill') d.innerHTML = e.by !== null && e.by !== undefined ? `${nm(e.by)}<span class="x">✕</span>${nm(e.id)}` : `${nm(e.id)}<span class="x">✕</span>${esc(e.cause.toUpperCase())}`;
    else if (kind === 'order') { const t = st.teams[e.team]; d.className = 'ord'; d.innerHTML = `<span style="color:${t.color}">${esc(t.name.toUpperCase())}</span> live order: ${esc(e.unitType)} x${e.count} → ${e.deployed}`; }
    else { const t = st.teams[e.team]; d.innerHTML = `<span style="color:${t.color}">TEAM ${esc((t.displayName || t.name).toUpperCase())}</span> ELIMINATED`; }
    kf.prepend(d);
    while (kf.children.length > 7) kf.lastChild.remove();
    setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 700); }, 7000);
  }

  // ---------- side panel ----------
  function renderTeamCards(st) {
    const cards = $('cards');
    if (cards.children.length !== st.teams.length || cards.dataset.mode !== 'commander') {
      cards.innerHTML = ''; cards.dataset.mode = 'commander';
      for (const t of st.teams) {
        const d = document.createElement('div');
        d.className = 'card'; d.dataset.team = t.id;
        d.innerHTML = `<div class="top"><span><img class="av" alt=""><i class="dot"></i><span class="nm"></span><span class="disp"></span></span><span class="st"></span></div>
          <div class="units"></div>
          <div class="lbl"><span>ENERGY</span><span class="ev"></span></div><div class="bar en"><i class="eb"></i></div>
          <div class="lbl"><span class="hl">HERO</span><span class="hv"></span></div><div class="bar"><i class="hb"></i></div>
          <div class="thought"></div><div class="plan"></div><div class="chips"></div><div class="flt"></div>`;
        d.onclick = () => { const u = cur.robots.filter(r => r.team === t.id && r.alive); const h = u.find(r => r.kind === 'hero') || u[0]; if (h) select(h.id); };
        cards.appendChild(d);
      }
    }
    for (const t of st.teams) {
      const d = cards.children[t.id];
      const units = st.robots.filter(r => r.team === t.id && r.alive);
      const hero = units.find(r => r.kind === 'hero');
      const selTeam = selected !== null && st.robots[selected] && st.robots[selected].team === t.id;
      d.classList.toggle('dead', t.eliminated); d.classList.toggle('sel', selTeam);
      // label: the warrior name (falls back to the style/seat name); the seat in brackets when it differs
      const nm = d.querySelector('.nm'); nm.textContent = (t.displayName || t.name).toUpperCase(); nm.style.color = t.color; d.querySelector('.dot').style.color = t.color;
      d.querySelector('.disp').textContent = t.displayName && t.displayName !== t.name ? `(${t.name})` : '';
      const avEl = d.querySelector('.av');
      if (t.avatar) { if (avEl.getAttribute('src') !== t.avatar) avEl.src = t.avatar; avEl.style.display = ''; avEl.style.borderColor = t.color; avEl.classList.toggle('badge', t.avatarKind === 'badge'); }
      else avEl.style.display = 'none';
      d.querySelector('.dot').style.display = t.avatar ? 'none' : '';
      d.querySelector('.st').textContent = t.eliminated ? 'ELIMINATED' : `score ${Math.round(t.score)}`;
      const pend = t.pending.length;
      d.querySelector('.units').innerHTML = `<span title="heroes / drones alive">UNITS ${t.heroes}H ${t.drones}D${pend ? ` <span style="opacity:.7">+${pend}</span>` : ''}</span><span title="drones deployed so far">DEP ${t.deployed.drone}d${t.deployed.hero - 1 > 0 ? '+' + (t.deployed.hero - 1) + 'h' : ''}</span><span>SPENT ${t.energySpent}</span>`;
      d.querySelector('.ev').textContent = `${Math.floor(t.energy)}/${t.energyMax}`;
      d.querySelector('.eb').style.width = (100 * t.energy / t.energyMax) + '%';
      const hp = hero ? hero.health / hero.maxHealth : 0;
      d.querySelector('.hl').textContent = hero ? `HERO ${hero.name.toUpperCase()}` : 'HERO DOWN';
      d.querySelector('.hv').textContent = hero ? `${Math.round(hero.health)}/${hero.maxHealth} ht ${Math.round(hero.heat)}` : '-';
      const hb = d.querySelector('.hb'); hb.style.width = (100 * hp) + '%'; hb.style.background = hp > 0.5 ? t.color : hp > 0.25 ? '#ffb000' : '#ff3030';
      const focus = selTeam ? st.robots[selected] : hero || units[0];
      d.querySelector('.thought').textContent = focus ? `> ${focus.kind === 'drone' ? focus.name + ': ' : ''}${focus.thought || ''}` : '> (no units on the field)';
      const planThought = t.battlePlanThought !== undefined ? t.battlePlanThought : t.commanderThought; // older servers: commanderThought
      const hasPlan = t.hasBattlePlan !== undefined ? t.hasBattlePlan : t.hasCommander;
      const planEl = d.querySelector('.plan'); planEl.textContent = planThought || (hasPlan ? '' : 'Battle plan: (none - live orders only)'); planEl.title = planEl.textContent;
      d.querySelector('.thought').title = d.querySelector('.thought').textContent;
      d.querySelector('.chips').innerHTML = units.map(r => {
        const f = Math.max(0, r.health / r.maxHealth);
        return `<span class="chip" title="${esc(r.name)}" style="color:${r.id === selected ? '#fff' : t.color}">${r.kind === 'hero' ? 'HERO' : esc(r.type)}<b style="width:${100 * f}%;background:${f > 0.5 ? t.color : f > 0.25 ? '#ffb000' : '#ff3030'}"></b></span>`;
      }).join('') + t.pending.map(p => `<span class="chip pend" style="color:${t.color}">${p.kind === 'hero' ? 'HERO' : esc(p.type)} t${p.readyTick}</span>`).join('');
      const faults = units.reduce((a, r) => a + (r.meta ? r.meta.faults : 0), 0);
      const fl = d.querySelector('.flt'); fl.textContent = faults ? `script faults ${faults}` : ''; fl.style.color = faults ? '#ff5050' : '';
    }
  }

  function renderPanel() {
    try { renderPanelInner(); } finally { applyDebug(); }
  }
  function renderPanelInner() {
    const st = cur;
    if (selected !== null && !st.robots[selected]) selected = null; // stale id (e.g. from the previous match)
    const state = st.status === 'over' ? 'MATCH OVER' : st.paused ? 'PAUSED' : 'LIVE';
    const cmdMode = st.mode === 'commander';
    $('status').textContent = `${cmdMode ? 'COMMANDER ' : ''}MATCH ${st.matchNo} (seed ${st.seed})  TICK ${st.tick}/${st.maxTicks}  [${state}]  ${st.tickMs}ms/tick  ` +
      (cmdMode ? `units ${st.robots.filter(r => r.alive).length}  teams ${st.teams.filter(t => !t.eliminated).length}/4` : `alive ${st.robots.filter(r => r.alive).length}/4`);
    $('btnPause').textContent = st.paused ? 'RESUME' : 'PAUSE';
    $('autoRestart').checked = st.autoRestart;
    const sel = $('speed');
    if (![...sel.options].some(o => +o.value === st.tickMs)) sel.add(new Option(st.tickMs + 'ms', st.tickMs));
    sel.value = String(st.tickMs);

    const cards = $('cards');
    if (cmdMode) renderTeamCards(st);
    else if (cards.children.length !== st.robots.length || cards.dataset.mode === 'commander') {
      cards.innerHTML = ''; cards.dataset.mode = 'classic';
      for (const r of st.robots) {
        const d = document.createElement('div');
        d.className = 'card'; d.dataset.id = r.id;
        d.innerHTML = `<div class="top"><span><img class="av" alt=""><span class="nm"></span> <span class="drv"></span></span><span class="st"></span></div>
          <div class="lbl"><span>HEALTH</span><span class="hv"></span></div><div class="bar"><i class="hb"></i></div>
          <div class="lbl"><span>HEAT</span><span class="tv"></span></div><div class="bar"><i class="tb"></i></div>
          <div class="thought"></div><div class="mem"></div><div class="flt"></div><div class="stats"></div>`;
        d.onclick = () => select(r.id);
        cards.appendChild(d);
      }
    }
    if (!cmdMode) for (const r of st.robots) {
      const d = cards.children[r.id];
      d.classList.toggle('dead', !r.alive); d.classList.toggle('sel', r.id === selected);
      const nm = d.querySelector('.nm'); nm.textContent = r.name.toUpperCase(); nm.style.color = r.color;
      const th = thinking && thinking.robots.get(r.id);
      const isThinking = r.alive && th && th.thinking && cur.status === 'running';
      const fmt = ms => ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
      d.querySelector('.st').textContent = !r.alive ? 'DESTROYED'
        : isThinking ? `thinking... ${fmt(Math.max(0, Date.now() - thinking.skew - th.since))}`
        : r.meta ? (r.lastStatus === 'ok' ? `cpu max ${r.meta.cpuMsMax.toFixed(1)}ms` : 'FAULT')
        : (r.lastStatus === 'ok' ? `reply ${fmt(r.lastLatencyMs)}` : `${r.lastStatus.toUpperCase()} ${fmt(r.lastLatencyMs)}`);
      d.querySelector('.st').style.color = isThinking ? '#ffffff' : r.lastStatus === 'ok' ? '' : '#ff5050';
      const tmc = teamOf(r), avEl = d.querySelector('.av');
      if (tmc && tmc.avatar) { if (avEl.getAttribute('src') !== tmc.avatar) avEl.src = tmc.avatar; avEl.style.display = ''; avEl.style.borderColor = r.color; }
      else avEl.style.display = 'none';
      const mt = r.meta;
      d.querySelector('.drv').textContent = mt ? `[SCRIPT] ${mt.scriptName} v${mt.version}` : `[${(r.driver || 'stub').toUpperCase()}]`;
      const fl = d.querySelector('.flt');
      fl.textContent = mt ? (mt.disqualified ? `DISQUALIFIED: ${mt.disqualifyReason}` : mt.faults ? `faults ${mt.faults} (last: ${mt.lastFault})` : 'faults 0') : '';
      fl.style.color = mt && (mt.disqualified || mt.faults) ? '#ff5050' : '';
      d.querySelector('.mem').textContent = '';
      d.querySelector('.hv').textContent = Math.round(r.health);
      const hb = d.querySelector('.hb'); hb.style.width = r.health + '%'; hb.style.background = r.health > 50 ? r.color : r.health > 25 ? '#ffb000' : '#ff3030';
      d.querySelector('.tv').textContent = Math.round(r.heat);
      const tb = d.querySelector('.tb'); tb.style.width = Math.min(100, r.heat) + '%'; tb.style.background = r.heat > 70 ? '#ff5020' : '#ffb000';
      d.querySelector('.thought').textContent = '> ' + (r.thought || '');
      d.querySelector('.stats').textContent = `shots ${r.shotsFired}  hits ${r.shotsHit}  kills ${r.kills}  pos (${Math.round(r.x)},${Math.round(r.y)}) hdg ${Math.round(r.heading)}°`;
    }
    // debug (only rendered while the panel is shown)
    if (selected !== null && debugOn) {
      const r = st.robots[selected];
      $('dbgName').textContent = r.name + (r.kind === 'drone' ? ` (${r.type} drone)` : '');
      $('dbgName').style.color = r.color;
      $('dbgBody').textContent =
        `scan dir ${Math.round(r.scan.dir)}° width ${Math.round(r.scan.width)}°  ->  ` +
        (r.scanResult ? `DETECTED ${st.robots[r.scanResult.targetId].name} at bearing ${r.scanResult.bearing}° distance ${r.scanResult.distance}` : 'nothing detected') +
        `\n\nlast COMMAND (${r.lastStatus}${r.lastError ? ': ' + r.lastError : ''}):\n${JSON.stringify(r.lastCmd, null, 1)}` +
        `\n\nlast SENSE:\n${JSON.stringify(r.lastSense, null, 1)}`;
    }
    // overlay
    const ov = $('overlay');
    if (st.status === 'over' && st.winner) {
      ov.classList.remove('hidden');
      const w = st.winner.team !== null && st.winner.team !== undefined ? st.teams[st.winner.team] : null;
      $('winText').textContent = w ? `${(w.displayName || w.name).toUpperCase()} WINS` : 'NO WINNER';
      $('winText').style.color = w ? w.color : '#39ff14';
      $('winReason').textContent = `${st.winner.reason} @ tick ${st.tick}`;
      if (st.held) { stopCountdown(); $('winCountdown').textContent = 'PAUSED: next match waits for FIGHT'; }
      else if (st.autoRestart && st.restartInMs != null) startCountdown(st.restartInMs); else { stopCountdown(); $('winCountdown').textContent = 'press RESTART for a new match'; }
    } else { ov.classList.add('hidden'); stopCountdown(); }
  }
  let cdTimer = null, cdEnd = 0;
  function startCountdown(ms) {
    if (ms == null) return;
    cdEnd = Date.now() + ms;
    if (cdTimer) return;
    const f = () => { $('winCountdown').textContent = `next match in ${Math.max(0, Math.ceil((cdEnd - Date.now()) / 1000))}s`; };
    f(); cdTimer = setInterval(f, 250);
  }
  function stopCountdown() { clearInterval(cdTimer); cdTimer = null; }

  function select(id) { selected = selected === id ? null : id; if (selected === null) { $('dbgName').textContent = 'click a robot'; $('dbgName').style.color = ''; } if (cur) renderPanel(); }

  cv.addEventListener('click', ev => {
    if (!cur) return;
    const rect = cv.getBoundingClientRect();
    const sx = cv.width / rect.width, sy = cv.height / rect.height; // CSS px -> canvas px, then undo the world transform
    const x = ((ev.clientX - rect.left) * sx - view.ox) / view.k, y = ((ev.clientY - rect.top) * sy - view.oy) / view.k;
    const now = performance.now();
    let best = null, bd = 60;
    for (const r of cur.robots) { if (!r.alive && r.kind === 'drone') continue; const p = displayed(r.id, now); const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = r.id; } }
    if (best !== null) select(best);
  });

  // debug panel: hidden by default, choice remembered. Selecting a unit works either way.
  function setDebug(on) {
    debugOn = !!on;
    try { localStorage.setItem('rw.debug', debugOn ? '1' : '0'); } catch {}
    applyDebug();
    if (cur) renderPanel();
  }
  applyDebug();
  $('btnDebug').onclick = () => setDebug(!debugOn);
  function setKills(on) {
    killsOn = !!on;
    try { localStorage.setItem('rw.kills', killsOn ? '1' : '0'); } catch {}
    applyDebug();
  }
  $('btnKills').onclick = () => setKills(!killsOn);
  // another tab toggled it: follow (localStorage is shared per origin)
  window.addEventListener('storage', e => { if (e.key === 'rw.kills') { killsOn = e.newValue === '1'; applyDebug(); } if (e.key === 'rw.debug') { debugOn = e.newValue === '1'; applyDebug(); if (cur) renderPanel(); } });

  $('btnPause').onclick = () => control(cur && cur.paused ? 'resume' : 'pause');
  $('btnStep').onclick = () => control('step');
  $('btnRestart').onclick = () => control('restart');
  $('speed').onchange = e => control('speed', { tickMs: +e.target.value });
  $('autoRestart').onchange = e => control('autorestart', { on: e.target.checked });
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.key === ' ') { e.preventDefault(); $('btnPause').click(); }
    if (e.key === 's') $('btnStep').click();
    if (e.key === 'r') $('btnRestart').click();
    if (e.key === 'd') $('btnDebug').click();
    if (e.key === 'k') $('btnKills').click();
  });

  // stale-tab guard: if the arena now serves a different UI build than this tab loaded, reload (keeps toggles)
  const myUi = ([...document.scripts].map(x => (x.src.match(/app\.js\?v=(\w+)/) || [])[1]).find(Boolean)) || null;
  const checkUi = () => { if (myUi) fetch('api/ui-version', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(v => { if (v && v.app && v.app !== myUi) location.reload(); }).catch(() => {}); };
  setInterval(checkUi, 15000);
  window.addEventListener('focus', checkUi); document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUi(); });

  // world (x, y) -> client (CSS px) coordinates, for tests and tools that click on units
  const toClient = (x, y) => { const r = cv.getBoundingClientRect(); return { x: r.left + (view.ox + x * view.k) * r.width / cv.width, y: r.top + (view.oy + y * view.k) * r.height / cv.height }; };
  window.__rw = { toClient, get view() { return { ...view }; }, get state() { return cur; }, select, get selected() { return selected; }, get debug() { return debugOn; }, setDebug, get kills() { return killsOn; }, setKills };
  connect();
  requestAnimationFrame(draw);
})();
