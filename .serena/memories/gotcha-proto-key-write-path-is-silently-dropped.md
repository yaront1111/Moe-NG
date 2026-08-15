# Gotcha: `obj["__proto__"] = value` silently creates NOTHING — but `JSON.parse` does

Found by adversarial review on task-739879d0 (distribution packaging), 2026-08-09.
The asymmetry is the whole trap: the READ path is correct and the WRITE path is
broken, so a round-trip test built from parsed JSON never catches it.

## Measured on Node v24.16.0

```js
const payload = {};
payload["__proto__"] = "abc";
Object.hasOwn(payload, "__proto__")            // false  <-- assignment discarded
Object.keys(payload)                            // []
Object.getPrototypeOf(payload) === Object.prototype  // true (unchanged)

JSON.parse('{"__proto__":"x","a":1}')
Object.hasOwn(parsed, "__proto__")              // TRUE   <-- own data property
Object.keys(parsed)                             // ["__proto__","a"]

Object.fromEntries([["__proto__","x"]])
Object.hasOwn(o, "__proto__")                   // TRUE, prototype intact
```

`__proto__` on an object literal is an accessor inherited from `Object.prototype`
whose setter ignores non-object values, so assigning a string is a no-op. JSON.parse
and `Object.fromEntries` use CreateDataProperty and bypass the setter entirely.

## The bug it caused

A packager built its asset payload by assignment in a loop:

```ts
const payload: Record<string, string> = {};
for (const asset of input.assets) {
  if (Object.hasOwn(payload, path)) return refuse("ASSET_PATH_DUPLICATE");
  payload[path] = base64;
}
```

For `path === "__proto__"` the entry vanished, the MANIFEST still declared the
asset, and the build returned `ok` for a container whose key set can never equal
its declared set. Fail-closed downstream (ASSET_SET_MISMATCH at startup), so not
a security hole — but a packager reporting success for an unusable artifact is a
defect. The `Object.hasOwn` duplicate guard inherited the same blind spot.

## Fix

Collect pairs and materialise once:

```ts
const payload: Array<readonly [string, string]> = [];
const seen = new Set<string>();          // NOT Object.hasOwn on the literal
...
Object.fromEntries(payload)
```

Do NOT reach for `Object.create(null)` as the fix if the value later crosses a
guard like this repo's `isPlainRecord`, which requires
`Object.getPrototypeOf(value) === Object.prototype` and would reject it.

## How to catch it

A test that round-trips through `JSON.parse` passes, because parse creates the key.
The test that works asserts the WRITE path's own output:

```ts
expect(Object.keys(carried.assets).sort()).toEqual(["__proto__", "src/real.ts"]);
```

Mutation-drill it by restoring the naive form
(`payload.reduce((a,[k,v]) => { a[k] = v; return a; }, {})`) and confirming red.

Related: `mem:gotcha-prototype-chain-key-lookup`, `mem:gotcha-prototype-chain-command-dispatch`.
