# Warrior helpers

Two small shell wrappers GrokBotWar uses to play a match from its seat. They call `tools/warrior-seat.js`, so they work against the local arena or the relay, whichever the seat file names.

| Script | What it does |
|---|---|
| `open.sh ["ORDER" ...]` | Waits for `READY`, `COUNTDOWN` or `START`, then posts the opening with `--report <id>` and prints `ID=<id>` to continue from. With no arguments it posts `DEPLOY ALL`, `AUTOBUY T RESERVE 36`, `FOCUS M`. Gives up after `OPEN_WAIT_S` (900 s). |
| `gs.sh <lastId> ["ORDER" ...]` | Posts up to 3 orders (plus one `WHY`) with `--report <lastId>` and prints each reply line as `ack: ...` (the OK/ERR lines, then the fresh `STATE` line). Then long-polls `next --since`, skips `STATE` reports, and prints the next report as `<id>\t<event>\t<line>` (`END` included). Gives up after `GS_TRIES` polls (40). |

Both run from the checkout that holds `tools/warrior-seat.js` and the seat file: this repo by default, or `GBW_DIR`.

```sh
tools/warrior-helpers/open.sh                    # ID=12
tools/warrior-helpers/gs.sh 12                   # wait for the next report
tools/warrior-helpers/gs.sh 15 "MOVE ALL z4" "WHY take z4 early"
```

## PvP (either side)

After `node tools/warrior-seat.js pvp` exits 0, run the same two helpers right away: `open.sh`, then `gs.sh <id>` until `END`. Nothing changes for either side.
- Host (Green): the match runs on our own arena, as in solo, but no `fight` is needed because the PvP match is already started.
- Guest (Ember): while the PvP match is active, `warrior-seat.js` sends `report`, `next` and `orders` to the saved PvP seat (`secrets/pvp-seat.json`) through the relay on its own, so the helpers need no flag. The seat retires at `END`, or when the relay says it's closed.

As Ember, the report lists our units first and tags the enemy `G`. Zones stay absolute: our home is `z8`, so `open.sh`'s default opening works as is, but a `MOVE` toward the enemy base goes down to `z1`. Each player brings its own army: set it with `warrior-seat.js opening ...` on our own arena before `pvp`, as for solo. As the guest, `pvp` sends that opening to the host before saying ready. `open.sh` doesn't cover the army: it posts orders (DEPLOY, AUTOBUY, FOCUS), and the arsenal is the opening. With no opening, a side fights with the balanced draft.

`tools/test-pvp-command.js` runs both helpers on both sides of a local PvP match to `END`.

## The opening and the active cap

Only 6 of our units can be on the field at once (`ACTIVE_CAP`, drones included). The rest wait in reserve, and deploying them later is free. The old opening `DEPLOY S R R R T T T M` names 8 units. Under the cap it fields the first 6 named (S R R R T T) and leaves the medic at home. So `open.sh` now posts `DEPLOY ALL`, which fills the 6 slots with one of each ground type and then goes round again: 1S 3R 3T 1M fields 1S 2R 2T 1M, and 1R 1T wait for a freed slot. A `DEPLOY` into a full field answers `ERR DEPLOY ...: cap 6 active, N in reserve`. A partial one answers `OK DEPLOY ALL (6 of 8 at T0, cap 6)`.

## Keep them in step

These helpers parse `warrior-seat.js` output: the plain `orders` reply, and the `report --json` and `next --json` fields `id`, `event` and `line`. Whenever `warrior-seat.js` orders, `next` or the report output change, update these helpers in the same commit and re-run `tools/warrior-helpers/dry-check.sh` (a throwaway `RELAY=off` arena on a free port, never 8787).
