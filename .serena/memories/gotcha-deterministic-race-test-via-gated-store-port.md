# Make a two-handle race DETERMINISTIC by gating inside the store port

Releasing two workers on a shared gate immediately *before* the function under test only makes the
collision LIKELY. If one handle finishes first, the other reads the settled state and the pre-fix code
passes — a flaky red, which is the same as no red.

## The technique

Wrap the REAL store handle inside the worker and block on the gate at the exact observation the race
turns on. For genesis (`apps/daemon/src/identity/genesis-first-boot-worker.mjs`):

```js
readRecoveryBinding: (slot) => {
  const read = store.readRecoveryBinding(slot);
  reads += 1;
  if (reads > 1) return read;                       // the post-install read-back must NOT block
  parentPort.postMessage({ kind: "OBSERVED", observed: read.ok ? read.outcome : read.code });
  Atomics.wait(gate, 1, 0);                         // released only after BOTH reported
  return read;
},
```

Driver: `release(gate, 0)` to open the stores, await both `OBSERVED`, assert
`expect(observed).toEqual(["ABSENT","ABSENT"])` — the collision is PROVEN, not assumed — then
`release(gate, 1)`.

Nothing about production is reimplemented: every call still lands on the real `SqliteEventStore`. Only
the *scheduling* is controlled.

## Assert on COMMITTED BYTES, not on the summary

Have the wrapper also echo what the store's installer answered (`outcome`, `bindingDigest`). Then the
clobber assertion is:

```ts
expect(reports.filter(r => r.installOutcome === "INSTALLED").map(r => r.installDigest))
  .toEqual([row.bindingDigest]);   // every binding ever committed is STILL the row on disk
```

A replacing installer commits twice with two different digests, so this reddens in **both**
interleavings. An outcome-count assertion (`exactly one INSTALLED`) reddens in only one of them.

## Two more things that cost me time

- Assert outcomes as a **mapped, sorted array**, not `filter(...).toHaveLength(1)`. `expected [] to
  have a length of 1 but got 0` tells you nothing; `["INSTALLED","REFUSED"]` vs
  `["INSTALLED","PRESENT"]` names the bug immediately.
- Close every store handle in a `finally` **before** posting the result, or Windows `rmSync` throws
  EPERM and the vitest worker dies with zero output, reading as a native crash.

Precedents in-repo: `packages/store/src/*-race-worker.mjs` (gate protocol PREOPEN_READY/READY/RESULT),
`adapters/jetbrains/src/jetbrains-runtime-entrypoint.test.ts` (real child via execFile).
