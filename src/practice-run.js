'use strict';
// Child process for POST /api/seat/practice: runs N headless commander-mode matches with one seat's CURRENT scripts
// against the other seats' configured house scripts ("stubs"). Nothing is recorded or persisted.
// Input (IPC message): {cfgPath, seat, scripts: {hero:{name,source}, drones:{type:{name,source}}, battlePlan:{name,source}|null}  ("commander" accepted as a deprecated alias), seeds:[...]}
const path = require('path');
const { Referee } = require('./referee');
const { loadQuickJS } = require('./sandbox');
const { loadConfig, buildRoster } = require('./roster');

process.on('message', async (job) => {
  try {
    await loadQuickJS();
    const base = path.join(__dirname, '..');
    const { cfg } = loadConfig(base, job.cfgPath);
    const { roster, store } = buildRoster(base, cfg);
    for (const e of roster) e._restoring = true; // read-only: never write state/rosters.json from here
    const me = roster.find(e => e.seat === job.seat);
    if (!me) throw new Error('unknown seat');
    const put = (k, v) => { if (!store.seats.has(k)) store.addSeat(k, {}); store._set(k, { name: v.name, source: v.source, origin: 'practice' }); };
    put(me.key('hero'), job.scripts.hero);
    for (const t of me.droneTypes()) if (!job.scripts.drones[t]) me.removeDrone(t);
    for (const [t, v] of Object.entries(job.scripts.drones)) { if (!me.droneTypeList.includes(t)) me.droneTypeList.push(t); put(me.key('drone', t), v); }
    const plan = job.scripts.battlePlan !== undefined ? job.scripts.battlePlan : job.scripts.commander;
    if (plan) put(me.key('battle-plan'), plan); else me.removeBattlePlan();
    const ref = new Referee(roster, { autoRestart: false, tickMs: 0, mode: 'commander', maxTicks: cfg.maxTicks, commander: cfg.commander, unitTypes: cfg.unitTypes, seed: job.seeds[0] });
    ref.paused = true;
    const idx = roster.indexOf(me), matches = [];
    for (let i = 0; i < job.seeds.length; i++) {
      if (i > 0) ref.newMatch(job.seeds[i]);
      while (ref.status === 'running') await ref.runTick();
      const s = ref.matchSummary(), t = s.teams[idx];
      const mine = s.robots.filter(r => r.team === idx);
      matches.push({ seed: s.seed, ticks: s.ticks, winner: s.winner.name, reason: s.winner.reason, won: s.winner.name === me.name, placement: t.placement, score: t.score,
        damageDealt: t.damageDealt, friendlyDamage: t.friendlyDamage, energySpent: t.energySpent, deployed: t.deployed,
        faults: mine.reduce((a, r) => a + (r.meta ? r.meta.faults : 0), 0) + (t.battlePlan ? t.battlePlan.faults || 0 : 0) });
      process.send({ progress: i + 1 });
    }
    process.send({ done: true, matches });
  } catch (e) { process.send({ error: String(e.message || e) }); }
});
