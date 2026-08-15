# Pattern: one fixture per predicate leg, each with every OTHER leg permitting

The verified fix shape for a multi-leg guard whose blocked cases are over-determined.
Proven end to end on `apps/control-room/src/fixtures.ts` (2026-08-08, task-fd82678f).

## The defect it repairs

```ts
const live = connection !== "DISCONNECTED" && !requiresAffordanceRefresh;
mutationsEnabled: live && nextAllowedCommands.length > 0
```

Three legs, four canonical fixtures — and every fixture that SHOULD be blocked was blocked
by two or three legs at once (DISCONNECTED and HISTORICAL both carried empty command lists).
So `const live = true` left the suite fully green. Each blocked case passed for the wrong
reason; no individual leg was load-bearing. Reading the tests does not reveal this. Only
mutation does.

## The fix

For each leg, add ONE fixture where that leg is the sole blocker and **every other
condition would permit the action**:

| fixture | connection | commands | refresh | isolates |
|---|---|---|---|---|
| dropped | DISCONNECTED | non-empty | false | connection leg |
| refreshRequired | CONNECTED | non-empty | **true** | refresh leg |
| noAffordances | CONNECTED | **empty** | false | length leg |

Keep them in a SEPARATE exported constant, not merged into the canonical set — the
canonical set is keyed one-per-state and duplicate keys would collide.

Then guard the case list (`mem:pattern-guard-the-case-list-not-just-the-cases`): assert the
array length, assert each fixture's own shape (connection/refresh/command count), and assert
`mutationsEnabled` false per fixture. Without the shape assertions a reorder or a quiet
fixture edit re-collapses the isolation silently.

## And kill the co-varying expectation

The same file's older test computed the expected value with production's own formula:

```ts
const live = snap.connection !== "DISCONNECTED" && !snap.requiresAffordanceRefresh;
expect(snap.mutationsEnabled).toBe(live && snap.nextAllowedCommands.length > 0);   // tautology
```

Replace with a fixed exhaustive `Record<State, boolean>` literal. A changed formula must
break the assertion, not be tracked by it.

## Acceptance test for the fix itself

The fix is not done when the suite is green — it is done when EACH leg deleted individually
turns it red. Four mutations, four reds, or a leg is still dead. Use the out-of-tree backup
protocol in `mem:gotcha-mutation-testing-restore-safety`; this repo is a shared working tree.

Related: `mem:gotcha-assertions-detached-from-their-subject` (item 5 is this exact case),
`mem:pattern-assert-which-layer-refused`.
