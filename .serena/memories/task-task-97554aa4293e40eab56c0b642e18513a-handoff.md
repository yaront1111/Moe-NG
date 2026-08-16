# task-97554aa4 Foundation self-host canary — architect output 2026-08-16

Delivered the routed Clause-2 output at HEAD e881141: three gaps re-measured on disk,
two production tasks filed, canary re-blocked on four ids. No plan submitted — correct
for an acceptance gate whose subjects are absent.

## The three gaps, re-measured (all still open)

**GAP A — pinned Claude production spawn. NOT FILED**, per routing. Owned by:
`ff589abd` (DONE) → `32eddfd3` (DONE, `observeInstalledClaudeRuntime` at
claude-host-runtime.ts:201) → `75ee4a84` (planned, `createClaudeRuntimePinRequest` —
the factory replacing 6cbff010's temporary `runtimePorts`) → `6cbff010` (BLOCKED).
Plus `d7b352e1`; sibling `7ba898f5` is DONE on the fd0 half only.

**GAP B — restart reconciliation. UNWIRED.** `reconcileOnRestart`
(restart-reconciliation.ts:235) callers: `continuation-test-harness.ts:6,73` (a harness
by name and fact), two test files, one doc comment. Zero production. `startDaemon`
(daemon-entry.ts:162) = resolveDependencies → mint CSRF → startControlRoomListener →
freeze/return. Filed **task-3e54b466**.

**GAP C — durable coordination. UNWIRED.** `createCoordinationAdapter`
(coordination-adapter.ts:111) has three callers, all its own test. A grep for
`coordination/` imports from production daemon modules outside that directory returns
**zero**. Registry admits BOOTSTRAP(:48)/REVIEW(:56)/SESSION(:61)/WORK(:66) + effect.activate
+ recovery.complete — no coordination kind. Filed **task-d17bb228**.

## Then planning GAP B found a sub-gap

`reconcileOnRestart` needs `InFlightAttempt[]`, and **nothing produces it** — the grep
returns only the type declaration and the request field. Checked for it under other
names first: all four `foundation-attempt-store.ts` readers (:73, :115, :128, :149) are
keyed by a known id, so none enumerate; the other `inFlight` hits are an in-memory map
in recovery-incarnation.ts and scheduler capacity units.

Filed **task-48c0c0db** (enumerator) and blocked `3e54b466` on it. Did not absorb it:
the wiring task is a consumer edge, an enumerator is new production capability, and
absorbing it would have made the wiring task edit what it composes.

## Chain now

`48c0c0db` → `3e54b466` → canary(GAP B)
`d17bb228` → canary(GAP C)
`75ee4a84` → `6cbff010` + `d7b352e1` → canary(GAP A)

`3e54b466`, `d17bb228` and the GAP A chain are independent — three parallel tracks; only
the canary waits on all four.

## Traps recorded in the filed tasks

- **`SESSION_FAMILY` is a decoy for GAP C**: it exists and is session *credential*
  lifecycle (open/renew/close), not coordination envelopes. Extending it closes nothing.
  `d17bb228`'s DoD pins it at exactly three kinds so the substitution reddens.
- **A test harness is not a production caller.** Routing production through
  `continuation-test-harness.ts` would leave GAP B where it is while looking closed.
- **`FOUNDATION_DISPATCH_EVENT_TYPES` has no terminal member** (only RECORDED and
  RESERVED), so "still in flight" must be decided from committed evidence. Inferring it
  from absence classifies every finished attempt as a crash.
- `packages/testkit/src/foundation/foundation-model-j3j4.ts` would make a green J3/J4
  trivial to fake — exactly the mock-backed journey this terminal gate must refuse.

## Unblock test — greps, never status

```
grep -rn "reconcileOnRestart" --include=*.ts apps | grep -v '\.test\.' | grep -v test-harness
grep -rn "createCoordinationAdapter" --include=*.ts apps | grep -v '\.test\.'
grep -rn "coordination/" --include=*.ts apps/daemon/src | grep -v "^apps/daemon/src/coordination/"
```
All three returned zero at this HEAD. Steps 2-8 of the canary plan are unchanged.

Related: `mem:gotcha-board-promotes-tasks-ahead-of-their-dependencies`.
