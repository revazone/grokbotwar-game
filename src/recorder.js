'use strict';
// MatchRecorder: writes matches/<id>/ for every match:
//   replay.jsonl   header (seed, mode, config, team scripts) + one line per tick + 'order' lines (live API
//                  orders, re-applied by tools/replay.js) + summary
//   scripts/       exact script sources used: <seat>.hero.js, <seat>.drone.<type>.js, <seat>.battle-plan.js
//   report.json / report.txt   whole-match report
//   teams/<seat>.txt / .json   per-team report for that team's coach bot (units, energy, orders)
//   robots/<seat>.txt / .json  same content as teams/ (older name, kept for compatibility)
const fs = require('fs');
const path = require('path');

class MatchRecorder {
  /** @param {{dir, roster}} opts roster = TeamEntry list from roster.js (scripts snapshotted at match start) */
  constructor(referee, { dir, roster }) {
    this.ref = referee; this.dir = dir; this.roster = roster;
    this.cur = null; this.lastId = null;
    referee.on('matchStart', e => this._start(e));
    referee.on('tickRecord', t => { if (this.cur) this.cur.lines.push(JSON.stringify({ type: 'tick', ...t })); });
    referee.on('order', o => { if (this.cur && o.source === 'api') this.cur.lines.push(JSON.stringify({ ...o, unitType: o.type, type: 'order' })); });
    referee.on('matchEnd', s => this._end(s));
    referee.on('rearm', e => { // arsenal changed before tick 1 (match paused at tick 0): keep the header in sync for replays
      if (!this.cur) return;
      for (const x of e.teams) if (this.cur.header.teams[x.id]) this.cur.header.teams[x.id].arsenal = x.arsenal || undefined;
      this.cur.lines[0] = JSON.stringify(this.cur.header);
    });
  }

  _start(e) {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const id = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-m${e.matchNo}-${e.seed.toString(16)}`;
    const files = {}; // relative path -> source
    const teams = this.roster.map((re, i) => {
      const seat = re.seat || re.name;
      const one = (key, file) => { const s = re.snap && re.snap[key]; if (!s) return null; files[file] = s.source; return { name: s.name, version: s.version, hash: s.hash, origin: s.origin, file }; };
      const hero = re.snap ? one(re.key('hero'), `scripts/${seat}.hero.js`) : null;
      const drones = {};
      for (const t of (e.teams[i] && e.teams[i].droneTypes) || []) drones[t] = one(re.key('drone', t), `scripts/${seat}.drone.${t}.js`);
      const battlePlan = e.teams[i] && e.teams[i].hasBattlePlan ? one(re.key('battle-plan'), `scripts/${seat}.battle-plan.js`) : null;
      return { id: i, name: re.name, seat, color: re.color, home: e.teams[i] && e.teams[i].home, scripts: { hero, drones, battlePlan }, handicap: (e.teams[i] && e.teams[i].handicap) || undefined, arsenal: (e.teams[i] && e.teams[i].arsenal) || undefined }; // effective handicap + declared arsenal this match
    });
    const c = e.cfg;
    const header = { type: 'header', id, matchNo: e.matchNo, seed: e.seed, mode: e.mode,
      config: { mode: c.mode, arena: c.arena, maxTicks: c.maxTicks, robotRadius: c.robotRadius, maxMove: c.maxMove, maxTurn: c.maxTurn, shellSpeed: c.shellSpeed, damagePerPower: c.damagePerPower, heatPerPower: c.heatPerPower, maxHeat: c.maxHeat, coolPerTick: c.coolPerTick, wallDamage: c.wallDamage, ramDamage: c.ramDamage, unitTypes: c.unitTypes, commander: c.commander },
      teams, robots: e.robots.map(r => ({ id: r.id, name: r.name, color: r.color, start: { x: r.x, y: r.y, heading: r.heading } })) };
    this.cur = { id, header, files, teams, lines: [JSON.stringify(header)] };
  }

  _end(summary) {
    if (!this.cur) return;
    const { id, files, teams, lines } = this.cur;
    const out = path.join(this.dir, id);
    for (const sub of ['scripts', 'teams', 'robots']) fs.mkdirSync(path.join(out, sub), { recursive: true });
    for (const [f, src] of Object.entries(files)) fs.writeFileSync(path.join(out, f), src);
    lines.push(JSON.stringify({ type: 'summary', ...summary }));
    fs.writeFileSync(path.join(out, 'replay.jsonl'), lines.join('\n') + '\n');
    const report = buildReport(id, summary, teams);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(out, 'report.txt'), report.text);
    for (const t of report.teams) {
      const json = JSON.stringify({ match: id, matchNo: summary.matchNo, ...t, timeline: report.timeline }, null, 2);
      const txt = t.text + '\n\nMatch timeline:\n' + report.timeline.map(x => `  t${x.tick}: ${x.text}`).join('\n') + '\n';
      for (const sub of ['teams', 'robots']) { fs.writeFileSync(path.join(out, sub, `${t.seat}.json`), json); fs.writeFileSync(path.join(out, sub, `${t.seat}.txt`), txt); }
    }
    this.lastId = id;
    this.cur = null;
    try {
      const keep = +process.env.KEEP_MATCHES || 200;
      const ids = fs.readdirSync(this.dir).filter(d => /^\d{8}-/.test(d)).sort();
      for (const old of ids.slice(0, Math.max(0, ids.length - keep))) fs.rmSync(path.join(this.dir, old), { recursive: true, force: true });
    } catch {}
  }
}

const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 >> 3 ^ 1 && n % 10) || 0] || 'th');
const sv = s => s ? `${s.name} v${s.version}` : 'none';

function unitLine(r) {
  const acc = r.shotsFired ? Math.round(100 * r.shotsHit / r.shotsFired) : 0;
  const fate = r.alive ? `alive (${r.health}/${r.maxHealth})` :
    r.deathCause === 'disqualified' ? `DISQUALIFIED t${r.deathTick} (${r.meta && r.meta.disqualifyReason})` :
    `died t${r.deathTick} at (${r.deathPos.x},${r.deathPos.y}) by ${r.killedBy ? r.killedBy + (r.deathCause !== 'shell' ? ` (${r.deathCause})` : '') : r.deathCause}`;
  const faults = r.meta ? r.meta.faults : 0;
  return `${r.name} [${r.kind === 'hero' ? 'hero' : r.type + ' drone'}, spawned t${r.spawnTick}]: ${fate}; dealt ${r.damageDealt}${r.friendlyDamage ? ` (+${r.friendlyDamage} friendly fire)` : ''}, took ${r.damageTaken}; shots ${r.shotsFired} hits ${r.shotsHit} (${acc}%), kills ${r.kills}; walls ${r.wallBumps}, overheats ${r.overheats}, faults ${faults}${r.meta && r.meta.lastFault ? ` (last: ${r.meta.lastFault})` : ''}`;
}

const list = o => Object.entries(o || {}).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
/** "Arsenal: budget 120, bought guard x3 (60), started with 60 energy. Launched at start: guard 3. From reserve: none. Wasted: none." */
function arsenalLine(a) {
  const bought = Object.entries(a.bought).map(([k, n]) => `${k} x${n}`).join(' + ') || 'nothing';
  return `Arsenal: budget ${a.budget}, bought ${bought} (${a.spent}), started with ${a.reserveEnergy} energy. Launched at start: ${list(a.launchedAtStart)}. From reserve: ${list(a.fromReserve)}. Wasted (never launched): ${list(a.unused)}.${a.notes && a.notes.length ? ' Notes: ' + a.notes.join('; ') + '.' : ''}`;
}

function buildReport(id, s, teamsHdr) {
  const cmdMode = s.mode === 'commander';
  const teams = s.teams.map((t, i) => {
    const hdr = teamsHdr[i] || { scripts: {} };
    const units = s.robots.filter(r => r.team === t.id);
    const byType = {};
    for (const r of units) {
      const k = r.kind === 'hero' ? 'hero' : r.type;
      const b = byType[k] = byType[k] || { units: 0, alive: 0, ticksAlive: 0, damageDealt: 0, damageTaken: 0, shotsFired: 0, shotsHit: 0, kills: 0, faults: 0 };
      b.units++; if (r.alive) b.alive++; b.ticksAlive += r.ticksAlive; b.damageDealt += r.damageDealt; b.damageTaken += r.damageTaken;
      b.shotsFired += r.shotsFired; b.shotsHit += r.shotsHit; b.kills += r.kills; b.faults += r.meta ? r.meta.faults : 0;
    }
    const won = s.winner && s.winner.team === t.id;
    const fate = won ? `WON (${s.winner.reason})` : t.eliminated ? `eliminated at tick ${t.eliminatedTick}` : `survived to the time limit with ${t.unitsAlive} units`;
    const label = t.displayName && t.displayName !== t.name ? `${t.displayName} (seat ${t.name})` : t.name;
    const L = [`Team ${label}: placed ${ord(t.placement)} of ${s.teams.length}; ${fate}. Score ${t.score} (remaining health${cmdMode ? ' + 0.25 x damage dealt' : ''}).`];
    if (cmdMode) {
      const dt = Object.entries(hdr.scripts.drones || {}).map(([k, v]) => `${k} = ${sv(v)}`).join(', ') || 'none';
      L.push(`Scripts: hero ${sv(hdr.scripts.hero)}; drones: ${dt}; battle plan: ${sv(hdr.scripts.battlePlan)}${t.battlePlan ? ` (faults ${t.battlePlan.faults}${t.battlePlan.lastFault ? ', last: ' + t.battlePlan.lastFault : ''}${t.battlePlan.disabled ? ', DISABLED: ' + t.battlePlan.disabled : ''})` : ''}.`);
      L.push(`Energy: started ${t.energyStart}, refilled ${t.energyGained}, spent ${t.energySpent}, left ${t.energyLeft}. Deployed during the match: ${t.deployed.hero - 1} extra hero(es), ${t.deployed.drone} drones${t.arsenal ? ' incl. arsenal' : ''} (${Object.entries(t.byType).filter(([k]) => k !== 'hero').map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}).`);
      if (t.arsenal) L.push(arsenalLine(t.arsenal));
      const refused = {};
      for (const o of t.orders) if (o.reason) refused[o.reason.replace(/\(.*\)/, '').trim()] = (refused[o.reason.replace(/\(.*\)/, '').trim()] || 0) + 1;
      L.push(`Orders: the battle plan ran ${t.battlePlanRuns || 0} times and placed ${t.ordersScript} deploy orders; ${t.ordersApi} live API orders. Logged (orders that deployed, plus all API orders): ${t.orders.length}${Object.keys(refused).length ? `; refused: ${Object.entries(refused).map(([k, v]) => `${k} x${v}`).join(', ')}` : ''}.`);
      if (t.orders.length) L.push('Recent orders: ' + t.orders.slice(-8).map(o => `t${o.tick} ${o.source === 'api' ? 'API' : 'plan'} ${o.type} x${o.count} -> ${o.deployed}${o.reason ? ' (' + o.reason + ')' : ''}`).join('; ') + '.');
    }
    L.push(`Damage dealt to enemies ${t.damageDealt}${t.friendlyDamage ? `, friendly fire ${t.friendlyDamage}` : ''}.`);
    if (cmdMode) {
      L.push('By unit type:');
      for (const [k, b] of Object.entries(byType)) L.push(`  ${k}: ${b.units} unit(s), ${b.alive} alive, avg life ${Math.round(b.ticksAlive / b.units)} ticks, dealt ${b.damageDealt} (${Math.round(b.damageDealt / b.units)}/unit), took ${b.damageTaken}, accuracy ${b.shotsFired ? Math.round(100 * b.shotsHit / b.shotsFired) : 0}%, kills ${b.kills}, faults ${b.faults}`);
    }
    L.push('Units:', ...units.map(r => '  ' + unitLine(r)));
    return {
      name: t.name, displayName: t.displayName || t.name, seat: t.seat, placement: t.placement, won, eliminated: t.eliminated, eliminatedTick: t.eliminatedTick, score: t.score,
      scripts: hdr.scripts, arsenal: t.arsenal || null, energy: { start: t.energyStart, gained: t.energyGained, spent: t.energySpent, left: t.energyLeft },
      deployed: t.deployed, byType, orders: t.orders, ordersApi: t.ordersApi, ordersScript: t.ordersScript, battlePlanRuns: t.battlePlanRuns, battlePlan: t.battlePlan,
      commanderRuns: t.battlePlanRuns, commander: t.battlePlan, // deprecated aliases (API < 4.2)
      damageDealt: t.damageDealt, friendlyDamage: t.friendlyDamage,
      units: units.map(r => ({ name: r.name, kind: r.kind, type: r.type, spawnTick: r.spawnTick, alive: r.alive, health: r.health, maxHealth: r.maxHealth,
        damageDealt: r.damageDealt, damageTaken: r.damageTaken, friendlyDamage: r.friendlyDamage, shotsFired: r.shotsFired, shotsHit: r.shotsHit, kills: r.kills,
        deathTick: r.deathTick, deathPos: r.deathPos, killedBy: r.killedBy, deathCause: r.deathCause, hitsOn: r.hitsOn, hitsBy: r.hitsBy,
        wallBumps: r.wallBumps, overheats: r.overheats, faults: r.meta ? r.meta.faults : 0, lastFault: r.meta ? r.meta.lastFault : null, cpuMsMax: r.meta ? +r.meta.cpuMsMax.toFixed(2) : null })),
      text: L.join('\n'),
    };
  }).sort((a, b) => a.placement - b.placement);
  const head = `Match ${id} (${s.mode || 'classic'} mode): ${s.winner.name === 'nobody' ? 'no winner' : (s.winner.displayName || s.winner.name) + ' won'} (${s.winner.reason}) after ${s.ticks}/${s.maxTicks} ticks. Seed ${s.seed}.`;
  const tl = s.timeline.filter(x => x.type !== 'drone_death' && x.type !== 'spawn');
  const text = [head, '', ...teams.map(t => t.text + '\n'), 'Timeline (heroes, eliminations; drone spawns/deaths are in each team section):', ...tl.map(x => `  t${x.tick}: ${x.text}`)].join('\n') + '\n';
  return { match: id, matchNo: s.matchNo, mode: s.mode, seed: s.seed, ticks: s.ticks, maxTicks: s.maxTicks, winner: s.winner, teams, timeline: s.timeline, text };
}

module.exports = { MatchRecorder, buildReport, arsenalLine };
