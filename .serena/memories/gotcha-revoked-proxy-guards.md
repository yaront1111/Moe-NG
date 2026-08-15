# Gotcha: `Array.isArray` throws on a revoked proxy — order structural guards accordingly

`Array.isArray(revokedProxy)` does **not** return false. It throws:

```
TypeError: Cannot perform 'IsArray' on a proxy that has been revoked
```

Per spec, `IsArray` pierces proxies to reach the target, and a revoked proxy has no
target. `Object.getPrototypeOf`, `Object.getOwnPropertyNames`, and
`Object.getOwnPropertyDescriptor` throw on revoked proxies for the same reason.

`node:util`'s `types.isProxy()` is the safe test: it is a native V8 check that triggers
no traps and never throws.

## The rule

In any `isPlainRecord`-style guard on a trust boundary, **test `types.isProxy` before any
other structural operation**:

```ts
// WRONG — throws instead of failing closed
if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
if (types.isProxy(value)) return false;

// RIGHT
if (value === null || typeof value !== "object" || types.isProxy(value)) return false;
if (Array.isArray(value)) return false;
```

A bare `Array.isArray(x)` on caller-supplied input needs the same treatment. In
`@moe/contracts` that is `isSafeArray()` in `packages/contracts/src/runtime/runtime-guards.ts`.

## Why it matters here

Fail-closed is an epic rail: hostile input must return a stable refusal, never escape as
an exception. This bug shipped past `tsc` and past a 92-test suite — nothing catches it
until you actually construct `Proxy.revocable(...)` and revoke it.

`typeof` on a revoked **callable** proxy is `"function"`, so callable proxies are caught
by the `typeof !== "object"` check and never reach the throwing operations. Only the
revoked **object** proxy path is dangerous.

## Convention

`packages/control-room-model/src/hostile-input.test.ts` already asserts
`expect(() => publicFn(revoked.proxy)).not.toThrow()`. Any new public entry point that
accepts `unknown` should carry the same assertion. Probe every parameter, not just the
first — nested values (`details`, `source`, array elements) reach guards too.
