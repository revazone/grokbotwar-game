// Seeded sim fingerprint: runs whole matches (Green autopilot vs Ember) and hashes every unit's
// position, hp and the bases each second. Same code + same units.csv => same hashes; any change to
// movement, combat or the commander shows up. Usage: node tools/fingerprint.js [--off] [--repo dir]
// --off runs with EMBER_COMMANDER=0 (the old wave brain). Prints one line per seed and a combined hash.
'use strict';
const path = require('path');
const crypto = require('crypto');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const repo = path.resolve(opt('repo', path.join(__dirname, '..')));
const off = args.includes('--off');
const { AgrtsMatch } = require(path.join(repo, 'src/agrts/match'));
const all = crypto.createHash('sha256');
for (const seed of [1, 2, 3, 7, 42]) {
  const m = new AgrtsMatch({ seed, pauseAfterMatch: true, emberCommander: !off });
  const h = crypto.createHash('sha256');
  let steps = 0;
  while (!m.over && steps < 12000) {
    m.update(0.05); steps++;
    if (steps % 20 === 0) h.update(m.units.map(u => `${u.id}:${u.x.toFixed(3)},${u.y.toFixed(3)},${u.hp.toFixed(3)}`).join('|') + `#${m.hp.map(v => v.toFixed(3))}`);
  }
  const fp = h.digest('hex').slice(0, 16);
  all.update(fp);
  console.log(`seed ${String(seed).padEnd(3)} steps=${steps} winner=${m.winner ? m.winner.side : '-'} hp=${m.hp.map(v => Math.round(v)).join('/')} ${fp}`);
}
console.log(`${off ? 'commander off' : 'commander on'}: ${all.digest('hex').slice(0, 16)}`);
