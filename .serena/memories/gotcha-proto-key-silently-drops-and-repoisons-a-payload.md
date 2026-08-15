# A `__proto__` field is dropped AND poisons the object it was copied into

Found by adversarial self-review on task-69d32b1da9e345f09cd18224b301747c,
2026-08-14. Measured, not theorised:

```js
const doc = JSON.parse('{"legacyId":"x","__proto__":{"polluted":true},"owner":"ada"}');
Object.keys(doc);                   // [ 'legacyId', '__proto__', 'owner' ]  <- OWN property
const payload = {};
for (const k of Object.keys(doc)) payload[k] = doc[k];
Object.keys(payload);               // [ 'owner' ]            <- the field VANISHED
Object.getPrototypeOf(payload) !== Object.prototype;  // true  <- and the proto moved
```

`JSON.parse` gives `__proto__` an **own** data property, but `obj[key] = value`
hits the inherited setter, so the accumulator loop silently drops the field and
replaces the prototype. Two failures for the price of one.

The second one is the nastier: in `@moe/import` a payload whose prototype moved
then fails `isPlainRecord` (`canonical-bytes.ts` requires `Object.prototype` or
`null`), so `canonicalPayload` refuses and the record is reported as
**CORRUPT_BYTES for a reason no operator can see** — the input looked fine.

Fixes, both one-liners:
- Building an object from dynamic keys: `Object.fromEntries(pairs)`, which uses
  CreateDataPropertyOrThrow and defines an own `__proto__` property faithfully.
  (`Object.defineProperty` works too; plain assignment never does.)
- READING a possibly-absent field: `Object.hasOwn(obj, key) ? obj[key] : null`.
  `obj[key] ?? null` is wrong for exactly this key — reading an absent
  `__proto__` returns the prototype OBJECT, not undefined, so `??` never fires
  and a non-string escapes into typed output.

Both sites existed in one task: the decoder's payload accumulator and the shadow
comparator's field read. Grep for `\[key\] = ` accumulator loops and `\[field\] ?? `
reads wherever keys come from untrusted JSON. Related:
`mem:gotcha-proto-key-drop-in-dynamic-key-accumulator`,
`mem:gotcha-proto-key-write-path-is-silently-dropped`,
`mem:gotcha-prototype-chain-key-lookup`.
