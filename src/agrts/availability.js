'use strict';
// Availability and PvP reservations (docs/SPEC.md §5.4 "Availability", PvP step 3). Information only for now:
// nothing in play reads it, and nothing calls reserve/release yet (later PvP steps will).
//   state  free      no match in progress and no reservation (armed and held before T0, waiting for a viewer,
//                    or over/held between matches all count as free)
//          busy      a match is running, counting down, or held mid-match (paused after T0, not over)
//          reserved  free, but claimed for an upcoming PvP match (POST /api/pvp/reserve)
//   since  ISO time the state last changed (as seen by this arena process)
//   matchId  the reservation's matchId (reserved; also shown on busy while a reservation is still held)
// Busy wins over reserved: a solo match can still start while reserved, exactly as today (we never block solo
// play). The reservation is kept underneath and the state goes back to reserved after the match if its TTL has
// not run out. A reservation always expires after ttlS, whatever the match does. Reservations live in memory:
// an arena restart drops them.

const TTL_MIN_S = 5;
const TTL_MAX_S = 900;
const TTL_DEFAULT_S = 120;
const MATCH_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** Is a match in progress? Running, counting down, or held mid-match. Pure: reads the match, never changes it. */
function matchBusy(m) {
  if (!m || m.over) return false;
  if (m.phase === 'countdown') return true;
  if (m.phase === 'live') return (m.steps || 0) > 0 || !m.paused;
  return false; // waiting for a viewer: armed, not started
}

class Availability {
  constructor({ now = () => Date.now(), onChange = null } = {}) {
    this.now = now;
    this.onChange = onChange;
    this.reservation = null; // { matchId, at, expiresAt, ttlS }
    this._timer = null;
    this._last = null; // { state, matchId, since }
  }

  _expire() {
    if (this.reservation && this.now() >= this.reservation.expiresAt) {
      this.reservation = null;
      this._clearTimer();
      return true;
    }
    return false;
  }

  _clearTimer() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }

  _arm() {
    this._clearTimer();
    if (!this.reservation) return;
    const ms = Math.max(0, this.reservation.expiresAt - this.now()) + 5;
    this._timer = setTimeout(() => { this._timer = null; if (this._expire() && this.onChange) this.onChange('expired'); }, ms);
    if (this._timer.unref) this._timer.unref();
  }

  /** { state, since, matchId? } for this match. Tracks since across calls. */
  view(m) {
    this._expire();
    const busy = matchBusy(m);
    const r = this.reservation;
    const state = busy ? 'busy' : r ? 'reserved' : 'free';
    const matchId = r ? r.matchId : undefined;
    if (!this._last || this._last.state !== state || this._last.matchId !== matchId) {
      this._last = { state, matchId, since: new Date(this.now()).toISOString() };
    }
    const out = { state, since: this._last.since };
    if (matchId) { out.matchId = matchId; out.expiresAt = new Date(r.expiresAt).toISOString(); }
    return out;
  }

  /**
   * Reserve for matchId. Free only; the same matchId again is idempotent (refreshes the TTL, never refused).
   * Returns { ok, status, ... } for the HTTP layer.
   */
  reserve(m, matchId, ttlS) {
    this._expire();
    const id = typeof matchId === 'string' ? matchId.trim() : '';
    if (!MATCH_ID_RE.test(id)) return { ok: false, status: 400, error: 'matchId must be 1 to 64 characters of A-Z a-z 0-9 . _ : -' };
    let ttl = ttlS == null ? TTL_DEFAULT_S : Number(ttlS);
    if (!Number.isFinite(ttl)) return { ok: false, status: 400, error: `ttlS must be a number of seconds (${TTL_MIN_S} to ${TTL_MAX_S})` };
    ttl = Math.max(TTL_MIN_S, Math.min(TTL_MAX_S, Math.round(ttl)));
    const r = this.reservation;
    if (r && r.matchId === id) {
      r.expiresAt = this.now() + ttl * 1000; r.ttlS = ttl;
      this._arm();
      return { ok: true, status: 200, reserved: true, again: true, matchId: id, ttlS: ttl, availability: this.view(m) };
    }
    if (r) return { ok: false, status: 409, error: `arena is reserved for another match (${r.matchId})`, availability: this.view(m) };
    if (matchBusy(m)) return { ok: false, status: 409, error: 'arena is busy: a match is in progress (running, counting down or held mid-match)', availability: this.view(m) };
    this.reservation = { matchId: id, at: this.now(), expiresAt: this.now() + ttl * 1000, ttlS: ttl };
    this._arm();
    if (this.onChange) this.onChange('reserved');
    return { ok: true, status: 200, reserved: true, again: false, matchId: id, ttlS: ttl, availability: this.view(m) };
  }

  /** Release matchId. No reservation: ok, released false (idempotent). Another matchId: refused. */
  release(m, matchId) {
    this._expire();
    const id = typeof matchId === 'string' ? matchId.trim() : '';
    if (!MATCH_ID_RE.test(id)) return { ok: false, status: 400, error: 'matchId must be 1 to 64 characters of A-Z a-z 0-9 . _ : -' };
    const r = this.reservation;
    if (!r) return { ok: true, status: 200, released: false, matchId: id, note: 'no reservation held (already released or expired)', availability: this.view(m) };
    if (r.matchId !== id) return { ok: false, status: 409, error: `arena is reserved for another match (${r.matchId})`, availability: this.view(m) };
    this.reservation = null;
    this._clearTimer();
    if (this.onChange) this.onChange('released');
    return { ok: true, status: 200, released: true, matchId: id, availability: this.view(m) };
  }

  stop() { this._clearTimer(); }
}

module.exports = { Availability, matchBusy, TTL_MIN_S, TTL_MAX_S, TTL_DEFAULT_S, MATCH_ID_RE };
