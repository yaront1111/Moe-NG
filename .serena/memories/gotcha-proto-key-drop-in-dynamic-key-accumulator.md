# A validated `__proto__` key vanishes when copied into `{}`

Only bites readers built for an **open / dynamic** key set. With a fixed key list that contains
no `__proto__`, it is unreachable — which is why it can sit latent in a shared helper for months.

`JSON.parse('{"__proto__":1}')` creates an own **data** property. `Object.keys` reports it,
`Object.getOwnPropertyDescriptor` returns it, so it passes every validation. But:

```js
const out = {};
for (const k of Object.keys(src)) out[k] = src[k];   // "__proto__" silently lost
```

assignment hits `Object.prototype`'s inherited `__proto__` **setter**, which ignores non-object
values and never creates an own key. Fix: accumulate into `Object.create(null)`.

```js
const out = Object.create(null);   // "__proto__" becomes a real own key
```

Object **spread** (`{...src}`) is safe — it uses CreateDataProperty and bypasses the setter.

## Why it is worse than "a key goes missing"

In a digest-bound contract the field is validated, then dropped, then **never enters the digest**,
and the record is still admitted. That is a silent evidence drop wearing a green test.

## The confusing part when it interacts with a second `{}` accumulator

`packages/runner/src/supervisor/effect-shape.ts`'s `exactRecord` also accumulates into `{}`. When
a dynamic-key caller layered on top of it, the key was dropped **there** first, and the caller's
later read of `snapshot["__proto__"]` returned `Object.prototype` — an object, which failed the
value check and rejected the item. Net behaviour was fail-closed **by accident**, via two
interacting drops, refusing with a code that named nothing about the real cause. Do not read that
accidental safety as the guard working.

`packages/runner/src/platform/platform-contract.ts`'s `snapshotExactRecord` already gets this
right (`Object.create(null)`) — prefer its shape when writing a new reader.

## How to find it

Probe, do not reason: copy `Object.keys(src)` into `{}` and into `Object.create(null)` and
compare. Then assert the digest **differs** from the same record without the smuggled key —
asserting "the item was accepted" would have passed either way.

Related: `mem:gotcha-proto-key-write-path-is-silently-dropped`,
`mem:gotcha-prototype-chain-key-lookup`, `mem:convention-hostile-shape-reads-in-pure-kernels`.
