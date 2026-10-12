'use strict';
// ScriptStore: the current script for each seat. Sources: a file in scripts/ (re-read at every match start if it
// changed) or a submission via POST /api/seat/script. Latest change wins. Read only at match start =>
// hot-swap between matches, never mid-match.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

class ScriptStore {
  constructor(baseDir) { this.baseDir = baseDir; this.seats = new Map(); }

  addSeat(seat, { file, name } = {}) {
    this.seats.set(seat, { file: file ? path.resolve(this.baseDir, file) : null, fileMtime: 0, current: null, history: [], name: name || seat });
    this._refreshFile(seat);
  }

  _refreshFile(seat) {
    const s = this.seats.get(seat);
    if (!s.file) return;
    let st; try { st = fs.statSync(s.file); } catch { return; }
    if (st.mtimeMs === s.fileMtime) return;
    s.fileMtime = st.mtimeMs;
    const source = fs.readFileSync(s.file, 'utf8');
    if (s.current && s.current.hash === sha(source)) return;
    this._set(seat, { name: path.basename(s.file), source, origin: 'file:' + path.relative(this.baseDir, s.file) });
  }

  _set(seat, { name, source, origin }) {
    const s = this.seats.get(seat);
    const version = (s.current ? s.current.version : 0) + 1;
    s.current = { name, version, source, hash: sha(source), origin, at: new Date().toISOString() };
    s.history.push({ name, version, hash: s.current.hash, origin, at: s.current.at });
    return s.current;
  }

  submit(seat, name, source) {
    const cur = this._set(seat, { name, source, origin: 'submitted' });
    const dir = path.join(this.baseDir, 'scripts', 'submitted');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${seat.replace(/[^A-Za-z0-9_-]+/g, '_')}-v${cur.version}-${cur.hash}.js`);
    fs.writeFileSync(file, source);
    cur.file = path.relative(this.baseDir, file);
    return cur;
  }

  /** restore a persisted submission (after an arena restart) */
  restore(seat, { name, file, version, at }) {
    const source = fs.readFileSync(path.resolve(this.baseDir, file), 'utf8');
    const s = this.seats.get(seat);
    s.current = { name, version: Math.max(version || 1, (s.current ? s.current.version : 0) + 1), source, hash: sha(source), origin: 'submitted', file, at: at || new Date().toISOString() };
    s.history.push({ name, version: s.current.version, hash: s.current.hash, origin: 'submitted (restored)', at: s.current.at });
    return s.current;
  }

  has(seat) { return this.seats.has(seat) && !!this.seats.get(seat).current; }
  remove(seat) { this.seats.delete(seat); }
  // called at match start (from the controller factory)
  get(seat) { this._refreshFile(seat); return this.seats.get(seat).current; }
  info(seat) { const s = this.seats.get(seat); return s && s.current ? { name: s.current.name, version: s.current.version, hash: s.current.hash, origin: s.current.origin } : null; }
}

module.exports = { ScriptStore, sha };
