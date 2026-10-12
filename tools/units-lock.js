#!/usr/bin/env node
// Locked unit table: check units.csv against units.lock.json, or update the lock after an intentional edit.
//   node tools/units-lock.js            check (exit 1 if units.csv is not the official table)
//   node tools/units-lock.js --update   write units.lock.json for the current units.csv (then commit both)
//   node tools/units-lock.js --hash <file>   print the fingerprint of any unit table
// docs/SPEC.md section 5.4, "Locked unit table".
'use strict';
const fs = require('fs');
const path = require('path');
const LOCK = require('../src/agrts/units-lock');

const ROOT = path.join(__dirname, '..');
const CSV = path.join(ROOT, 'units.csv');
const args = process.argv.slice(2);

if (args[0] === '--hash') {
  const f = path.resolve(args[1] || CSV);
  console.log(`${LOCK.hashText(fs.readFileSync(f, 'utf8'))}  ${f}`);
  process.exit(0);
}

const text = fs.readFileSync(CSV, 'utf8');
const hash = LOCK.hashText(text);

if (args.includes('--update')) {
  // The csv must parse: we never lock a table the arena would reject.
  process.env.UNITS_LOCK = 'off';   // loading units.js checks the old lock; that warning is noise here
  const { parseUnits } = require('../src/agrts/units');
  try { parseUnits(text); } catch (e) { console.error(`units.csv does not load, lock not updated: ${e.message}`); process.exit(1); }
  const before = LOCK.readLock().hash;
  fs.writeFileSync(LOCK.LOCK_FILE, JSON.stringify(LOCK.lockFor(text), null, 2) + '\n');
  console.log(before === hash ? `units.lock.json already matches units.csv (${hash})` : `units.lock.json updated: ${before ? before.slice(0, 12) : '(none)'} -> ${hash}`);
  console.log('Commit units.csv and units.lock.json together.');
  process.exit(0);
}

const lock = LOCK.readLock();
if (lock.error) { console.error(`FAIL  ${lock.error}`); process.exit(1); }
if (lock.hash !== hash) {
  console.error(`FAIL  units.csv (${hash.slice(0, 12)}) does not match units.lock.json (${lock.hash.slice(0, 12)}).`);
  console.error('      If the edit is intentional: node tools/units-lock.js --update, then commit both files.');
  process.exit(1);
}
console.log(`OK  units.csv is the official table (${hash})`);
