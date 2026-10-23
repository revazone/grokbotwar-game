/* Match video (Oct 21). Records the battlefield canvas, plus the game sounds from sfx.js, from go-live to END with
   canvas.captureStream + MediaRecorder, all in the viewer's browser (nothing is sent to the server). At END the result
   card gets a "Download video" button (and "Share" where the phone offers it). MP4 (H.264) where the browser records it
   (iOS Safari, recent Chrome), WebM (VP9/VP8) otherwise. 2.5 Mbps video cap, 1 s chunks. On by default; the REC pill
   turns it off for this browser (localStorage 'gbw.rec.off'). Keep this file identical to relay/public/agrts-rec.js. */
(() => {
  'use strict';
  if (typeof window === 'undefined' || window.__gbwRec) return; window.__gbwRec = true;
  const KEY = 'gbw.rec.off', FPS = 30, VBPS = 2500000, ABPS = 96000;
  const TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const MR = window.MediaRecorder;
  const canvasEl = () => document.getElementById('canvas') || document.getElementById('arena');
  const supported = () => !!(MR && canvasEl() && canvasEl().captureStream);
  let off = false; try { off = localStorage.getItem(KEY) === '1'; } catch (e) {}
  let hasAudio = false, rec = null, chunks = [], mime = '', phase = 'idle', url = null, file = null, pill = null, winner = '';
  const api = window.GbwRec = { get phase() { return phase; }, get mime() { return mime; }, get audio() { return hasAudio; }, get bytes() { return chunks.reduce((a, c) => a + c.size, 0); }, get url() { return url; }, get file() { return file; } };

  function pick() { for (const t of TYPES) { try { if (MR.isTypeSupported(t)) return t; } catch (e) {} } return ''; }
  function start() {
    if (rec || off || !supported()) return;
    try {
      const v = canvasEl().captureStream(FPS), tracks = v.getVideoTracks().slice();
      const a = window.GbwSfx && GbwSfx.tap && GbwSfx.tap(); if (a) tracks.push(...a.getAudioTracks()); hasAudio = tracks.length > 1;
      mime = pick(); chunks = []; clearResult();
      const opt = { videoBitsPerSecond: VBPS, audioBitsPerSecond: ABPS }; if (mime) opt.mimeType = mime;
      rec = new MR(new MediaStream(tracks), opt); mime = rec.mimeType || mime || 'video/webm';
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = finish;
      rec.start(1000); phase = 'recording'; paint();
    } catch (e) { rec = null; phase = 'error'; paint(); }
  }
  function stop() { if (rec && rec.state !== 'inactive') { phase = 'saving'; paint(); try { rec.stop(); } catch (e) { finish(); } } }
  function finish() {
    const r = rec; rec = null; if (r) try { r.stream.getVideoTracks().forEach(t => t.stop()); } catch (e) {}
    if (!chunks.length) { phase = 'idle'; paint(); return; }
    const type = mime.split(';')[0], ext = /mp4/.test(type) ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type }); chunks = [];
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const name = `grokbotwar-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${winner || 'end'}.${ext}`;
    url = URL.createObjectURL(blob); try { file = new File([blob], name, { type }); } catch (e) { file = blob; file.name = name; }
    phase = 'ready'; paint(); offer(name, blob.size);
  }
  function clearResult() { if (url) URL.revokeObjectURL(url); url = null; file = null; const b = document.getElementById('recBox'); if (b) b.remove(); }
  function offer(name, size) {
    const toast = document.getElementById('toast'); if (!toast) return;
    const box = document.createElement('div'); box.id = 'recBox';
    box.style.cssText = 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:8px;pointer-events:auto';
    const btn = 'padding:7px 12px;border-radius:8px;border:1px solid rgba(186,252,130,.6);background:rgba(186,252,130,.14);color:#e8f5dc;font:600 12px/1.2 sans-serif;text-decoration:none;cursor:pointer';
    const a = document.createElement('a'); a.id = 'recDownload'; a.href = url; a.download = name; a.style.cssText = btn;
    a.textContent = `⬇ Download video (${(size / 1048576).toFixed(1)} MB)`; box.appendChild(a);
    if (navigator.canShare && file instanceof File && navigator.canShare({ files: [file] })) {
      const s = document.createElement('button'); s.type = 'button'; s.style.cssText = btn; s.textContent = 'Share';
      s.onclick = () => navigator.share({ files: [file], title: 'GrokBotWar match' }).catch(() => {}); box.appendChild(s);
    }
    const x = document.createElement('button'); x.type = 'button'; x.id = 'recClose'; x.title = 'Close'; x.setAttribute('aria-label', 'Close');
    x.style.cssText = btn + ';padding:7px 10px'; x.textContent = '✕';
    x.onclick = () => { clearResult(); toast.style.display = 'none'; }; box.appendChild(x);
    toast.appendChild(box);
  }
  function paint() {
    if (!supported()) return;
    if (!pill && document.body) {
      pill = document.createElement('button'); pill.type = 'button'; pill.id = 'recPill';
      pill.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:61;padding:4px 9px;border-radius:12px;background:rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.25);color:#ddd;font:600 11px/1.2 sans-serif;cursor:pointer';
      pill.onclick = () => { off = !off; try { localStorage.setItem(KEY, off ? '1' : '0'); } catch (e) {} if (off && rec) { chunks = []; try { rec.onstop = () => { rec = null; phase = 'idle'; paint(); }; rec.stop(); } catch (e) {} } paint(); tick(); };
      document.body.appendChild(pill);
    }
    if (pill) pill.innerHTML = off ? '<span style="color:#888">●</span> REC OFF' : phase === 'recording' ? '<span style="color:#ff4d4d">●</span> REC' : phase === 'saving' ? '● SAVING' : '<span style="color:#bbb">●</span> REC ON';
    if (pill) pill.title = off ? 'Match video is off. Tap to record matches' : 'Recording this match as a video. Tap to turn off';
  }
  // Go-live and END from the page's own state (window.__gbw.state on both watch pages); no hooks into the renderers.
  let last = '';
  function tick() {
    const g = window.__gbw, st = g && g.state; if (!st) return;
    const pre = st.phase === 'waiting' || st.phase === 'countdown', over = st.status === 'over';
    const key = over ? 'over' : pre ? 'pre' : 'live';
    if (key === 'live' && !rec && phase !== 'ready' && phase !== 'saving') start();
    if (key === 'pre' && last !== 'pre') { if (rec) { rec.onstop = null; try { rec.stop(); } catch (e) {} rec = null; } chunks = []; clearResult(); phase = 'idle'; } // a new match
    if (key === 'over' && last !== 'over' && rec) {
      const w = st.winner && st.winner.side; winner = w === 0 ? 'green-wins' : w === 1 ? 'ember-wins' : 'draw';
      setTimeout(stop, 2500); // keep the last blasts on the tape
    }
    if (key === 'live' && phase === 'ready') { clearResult(); phase = 'idle'; } // match restarted without a gate
    last = key; paint();
  }
  setInterval(tick, 500);
})();
