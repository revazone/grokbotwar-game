'use strict';
// Version stamp (docs/SPEC.md §5.4 "Version stamp", PvP step 2). The single source of truth for "which build is this arena
// running?" Information only: nothing in play reads it.
//   GAME_VERSION  package.json version + the git short sha of the checkout the arena started from, e.g.
//                 "0.1.0+440c8a9". "-dirty" is added when tracked files differ from that commit. Without git
//                 (a copy with no .git, git not installed) it is "0.1.0+<sha read from .git>" or plain "0.1.0".
//                 GBW_BUILD (env) overrides the part after "+", for a packaged build with no checkout.
//   PVP_PROTOCOL  version of the matchmaking protocol (queue, pairing, seat handoff). Two arenas can only
//                 be paired when it matches. Bump it when that protocol changes, not for gameplay changes.
//                 It is separate from protocol.js PROTOCOL_VERSION, which versions the warrior report line.
// stamp() is what healthz, the relay frame and /api/seat/info carry: { game, protocol, unitsHash, official }.
// The sha is read once, when this file is first required, so a git pull after start does not change what a
// running arena reports: it reports the code it is running.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PVP_PROTOCOL = 1;

function pkgVersion(root = ROOT) {
  try { const v = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; return typeof v === 'string' && v ? v : '0.0.0'; }
  catch { return '0.0.0'; }
}

/** Short sha of HEAD without running git: .git/HEAD, then the loose ref or packed-refs. '' when there is none. */
function shaFromFiles(root = ROOT) {
  try {
    const gitDir = path.join(root, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    let sha = head;
    const m = head.match(/^ref:\s*(.+)$/);
    if (m) {
      const ref = m[1].trim();
      try { sha = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim(); }
      catch {
        const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split('\n').find(l => l.endsWith(' ' + ref));
        sha = packed ? packed.split(' ')[0] : '';
      }
    }
    return /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : '';
  } catch { return ''; }
}

/** { sha, dirty, source }: git when it works, else the .git files, else nothing. Never throws. */
function gitBuild(root = ROOT, env = process.env) {
  const forced = String(env.GBW_BUILD || '').trim();
  if (forced) return { sha: forced.replace(/[^0-9A-Za-z._-]/g, '').slice(0, 40), dirty: false, source: 'GBW_BUILD' };
  const git = args => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
  try {
    if (!fs.existsSync(path.join(root, '.git'))) throw new Error('no .git');
    const sha = git(['rev-parse', '--short=7', 'HEAD']);
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('bad sha');
    let dirty = false;
    try { dirty = git(['status', '--porcelain', '--untracked-files=no']) !== ''; } catch {}
    return { sha, dirty, source: 'git' };
  } catch {
    const sha = shaFromFiles(root);
    return sha ? { sha, dirty: false, source: '.git files' } : { sha: '', dirty: false, source: 'none' };
  }
}

function gameVersion(root = ROOT, env = process.env) {
  const b = gitBuild(root, env);
  return pkgVersion(root) + (b.sha ? `+${b.sha}${b.dirty ? '-dirty' : ''}` : '');
}

const BUILD = gitBuild();
const GAME_VERSION = pkgVersion() + (BUILD.sha ? `+${BUILD.sha}${BUILD.dirty ? '-dirty' : ''}` : '');

/**
 * The version stamp. lock is a units-lock result ({ hash, official }); default: the table in play now.
 * { game, protocol, unitsHash, official } - official is true/false, or null with UNITS_LOCK=off.
 */
function stamp(lock) {
  let l = lock;
  if (!l) { try { l = require('./units').lockStatus(); } catch { l = null; } }
  return { game: GAME_VERSION, protocol: PVP_PROTOCOL, unitsHash: (l && l.hash) || '', official: l ? (l.official == null ? null : !!l.official) : null };
}

/** Is a stamp well formed? (later steps compare two of them before pairing). */
function isStamp(s) {
  return !!s && typeof s === 'object' && typeof s.game === 'string' && Number.isInteger(s.protocol) && typeof s.unitsHash === 'string';
}

module.exports = { PVP_PROTOCOL, GAME_VERSION, BUILD, stamp, isStamp, pkgVersion, gitBuild, gameVersion, shaFromFiles };
