'use strict';
/**
 * CONTROLLER INTERFACE
 * --------------------
 * A controller is just:   async function (sense) -> command
 * created by a factory    make() -> controller   (one per robot per match, so it may keep private memory
 *                                                 in its closure).
 *
 * sense (built by the referee each tick; see Referee._buildSense):
 * {
 *   tick, ticksLeft, robotsAlive,
 *   arena: {w, h},
 *   limits: {maxMove, maxTurn, scanWidth:[min,max], power:[1,3], maxHeat, shellSpeed},
 *   self:  {name, x, y, heading, health, heat, canFire, damageTakenLastTick, hitWallLastTick},
 *   scan:  {dir, width, result: null | {bearing, distance, relBearing}}   // result of LAST tick's scan
 * }
 * Angles are degrees, 0 = east (+x), 90 = south (+y, screen down), clockwise.
 *
 * command (any field may be omitted):
 * {
 *   move:  -50..50,                       // units along heading this tick (after turning)
 *   turn:  -30..30,                       // degrees, applied before moving
 *   scan:  {dir: 0..360, width: 2..90},   // where to look; result arrives in next tick's sense
 *   fire:  {angle: 0..360, power: 1..3} | null,
 *   thought: "one line"                   // shown to spectators
 * }
 * Invalid, thrown, or late (> controllerTimeoutMs) replies => robot stands still that tick.
 *
 * Future: a Grok Bot controller (src/controllers/grokbot.js, NOT implemented yet) will implement exactly
 * this signature by sending the sense JSON to a Grok Bot whose description is its program and parsing
 * its JSON reply.
 */
module.exports = {};
