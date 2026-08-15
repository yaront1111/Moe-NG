# Gotcha: uniform random-walk property tests over lifecycle reducers are usually vacuous

Writing a seeded `xorshift32` trace that picks a uniformly random command kind
each step and feeds it to a lifecycle reducer **almost never reaches the deep
states**, so every invariant asserted about those states silently passes
without ever being evaluated.

Measured on the planning-run reducer (12 command kinds, 9 lifecycle states,
1800 total steps across 5 seeds x 3 variants):

- `planning.claim` succeeded 27 times
- `plan.propose` succeeded **0 times**
- the multi-node admission gate — the whole point of the test — never fired

Two compounding causes: a terminal state (`CANCELLED`, `REJECTED`) absorbs
every remaining step of the trace, and reaching a deep state needs N *specific*
commands in order, which is exponentially unlikely at 1/12 per draw.

## Diagnose it before trusting it

Do not eyeball the trace. Tally `(commandKind => outcome)` pairs and print
them once:

```ts
const tally = new Map<string, number>();
for (const entry of observed) {
  if (Array.isArray(entry)) {
    const key = `${String(entry[0])}=>${String(entry[1])}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
}
console.log([...tally.entries()].sort());
```

A kind with only rejection outcomes and zero accepted outcomes is the tell.

## The fix — seed pools, not pure random walks

Build a pool of REAL reduced states with a helper that drives a known-good
command sequence, then start the trace from a random pool member and *restart
into* the pool whenever the run goes terminal:

```ts
function driveRun(steps, expectedLifecycle) { /* asserts each step ok */ }
const pool = [undefined, draft, ready, owned, sealed, draining];
let current = pool[next() % pool.length];
// ...on terminal: current = pool[next() % pool.length]
```

Three things make this hold up:

1. `driveRun` asserts each member's expected final lifecycle, so the pool is
   itself mutation-resistant — a reducer change that breaks the setup fails
   loudly instead of quietly shrinking coverage.
2. Bias kind selection ~70% toward the currently-legal set and keep ~30%
   uniform, so illegal transitions still get exercised.
3. Add one **aggregate existence assertion** (`expect(observed.some(e => e[1]
   === "MULTI_NODE_EXECUTION_UNSUPPORTED")).toBe(true)`) across all seeds. It
   is the only thing that proves the property was not vacuous. Assert it over
   the combined run, not per seed — per-seed existence is flaky.

Exclude pool members that would trivially violate the property under test
(e.g. multi-node traces seed only at or before the sealed submission, never at
`PLAN_REVIEW`), otherwise the setup, not the reducer, fails the assertion.
