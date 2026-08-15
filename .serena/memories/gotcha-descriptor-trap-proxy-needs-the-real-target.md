# Gotcha: a descriptor-trap proxy needs the REAL record as its target, not just a non-empty one

Sibling of `mem:gotcha-hostile-proxy-descriptor-trap-needs-nonempty-target`, and strictly stronger.

That memory says: give a `getOwnPropertyDescriptor`-trap proxy a target with at least one own key, or
`Object.keys` never reaches [[GetOwnProperty]] and the trap never fires. True, but insufficient against an
EXACT-SHAPE parser. Such a parser checks the key SET first:

```ts
const own = Reflect.ownKeys(value);
if (!own.every((k) => typeof k === "string" && keys.includes(k))) return null;  // <-- refuses here
for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); ... }
```

A proxy over `{ probeKey: "value" }` is refused at the key check and the descriptor trap is NEVER invoked.
The case still refuses, still asserts the right code/leg/layer, and reads as full coverage — while
degrading into an ordinary "record with a wrong key" case that a dozen other cases already cover.

Rule: the proxy target must be the record the parser EXPECTS (right prototype, right key set), so control
reaches the descriptor read. Then assert a positive trap counter — that assertion is what catches this;
without it the degradation is invisible.

Observed on `apps/daemon/src/work/work-claim.test.ts`: 5 of 48 generated hostile cases failed only
`expect(probe.hits).toBeGreaterThan(0)`, never the refusal assertions.
