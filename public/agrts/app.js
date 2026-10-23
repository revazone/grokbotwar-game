/* Iteration 11 spectator. The match runs on the server (src/agrts/match.js).
   draw.js paints the prototype field in canvas pixels; this file fills the HUD. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const canvas = $('canvas'), ctx = canvas.getContext('2d');
  let state = null, seenNotice = 0;
  let W = 800, H = 380, cssW = 800, cssH = 380, dpr = 1;
  let land = [], units = [], hp = [100, 100], elapsed = 0;
  let walls = [], rough = [], sparks = [], shots = [], combatFx = [], spawnFx = [];
  let capturePulses = [], spendPulses = [], healPopups = [], cameraShake = 0;
  // Viewer gate id from the owner link's fragment (#g=<id>), presented on /events. Without it this page only spectates.
  let GATE = null;
  try {
    const gm = /(?:^#|&)g=([0-9a-f]{32})(?:&|$)/.exec(location.hash || '');
    if (gm) { GATE = gm[1]; sessionStorage.setItem('gbw-gate:local', GATE); } else GATE = sessionStorage.getItem('gbw-gate:local');
  } catch {}
  if (!/^[0-9a-f]{32}$/.test(GATE || '')) GATE = null;
  window.__gbw = { get state() { return state; } };

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(devicePixelRatio || 1, 2);
    cssW = Math.max(1, r.width); cssH = Math.max(1, r.height);
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  }
  new ResizeObserver(resize).observe(canvas);

  function post(action) {
    return fetch('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
  }
  $('toast-new').addEventListener('click', () => post('restart'));

  const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Complete arsenal: one row per unit type (zeros dimmed). Desktop shows icon, name and × count; the phone
  // layout turns the same rows into icon + × count chips in CSS. The icon is the field's own drawUnit shape.
  function unitIcon(k, side) {
    const url = window.GbwAgrtsDraw && GbwAgrtsDraw.icon ? GbwAgrtsDraw.icon(k.type, side, 26) : '';
    return url ? `<img class="uicon" src="${url}" alt="">` : `<i class="mini" style="color:${esc(k.color)}">${esc(k.glyph)}</i>`;
  }
  function inventoryMarkup(list, side) {
    if (!list || !list.length) return '<div class="empty">—</div>';
    return list.map(k => `<div class="invrow${Number(k.count) > 0 ? '' : ' zero'}" title="${esc(k.name)}"><span>${unitIcon(k, side)}<em class="unit-name">${esc(k.name)}</em></span><b class="count">× ${esc(k.count)}</b></div>`).join('');
  }
  // Rewrite a panel block only when its markup changes, so the icons do not reload every frame.
  const lastHtml = {};
  function setHtml(id, html) { const n = $(id); if (n && lastHtml[id] !== html) { lastHtml[id] = html; n.innerHTML = html; } }
  // Comm net scrollback: the page keeps up to 200 entries per side and only prepends new rows, so a scrolled-back
  // view and any text selection survive updates. Stuck to the top (newest) only while the user is at the top.
  let commNet = null; // COMM NET exchanges view (agrts-commnet.js), mounted on the first frame
  const commHist = [[], []];
  const commKey = r => `${r.at}|${r.from}|${r.text}`;
  function commsRender(s, rows) {
    const n = $('dfeed' + s); if (!n) return;
    const hist = commHist[s];
    if (!rows || !rows.length) { if (hist.length || lastHtml['dfeed' + s] !== 'c0') { hist.length = 0; n.innerHTML = ''; lastHtml['dfeed' + s] = 'c0'; } return; }
    if (lastHtml['dfeed' + s] !== 'c') { n.innerHTML = ''; hist.length = 0; lastHtml['dfeed' + s] = 'c'; }
    let fresh = rows;
    if (hist.length) {
      const top = commKey(hist[0]), i = rows.findIndex(r => commKey(r) === top);
      if (i >= 0) fresh = rows.slice(0, i);
      else if (String(rows[0].at) < String(hist[0].at)) { n.innerHTML = ''; hist.length = 0; } // new match
    }
    if (!fresh.length) return;
    const html = fresh.map(r => {
      const k = { neg: 'err', frago: 'deploy', wilco: 'hold', net: 'bank', threat: 'err', loss: 'err' }[r.kind] || 'hold';
      return `<div class="crow"><span class="at">${esc(r.at)}</span> <b class="k-${k}">${esc(r.from)}:</b> ${esc(r.text)}</div>`;
    }).join('');
    const atTop = n.scrollTop <= 2, h0 = n.scrollHeight;
    n.insertAdjacentHTML('afterbegin', html);
    hist.unshift(...fresh);
    while (hist.length > 200) { hist.pop(); if (n.lastElementChild) n.lastElementChild.remove(); }
    if (atTop) n.scrollTop = 0; else n.scrollTop += n.scrollHeight - h0;
  }
  // Comm net (src/agrts/comms.js renders the text in the arena; this is only layout, easy to replace).
  function commsMarkup(rows) {
    return rows.slice(0, 12).map(r => {
      const k = { neg: 'err', frago: 'deploy', wilco: 'hold', net: 'bank', threat: 'err', loss: 'err' }[r.kind] || 'hold';
      return `<div class="crow"><span class="at">${esc(r.at)}</span> <b class="k-${k}">${esc(r.from)}:</b> ${esc(r.text)}</div>`;
    }).join('');
  }
  function feedMarkup(rows) {
    if (!rows || !rows.length) return '<div class="drow wait"><span class="detail">—</span></div>';
    return rows.slice(0, 8).map(r => {
      const kind = ['deploy', 'buy', 'hold', 'bank', 'err'].includes(r.kind) ? r.kind : 'hold';
      const detail = r.detail ? `<span class="detail">· ${esc(r.detail)}</span>` : '';
      const ms = r.ms ? `<span class="ms">${esc(r.ms)}</span>` : '';
      const auto = r.auto ? '<span class="auto">auto</span>' : '';
      const why = r.why ? `<div class="dwhy">${esc(r.why)}</div>` : '';
      return `<div class="ditem"><div class="drow"><span class="at">${esc(r.at)}</span><span class="verb k-${kind}">${esc(r.verb)}</span>${detail}${ms}${auto}</div>${why}</div>`;
    }).join('');
  }
  function paintHud(st) {
    // The arena's unit table (units.csv) first, so arsenal icons and the field use the current shapes.
    if (window.GbwAgrtsDraw && GbwAgrtsDraw.setTable) GbwAgrtsDraw.setTable(st.unitTable);
    { const eb = document.querySelector('.eyebrow'); if (eb) eb.textContent = 'AGENTIC REAL-TIME STRATEGY' + (st.rules && st.rules.version ? ` · RULES ${st.rules.version} ${st.rules.source || ''}` : ''); }
    paintGate(st);
    $('toast').classList.toggle('show', st.status === 'over');
    if (st.status === 'over' && st.winner) {
      $('winner').textContent = st.winner.side == null ? 'DRAW' : (st.winner.side === 0 ? 'GREEN VICTORY' : 'EMBER VICTORY');
      const nice = b => String(b || '').charAt(0) + String(b || '').slice(1).toLowerCase();
      const lostBase = st.sides && st.sides[1 - st.winner.side] && st.sides[1 - st.winner.side].base;
      const lost = st.winner.side === 0 || st.winner.side === 1 ? nice(lostBase || (st.winner.side === 0 ? 'CINDER-09' : 'HAVEN-01')) : 'both bases';
      $('wintext').textContent = st.winner.side == null ? `${st.winner.reason} · ${st.clock}` : `${lost} destroyed · ${st.clock}`;
    }
    st.sides.forEach((sd, s) => {
      $('label' + s).textContent = sd.label;
      $('role' + s).textContent = sd.role;
      $('base' + s).textContent = sd.base;
      $('hp' + s).textContent = `${sd.hp} HP`;
      $('cr' + s).textContent = sd.bank; // bank under HP (whole credits, "74 CR")
      $('bar' + s).style.width = Math.max(0, st.hp[s]) + '%';
      $('field' + s).textContent = sd.field;
      $('reserve' + s).textContent = sd.reserve;
      $('land' + s).textContent = sd.land;
      $('bank' + s).textContent = sd.bank;
      $('nextbuy' + s).textContent = sd.next;
      $('posture' + s).textContent = sd.posture;
      $('healing' + s).textContent = sd.healing;
      // COMM NET exchanges (agrts-commnet.js) when loaded; the old flat feed otherwise.
      if (window.GbwCommNet) { /* rendered below, once per frame */ } else if (sd.comms && sd.comms.length) commsRender(s, sd.comms); else { if (lastHtml['dfeed' + s] === 'c') commHist[s].length = 0; setHtml('dfeed' + s, feedMarkup(sd.feed)); }
      { const m = $('mobile-decision' + s); if (m) m.textContent = sd.commShort || sd.mobile || ''; }
      setHtml('inventory' + s, inventoryMarkup(sd.inventory, s));
    });
    if (window.GbwCommNet) { commNet = commNet || GbwCommNet.attach({}); commNet.update(st); }
    const notice = (st.notices || []).filter(n => n.id > seenNotice).pop();
    if (notice) {
      seenNotice = notice.id;
      const box = $('spend-flash');
      box.style.setProperty('--spend-color', notice.side === 0 ? '#bafc82' : '#ff7768');
      $('spend-title').textContent = `${notice.side === 0 ? 'GREEN' : 'EMBER'} · −${notice.amount} CREDITS`;
      $('spend-detail').textContent = `${notice.names} ADDED TO RESERVE`;
      box.classList.remove('show'); void box.offsetWidth; box.classList.add('show');
    }
  }

  function paintGate(st) {
    const gate = $('gate');
    if (!gate) return;
    const pre = st.phase === 'waiting' || st.phase === 'countdown';
    gate.hidden = !pre;
    if (!pre) return;
    if (st.phase === 'countdown') {
      $('gate-kicker').textContent = '';
      $('gate-title').textContent = '';
      $('gate-count').textContent = String(st.countdown || '');
    } else {
      // Armed behind the viewer gate: only a page opened with the gate id (#g=...) starts it; any other page just spectates.
      if (st.gated && !GATE) {
        $('gate-kicker').textContent = 'A new match is waiting';
        $('gate-title').textContent = 'Open the new link from your commander to start it. This page is only spectating.';
      } else {
        $('gate-kicker').textContent = 'Waiting for viewer';
        $('gate-title').textContent = "Match starts when you're watching";
      }
      $('gate-count').textContent = '';
    }
  }

  function sync(st) {
    W = st.w || 800; H = st.h || 380;
    land = st.land || []; units = st.units || []; hp = st.hp || [100, 100]; elapsed = st.elapsed || 0;
    walls = st.walls || []; rough = st.rough || []; sparks = st.sparks || []; shots = st.shots || [];
    combatFx = st.combatFx || []; spawnFx = st.spawnFx || []; capturePulses = st.capturePulses || [];
    spendPulses = st.spendPulses || []; healPopups = st.healPopups || []; cameraShake = st.cameraShake || 0;
    resize();
  }

  function draw() {
    if (!state || !window.GbwAgrtsDraw) return;
    GbwAgrtsDraw.paint(ctx, {
      cssW, cssH, dpr, w: W, h: H, land, walls, rough, hp, elapsed,
      units, shots, sparks, combatFx, spawnFx, capturePulses, spendPulses, healPopups, cameraShake,
      unitTable: state.unitTable, turrets: state.turrets || [], hospitals: state.hospitals || [],
      towersOn: state.towersOn, towers: state.towers, shield: state.shield, hpEvents: state.hpEvents, towerPts: state.towerPts, timeLimit: state.timeLimit,
    });
  }


  function loop() {
    try { if (state) { sync(state); draw(); } }
    catch (e) { /* a bad frame stays on the last good picture */ }
    requestAnimationFrame(loop);
  }

  const es = new EventSource('/events' + (GATE ? '?g=' + GATE : ''));
  es.onmessage = ev => {
    try { state = JSON.parse(ev.data); paintHud(state); }
    catch (e) { /* ignore a bad event */ }
  };
  requestAnimationFrame(loop);
})();
