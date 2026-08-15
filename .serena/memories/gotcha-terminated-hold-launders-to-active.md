# A terminated expansion hold launders back to ACTIVE with no in-band trace

Measured 2026-08-13 against `reduceExpansionPlanningHold`
(`packages/core/src/expansion/expansion-planning-hold.ts`).

`ExpansionPlanningHoldState` records termination in `{lifecycle, version,
terminalReceipt}` and NOWHERE ELSE. Strip those three back to
`{lifecycle: "ACTIVE", version: 1, terminalReceipt: null}` and the value is
byte-identical to what the reducer produces for a live hold — its
`creationReceipt.command` still replays cleanly into an ACTIVE state, because
that command never knew about the termination.

So a consumer that validates a hold by REPLAYING ITS CREATION COMMAND proves
only that the hold was once legitimately created. It cannot detect a laundered
terminal hold, and neither can any amount of inspecting the value.

The only thing that separates them is an out-of-band **daemon-current hold
version**. `bindExpansionAdmission` therefore requires
`currentAuthority.holdVersion` and refuses `EXPANSION_BINDING_HOLD_VERSION_MISMATCH`
at layer `CURRENT_AUTHORITY` — that comparison is load-bearing, not belt-and-braces.

Two consequences for anyone touching this family:
- Gate on the OUTER `lifecycle`/`version`/`terminalReceipt` BEFORE replaying,
  or an honestly-presented terminal hold gets resurrected by its own replay.
- A test that only asserts "a terminated hold is refused" is answered by the
  outer gate and says nothing about the laundered case. Assert both halves.

Found by adversarial probe, not by a failing test. See
`mem:task-task-2d9696160e674f26a8d422c45829d80e-handoff`.
