# A bare count over a closed registry is an off-by-one that names nothing

`apps/daemon/src/daemon-store-dependencies.test.ts` asserted the runtime command
registry as `registrySize: 21`. Every task that registered a new command kind
turned that line red, and the red said only "expected 21, received 22" — it
never named the kind that arrived, so three separate workers read it as an
off-by-one artifact of somebody else's in-flight work rather than as their own
missed edit. It reddened four tasks' gates over one afternoon.

## The shape that works

Report the SET from the runtime and pin it by name in the test:

```ts
// child/report side
registryKinds: [...deps.registry.keys()].sort(),
// assertion side — all 22 spelled out
registryKinds: ["approval.decide", "effect.activate", /* ... */ "work.renew"],
```

Now the failure output is `+ "effect.activate"`: the new command names itself,
and a DROPPED command names what was lost. `.sort()` is what makes it
deterministic — `Map` keys are insertion-ordered, and registry entries are built
by iterating `Object.keys(PAYLOAD_KEYS)`.

`daemon-command-registry.test.ts` already had the good shape at line 166 —
`expect([...deps.registry.keys()].sort()).toEqual(ROWS.map(r => r.kind).sort())`
against a hand-written 22-row table — which is why that suite named the kind
while its sibling only counted.

## Generalizes

Any assertion over a closed enum, registry, or export barrel: assert the NAME
SET, not the cardinality. A count is the one assertion that goes stale on
somebody else's commit and cannot tell you whose.

Prove the assertion is live before trusting it: delete one name and confirm the
failure output contains that name. Restore from a saved copy, never
`git checkout` in this shared worktree.

Related: `mem:gotcha-closed-enum-all-array-couples-sibling-tests`.
