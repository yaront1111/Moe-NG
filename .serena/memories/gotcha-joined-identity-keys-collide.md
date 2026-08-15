# Gotcha: a separator-joined identity key is not injective

Found 2026-08-08 by adversarial self-review on `task-5ee5b801` (`budget-measurement.ts`), after the
tests were already green and the mutation sweep already clean. No test would ever have caught it.

## The bug

```ts
identity: `${record.providerRunRef}|${record.meter}|${record.sequence}`
```

`providerRunRef` and `meter` are arbitrary bounded strings — nothing forbids a `|`. So

- `("run|x", "y",   1)` -> `"run|x|y|1"`
- `("run",   "x|y", 1)` -> `"run|x|y|1"`

Two distinct observations, one identity. Consequences, in increasing order of nastiness:

1. Dedup/monotonicity misfires — here it fell to `_IDENTITY_CONFLICT`, the fail-closed direction,
   so it looked survivable.
2. The identity was also embedded in the projected **policy fact ID**. Two genuinely different
   measurements collapse into one fact downstream. Policy dedupes by fact ID, so a real measurement
   silently disappears. That is not fail-closed; it is evidence loss.

## The fix — length-prefix each component

```ts
return `${run.length}:${run}|${meter.length}:${meter}|${record.sequence}`;
```

Netstring-style. Injective for arbitrary component contents, still deterministic, still readable in
a log. Cheap: one helper, and a three-line test that two swapped-separator inputs differ.

## Rule

Any time you build a composite key by joining caller-supplied strings — identity, cache key, dedup
key, fact ID, digest input — ask whether a component can contain the separator. If the components
are validated refs (i.e. arbitrary bounded strings), the answer is yes. Either length-prefix, or
hash each component separately, or pin the components to a charset that excludes the separator and
test that pin. Do not rely on "our IDs never contain pipes."

Related: this is a canonicalisation flaw of the same family as an unescaped digest preimage. The
mutation sweep will NOT find it — reverting to the naive join reddens tests only once you've added
the injectivity test.
