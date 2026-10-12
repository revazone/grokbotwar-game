'use strict';
// Locked unit table (docs/SPEC.md §5.4, "Locked unit table"). units.lock.json at the repo root holds the
// sha256 of the official units.csv. The arena hashes the table it actually loaded at every match boot and
// says whether it is the official one. This never changes play: a modified table loads and plays as
// before. It only answers "is this the official table?" so PvP can later refuse a tampered arena.
//
// UNITS_LOCK (env) picks the mode:
//   warn     (default) compare, log one warning line per modified version of the file, play as normal
//   enforce  same, and a non-official table is not allowed into PvP (pvp:false). Local play is never blocked.
//   off      no comparison and no log line (official:null)
// Change units on purpose: edit units.csv, run `node tools/units-lock.js --update`, commit both files.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODES = ['warn', 'enforce', 'off'];
const LOCK_FILE = path.join(__dirname, '..', '..', 'units.lock.json');

/**
 * Canonical text of a unit table: no BOM, LF line endings, no trailing spaces or tabs on any line,
 * no blank lines at the end, one final newline. Saving the file on Windows or with an editor that
 * trims or adds whitespace does not change the hash; any change to a cell does.
 */
function normalize(text) {
  const lines = String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[ \t]+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

function hashText(text) {
  return crypto.createHash('sha256').update(normalize(text), 'utf8').digest('hex');
}

function mode(env = process.env) {
  const m = String(env.UNITS_LOCK || '').trim().toLowerCase();
  return MODES.includes(m) ? m : 'warn';
}

/** Reads the lock. Returns { hash, error }. A missing or bad lock means nothing counts as official. */
function readLock(file = LOCK_FILE) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { hash: '', error: `cannot read ${path.basename(file)}: ${e.code || e.message}` }; }
  const h = j && typeof j.sha256 === 'string' ? j.sha256.toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(h)) return { hash: '', error: `${path.basename(file)} has no valid sha256` };
  return { hash: h, error: '' };
}

/** The lock file's content for a given units.csv text (tools/units-lock.js --update writes this). */
function lockFor(text) {
  const rows = normalize(text).split('\n').filter(l => l.trim() && !/^\s*#/.test(l)).length - 1;
  return {
    file: 'units.csv',
    sha256: hashText(text),
    rows: Math.max(0, rows),
    normalization: 'BOM removed, CRLF/CR to LF, trailing spaces and tabs removed on each line, trailing blank lines removed, one final newline',
    note: 'Official unit table fingerprint. Change units on purpose: edit units.csv, run node tools/units-lock.js --update, commit both. docs/SPEC.md section 5.4.',
  };
}

/**
 * Compare a loaded table's text against the lock. text null = the built-in table (file never loaded),
 * which is not official. Returns { mode, hash, official, pvp, error }.
 *   official: true/false, or null when the mode is off
 *   pvp:      may this table be used for PvP? false only in enforce mode with a non-official table
 */
function check(text, { env = process.env, lockFile = LOCK_FILE } = {}) {
  const m = mode(env);
  const hash = text == null ? '' : hashText(text);
  if (m === 'off') return { mode: m, hash, official: null, pvp: true, error: '' };
  const lock = readLock(lockFile);
  const official = !!hash && !!lock.hash && hash === lock.hash;
  return { mode: m, hash, official, pvp: m === 'enforce' ? official : true, error: lock.error || (text == null ? 'built-in table (units.csv not loaded)' : '') };
}

/** For PvP (a later step): { ok, error }. Refuses only in enforce mode. Local play never calls this. */
function pvpGate(result) {
  if (!result || result.pvp) return { ok: true, error: '' };
  return { ok: false, error: `unit table is not the official one (units.csv ${result.hash ? result.hash.slice(0, 12) : 'built-in'}); PvP needs the official table` };
}

module.exports = { MODES, LOCK_FILE, normalize, hashText, mode, readLock, lockFor, check, pvpGate };
