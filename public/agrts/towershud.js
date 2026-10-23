/* Towers HUD (TOWERS=1 only; src/agrts/towers.js). Wraps GbwAgrtsDraw.paint like fx.js and sfx.js and, from each frame, keeps two
   small DOM bits under the commander cards: a tick at 20% on each Team HP bar (the floor: only a base hit goes below it) and a row
   of pips, GUN / HOSP / DEPOT, up or down (a rebuild countdown while down), with the side's tie-break tower points.
   Nothing is drawn with the flag off. The field itself (towers, shield dome, HP popups, last-60-s line) is in draw.js.
   Keep this file identical to relay/public/agrts-towershud.js. */
(() => {
  'use strict';
  if (typeof window === 'undefined' || window.__gbwTowersHud) return; window.__gbwTowersHud = true;
  const D = window.GbwAgrtsDraw; if (!D || D.__twhud) return;
  const COL = ['#bafc82', '#ff7768'], last = ['', ''];
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function mount(s) {
    const bar = document.getElementById('bar' + s), box = bar && bar.parentElement; if (!box) return null;
    if (!box.__tw) {
      if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
      const tick = document.createElement('i'); tick.className = 'tw-floor'; tick.title = 'Team HP floor: towers, zones and siege stop here; only a base hit goes lower';
      tick.style.cssText = 'position:absolute;top:-2px;bottom:-2px;left:20%;width:2px;margin-left:-1px;background:rgba(255,255,255,.75);pointer-events:none;display:none;z-index:2';
      box.appendChild(tick);
      const pips = document.createElement('div'); pips.className = 'tw-pips'; pips.dataset.side = String(s);
      pips.style.cssText = 'display:none;gap:5px;flex-wrap:wrap;margin-top:4px;font:700 9px/1.2 "IBM Plex Mono",monospace;letter-spacing:.04em';
      // Commander cards (watch page): the pips live in the card's own .cc-towers row and are styled by agrts-layout.css.
      const host = box.closest && box.closest('.cc') && box.closest('.cc').querySelector('.cc-towers');
      if (host) { pips.classList.add('card'); pips.style.cssText = 'display:none'; host.appendChild(pips); }
      else box.insertAdjacentElement('afterend', pips);
      box.__tw = { tick, pips };
    }
    return box.__tw;
  }
  const card = () => !!document.querySelector('.cc-towers');
  function pip(label, st, col) {
    if (!st) return '';
    const up = !!st.alive, txt = up ? label : (st.rebuild > 0 ? `${label} ${st.rebuild}s` : label);
    if (card()) return `<span class="tw-pip ${up ? 'up' : 'down'}">${esc(txt)}</span>`;
    const style = up ? `color:${col};border:1px solid ${col}` : 'color:#8a8577;border:1px dashed #5a574c;text-decoration:line-through';
    return `<span class="tw-pip ${up ? 'up' : 'down'}" style="padding:1px 4px;border-radius:3px;${style}">${esc(txt)}</span>`;
  }
  function update(f) {
    for (const s of [0, 1]) {
      const m = mount(s); if (!m) continue;
      const on = !!f.towersOn;
      m.tick.style.display = on ? 'block' : 'none';
      if (!on) { if (last[s]) { last[s] = ''; m.pips.innerHTML = ''; } m.pips.style.display = 'none'; continue; }
      const gun = (f.towers || []).find(t => t.kind === 'gun' && t.side === s), dep = (f.towers || []).find(t => t.kind === 'depot' && t.side === s);
      const hosp = (f.hospitals || []).find(h => h.side === s);
      const pts = (f.towerPts || [0, 0])[s] || 0;
      // BUY RANGE: rounds left on the gun tower(s) and the base turret (frames carry them only while the boost is on)
      const rng = (f.towers || []).filter(t => t.kind === 'gun' && t.side === s && !t.extra).reduce((a, t) => a + (t.rounds || 0), 0) + (((f.turrets || []).find(t => t.side === s) || {}).rounds || 0);
      const rngChip = rng > 0 ? (card() ? `<span class="tw-pip up rng" title="BUY RANGE: rounds left on the tower and turret">RNG ${rng}</span>` : `<span class="tw-pip up rng" title="BUY RANGE: rounds left" style="padding:1px 4px;border-radius:3px;color:#ffd36b;border:1px solid #ffd36b">RNG ${rng}</span>`) : '';
      const html = pip('GUN', gun, COL[s]) + pip('HOSP', hosp, COL[s]) + pip('DEPOT', dep, COL[s]) + rngChip +
        `<span class="tw-pts" title="Tower points taken (tie-break at the time limit)"${card() ? '' : ' style="color:#d8e0d0;opacity:.8"'}>TOWERS ${pts}</span>`;
      m.pips.style.display = m.pips.classList.contains('card') ? '' : 'flex';
      if (html !== last[s]) { last[s] = html; m.pips.innerHTML = html; }
    }
  }
  const orig = D.paint;
  D.paint = function (ctx, f) { try { if (f) update(f); } catch (e) {} return orig.apply(this, arguments); };
  D.__twhud = true;
})();
