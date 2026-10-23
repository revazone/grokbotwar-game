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
const { fromEnv: economyFromEnv, economyCode } = require('./economy');
const RULES = require('./rules'); // economy.csv numbers sit behind the env variables below (env wins, else the ruleset, else the default)

const ROOT = path.join(__dirname, '..', '..');
const PVP_PROTOCOL = 1;
// RULES_VERSION  version of the game rules the match sim plays (the base turret, ...). The host arena runs the
//                match, so the rules are the host's; two arenas are paired only when it matches, so both
//                players' bots read the same report and expect the same field. Bump it on a rule change.
//                1 = before the base turret (a stamp without it counts as 1). 2 = base turret. 3 = unit stances.
const RULES_VERSION = 3;
// DAMAGE_SCALE (env, balance test) changes the rules too: at any value other than 1 the stamp's rules
// becomes RULES_VERSION*1000 + scale*100 (3070 at 0.7), so the relay never pairs arenas with different
// scales (relay/queue.js compares rules), and the stamp carries damageScale for display.
// Defaults are the live settings (Oct 14): DAMAGE_SCALE 0.7, BASE_INCOME 12, unlimited buys, field hospital on.
// The rules stamp still measures against the old baseline (1, 4, 6, off), so stamps match pre-change arenas
// that set the same values in arena.env.
const DEFAULT_DAMAGE_SCALE = 0.7, DEFAULT_BASE_INCOME = 12;
function damageScale() { const e = RULES.env(); const v = Number(e.DAMAGE_SCALE); return Number.isFinite(v) && v > 0 && v <= 5 && e.DAMAGE_SCALE !== '' ? v : DEFAULT_DAMAGE_SCALE; }
// BASE_INCOME (default 4) and BUY_CAP (default 6, 0/unlimited/inf = none) are balance flags too. Any
// non-default value adds a suffix so the relay refuses mixed arenas: rules*1000 + income*10 (+1 per
// buy-cap step: BUY_CAP n -> + n*100000, unlimited -> + 99*100000). Defaults keep the plain stamp.
function baseIncome() { const r = RULES.env().BASE_INCOME; const v = Number(r); return r != null && r !== '' && Number.isFinite(v) && v >= 0 ? v : DEFAULT_BASE_INCOME; }
function buyCap() {
  const e = RULES.env().BUY_CAP;
  const r = String(e == null ? '' : e).trim().toLowerCase();
  if (r === '') return Infinity;
  if (r === 'unlimited' || r === 'inf' || r === 'infinity' || r === '0') return Infinity;
  const v = Number(r); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 6;
}
// FIELD_HOSPITAL is a rules change too (docs/FIELD-HOSPITAL.md). On by default; 0/off/false/no/none turns it off.
// The stamp grows a fieldHospital flag and rules += 1e12, so the relay will not pair a hospital arena
// with one that plays the old regen. With the flag off, rulesStamp and stamp() stay the default shape.
function fieldHospital(env = process.env) { const s = String(env.FIELD_HOSPITAL == null ? '' : env.FIELD_HOSPITAL).trim().toLowerCase(); return !['0', 'off', 'false', 'no', 'none'].includes(s); }
// Territory-income flags (docs/TERRITORY-INCOME.md). The zone cap defaults to 3, so an unset env
// adds territoryCap and economy code 3 × 1e13. Explicit 0/off adds nothing for that knob.
// Any other knob that is on adds its bucket the same way (economy code at most 639).
// MORTAR defaults on (docs/MORTAR.md). The addend is 2e15 + 1e11, which is not a multiple of the
// economy step (1e13), so it cannot collide with an economy code, and the worst case (every economy
// bucket, the hospital bit, and this addend) stays inside Number.MAX_SAFE_INTEGER.
const MORTAR_RULES = 2e15 + 1e11;
function mortarOn(env = process.env) {
  const s = String(env.MORTAR == null ? '' : env.MORTAR).trim().toLowerCase();
  if (s === '0' || s === 'off' || s === 'false' || s === 'no' || s === 'none') return false;
  return true;
}
// TOWERS (src/agrts/towers.js): towers and Team HP are a rules change. With the flag on the base rules version is
// one higher (4 instead of 3) and the stamp carries towers: true, so the relay never pairs a towers arena with an
// old one. With it off the stamp keeps its old shape.
function towersOn(env = process.env) { return require('./towers').towersOn(env); }
function rulesStamp(scale = damageScale(), income = baseIncome(), cap = buyCap(), hosp = fieldHospital(), econ = economyFromEnv(), mortar = mortarOn(), towers = towersOn()) {
  const rv = RULES_VERSION + (towers ? 1 : 0);
  let r = scale === 1 ? rv : rv * 1000 + Math.round(scale * 100);
  if (income !== 4) r += 1e6 * (1 + Math.round(income));
  if (cap !== 6) r += 1e9 * (cap === Infinity ? 99 : Math.min(98, cap));
  if (hosp) r += 1e12;
  const code = economyCode(econ);
  if (code) r += code * 1e13;
  if (mortar) r += MORTAR_RULES;
  return r;
}

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
 * { game, protocol, rules, unitsHash, official } - official is true/false, or null with UNITS_LOCK=off.
 */
function economyStamp(econ = economyFromEnv()) {
  return {
    ...(econ.cap > 0 ? { territoryCap: econ.cap } : {}),
    ...(econ.diminish < 1 ? { territoryDiminish: econ.diminish } : {}),
    ...(econ.catchup > 0 ? { catchupIncome: econ.catchup } : {}),
    ...(econ.discount > 0 ? { breakerDiscount: econ.discount } : {}),
    ...(econ.decay > 0 ? { bankDecay: econ.decay } : {}),
  };
}

function stamp(lock) {
  let l = lock;
  if (!l) { try { l = require('./units').lockStatus(); } catch { l = null; } }
  return { game: GAME_VERSION, protocol: PVP_PROTOCOL, rules: rulesStamp(), unitsHash: (l && l.hash) || '', official: l ? (l.official == null ? null : !!l.official) : null, ...(damageScale() !== 1 ? { damageScale: damageScale() } : {}), ...(baseIncome() !== 4 ? { baseIncome: baseIncome() } : {}), ...(buyCap() !== 6 ? { buyCap: buyCap() === Infinity ? 'unlimited' : buyCap() } : {}), ...(fieldHospital() ? { fieldHospital: true } : {}), ...economyStamp(), ...(mortarOn() ? { mortar: true } : {}), ...(towersOn() ? { towers: true } : {}) };
}

/** Is a stamp well formed? (later steps compare two of them before pairing). */
function isStamp(s) {
  return !!s && typeof s === 'object' && typeof s.game === 'string' && Number.isInteger(s.protocol) && typeof s.unitsHash === 'string';
}

module.exports = { PVP_PROTOCOL, RULES_VERSION, MORTAR_RULES, rulesStamp, damageScale, baseIncome, buyCap, fieldHospital, mortarOn, towersOn, economyStamp, GAME_VERSION, BUILD, stamp, isStamp, pkgVersion, gitBuild, gameVersion, shaFromFiles };
