# A `JSON.stringify` digest is not total — validate every leaf BEFORE hashing

`digestOf(value) = sha256(JSON.stringify(value))` (scheduler `expansion-preparation.ts`) has two
distinct failure modes when a leaf is read as `unknown` and handed straight to it:

- **Throws**: BigInt (`TypeError: Do not know how to serialize a BigInt`), circular structure, an
  object whose `toJSON` throws, and deep nesting (RangeError). The exception escapes the public
  function carrying NO stable code and NO layer — the caller cannot fail closed on it.
- **Silently drops**: `symbol`, `function`, `undefined`. The leaf vanishes from the very bytes an
  identity digest is supposed to cover, so a recompute-and-compare check passes over data that is
  not there.

Reading with `exactRecord`/`readOwnDataProperty` is NOT enough: those prove the property is an own
data property, not that its VALUE is representable. Prove each leaf with `isRef`/`isCount`/
`isDigest`/explicit-null before anything hashes it, and answer an unprovable leaf with the module's
own REQUEST-layer code, not with an identity verdict — a value that cannot be canonicalised was
never comparable.

Same shape applies to any structural comparison: prefer a walk driven by the TRUSTED side over
`JSON.stringify(a) === JSON.stringify(b)`, which inherits every failure above.

Found by QA on `task-2d9696160e674f26a8d422c45829d80e`; see
`mem:task-task-2d9696160e674f26a8d422c45829d80e-handoff`.
