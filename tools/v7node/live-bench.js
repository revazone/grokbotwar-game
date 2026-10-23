// One headless local match: Node Play Loop (loop.js) on report v7 through the relay (or the arena alone when relay/ is absent, as in the public game) vs Ember, with the strategy card approved first.
// Bench copy of live.js with the live arena's settings (DAMAGE_SCALE 0.7, BASE_INCOME 12, BUY_RANGE 1), a per-run inject file (LIVE_TAG) and the arena dir printed. Never port 8787.
'use strict'; const fs = require('fs'); const { startStack, req } = require('../strategy-stack'); const L = require('./loop');
const fmt = process.argv[2] || 'v7';
(async () => {
  const noRelay = !fs.existsSync(require('path').join(__dirname, '..', '..', 'relay', 'server.js'));   // public game: no relay/, no viewer
  const env = { ...(process.env.LIVE_NOCARD || noRelay ? { AWAIT_VIEWER: '0' } : {}), GBW_PVP: '0', DAMAGE_SCALE: '0.7', BASE_INCOME: '12', BUY_RANGE: '1', BUY_CAP: '0', FIELD_HOSPITAL: '1', TERRITORY_CAP: '3', MORTAR: '1', ...(process.env.GAME_SPEED ? { GAME_SPEED: process.env.GAME_SPEED } : {}), ...(process.env.ARENA_NODE_OPTIONS ? { NODE_OPTIONS: process.env.ARENA_NODE_OPTIONS, MEDSTATS_OUT: process.env.MEDSTATS_OUT } : {}) };
  const st = await startStack({ env, fight: false });
  try {
    // owner approves Ray's current plan on the card: Balanced + 1 early medic
    const fg = st.cli(['fight', '--propose', 'balanced', '--medics', '1', '--medic', 'one_early', ...(process.env.LIVE_NOTE ? ['--note', process.env.LIVE_NOTE] : [])]); console.log('fight --propose', fg.status);
    if (st.relay) {   // owner card lives on the relay; without one (public game) the arena gives Balanced defaults
    await req('GET', `${st.relayBase}/r/${st.room}/strategy`, st.okey);
    const ap = await req('POST', `${st.relayBase}/r/${st.room}/strategy`, st.okey, { strategy: { plan: 'balanced', medics: 1, medic: 'one_early', ...(process.env.LIVE_NOTE ? { note: process.env.LIVE_NOTE } : {}) }, ready: true });
    console.log('card approve', ap.code, ap.j && (ap.j.ok || ap.j.error)); } else console.log('no relay: card skipped (Balanced defaults)');
    const os = await req('POST', `${st.arenaBase}/api/owner/start`, st.okey, {}); console.log('owner start', os.code);   // stands in for the owner pressing Start (no browser here)
    const kv = st.cli(['strategy', '--wait', '60']).stdout; console.log(kv.split('\n').filter(x => /plan=|hold=|push=|medics=|medic=|approved=|note=/.test(x)).join(' '));
    const inj = '/tmp/v7node/inject-' + (process.env.LIVE_TAG || 'x'); fs.writeFileSync(inj, 'FOCUS D\n');
    const o = await L.run({ fmt, strategyKv: kv, inject: inj, seat: { token: st.seatTok(), arena: st.arenaBase, relay: st.relay ? { url: st.relayBase, room: st.room } : undefined } });
    fs.writeFileSync(`/tmp/v7node/live-${process.env.LIVE_TAG || "x"}-${fmt}.json`, JSON.stringify(o, null, 1));
    const s = [...o.lat].sort((x, y) => x - y);
    console.log(`RESULT ${o.result}\nreports ${o.reports.length} v7 lines ${o.reports.filter(x => /^v7 /.test(x)).length} posts ${o.posts.length} acks ${o.posts.reduce((n, p) => n + p.acks.length, 0)} refusals ${o.refusals.length} slot_full ${o.posts.flatMap(p => p.acks).filter(a => /slot_full/.test(a)).length} decide median ${s[s.length >> 1].toFixed(3)} ms p95 ${s[Math.floor(s.length * 0.95)].toFixed(3)} ms`);
    for (const r of o.refusals) console.log('  REFUSED', JSON.stringify(r));
  } finally { console.log('ARENADIR ' + st.arenaDir); st.stop(); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
