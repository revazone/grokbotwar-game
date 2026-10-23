/* COMM NET exchanges (docs/COMMNET-EXCHANGES.md). Watch-page presentation only; the arena renders every word
   (src/agrts/comms.js) and stamps msgId / exchangeId / replyTo / from / to / priority / subject on each entry.
   Grouping uses those ids only, never timing. Every original message keeps its exact wording in history.
   Keep this file identical to relay/public/agrts-commnet.js. Works in Node too (the model, for tests). */
(function (root) {
  'use strict';
  const URGENT = p => p === 'flash' || p === 'priority';
  const PRI_LABEL = { flash: 'FLASH', priority: 'PRI' };
  const seqOf = id => { const m = /(\d+)$/.exec(String(id || '')); return m ? +m[1] : 0; };
  const MAX_MSGS = 800;
  const COMPACT = 3;

  // ---------------------------------------------------------------- model (one per team)
  function Model() { this.reset(); }
  Model.prototype.reset = function () {
    this.msgs = new Map();   // id -> message (the arena row + id, exId, seq, rx)
    this.order = [];         // ids, arrival order (= arena order)
    this.ex = new Map();     // exchangeId -> { id, leadId, ids, firstSeq, subSeq, lastSeq, seen }
    this.maxSeq = 0;
    this.tick = 0;           // local arrival counter (orders exchanges, also for legacy rows)
    this.reasons = new Set();// reading hold: 'select' | 'hover' | 'focus' | 'history'
    this.selected = null;    // exchange the user picked
    this.pinned = null;      // exchange shown when the hold began
    this.frozen = null;      // compact ids frozen while held
    this.pending = new Set();// exchanges with new substantive traffic while held
    this.urgent = [];        // urgent message ids that arrived while held (not in the shown exchange)
    this.ended = false;
    this.match = null;
    this.version = (this.version || 0) + 1;
  };
  /** rows: the frame's comms (newest first). Returns { added, newEx } counts. */
  Model.prototype.ingest = function (rows, now) {
    rows = Array.isArray(rows) ? rows : [];
    now = now == null ? Date.now() : now;
    const top = rows[0];
    // A new match restarts the arena's msg counter: an unknown newest id below what we hold means a new match.
    // A new match: the arena stamps its match number on every entry (and restarts the msg counter).
    if (top && top.match != null && this.match != null && top.match !== this.match) this.reset();
    else if (top && top.msgId && !this.msgs.has(top.msgId) && seqOf(top.msgId) < this.maxSeq) this.reset();
    if (top && top.match != null) this.match = top.match;
    let added = 0, newEx = 0, cued = 0;
    const shownBefore = this.shownId();
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (!r) continue;
      const legacy = !r.msgId;
      const id = legacy ? `L|${r.at}|${r.from}|${r.text}` : r.msgId;
      if (this.msgs.has(id)) continue;
      const seq = ++this.tick;
      // Rows without ids (an older arena): each is its own exchange. Nothing is inferred.
      const exId = legacy ? `x${id}` : (r.exchangeId || `x${id}`);
      const m = Object.assign({}, r, { id, exId, seq, rx: now, ack: !!r.ack, replyTo: legacy ? null : (r.replyTo || null) });
      this.msgs.set(id, m); this.order.push(id);
      if (!legacy) this.maxSeq = Math.max(this.maxSeq, seqOf(id));
      let x = this.ex.get(exId);
      if (!x) { x = { id: exId, leadId: m.replyTo ? null : id, ids: [], firstSeq: seq, subSeq: 0, lastSeq: seq, seen: 0 }; this.ex.set(exId, x); newEx++; }
      if (!m.replyTo && !x.leadId) x.leadId = id;
      x.ids.push(id); x.lastSeq = seq;
      // Routine acknowledgments never move an exchange up on their own.
      if (!m.ack) x.subSeq = seq;
      if (this.held()) {
        if (exId !== shownBefore && !m.ack) this.pending.add(exId);
        if (URGENT(m.priority) && exId !== shownBefore) this.urgent.push(id);
      }
      added++; if (!m.ack) cued++;   // acks ("wilco, out") are routine: they never raise the radio cue
    }
    while (this.order.length > MAX_MSGS) this._dropOldest();
    if (added) this.version++;
    if (!this.held()) { const s = this.ex.get(this.shownId()); if (s) s.seen = s.ids.length; }
    return { added, newEx, cued };
  };
  Model.prototype._dropOldest = function () {
    const id = this.order.shift(); const m = this.msgs.get(id); this.msgs.delete(id);
    const x = m && this.ex.get(m.exId);
    if (x) { x.ids = x.ids.filter(i => i !== id); if (x.leadId === id) x.leadId = null; if (!x.ids.length) this.ex.delete(x.id); }
  };
  Model.prototype.held = function () { return this.reasons.size > 0; };
  /** Latest substantive exchange (what live mode features). */
  Model.prototype.liveId = function () {
    let best = null;
    for (const x of this.ex.values()) if (x.subSeq && (!best || x.subSeq > best.subSeq)) best = x;
    return best ? best.id : null;
  };
  Model.prototype.shownId = function () {
    if (this.held()) { const id = this.selected || this.pinned; if (id && this.ex.has(id)) return id; }
    return this.liveId();
  };
  Model.prototype.recentIds = function (n) {
    return [...this.ex.values()].filter(x => x.subSeq).sort((a, b) => b.subSeq - a.subSeq).slice(0, n).map(x => x.id);
  };
  /** Up to n compact exchanges below the shown one. Frozen while the user reads. */
  Model.prototype.compactIds = function (n = COMPACT) {
    const shown = this.shownId();
    if (this.held() && this.frozen) return this.frozen.filter(id => id !== shown && this.ex.has(id)).slice(0, n);
    return this.recentIds(n + 1).filter(id => id !== shown).slice(0, n);
  };
  Model.prototype.hold = function (reason, on) {
    const was = this.held();
    if (on) {
      if (!was) { this.pinned = this.shownId(); this.frozen = this.recentIds(COMPACT + 1); }
      this.reasons.add(reason);
    } else this.reasons.delete(reason);
    if (was && !this.held()) this._release();
    this.version++;
  };
  Model.prototype.select = function (exId) {
    if (!this.ex.has(exId)) return;
    if (!this.held()) { this.pinned = this.shownId(); this.frozen = this.recentIds(COMPACT + 1); }
    this.selected = exId; this.reasons.add('select');
    const x = this.ex.get(exId); x.seen = x.ids.length;
    this.pending.delete(exId);
    this.urgent = this.urgent.filter(id => { const m = this.msgs.get(id); return m && m.exId !== exId; });
    this.version++;
  };
  /** "Follow live": drop every hold and feature the latest substantive exchange again. */
  Model.prototype.followLive = function () { this.reasons.clear(); this._release(); this.version++; };
  Model.prototype._release = function () {
    this.selected = null; this.pinned = null; this.frozen = null; this.pending.clear(); this.urgent = [];
    const s = this.ex.get(this.liveId()); if (s) s.seen = s.ids.length;
  };
  Model.prototype.unread = function (exId) { const x = this.ex.get(exId); return x ? Math.max(0, x.ids.length - x.seen) : 0; };
  Model.prototype.exchange = function (exId) {
    const x = this.ex.get(exId); if (!x) return null;
    const msgs = x.ids.map(id => this.msgs.get(id)).filter(Boolean);
    const lead = x.leadId ? this.msgs.get(x.leadId) : null;
    return { id: x.id, lead, replies: msgs.filter(m => m !== lead), msgs, urgent: msgs.some(m => URGENT(m.priority)), firstSeq: x.firstSeq };
  };
  /** Complete stream, grouped by exchange, exchanges in the order they opened, messages in arrival order. */
  Model.prototype.history = function () {
    return [...this.ex.values()].sort((a, b) => a.firstSeq - b.firstSeq).map(x => this.exchange(x.id));
  };
  Model.prototype.count = function () { return this.msgs.size; };
  /** Latest substantive traffic, split by direction. Acks stay in the model and are not listed.
   *  Outgoing is the commander's own station (callsign ending in Main). Everything else on this
   *  net is incoming to Main. Newest first. n is how many each lane offers the sidebar. */
  Model.prototype.lanes = function (n = 2) {
    const incoming = [], outgoing = [];
    const main = from => /\bMain$/.test(String(from || ''));
    let urgent = null, scannedIn = 0;
    for (let i = this.order.length - 1; i >= 0; i--) {
      const msg = this.msgs.get(this.order[i]);
      if (!msg || msg.ack) continue;
      if (main(msg.from)) { if (outgoing.length < n) outgoing.push(msg); }
      else {
        scannedIn++;
        if (incoming.length < n) incoming.push(msg);
        // A FLASH/PRI a few lines back still takes the older slot, so the cue is not buried by the next routine report.
        if (!urgent && (msg.priority === 'flash' || msg.priority === 'priority') && scannedIn <= 6) urgent = msg;
      }
      if (incoming.length >= n && outgoing.length >= n && (urgent || scannedIn >= 6)) break;
    }
    if (n > 1 && urgent && !incoming.some(m => m.id === urgent.id)) {
      if (incoming.length < n) incoming.push(urgent);
      else incoming[incoming.length - 1] = urgent;
    }
    return { incoming, outgoing };
  };

  /** Every substantive message in one direction ('in' | 'out'), newest first. Client memory, this match only. */
  Model.prototype.laneLog = function (dir) {
    const out = [], main = from => /\bMain$/.test(String(from || ''));
    for (let i = this.order.length - 1; i >= 0; i--) {
      const msg = this.msgs.get(this.order[i]);
      if (!msg || msg.ack) continue;
      if ((dir === 'out') === main(msg.from)) out.push(msg);
    }
    return out;
  };

  // ---------------------------------------------------------------- rendering helpers
  const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /** Body without radio header/prowords only when the arena supplied it (structured), else the exact text. */
  const bodyOf = m => (m.body && String(m.body).trim()) || m.text;
  const priTag = m => PRI_LABEL[m.priority] ? `<span class="cn-pri cn-pri-${m.priority}">${PRI_LABEL[m.priority]}</span>` : '';
  const labelTag = m => m.label ? `<span class="cn-lab">${esc(m.label)}</span>` : '';
  const stateTag = m => m.state ? `<span class="cn-state">✓ ${esc(m.state)}</span>` : '';
  const fresh = (m, now) => { const age = now - (m.rx || 0); return age >= 0 && age < 1400 ? ` cn-new" style="animation-delay:-${age}ms` : ''; };
  function subjectText(s) { if (!s) return ''; if (s.unitId) return 'Locate unit'; if (s.zone) return 'Locate sector'; return ''; }

  // ---------------------------------------------------------------- view
  /**
   * opts: { side, models:[m0,m1], mount, mode:'side'|'phone', env }
   * env: { emblem(callsign, side) -> html, teamName(side), locate(subject, side) -> bool, canLocate(subject, side) -> bool|string, onOpenSheet(side) }
   */
  function View(opts) {
    this.o = opts; this.side = opts.side; this.mode = opts.mode || 'side'; this.env = opts.env || {};
    this.root = document.createElement('div');
    this.root.className = `cn cn-${this.mode}`;
    this.root.setAttribute('role', 'region');
    this.root.setAttribute('aria-label', 'Comm net');
    opts.mount.innerHTML = ''; opts.mount.appendChild(this.root);
    this.view = 'live'; // 'live' | 'history' (desktop) ; phone sheet handled separately
    this.sig = ''; this.histSig = '';
    this._wire();
  }
  View.prototype.model = function () { return this.o.models[this.side]; };
  View.prototype._wire = function () {
    const r = this.root;
    r.addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
      const act = b.dataset.act, m = this.model();
      if (act === 'select') m.select(b.dataset.ex);
      else if (act === 'follow') { this.view = 'live'; m.followLive(); }
      else if (act === 'history') { this.view = 'history'; m.hold('history', true); }
      else if (act === 'back') { this.view = 'live'; m.hold('history', false); }
      else if (act === 'lanelog') { this.openLog(b.dataset.dir); return; }
      else if (act === 'locate') this._locate(b);
      else if (act === 'more' && this.env.onOpenSheet) this.env.onOpenSheet(this.side);
      else if (act === 'team') { this.side = +b.dataset.side; this.sig = ''; }
      this.render(true);
    });
    // Hover / keyboard focus on an exchange holds the reading position.
    r.addEventListener('mouseover', e => { if (e.target.closest('.cn-x, .cn-c')) this._hover(true); });
    r.addEventListener('mouseleave', () => this._hover(false));
    r.addEventListener('focusin', e => { if (this._refocus) return; if (e.target.closest('.cn-x, .cn-c')) { this.model().hold('focus', true); this.render(); } });
    r.addEventListener('focusout', e => { if (this._refocus || this._rendering) return; if (!r.contains(e.relatedTarget)) { this.model().hold('focus', false); this.render(); } });
    r.addEventListener('keydown', e => { const p = e.target.closest && e.target.closest('.cn-pane[data-act]'); if (p && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); this.openLog(p.dataset.dir); } });
    r.addEventListener('keydown', e => { if (e.key === 'Escape' && this.view === 'history') { this.view = 'live'; this.model().hold('history', false); this.render(true); } });
  };
  View.prototype._hover = function (on) {
    if (this.mode === 'phone') return; // touch has no hover; taps select instead
    const m = this.model();
    if (on === m.reasons.has('hover')) return;
    m.hold('hover', on); this.render();
  };
  View.prototype._locate = function (b) {
    let s = null; try { s = JSON.parse(b.dataset.subject); } catch {}
    if (s && this.env.locate) this.env.locate(s, this.side);
  };
  View.prototype.speaker = function (m, side) {
    const em = this.env.emblem ? this.env.emblem(m.from, side) : '';
    return `<span class="cn-emb" aria-hidden="true">${em}</span><b class="cn-from">${esc(m.from)}</b>`;
  };
  View.prototype.locateBtn = function (subject, side) {
    const label = subjectText(subject); if (!label) return '';
    const ok = this.env.canLocate ? this.env.canLocate(subject, side) : true;
    const why = ok === true ? '' : (typeof ok === 'string' ? ok : 'Not on the field');
    const what = subject.unitId ? subject.unitId : `zone ${subject.zone}`;
    return `<button type="button" class="cn-loc" data-act="locate" data-subject='${esc(JSON.stringify(subject))}' ${why ? `disabled aria-disabled="true" title="${esc(why)}"` : `title="Highlight ${esc(what)} on the field"`}>◎ ${label}${why ? ` <i>· ${esc(why)}</i>` : ''}</button>`;
  };
  View.prototype.card = function (x, side, now, opts = {}) {
    if (!x) return '<div class="cn-empty">Net quiet. Waiting for traffic.</div>';
    const lead = x.lead || x.msgs[0];
    const urgent = x.urgent;
    const subjects = [];
    const seenS = new Set();
    for (const m of [lead, ...x.replies]) if (m && m.subject) { const k = JSON.stringify(m.subject); if (!seenS.has(k)) { seenS.add(k); subjects.push(m.subject); } }
    const head = `<div class="cn-head">${this.speaker(lead, side)}${lead.to ? `<span class="cn-arrow" aria-label="to">→</span><span class="cn-to">${esc(lead.to)}</span>` : ''}</div>`;
    const meta = `<div class="cn-meta">${priTag(lead)}${labelTag(lead)}<time>${esc(lead.at)}</time>${x.lead ? '' : '<span class="cn-lab">earlier message not received</span>'}</div>`;
    const replies = (x.lead ? x.replies : x.msgs.slice(1)).map(m => `<li class="cn-r${URGENT(m.priority) ? ' cn-urg' : ''}${fresh(m, now)}"><span class="cn-rarr" aria-hidden="true">↳</span>${this.speaker(m, side)}<span class="cn-rbody">${esc(bodyOf(m))}</span>${stateTag(m)}${priTag(m)}<time>${esc(m.at)}</time></li>`).join('');
    const locs = subjects.slice(0, 2).map(s => this.locateBtn(s, side)).join('');
    return `<article class="cn-x${urgent ? ' cn-urg' : ''}" tabindex="0" aria-label="Exchange from ${esc(lead.from)}">${opts.label ? `<div class="cn-kick">${esc(opts.label)}</div>` : ''}${head}${meta}<p class="cn-body${fresh(lead, now)}">${esc(bodyOf(lead))}</p>${replies ? `<ul class="cn-replies">${replies}</ul>` : ''}${locs ? `<div class="cn-locs">${locs}</div>` : ''}</article>`;
  };
  View.prototype.compact = function (id, side) {
    const m = this.model(), x = m.exchange(id); if (!x) return '';
    const lead = x.lead || x.msgs[0];
    const n = x.msgs.length - 1, u = m.unread(id);
    const count = u > 0 ? `<span class="cn-cnt cn-unread">${u} new</span>` : n > 0 ? `<span class="cn-cnt">${n} repl${n === 1 ? 'y' : 'ies'}</span>` : '';
    const pri = x.urgent ? priTag(x.msgs.find(q => URGENT(q.priority))) : '';
    return `<li><button type="button" class="cn-c${x.urgent ? ' cn-urg' : ''}" data-act="select" data-ex="${esc(id)}" aria-label="Open exchange from ${esc(lead.from)}"><span class="cn-ctop"><b>${esc(lead.from)}</b>${pri}${labelTag(lead)}${count}</span><span class="cn-prev">${esc(bodyOf(lead))}</span></button></li>`;
  };
  View.prototype.bar = function () {
    const m = this.model();
    const st = this.o.status ? this.o.status() : 'live';
    const live = st === 'ended' ? '<span class="cn-live cn-ended">■ Match ended</span>' : m.held() ? '<span class="cn-live cn-hold">❚❚ Reading</span>' : '<span class="cn-live">● Live</span>';
    const pend = m.pending.size, urg = m.urgent.length;
    const ind = m.held() && (pend || urg)
      ? `${urg ? `<button type="button" class="cn-urgchip" data-act="select" data-ex="${esc((m.msgs.get(m.urgent[m.urgent.length - 1]) || {}).exId || '')}">⚠ ${urg} urgent</button>` : ''}${pend ? `<span class="cn-newx">${pend} new exchange${pend === 1 ? '' : 's'}</span>` : ''}`
      : '';
    const follow = m.held() ? '<button type="button" class="cn-follow" data-act="follow">Follow live</button>' : '';
    // Sidebar no longer draws the History button. The model still keeps the full stream (history()).
    return `<div class="cn-bar">${live}${ind}${follow}</div>`;
  };
  View.prototype.teamTabs = function () {
    const name = s => esc(this.env.teamName ? this.env.teamName(s) : (s ? 'Ember' : 'Green'));
    return `<div class="cn-tabs" role="tablist">${[0, 1].map(s => `<button type="button" role="tab" aria-selected="${s === this.side}" class="cn-tab t${s}${s === this.side ? ' on' : ''}" data-act="team" data-side="${s}"><i aria-hidden="true">${s ? '◆' : '▲'}</i> ${name(s)}</button>`).join('')}</div>`;
  };
  View.prototype.historyMarkup = function (side) {
    const m = this.model();
    return m.history().map(x => {
      if (!x) return '';
      return `<section class="cn-hx" data-ex="${esc(x.id)}">${x.msgs.map(q => `<div class="cn-hm${q.replyTo ? ' cn-hr' : ''}${URGENT(q.priority) ? ' cn-urg' : ''}" data-id="${esc(q.id)}"><time>${esc(q.at)}</time>${q.replyTo ? '<span class="cn-rarr" aria-hidden="true">↳</span>' : ''}<b>${esc(q.from)}</b>${q.to ? ` <span class="cn-to">→ ${esc(q.to)}</span>` : ''} ${priTag(q)}<span class="cn-full">${esc(q.text)}</span></div>`).join('')}</section>`;
    }).join('') || '<div class="cn-empty">No traffic yet.</div>';
  };
  /** Re-render history inside its scroller without moving what the reader is looking at. */
  View.prototype.fillHistory = function (box, side) {
    const m = this.model();
    const sig = `${side}|${m.version}|${m.count()}`;
    if (sig === this.histSig && box.childElementCount) return;
    this.histSig = sig;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 4 && box.dataset.filled === '1';
    let anchor = null, off = 0;
    if (box.dataset.filled === '1' && !atBottom) {
      const top = box.getBoundingClientRect().top;
      for (const el of box.querySelectorAll('.cn-hm')) { const r = el.getBoundingClientRect(); if (r.bottom > top) { anchor = el.dataset.id; off = r.top - top; break; } }
    }
    box.innerHTML = this.historyMarkup(side);
    if (box.dataset.filled !== '1') { box.dataset.filled = '1'; box.scrollTop = box.scrollHeight; return; }
    if (anchor) {
      const el = box.querySelector(`.cn-hm[data-id="${CSS.escape(anchor)}"]`);
      if (el) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - off;
    }
  };
  View.prototype.render = function (force) {
    const m = this.model(), side = this.side, now = Date.now();
    const st = this.o.status ? this.o.status() : 'live';
    if (this.mode === 'side' && this.view === 'history') {
      let box = this.root.querySelector('.cn-hist');
      if (!box) {
        this.root.innerHTML = `<div class="cn-bar"><span class="cn-live cn-hold">History · ${esc(this.env.teamName ? this.env.teamName(side) : '')}</span><button type="button" class="cn-follow" data-act="back">Back</button><button type="button" class="cn-follow" data-act="follow">Follow live</button></div><div class="cn-hist" tabindex="0" aria-label="Comm net history"></div>`;
        box = this.root.querySelector('.cn-hist');
        this.sig = ''; this.barSig = '';
      }
      this.fillHistory(box, side);
      return;
    }
    if (this.root.querySelector('.cn-hist')) { this.root.innerHTML = ''; force = true; }
    if (this.mode === 'side') { this.renderLanes(force); return; }
    const shownId = m.shownId();
    const x = m.ex.get(shownId);
    const compacts = m.compactIds();
    const locSig = this.env.locSig ? this.env.locSig(side) : '';
    // The body re-renders only when what it shows changes (not on hover / focus / hold changes), so a
    // pointer or keyboard user never has the element under them replaced by a hold toggle.
    const bodySig = [side, st, shownId, x ? x.ids.length : 0, compacts.map(id => `${id}:${m.unread(id)}:${(m.ex.get(id) || {}).ids.length}`).join(','), locSig, m.count(), m.ex.size].join('|');
    const barSig = [side, st, m.held(), m.pending.size, m.urgent.length, m.count()].join('|');
    if (!force && bodySig === this.sig && barSig === this.barSig) return;
    const label = st === 'ended' ? 'Last exchange' : '';
    if (force || !this.root.firstChild || bodySig !== this.sig) {
      this.sig = bodySig; this.barSig = barSig;
      const shown = m.exchange(shownId);
      const more = Math.max(0, m.ex.size - 1);
      const act = document.activeElement && this.root.contains(document.activeElement) ? document.activeElement : null;
      const key = act ? (act.dataset.ex ? `[data-ex="${act.dataset.ex}"]` : act.dataset.act ? `[data-act="${act.dataset.act}"]` : act.classList.contains('cn-x') ? '.cn-x' : '') : '';
      this._rendering = true;
      if (this.mode === 'phone') {
        this.root.innerHTML = `${this.teamTabs()}<div class="cn-barwrap">${this.bar()}</div>${this.card(shown, side, now, { label })}<div class="cn-foot"><button type="button" class="cn-more" data-act="more" ${more ? '' : 'disabled'}>${more} more exchange${more === 1 ? '' : 's'} · history ▴</button></div>`;
      } else {
        this.root.innerHTML = `<div class="cn-barwrap">${this.bar()}</div><div class="cn-main">${this.card(shown, side, now, { label })}</div>${compacts.length ? `<ol class="cn-list" aria-label="Recent exchanges">${compacts.map(id => this.compact(id, side)).join('')}</ol>` : ''}`;
      }
      if (key) { const el = this.root.querySelector(key); if (el) { this._refocus = true; el.focus({ preventScroll: true }); this._refocus = false; } }
      this._rendering = false;
      this.fit();
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => this.fit()); // after icons / fonts settle
      return;
    }
    this.barSig = barSig;
    const bw = this.root.querySelector('.cn-barwrap');
    if (bw) bw.innerHTML = this.bar();
  };

  /** One sidebar line. Incoming names the sender only (the recipient is always Main). Agent (outgoing) names who it went to. */
  View.prototype.laneMsg = function (m, dir) {
    const who = dir === 'in' ? m.from : (m.to || '');
    const acc = m.priority === 'flash' ? ' cn-acc-flash' : m.priority === 'priority' ? ' cn-acc-pri' : '';
    const whoHtml = who ? `<div class="cn-who">${esc(who)}</div>` : '';
    const text = bodyOf(m), len = String(text || '').length;
    const fit = len > 180 ? ' cn-xlong' : len > 90 ? ' cn-long' : ''; // phone lanes shrink long traffic instead of cutting it
    return `<article class="cn-msg${acc}${fit}">${whoHtml}<p class="cn-say">${esc(text)}</p></article>`;
  };
  View.prototype.pane = function (label, msgs, dir) {
    const body = msgs.length ? msgs.map(m => this.laneMsg(m, dir)).join('') : '<div class="cn-quiet">Quiet</div>';
    return `<section class="cn-pane cn-${dir}" aria-label="${label}, open full log" role="button" tabindex="0" data-act="lanelog" data-dir="${dir}" title="Open the full ${label.toLowerCase()} log"><h3 class="cn-plab">${label}</h3><div class="cn-pbody">${body}</div></section>`;
  };
  /** Phone-landscape strip: one glance line. Hidden on the desktop sidebar. */
  View.prototype.glance = function (lanes) {
    const m = (lanes.incoming[0] || lanes.outgoing[0]);
    if (!m) return '<div class="cn-glance"><div class="cn-quiet">Net quiet</div></div>';
    const dir = lanes.incoming[0] ? 'in' : 'out';
    const acc = m.priority === 'flash' ? ' cn-acc-flash' : m.priority === 'priority' ? ' cn-acc-pri' : '';
    return `<div class="cn-glance${acc}">${this.laneMsg(m, dir)}</div>`;
  };
  /** Desktop / portrait sidebar: Incoming and Agent only. History stays in the model and is not drawn. */
  View.prototype.renderLanes = function (force) {
    const m = this.model(), side = this.side;
    const st = this.o.status ? this.o.status() : 'live';
    const lanes = m.lanes(1);
    if (this.logDir) this.fillLog();
    const sig = [side, st, lanes.incoming.map(q => q.id).join(','), lanes.outgoing.map(q => q.id).join(',')].join('|');
    if (!force && sig === this.sig) return;
    this.sig = sig;
    this.root.innerHTML = `${this.glance(lanes)}<div class="cn-bar"><span class="cn-netname">COMM NET</span></div><div class="cn-split">${this.pane('Incoming', lanes.incoming, 'in')}${this.pane('Agent', lanes.outgoing, 'out')}</div>`;
  };

  /** Full log of one lane in a modal: close button, Esc, or a click on the backdrop. */
  View.prototype.openLog = function (dir) {
    if (typeof document === 'undefined') return;
    this.closeLog();
    this.logDir = dir === 'out' ? 'out' : 'in';
    const el = document.createElement('div');
    el.className = 'cn-modal'; this.logEl = el;
    const label = this.logDir === 'in' ? 'Incoming' : 'Agent';
    el.innerHTML = `<div class="cn-mbox team-${this.side ? 'b' : 'a'}" role="dialog" aria-modal="true" aria-label="${label} log"><div class="cn-mhead"><span>COMM NET · ${label.toUpperCase()} · newest first</span><button type="button" class="cn-close" data-x aria-label="Close">×</button></div><div class="cn-mlist" tabindex="0"></div></div>`;
    el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-x]')) this.closeLog(); });
    this._esc = e => { if (e.key === 'Escape') this.closeLog(); };
    document.addEventListener('keydown', this._esc);
    document.body.appendChild(el);
    this.logSig = ''; this.fillLog();
    el.querySelector('.cn-close').focus();
  };
  View.prototype.fillLog = function () {
    if (!this.logEl) return;
    const msgs = this.model().laneLog(this.logDir);
    const sig = this.side + ':' + msgs.length + ':' + (msgs[0] ? msgs[0].id : '');
    if (sig === this.logSig) return; this.logSig = sig;
    const box = this.logEl.querySelector('.cn-mlist');
    box.innerHTML = msgs.length ? msgs.map(x => this.laneMsg(x, this.logDir)).join('') : '<div class="cn-quiet">No traffic yet.</div>';
  };
  View.prototype.closeLog = function () {
    if (this.logEl) this.logEl.remove();
    if (this._esc) document.removeEventListener('keydown', this._esc);
    this.logEl = null; this.logDir = null; this._esc = null;
  };

  /**
   * Desktop: the expanded card owns the space. Compact cards are dropped (down to one) until the card's
   * scroll area is at least MIN_CARD px tall; anything longer scrolls inside the card with a fade cue.
   */
  const MIN_CARD = 120;
  View.prototype.fit = function () {
    if (this.mode !== 'side') return;
    const main = this.root.querySelector('.cn-main'); if (!main || !main.clientHeight && !main.offsetParent) return;
    const items = [...this.root.querySelectorAll('.cn-list li')];
    for (let i = items.length - 1; i >= 1 && main.clientHeight < Math.min(MIN_CARD, main.scrollHeight); i--) items[i].hidden = true;
    const cue = () => main.classList.toggle('cn-cue', main.scrollHeight - main.scrollTop - main.clientHeight > 3);
    main.onscroll = cue; cue();
  };

  // ---------------------------------------------------------------- phone sheet (recent + history)
  function Sheet(opts) {
    this.o = opts; this.env = opts.env || {}; this.side = 0; this.tab = 'recent'; this.open = false;
    this.el = document.createElement('div');
    this.el.className = 'cn-sheet'; this.el.hidden = true;
    this.el.setAttribute('role', 'dialog'); this.el.setAttribute('aria-modal', 'false'); this.el.setAttribute('aria-label', 'Comm net exchanges');
    document.body.appendChild(this.el);
    this.helper = new View({ side: 0, models: opts.models, mount: document.createElement('div'), mode: 'sheet', env: opts.env, status: opts.status });
    this.el.addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
      const a = b.dataset.act;
      if (a === 'close') return this.close();
      if (a === 'tab') { this.tab = b.dataset.tab; this.render(true); return; }
      if (a === 'team') { this.setSide(+b.dataset.side); return; }
      if (a === 'select') { this.model().select(b.dataset.ex); this.close(); return; }
      if (a === 'follow') { this.model().followLive(); this.close(); return; }
    });
    this.el.addEventListener('keydown', e => { if (e.key === 'Escape') this.close(); });
  }
  Sheet.prototype.model = function () { return this.o.models[this.side]; };
  Sheet.prototype.setSide = function (s) {
    if (this.open) this.model().hold('history', false);
    this.side = s; this.helper.side = s; this.helper.histSig = '';
    if (this.open) this.model().hold('history', true);
    this.render(true);
  };
  Sheet.prototype.show = function (side) {
    this.side = side; this.helper.side = side; this.open = true; this.el.hidden = false; this.helper.histSig = '';
    this.model().hold('history', true);
    this.render(true);
    const c = this.el.querySelector('.cn-close'); if (c) c.focus({ preventScroll: true });
    if (this.o.onChange) this.o.onChange();
  };
  Sheet.prototype.close = function () {
    if (!this.open) return;
    this.open = false; this.el.hidden = true; this.model().hold('history', false);
    if (this.o.onChange) this.o.onChange();
  };
  Sheet.prototype.render = function (force) {
    if (!this.open) return;
    const m = this.model(), v = this.helper;
    if (force || !this.el.firstChild) {
      this.el.innerHTML = `<div class="cn-sh-head">${v.teamTabs()}<div class="cn-sh-tabs" role="tablist"><button type="button" role="tab" data-act="tab" data-tab="recent" aria-selected="${this.tab === 'recent'}" class="${this.tab === 'recent' ? 'on' : ''}">Recent</button><button type="button" role="tab" data-act="tab" data-tab="history" aria-selected="${this.tab === 'history'}" class="${this.tab === 'history' ? 'on' : ''}">Full history</button></div><button type="button" class="cn-follow" data-act="follow">Follow live</button><button type="button" class="cn-close" data-act="close" aria-label="Close">×</button></div><div class="cn-sh-body cn-hist" tabindex="0"></div>`;
      this.sig = ''; v.histSig = '';
    }
    const box = this.el.querySelector('.cn-sh-body');
    if (this.tab === 'history') { box.classList.add('cn-hist'); v.fillHistory(box, this.side); return; }
    const sig = `${this.side}|${m.version}`;
    if (sig === this.sig) return;
    this.sig = sig;
    box.dataset.filled = '';
    const ids = m.recentIds(12);
    box.innerHTML = ids.length ? `<ol class="cn-list">${ids.map(id => v.compact(id, this.side)).join('')}</ol>` : '<div class="cn-empty">No traffic yet.</div>';
  };


  // ---------------------------------------------------------------- page glue (both watch pages call this)
  /**
   * attach({ getState, arena }) -> { update(st) }. Mounts a desktop COMM NET in each team sidebar (.team .agent),
   * a phone COMM NET right below the arena (outside the fixed-height shell, so the arena keeps its size), and
   * the phone bottom sheet. getState() returns the latest frame (units carry tag, side, x, y).
   */
  function attach(cfg) {
    const doc = document;
    const models = [new Model(), new Model()];
    let runKey = null;   // boot + match number of the frame the models hold
    let heard = false;   // false until the first frame has been read: that backlog makes no sound
    let st = null;
    const arenaEl = cfg.arena || doc.querySelector('#battle .arena');
    const sides = () => (st && st.sides) || [];
    const names = side => { const sd = sides()[side] || {}; const out = {}; for (const k of sd.inventory || []) out[String(k.name).toLowerCase()] = k.type; return out; };
    const status = () => (st && (st.status === 'over' || (st.winner && st.winner.side !== undefined && st.status !== 'running'))) ? 'ended' : 'live';
    const unitsOf = () => (st && Array.isArray(st.units)) ? st.units : [];
    const findUnit = (tag, side) => unitsOf().find(u => u.tag === tag && u.side === side && u.hp > 0);
    const env = {
      teamName: s => { const sd = sides()[s] || {}; return sd.label ? String(sd.label).replace(/\s+COMMAND$/i, '') : (s ? 'Ember' : 'Green'); },
      emblem: (call, side) => {
        const c = String(call || '');
        if (/\bMain$/.test(c)) return '<span class="cn-badge cn-b-main" title="Main (the agent)">★</span>';
        if (/^All (units|stations)$/.test(c)) return '<span class="cn-badge">⁂</span>';
        if (c === 'Depot' || c === 'Field hospital') return '<span class="cn-badge">▣</span>';
        const m = /^(.*\S)\s+\S+$/.exec(c);
        const type = m && names(side)[m[1].toLowerCase()];
        const draw = typeof window !== 'undefined' && window.GbwAgrtsDraw;
        if (type && draw && draw.icon) { const url = draw.icon(type, side, 18); if (url) return `<img class="cn-icon" src="${url}" alt="">`; }
        return '<span class="cn-badge">⌂</span>';
      },
      canLocate: (s, side) => {
        if (s.unitId) return findUnit(s.unitId, side) ? true : 'Not on the field';
        if (s.zone >= 1 && s.zone <= 8) return true;
        return 'Unavailable';
      },
      locSig: side => unitsOf().filter(u => u.side === side && u.hp > 0).map(u => u.tag).join(','),
      locate: (s, side) => locate(s, side),
      onOpenSheet: side => sheet.show(side),
    };
    // desktop: one view per team sidebar
    const views = [0, 1].map(side => {
      const agent = doc.querySelector(`#dfeed${side}`) && doc.querySelector(`#dfeed${side}`).parentElement;
      if (!agent) return null;
      const mount = doc.createElement('div'); mount.className = 'cn-mount'; agent.appendChild(mount);
      return new View({ side, models, mount, mode: 'side', env, status });
    });
    doc.documentElement.classList.add('cn-on');
    // phone: below the arena, outside the 100dvh shell (page scrolls; the arena keeps its size)
    const shell = doc.querySelector('.shell');
    const wrap = doc.createElement('div'); wrap.className = 'cn-phone-wrap';
    if (shell && shell.parentNode) shell.parentNode.insertBefore(wrap, shell.nextSibling);
    const phone = new View({ side: 0, models, mount: wrap, mode: 'phone', env, status });
    const sheet = new Sheet({ models, env, status, onChange: () => phone.render(true) });
    // the strip's glance line on phone opens the sheet for that team
    views.forEach((v, side) => v && v.root.addEventListener('click', e => {
      if (!matchMedia('(max-width:950px) and (orientation:landscape)').matches) return;
      if (e.target.closest('[data-act]')) return;
      sheet.show(side);
    }));

    let hl = null;
    function locate(s, side) {
      if (!arenaEl || env.canLocate(s, side) !== true) return false;
      const cv = arenaEl.querySelector('canvas'); if (!cv) return false;
      const ar = arenaEl.getBoundingClientRect(), cr = cv.getBoundingClientRect();
      const W = (st && (st.w || (st.arena && st.arena.w))) || 800, H = (st && (st.h || (st.arena && st.arena.h))) || 380;
      if (hl) hl.remove();
      hl = doc.createElement('div');
      hl.className = s.unitId ? 'cn-hl cn-hl-unit' : 'cn-hl cn-hl-zone';
      hl.setAttribute('aria-hidden', 'true');
      arenaEl.appendChild(hl);
      const t0 = performance.now(), me = hl;
      const place = () => {
        if (me !== hl || !me.isConnected) return;
        if (s.unitId) {
          const u = findUnit(s.unitId, side);
          if (!u) { me.remove(); return; }
          me.style.left = (cr.left - ar.left + u.x * cr.width / W) + 'px';
          me.style.top = (cr.top - ar.top + u.y * cr.height / H) + 'px';
        } else {
          me.style.left = (cr.left - ar.left + (s.zone - 1) * cr.width / 8) + 'px';
          me.style.top = (cr.top - ar.top) + 'px';
          me.style.width = (cr.width / 8) + 'px'; me.style.height = cr.height + 'px';
        }
        if (performance.now() - t0 < 1800) requestAnimationFrame(place); else me.remove();
      };
      place();
      return true;
    }
    return {
      models, views, phone, sheet,
      update(frame) {
        st = frame;
        // Messages belong to one match of one arena start (the arena restarts with match 1 every time, so both count): a new key opens
        // every panel empty, whether or not the new match has said anything yet. A reload starts with no key and shows the live frame.
        const k = `${frame && frame.boot != null ? frame.boot : ''}:${frame && frame.matchNo != null ? frame.matchNo : ''}`;
        if (runKey !== null && k !== runKey) models.forEach(m => m && m.reset());
        runKey = k;
        const got = [0, 0];
        sides().forEach((sd, s) => { if (sd) got[s] = models[s].ingest(sd.comms || []).cued || 0; });
        // One cue per frame and side with a new COMM message that is not a routine ack (the SFX layer plays the radio). The first frame is the backlog of a page
        // opened mid-match and stays silent.
        if (heard) got.forEach((n, side) => { if (n > 0) { try { window.dispatchEvent(new CustomEvent('gbw:comm', { detail: { side, added: n, cued: n } })); } catch (e) {} } });
        heard = true;
        views.forEach(v => v && v.render());
        phone.render();
        sheet.render();
      },
    };
  }

  const api = { Model, View, Sheet, attach, URGENT, bodyOf };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GbwCommNet = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* CR readout VFX (Oct 14). Watches #cr0/#cr1 and pops a coin + floating +N / −N on each change.
   Changes within 150 ms are netted into one popup (income + upkeep on the same tick), a drop of 20+ CR
   (a purchase) gets its own popup, at most 3 popups per side at once. prefers-reduced-motion: colour flash only. */
(function crfx() {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  const reduce = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const num = el => { const n = parseInt(String(el.textContent).replace(/[^0-9-]/g, ''), 10); return Number.isFinite(n) ? n : null; };
  const BIG = 20, WINDOW = 150, CAP = 3;
  function flash(el, cls) { el.classList.remove('crfx-up', 'crfx-down'); void el.offsetWidth; el.classList.add(cls); }
  function pop(el, side, delta, live) {
    if (!delta) return;
    const up = delta > 0;
    flash(el, up ? 'crfx-up' : 'crfx-down');
    try { window.dispatchEvent(new CustomEvent('gbw:cr', { detail: { side, delta } })); } catch (e) {}
    if (reduce()) return;
    const r = el.getBoundingClientRect(); if (!r.width) return;
    while (live.length >= CAP) { const o = live.shift(); o.remove(); }
    const p = document.createElement('span');
    p.className = 'crfx-pop ' + (up ? 'crfx-gain' : 'crfx-loss') + (side ? ' crfx-b' : '');
    p.innerHTML = `<i class="crfx-coin"></i><b>${up ? '+' : '−'}${Math.abs(delta)}</b>`;
    p.style.left = Math.round(r.right + 2) + 'px'; p.style.top = Math.round(r.top) + 'px';
    p.style.setProperty('--crfx-dy', (live.length * -20) + 'px');
    document.body.appendChild(p); live.push(p);
    const w = p.offsetWidth; if (r.right + 2 + w > innerWidth - 4) p.style.left = Math.max(4, innerWidth - 4 - w) + 'px';
    const done = () => { p.remove(); const i = live.indexOf(p); if (i >= 0) live.splice(i, 1); };
    p.addEventListener('animationend', e => { if (e.target === p) done(); }); setTimeout(done, 1700);
  }
  function watch(el, side) {
    let last = num(el), pend = 0, timer = null; const live = [];
    new MutationObserver(() => {
      const v = num(el); if (v == null) return;
      if (last == null) { last = v; return; }
      const d = v - last; last = v; if (!d) return;
      if (d <= -BIG) { pop(el, side, d, live); return; } // a purchase: its own popup
      pend += d;
      if (!timer) timer = setTimeout(() => { timer = null; const n = pend; pend = 0; if (Math.abs(n) >= 5) pop(el, side, n, live); }, WINDOW);
    }).observe(el, { childList: true, characterData: true, subtree: true });
  }
  function boot() {
    let n = 0;
    for (const s of [0, 1]) { const el = document.getElementById('cr' + s); if (el && !el.dataset.crfx) { el.dataset.crfx = '1'; watch(el, s); n++; } }
    if (n < 2) setTimeout(boot, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
