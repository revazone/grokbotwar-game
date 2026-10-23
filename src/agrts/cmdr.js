'use strict';
// Commander chat (docs/COMMANDER-CHAT.md): short notes from the arena owner, typed on the relay watch page,
// delivered to the owner's own seat in its protocol reports as a `cmdr` section, acknowledged by the bot with
// `ACK <id> <text>`. Notes are owner-only: they never ride a spectator frame, a replay or the other seat's report.
//   Owner key: state/owner.json {key} (`ok_` + 48 hex). The relay only ever gets sha256(key).
//   History: state/cmdr.json, last 50 notes. Notes sent between matches are refused (dropped), and any note
//   still pending when a match ends is dropped.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_LEN = 120;          // characters per note
const RATE_N = 6, RATE_MS = 60000;   // notes per minute
const HISTORY = 50;           // notes kept
const QUEUE_MAX = 10;         // pending notes
const PER_REPORT = 2;         // notes per report
const REPEAT_S = 30;          // a delivered, unacked note rides reports for this many match seconds
const ACK_MAX = 60;           // ack text shown on the comm net
const OWNER_SIDE = 0;         // phase 1: the arena owner's bot is the Green (host) seat

const KEY_RE = /^ok_[0-9a-f]{48}$/;
const newKey = () => 'ok_' + crypto.randomBytes(24).toString('hex');
const hashKey = k => crypto.createHash('sha256').update(String(k)).digest('hex');

function writePrivate(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Load the owner key, creating it once. rotate:true replaces it. */
function ownerKey(root, { rotate = false } = {}) {
  const file = path.join(root, 'state', 'owner.json');
  let cur = null;
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (KEY_RE.test(j.key)) cur = j.key; } catch {}
  if (cur && !rotate) return cur;
  const key = newKey();
  writePrivate(file, { key, createdAt: new Date().toISOString(), note: 'commander chat owner key; keep private. Rotate: node tools/warrior-seat.js owner-link --rotate' });
  return key;
}

/** Note text: one line, no `"` or `|` (report delimiters), no control characters, at most MAX_LEN. */
function cleanText(s, max = MAX_LEN) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f"|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

class CmdrBox {
  constructor({ root = null, now = () => Date.now() } = {}) {
    this.file = root ? path.join(root, 'state', 'cmdr.json') : null;
    this.now = now;
    this.notes = [];
    this.seq = 0;
    this.sent = [];   // wall times of accepted posts (rate limit)
    this.version = 0; // bumps on every change (GET ?since)
    if (this.file) {
      try {
        const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (Array.isArray(j.notes)) this.notes = j.notes.slice(-HISTORY);
        this.seq = Number.isInteger(j.seq) ? j.seq : 0;
        // a restart ends whatever match was running: nothing pending survives it
        for (const n of this.notes) if (n.state === 'sent') n.state = 'dropped';
      } catch {}
    }
  }

  _save() {
    this.version++;
    if (!this.file) return;
    try { writePrivate(this.file, { seq: this.seq, notes: this.notes }); } catch {}
  }

  /** Owner posts a note. ctx: { accepting, matchNo }. Returns { status, body }. */
  post(text, cid, ctx) {
    const t = cleanText(text);
    if (!t) return { status: 400, body: { ok: false, error: 'empty', message: 'Type a note first.' } };
    if (String(text).trim().length > MAX_LEN) return { status: 400, body: { ok: false, error: 'too_long', message: `At most ${MAX_LEN} characters.` } };
    const c = typeof cid === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(cid) ? cid : null;
    if (c) { const dup = this.notes.find(n => n.cid === c); if (dup) return { status: 200, body: { ok: true, note: dup, dup: true } }; }
    if (!ctx || !ctx.accepting) return { status: 409, body: { ok: false, error: 'between_matches', message: 'No match running. Notes sent between matches are dropped.' } };
    const now = this.now();
    this.sent = this.sent.filter(x => now - x < RATE_MS);
    if (this.sent.length >= RATE_N) return { status: 429, body: { ok: false, error: 'rate_limit', message: `At most ${RATE_N} notes a minute.`, retryMs: RATE_MS - (now - this.sent[0]) } };
    if (this.notes.filter(n => n.state === 'sent').length >= QUEUE_MAX) return { status: 429, body: { ok: false, error: 'queue_full', message: 'Too many notes waiting.' } };
    this.sent.push(now);
    const note = { id: 'c' + (++this.seq), cid: c, text: t, at: now, match: ctx.matchNo, boot: ctx.boot || null, state: 'sent' };
    this.notes.push(note);
    if (this.notes.length > HISTORY) this.notes.splice(0, this.notes.length - HISTORY);
    this._save();
    return { status: 202, body: { ok: true, note } };
  }

  /**
   * Owner's history (newest last). ctx { matchNo, boot }: only THIS match's notes, so a new match (or a restarted arena, where the
   * match number starts at 1 again) opens an empty TO MAIN panel and a reload mid-match still shows its own notes. The file keeps
   * the last 50 notes for the record; notes from before the boot stamp existed belong to no match and are not shown.
   */
  view(ctx) {
    const mine = ctx ? this.notes.filter(n => n.match === ctx.matchNo && n.boot === (ctx.boot || null)) : this.notes;
    return { ok: true, version: this.version, max: MAX_LEN, rate: RATE_N, matchNo: ctx ? ctx.matchNo : undefined, boot: ctx ? ctx.boot || null : undefined, notes: mine.map(n => ({ id: n.id, cid: n.cid, text: n.text, at: n.at, state: n.state, ack: n.ack || null, match: n.match })) };
  }

  clear() { this.notes = this.notes.filter(n => n.state === 'sent' || (n.state === 'delivered' && n.riding)); this._save(); return { ok: true }; }

  /**
   * Notes for one report. ctx: { side, seated, live, matchNo, elapsed }. Only the owner's seat, only while its
   * warrior has the con (not during a takeover), only live. Oldest first, at most PER_REPORT.
   */
  forReport(ctx) {
    if (!ctx || ctx.side !== OWNER_SIDE || !ctx.live || !ctx.seated) return [];
    let changed = false;
    const out = [];
    const mine = this.notes.filter(n => n.match === ctx.matchNo);
    for (const n of mine) if (n.state === 'delivered' && n.riding && ctx.elapsed - n.firstAt > REPEAT_S) { n.riding = false; changed = true; }
    // new notes first (oldest first), then repeats of delivered, unacked ones in the slots left
    const pick = [...mine.filter(n => n.state === 'sent'), ...mine.filter(n => n.state === 'delivered' && n.riding)].slice(0, PER_REPORT);
    for (const n of pick) {
      if (n.state === 'sent') { n.state = 'delivered'; n.riding = true; n.firstAt = ctx.elapsed; n.deliveredAt = this.now(); changed = true; }
    }
    pick.sort((a, b) => +a.id.slice(1) - +b.id.slice(1));
    for (const n of pick) out.push({ id: n.id, text: n.text });
    if (changed) this._save();
    return out;
  }

  /** Is there a note waiting for this seat's next report (a CMDR report is worth pushing)? No side effects. */
  hasPending(ctx) {
    if (!ctx || ctx.side !== OWNER_SIDE || !ctx.seated) return false;
    return this.notes.some(n => n.match === ctx.matchNo && n.state === 'sent');
  }

  /** The bot's `ACK <id> [NEG] <text>`. Returns { ok, note, neg, text } or { error }. */
  ack(side, id, rest) {
    if (side !== OWNER_SIDE) return { error: 'unknown note' };
    const n = this.notes.find(x => x.id === String(id || '').toLowerCase());
    if (!n || (n.state !== 'delivered' && n.state !== 'acked' && n.state !== 'declined')) return { error: 'unknown note' };
    if (n.state !== 'delivered') return { ok: true, dup: true, note: n };
    if (!n.riding) return { error: 'note expired' };   // a note from an earlier match, or past its 30 s
    let txt = String(rest || '').trim();
    const neg = /^NEG\b/i.test(txt);
    if (neg) txt = txt.replace(/^NEG\b\s*/i, '');
    txt = cleanText(txt, ACK_MAX);
    n.state = neg ? 'declined' : 'acked';
    n.ack = txt || (neg ? 'unable' : 'roger');
    n.ackAt = this.now();
    n.riding = false;
    this._save();
    return { ok: true, note: n, neg, text: txt };
  }

  /** Match over (or a new one booting): drop what never reached the bot, stop repeating the rest. */
  matchEnd() {
    let changed = false;
    for (const n of this.notes) {
      if (n.state === 'sent') { n.state = 'dropped'; changed = true; }
      if (n.riding) { n.riding = false; changed = true; }
    }
    if (changed) this._save();
  }
}

/** ` cmdr c3 "push z6" c4 "save for B"` token. Total kept under ~260 characters. */
function formatCmdr(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const items = list.slice(0, PER_REPORT).map(n => ({ id: n.id, text: cleanText(n.text) }));
  return 'cmdr ' + items.map(n => `${n.id} "${n.text}"`).join(' ');
}

module.exports = { CmdrBox, ownerKey, hashKey, cleanText, formatCmdr, KEY_RE, MAX_LEN, RATE_N, HISTORY, PER_REPORT, REPEAT_S, ACK_MAX, OWNER_SIDE };
