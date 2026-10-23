window.GBW_FX_ON = true;
/* Weapon VFX overlay (watch page only). Wraps GbwAgrtsDraw.paint and draws on top of the field
   from events derived client-side by diffing frames: new shots (by type role; type 'turret' is a base
   turret shot), new combatFx 'blast' (base hit) / 'detonate' (drone) / 'turretDown', new healPopups. No game, relay or bot changes.
   Pooled particles, hard caps, runs inside the existing render loop.
   Keep this file identical to relay/public/agrts-fx.js. */
(() => {
  'use strict';
  const D = window.GbwAgrtsDraw; if (!D || D.__fx) return;
  const reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const MAXP = 140, MAXE = 48;
  const P = [], E = [];               // pools; .on marks live
  for (let i = 0; i < MAXP; i++) P.push({ on: 0 });
  for (let i = 0; i < MAXE; i++) E.push({ on: 0 });
  const scorch = [];                  // {x,y,r,t} max 12
  let seen = new Set(), shotLife = new Map(), last = 0, shake = 0;
  const get = pool => { for (const o of pool) if (!o.on) return o; return null; };
  function part(x, y, vx, vy, life, col, sz) { const p = get(P); if (!p) return; p.on = 1; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.t = 0; p.life = life; p.col = col; p.sz = sz; }
  function fx(kind, o) { const e = get(E); if (!e) return; e.on = 1; e.kind = kind; e.t = 0; Object.assign(e, o); }
  const k = (o, s) => s + Math.round(o.x) + ',' + Math.round(o.y) + ',' + Math.round(o.tx || 0) + ',' + Math.round(o.ty || 0) + ',' + (o.type || o.kind || o.amount || '');
  function burst(x, y, n, col, sp, life, sz) { for (let i = 0; i < n; i++) { const a = Math.random() * 6.283, v = sp * (.4 + Math.random() * .6); part(x, y, Math.cos(a) * v, Math.sin(a) * v, life, col, sz); } }

  function detect(f, sx, sy) {
    const now = new Set(), nextLife = new Map(), types = D.types || {};
    for (const s of f.shots || []) {
      const key = k(s, 's'); now.add(key); const pl = shotLife.get(key); nextLife.set(key, s.life); if (pl !== undefined && !(s.life > pl)) continue;
      const role = (types[s.type] || {}).role, x = s.x * sx, y = s.y * sy, tx = (s.tx ?? s.x) * sx, ty = (s.ty ?? s.y) * sy;
      if (role === 'armor') fx('shell', { x, y, tx, ty, life: .42, col: s.col || '#efbd68' });
      else if (role === 'fast') { for (let i = 0; i < 3; i++) fx('pellet', { x, y, tx: tx + (Math.random() - .5) * 8, ty: ty + (Math.random() - .5) * 8, life: .22, d: i * .06 }); burst(x, y, 2, '#f2ff7a', 35, .08, 1.4); }
      else if (s.type === 'turret') { fx('tracer', { x, y, tx, ty, life: .16, col: s.col || '#fff6c8' }); burst(x, y, 4, s.col || '#fff1b8', 60, .14, 1.8); burst(tx, ty, 3, '#ffe2a8', 45, .18, 1.6); }
      else if (role === 'ranged') { fx('tracer', { x, y, tx, ty, life: .14, col: s.col || '#8ee5c1' }); burst(x, y, 3, '#fff1b8', 50, .12, 1.6); }
    }
    for (const c of f.combatFx || []) {
      if (c.kind !== 'blast' && c.kind !== 'detonate' && c.kind !== 'turretDown') continue;
      const key = k(c, 'c'); now.add(key); if (seen.has(key)) continue;
      const x = c.x * sx, y = c.y * sy;
      if (c.kind === 'turretDown') { fx('boom', { x, y, life: 1, r: 64 }); fx('flash', { x, y, life: .45, r: 40 }); burst(x, y, 30, '#ffb35c', 170, .8, 3); burst(x, y, 12, '#9a958a', 60, 1.2, 3.4); if (scorch.length >= 12) scorch.shift(); scorch.push({ x, y, r: 30, t: 0 }); if (!reduce) shake = Math.max(shake, .3); }
      else if (c.kind === 'blast') { fx('boom', { x, y, life: .7, r: 46 }); burst(x, y, 18, '#ffb35c', 140, .6, 2.6); if (!reduce) shake = Math.max(shake, .3); }
      else {
        const r = Math.max(10, c.r || 20) * Math.min(sx, sy);
        fx('dive', { x, y, tx: x - (c.side === 1 ? -1 : 1) * 60, ty: y - 50, life: .3, col: c.col || '#ffd27a' });
        fx('flash', { x, y, life: .35, r: r * 1.2 }); burst(x, y, 14, '#ffe2a8', 120, .5, 2.2);
        if (scorch.length >= 12) scorch.shift(); scorch.push({ x, y, r: r * .7, t: 0 });
      }
    }
    for (const h of f.healPopups || []) {
      const key = k(h, 'h'); now.add(key); if (seen.has(key)) continue;
      fx('heal', { x: h.x * sx, y: h.y * sy, life: .8 });
    }
    seen = now; shotLife = nextLife;
  }

  function step(dt) {
    for (const p of P) if (p.on) { p.t += dt; if (p.t >= p.life) { p.on = 0; continue; } p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= .92; p.vy *= .92; }
    for (const e of E) if (e.on && (e.t += dt) >= e.life) e.on = 0;
    for (let i = scorch.length - 1; i >= 0; i--) if ((scorch[i].t += dt) > 6) scorch.splice(i, 1);
    shake = Math.max(0, shake - dt);
  }

  function render(ctx) {
    ctx.save();
    for (const s of scorch) { const a = .35 * (1 - s.t / 6); const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r); g.addColorStop(0, `rgba(20,12,8,${a})`); g.addColorStop(1, 'rgba(20,12,8,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fill(); }
    ctx.globalCompositeOperation = 'lighter';
    for (const e of E) {
      if (!e.on) continue; const q = e.t / e.life, f = 1 - q;
      ctx.globalAlpha = f; ctx.strokeStyle = e.col || '#fff'; ctx.fillStyle = e.col || '#fff';
      if (e.kind === 'tracer') { const hx = e.x + (e.tx - e.x) * Math.min(1, q * 1.6), tl = Math.max(0, q * 1.6 - .35), ex = e.x + (e.tx - e.x) * tl, ey = e.y + (e.ty - e.y) * tl, hy = e.y + (e.ty - e.y) * Math.min(1, q * 1.6); ctx.lineWidth = 1.6; ctx.strokeStyle = '#fff6c8'; ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(hx, hy); ctx.stroke(); if (q < .5) { ctx.fillStyle = '#ffe9a0'; ctx.beginPath(); ctx.arc(e.x, e.y, 4 * (1 - q * 2) + 1, 0, 6.283); ctx.fill(); } }
      else if (e.kind === 'shell') { const px = e.x + (e.tx - e.x) * q, py = e.y + (e.ty - e.y) * q - Math.sin(q * 3.1416) * 14; ctx.globalAlpha = 1; ctx.fillStyle = '#ffd890'; ctx.beginPath(); ctx.arc(px, py, 3.6, 0, 6.283); ctx.fill(); ctx.globalAlpha = .4; ctx.beginPath(); ctx.arc(px - (e.tx - e.x) * .04, py - (e.ty - e.y) * .04, 2.4, 0, 6.283); ctx.fill(); if (e.t + 1 / 60 >= e.life) { fx('ring', { x: e.tx, y: e.ty, life: .4, r: 26, col: '#ffcf86' }); burst(e.tx, e.ty, 6, '#ffb35c', 70, .35, 2); } }
      else if (e.kind === 'pellet') { const qq = Math.max(0, (e.t - e.d) / (e.life - e.d)); if (e.t >= e.d && qq < 1) { ctx.globalAlpha = 1; ctx.fillStyle = '#f2ff7a'; ctx.beginPath(); ctx.arc(e.x + (e.tx - e.x) * qq, e.y + (e.ty - e.y) * qq, 1.8, 0, 6.283); ctx.fill(); } }
      else if (e.kind === 'dart') { const h = Math.min(1, q * 1.3), t0 = Math.max(0, h - .3); ctx.lineWidth = 1; ctx.strokeStyle = '#eaffd2'; ctx.beginPath(); ctx.moveTo(e.x + (e.tx - e.x) * t0, e.y + (e.ty - e.y) * t0); ctx.lineTo(e.x + (e.tx - e.x) * h, e.y + (e.ty - e.y) * h); ctx.stroke(); }
      else if (e.kind === 'ring') { ctx.lineWidth = 2.5 * f + .5; ctx.beginPath(); ctx.arc(e.x, e.y, 3 + q * e.r, 0, 6.283); ctx.stroke(); }
      else if (e.kind === 'dive') { ctx.lineWidth = 2; ctx.strokeStyle = '#ffd27a'; ctx.beginPath(); ctx.moveTo(e.tx + (e.x - e.tx) * q, e.ty + (e.y - e.ty) * q); ctx.lineTo(e.x, e.y); ctx.stroke(); }
      else if (e.kind === 'flash') { ctx.fillStyle = '#fff4d0'; ctx.globalAlpha = f * .8; ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (.3 + q * .7), 0, 6.283); ctx.fill(); }
      else if (e.kind === 'heal') { ctx.strokeStyle = '#7dff9e'; ctx.globalAlpha = f * .7; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(e.x, e.y, 6 + q * 18, 0, 6.283); ctx.stroke(); ctx.fillStyle = 'rgba(125,255,158,.18)'; ctx.beginPath(); ctx.arc(e.x, e.y, 6 + q * 14, 0, 6.283); ctx.fill(); }
      else if (e.kind === 'boom') { ctx.fillStyle = '#ffdca0'; ctx.globalAlpha = f * .7; ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (.25 + q * .75), 0, 6.283); ctx.fill(); ctx.strokeStyle = '#ff9a4a'; ctx.lineWidth = 3 * f + .5; ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (.4 + q * 1.1), 0, 6.283); ctx.stroke(); }
    }
    for (const p of P) if (p.on) { ctx.globalAlpha = 1 - p.t / p.life; ctx.fillStyle = p.col; ctx.fillRect(p.x, p.y, p.sz, p.sz); }
    ctx.restore();
  }

  const orig = D.paint;
  D.paint = function (ctx, f) {
    const now = performance.now(), dt = last ? Math.min(.1, (now - last) / 1000) : 0; last = now;
    const W = Math.max(1, f.cssW || f.w || 800), H = Math.max(1, f.cssH || f.h || 380), sx = W / (f.w || 800), sy = H / (f.h || 380);
    try { detect(f, sx, sy); step(dt); } catch (e) {}
    const dpr = f.dpr || 1;
    if (shake > 0) { ctx.save(); const a = shake / .3 * 3; ctx.setTransform(dpr, 0, 0, dpr, (Math.random() - .5) * a * dpr, (Math.random() - .5) * a * dpr); }
    orig(ctx, f);
    try { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); render(ctx); } catch (e) {}
    if (shake > 0) ctx.restore();
  };
  D.__fx = true;
})();
