'use strict';
// All tunables in one place. Override via env (see server.js) or Referee constructor.
module.exports = {
  arena: { w: 1500, h: 830 },  // widescreen battlefield (~1.81:1, fills a landscape phone next to the HUD); scripts read sense.arena / sense.limits.arena
  tickMs: 300,               // wall-clock time between ticks (spectator speed); env TICK_MS. 300 ms (was 150) so people can follow a fight
  controllerTimeoutMs: 400,  // only matters for async controllers; scripts are bounded by the sandbox CPU limit  // a controller reply later than this = stand still; env CONTROLLER_TIMEOUT_MS
  maxTicks: 600,             // time limit; then most health wins; env MAX_TICKS
  robotRadius: 20,
  maxMove: 50,               // units per tick, along heading (negative = reverse)
  maxTurn: 30,               // degrees per tick
  scanMinWidth: 2,
  scanMaxWidth: 90,
  shellSpeed: 110,           // units per tick
  damagePerPower: 8,         // hit damage = power * damagePerPower (power 1..3 => 8/16/24)
  heatPerPower: 14,          // firing adds power * heatPerPower heat
  maxHeat: 100,              // cannot fire if heat + shot heat > maxHeat
  coolPerTick: 7,
  wallDamage: 1,             // bumping a wall
  ramDamage: 2,              // robot-robot collision (both)
  autoRestart: true,
  autoRestartDelayMs: 6000,
  pauseAfterMatch: false, // true = hold after every match until resume (solo style matches default to true, see server.js)

  // ---- match mode: 'classic' (one unit per team, base stats above) or 'commander' (teams of hero + drones) ----
  mode: 'classic',
  // Unit specs. 'classic' = the base stats above (used in classic mode). hero/drone are used in commander mode.
  unitTypes: {
    classic: { health: 100, radius: 20, maxMove: 50, maxTurn: 30, maxPower: 3, damagePerPower: 8, heatPerPower: 14, maxHeat: 100, coolPerTick: 7, shellSpeed: 110, scanMaxWidth: 90 },
    hero:    { health: 200, radius: 20, maxMove: 50, maxTurn: 30, maxPower: 3, damagePerPower: 10, heatPerPower: 14, maxHeat: 100, coolPerTick: 7, shellSpeed: 110, scanMaxWidth: 90, cost: 80 },
    drone:   { health: 40, radius: 12, maxMove: 60, maxTurn: 45, maxPower: 1, damagePerPower: 5, heatPerPower: 20, maxHeat: 100, coolPerTick: 8, shellSpeed: 130, scanMaxWidth: 60, cost: 20 },
  },
  commander: {
    maxTicks: 1500,            // commander matches are longer (1500 ticks = 7m30s cap at 300 ms; most end in about 3 min)
    energyStart: 60,           // starting energy when no seat in the arena uses an arsenal (old behavior)
    arsenalBudget: 120,        // pre-match budget per team when arsenals are used (SPEC 5.1): drones at unitTypes.drone.cost each; the rest = starting energy
    energyMax: 200,
    energyPerTick: 0.25,       // refill rate (0.83 energy/second at 300 ms ticks)
    heroCap: 2,                // max heroes alive + pending per team
    droneCap: 4,               // max drones alive + pending per team
    rosterMaxDrones: 3,        // distinct drone scripts (unit types) per team
    spawnDelayTicks: 8,
    lastStandTicks: 15,        // a team with no units alive or pending is eliminated after this many ticks (time for the battle plan / live orders to redeploy)        // order -> unit appears at home corner
    battlePlanEveryTicks: 13,  // each team's battle plan runs about every 4 s (old name: commanderEveryTicks)
    orderCooldownMs: 10000,    // POST /api/seat/order rate limit per seat (wall clock)
    timerDamageWeight: 0.25,   // timer score = remaining unit health + 0.25 * damage dealt to enemies
    // "soft" seats (bots.json seat "soft": true, e.g. NPC rivals in a player's first match) get this handicap;
    // a seat may also give its own "handicap": {energyRate, planEveryTicks}
    softHandicap: { energyRate: 0.75, planEveryTicks: 26 },
    battlePlanMaxFaults: 10,   // battle plan disabled for the match after this many faults (old name: commanderMaxFaults)
  },
};
