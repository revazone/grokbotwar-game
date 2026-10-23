/* Watch-page sound effects (Oct 14). Kenney CC0 sounds (see docs/SFX-CREDITS.md), played with Web Audio.
   Wraps GbwAgrtsDraw.paint (like agrts-fx.js) and plays sounds for new events found by diffing frames.
   Mute toggle (🔊/🔇) persists in localStorage 'gbw.sfx.muted'; audio unlocks on the first tap/click (iOS).
   Per-sound cooldown, max 6 voices, modest volume. Keep this file identical to public/agrts/sfx.js.
   Oct 18: combat, heal, comm and zone sounds are the realistic set approved on the test range (docs/SFX-CREDITS.md); a master
   compressor keeps a firefight from clipping. */
(() => {
  'use strict';
  if (typeof window === 'undefined' || window.__gbwSfx) return; window.__gbwSfx = true;
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
  const me = document.currentScript && document.currentScript.src || '';
  const BASE = me ? me.replace(/[^/]*$/, '') : '';
  // name: [volume, cooldown ms, max same-name voices]
  const S = {
    rifle: [.5, 90, 3], scout: [.4, 90, 2], breaker: [.75, 250, 2], 'mortar-launch': [.7, 300, 2], 'mortar-impact': [.8, 200, 3],
    drone: [.9, 120, 3], 'drone-launch': [.28, 250, 3], turret: [.45, 420, 2], destroyed: [.35, 120, 2], heal: [.4, 500, 1],
    capture: [.6, 600, 1], lost: [.6, 600, 1], coin: [.18, 250, 1], squelch: [.15, 300, 1], comm: [.5, 600, 1],
    start: [.4, 3000, 1], victory: [.45, 3000, 1], defeat: [.45, 3000, 1], alarm: [.3, 2500, 1],
  };
  const MAXV = 6, KEY = 'gbw.sfx.muted';
  let muted = false; try { muted = localStorage.getItem(KEY) === '1'; } catch (e) {}
  let ctx = null, master = null, hint = null, frames = 0; const buf = {}, lastAt = {}, live = [], inflight = {};
  // Fetch and decode every sound not held yet. Runs on each gesture, so a sound that failed once (network blip) is retried.
  function load() {
    for (const n of Object.keys(S)) {
      if (buf[n] || inflight[n]) continue; inflight[n] = true;
      fetch(BASE + 'sfx-' + n + '.mp3').then(r => r.ok ? r.arrayBuffer() : null)
        .then(a => a && new Promise((ok, no) => ctx.decodeAudioData(a, ok, no))).then(b => { if (b) buf[n] = b; }).catch(() => {}).then(() => { inflight[n] = false; });
    }
  }
  // The audio graph. Built at load (a context made before a tap starts suspended; the first tap resumes it) so the match
  // recorder (rec.js) can take its sound track from the first frame: GbwSfx.tap() returns a MediaStream of everything played.
  let tail = null, tapDest = null;
  function ensure() {
    if (ctx) return;
    ctx = new AC(); master = ctx.createGain(); master.gain.value = .6; tail = master;
    if (ctx.createDynamicsCompressor) { const c = ctx.createDynamicsCompressor(); c.threshold.value = -14; c.ratio.value = 6; c.attack.value = .003; c.release.value = .15; master.connect(c); tail = c; }
    tail.connect(ctx.destination);
  }
  function tap() { try { ensure(); if (!tapDest && ctx.createMediaStreamDestination) { tapDest = ctx.createMediaStreamDestination(); tail.connect(tapDest); } return tapDest && tapDest.stream; } catch (e) { return null; } }
  function unlock() {
    try {
      ensure();
      if (ctx.state !== 'running') { const r = ctx.resume(); if (r && r.catch) r.catch(() => {}); }   // 'suspended', and iOS 'interrupted' after a call or a lock
      const s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, 22050); s.connect(master); s.start(0); // iOS unlock
      load();
    } catch (e) {}
  }
  for (const ev of ['pointerdown', 'pointerup', 'mousedown', 'click', 'touchend', 'keydown']) window.addEventListener(ev, unlock, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ctx && ctx.state !== 'running') { try { const r = ctx.resume(); if (r && r.catch) r.catch(() => {}); } catch (e) {} } });
  // Browsers keep sound off until the page gets a tap or key. An owner link opens straight into a match, so say so, once, until it is on.
  let mutedAt = 0;
  function nudge() {
    const off = !muted && frames > 0 && (!ctx || ctx.state !== 'running');
    if (muted && frames > 0 && !mutedAt) mutedAt = performance.now();   // a saved mute (same browser, same site) is easy to miss: say so for a few seconds
    const mm = muted && mutedAt && performance.now() - mutedAt < 8000, need = off || mm;
    if (need && !hint && document.body) {
      hint = document.createElement('div'); hint.id = 'sfxHint';
      hint.style.cssText = 'position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:60;padding:6px 12px;border-radius:14px;background:rgba(0,0,0,.72);color:#d8e0d0;border:1px solid rgba(186,252,130,.45);font:12px/1.2 sans-serif;pointer-events:none';
      document.body.appendChild(hint);
    }
    if (hint) { hint.textContent = mm ? '🔇 Sound is muted. Tap the speaker button to turn it on' : '🔊 Tap the page to turn on sound'; hint.style.display = need ? 'block' : 'none'; }
  }
  setInterval(nudge, 700);
  function play(n, pan) {
    if (muted || !ctx || ctx.state !== 'running' || document.hidden) return;
    const b = buf[n], cfg = S[n]; if (!b || !cfg) return;
    const t = performance.now(); if (t - (lastAt[n] || 0) < cfg[1]) return;
    for (let i = live.length - 1; i >= 0; i--) if (live[i].end < ctx.currentTime) live.splice(i, 1);
    if (live.length >= MAXV || live.filter(v => v.n === n).length >= cfg[2]) return;
    lastAt[n] = t;
    try {
      const s = ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = 1 + (Math.random() - .5) * .12;
      const g = ctx.createGain(); g.gain.value = cfg[0]; s.connect(g);
      let out = g; if (ctx.createStereoPanner && pan != null) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-.7, Math.min(.7, pan)); g.connect(p); out = p; }
      out.connect(master); s.start(); live.push({ n, end: ctx.currentTime + b.duration / s.playbackRate.value });
    } catch (e) {}
  }
  window.GbwSfx = { play, isMuted: () => muted, tap };

  // Mute toggle, next to the fullscreen button when present, else fixed bottom-right.
  function button() {
    const b = document.createElement('button'); b.type = 'button'; b.id = 'sfxBtn'; b.className = 'sfx-btn';
    const paint = () => { b.textContent = muted ? '🔇' : '🔊'; b.title = muted ? 'Sound off (tap to turn on)' : 'Sound on (tap to mute)'; b.setAttribute('aria-pressed', String(!muted)); };
    b.setAttribute('aria-label', 'Sound effects'); paint();
    b.style.cssText = 'font:16px/1 sans-serif;min-width:34px;min-height:34px;padding:4px;background:rgba(0,0,0,.35);color:#d8e0d0;border:1px solid rgba(186,252,130,.35);border-radius:6px;cursor:pointer;margin-left:6px';
    b.addEventListener('click', () => { muted = !muted; try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch (e) {} unlock(); paint(); if (!muted) play('coin'); });
    const fs = document.getElementById('fsBtn');
    if (fs && fs.parentNode) fs.parentNode.insertBefore(b, fs.nextSibling);
    else { b.style.position = 'fixed'; b.style.right = '10px'; b.style.bottom = '10px'; b.style.zIndex = '50'; document.body.appendChild(b); }
  }

  // Frame diffing (same keys as agrts-fx.js).
  const D = window.GbwAgrtsDraw;
  const k = (o, s) => s + Math.round(o.x) + ',' + Math.round(o.y) + ',' + Math.round(o.tx || 0) + ',' + Math.round(o.ty || 0) + ',' + (o.type || o.kind || o.amount || '');
  let seen = new Set(), shotLife = new Map(), ids = null, lastEl = -1, W = 800, pend = [];
  let twAlive = new Map(), shieldPrev = null, hpSeen = new Set(); // towers (TOWERS=1): last alive flags, shield flags, HP events already sounded
  const panOf = x => (x / W) * 2 - 1;
  function detect(f) {
    frames++; W = f.w || 800; const types = (D && D.types) || {}, now = new Set(), nl = new Map();
    const el = f.elapsed || 0;
    if (lastEl < 0 || el + 1 < lastEl) { seen = new Set(); shotLife = new Map(); ids = null; twAlive = new Map(); shieldPrev = null; hpSeen = new Set(); if (lastEl >= 0 || el < 3) play('start'); }
    lastEl = el;
    for (const s of f.shots || []) {
      const key = k(s, 's'); nl.set(key, s.life); const pl = shotLife.get(key); if (pl !== undefined && !(s.life > pl)) continue;
      const role = (types[s.type] || {}).role, p = panOf(s.x);
      if (s.type === 'turret') play('turret', p); else if (role === 'armor') play('breaker', p); else if (role === 'ranged') play('rifle', p); else if (role === 'fast') play('scout', p);
    }
    for (const c of f.combatFx || []) {
      const key = k(c, 'c'); now.add(key); if (seen.has(key)) continue; const p = panOf(c.x);
      if (c.kind === 'mortarLaunch') play('mortar-launch', p);
      else if (c.kind === 'mortar') pend.push({ at: performance.now() + Math.max(0, (c.delay || 0) - (c.t || 0)) * 1000, p });
      else if (c.kind === 'detonate') play('drone', p);
      else if (c.kind === 'turretDown') play('destroyed', p);
      else if (c.kind === 'blast') play('alarm', p);
    }
    for (const h of f.healPopups || []) { const key = k(h, 'h'); now.add(key); if (!seen.has(key)) play('heal', panOf(h.x)); }
    // Forward post unlocked (Range postMoment): Green hears capture once per unlock (locked set, no new file). Ready and build stay silent; a destroyed post uses 'destroyed' (towers()).
    for (const t of f.towers || []) if (t.kind === 'post' && t.side === 0 && t.glow > 0) { const key = 'post' + t.slot; now.add(key); if (!seen.has(key)) play('capture'); }
    for (const c of f.capturePulses || []) { const key = 'z' + c.zone + ',' + c.side; now.add(key); if (!seen.has(key)) play(c.side === 0 ? 'capture' : 'lost'); }
    const cur = new Map(); for (const u of f.units || []) if (u.id != null) cur.set(u.id, u);
    if (ids) for (const [id, u] of ids) if (!cur.has(id)) { play('destroyed', panOf(u.x)); break; }
    if (ids) for (const [id, u] of cur) if (!ids.has(id) && u.type === 'drone') { play('drone-launch', panOf(u.x)); break; } // an FPV drone leaves the base
    if (f.towersOn) towers(f);
    ids = cur; seen = now; shotLife = nl;
    const t = performance.now(); pend = pend.filter(m => { if (m.at <= t) { play('mortar-impact', m.p); return false; } return true; });
  }
  // Towers and Team HP (TOWERS=1). Gun shots are type 'turret' (sound above). A tower going down: destroyed (the depot also alarm),
  // and a coin when it is Ember's (Green is the viewer's side). The base shield dropping: squelch. A Team HP event of 8+: alarm.
  // A zone lost: lost for Green, capture when it is Ember's zone.
  function towers(f) {
    for (const t of f.towers || []) {
      const key = t.side + t.kind, was = twAlive.get(key); twAlive.set(key, !!t.alive);
      if (was && !t.alive) { play('destroyed', panOf(t.x)); if (t.kind === 'depot') play('alarm'); if (t.side === 1 && t.kind !== 'post') play('coin', .4); }
    }
    const sh = f.shield || [];
    if (shieldPrev) for (const s of [0, 1]) if (shieldPrev[s] && !sh[s]) play('squelch', s ? .5 : -.5);
    shieldPrev = [!!sh[0], !!sh[1]];
    const nowEv = new Set();
    for (const e of f.hpEvents || []) {
      const key = e.side + e.why + e.at; nowEv.add(key); if (hpSeen.has(key)) continue;
      if (e.why === 'zone') play(e.side === 0 ? 'lost' : 'capture');
      else if (e.why === 'tower' && e.amount >= 8 && e.side === 0) play('alarm');
    }
    hpSeen = nowEv;
  }
  if (D && !D.__sfx) {
    const orig = D.paint; D.__sfx = true;
    D.paint = function (c, f) { try { if (f) detect(f); } catch (e) {} return orig.apply(this, arguments); };
  }

  // DOM events: CR changes (from the coin VFX), COMM NET messages, match result.
  window.addEventListener('gbw:cr', e => { const d = e.detail || {}; if (Math.abs(d.delta || 0) >= 5) play('coin', d.side ? .5 : -.5); });
  function boot() {
    button();
    // A radio cue for each new COMM NET message, incoming and outgoing: commnet.js raises gbw:comm per side that got new ones.
    // Without commnet (older pages) the old feed node is watched instead.
    // Only the viewer's own net (side 0, Green) raises the cue: the rival's chatter (reports, FRAGOs, unit status) made it fire every second or two
    // (about 16 a minute, two thirds of them from the other team). commnet.js never counts acks. RIVAL_CUE = true brings the other net back.
    const RIVAL_CUE = false;
    window.addEventListener('gbw:comm', e => { const d = e.detail || {}; if (d.side === 1 && !RIVAL_CUE) return; play('comm', d.side === 1 ? .4 : d.side === 0 ? -.4 : 0); });
    for (const s of [0, 1]) { const el = document.getElementById('dfeed' + s); if (el) new MutationObserver(m => { if (!window.GbwCommNet && (s === 0 || RIVAL_CUE) && m.some(r => r.addedNodes.length)) play('comm', s ? .4 : -.4); }).observe(el, { childList: true, subtree: true }); }
    const toast = document.getElementById('toast'); let shown = false;
    if (toast) new MutationObserver(() => {
      const on = toast.classList.contains('show'); if (on && !shown) { const w = (document.getElementById('winner') || {}).textContent || ''; play(/GREEN/.test(w) ? 'victory' : /EMBER/.test(w) ? 'defeat' : 'lost'); } shown = on;
    }).observe(toast, { attributes: true, attributeFilter: ['class'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
