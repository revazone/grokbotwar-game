'use strict';
// Team avatars: optional image per seat. Sources: bots.json `avatar` file path (re-checked every few seconds),
// or POST /api/seat/avatar. Every image is validated (PNG/JPEG/WebP magic bytes, <= 256 KB, <= 4096x4096) and
// RE-ENCODED with sharp to a 128x128 PNG with all metadata stripped; only the re-encoded file is ever served.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { normalizeIdentity, renderBadge } = require('./badges');

const MAX_BYTES = 256 * 1024;
const SIZE = 128;

function sniff(buf) {
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

async function sanitize(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('empty image');
  if (buf.length > MAX_BYTES) throw new Error(`image too large (${buf.length} bytes, max ${MAX_BYTES})`);
  const kind = sniff(buf);
  if (!kind) throw new Error('only PNG, JPEG or WebP images are accepted');
  const img = sharp(buf, { limitInputPixels: 4096 * 4096, failOn: 'error', animated: false });
  const meta = await img.metadata();
  if (meta.format !== kind) throw new Error(`file content (${meta.format}) does not match its header (${kind})`);
  return sharp(buf, { limitInputPixels: 4096 * 4096, failOn: 'error', animated: false })
    .rotate()                                   // honour EXIF orientation, then metadata is dropped
    .resize(SIZE, SIZE, { fit: 'cover', position: 'attention' })
    .flatten({ background: '#000000' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

class AvatarStore {
  constructor(baseDir) { this.dir = path.join(baseDir, 'avatars'); this.baseDir = baseDir; this.seats = new Map(); fs.mkdirSync(this.dir, { recursive: true }); }

  // Precedence for what a team shows: uploaded/config image > identity badge > (client) colored arrow.
  async addSeat(seat, file, identity, teamColor) {
    const s = { file: file ? path.resolve(this.baseDir, file) : null, mtime: 0, hash: null, error: null, identity: null, badgeHash: null, teamColor };
    this.seats.set(seat, s);
    // a previously uploaded avatar survives restarts
    const saved = path.join(this.dir, `${seat}.png`);
    if (fs.existsSync(saved)) s.hash = crypto.createHash('sha256').update(fs.readFileSync(saved)).digest('hex').slice(0, 10);
    await this._checkFile(seat);
    // identity: one set via the API (persisted) wins over bots.json
    const saved2 = this._identities()[seat];
    if (saved2 || identity) await this.setIdentity(seat, saved2 || identity, { persist: false });
  }

  _identities() { try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'identities.json'), 'utf8')); } catch { return {}; } }

  async setIdentity(seat, raw, { persist = true } = {}) {
    const s = this.seats.get(seat);
    const id = normalizeIdentity(raw, s.teamColor);
    const png = await renderBadge(id);
    fs.writeFileSync(path.join(this.dir, `${seat}.badge.png`), png);
    s.identity = id; s.badgeHash = crypto.createHash('sha256').update(png).digest('hex').slice(0, 10);
    if (persist) { const all = this._identities(); all[seat] = { name: id.name, avatarShape: id.avatarShape, avatarColor: id.avatarColor }; fs.writeFileSync(path.join(this.dir, 'identities.json'), JSON.stringify(all, null, 2)); }
    return id;
  }
  identity(seat) { const s = this.seats.get(seat); return s ? s.identity : null; }

  /** remove an uploaded image so the identity badge (or arrow) shows again */
  clearImage(seat) { const s = this.seats.get(seat); if (!s) return; try { fs.unlinkSync(path.join(this.dir, `${seat}.png`)); } catch {} s.hash = null; s.file = null; }

  async _checkFile(seat) {
    const s = this.seats.get(seat);
    if (!s || !s.file) return;
    let st; try { st = fs.statSync(s.file); } catch { s.error = 'avatar file not found'; return; }
    if (st.mtimeMs === s.mtime) return;
    s.mtime = st.mtimeMs;
    try { await this._store(seat, await sanitize(fs.readFileSync(s.file))); s.error = null; }
    catch (e) { s.error = e.message; console.warn(`[avatars] ${seat}: ${e.message}`); }
  }

  async _store(seat, png) {
    fs.writeFileSync(path.join(this.dir, `${seat}.png`), png);
    this.seats.get(seat).hash = crypto.createHash('sha256').update(png).digest('hex').slice(0, 10);
  }

  async upload(seat, buf) { const png = await sanitize(buf); await this._store(seat, png); return { hash: this.seats.get(seat).hash, bytes: png.length }; }

  url(seat) {
    const s = this.seats.get(seat); if (!s) return null;
    if (s.hash) return `/avatars/${encodeURIComponent(seat)}.png?v=${s.hash}`;
    if (s.badgeHash) return `/avatars/${encodeURIComponent(seat)}.badge.png?v=${s.badgeHash}`;
    return null;
  }
  avatarSource(seat) { const s = this.seats.get(seat); return !s ? null : s.hash ? 'image' : s.badgeHash ? 'badge' : 'none'; }
  filePath(seat, badge = false) { return this.seats.has(seat) ? path.join(this.dir, `${seat}${badge ? '.badge' : ''}.png`) : null; }
  watch(ms = 3000) { setInterval(() => { for (const seat of this.seats.keys()) this._checkFile(seat); }, ms).unref(); }
}

module.exports = { AvatarStore, sanitize, MAX_BYTES };
