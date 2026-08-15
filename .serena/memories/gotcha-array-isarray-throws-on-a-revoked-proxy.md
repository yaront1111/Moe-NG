# Gotcha: `Array.isArray` throws on a revoked proxy, so guard ORDER decides refuse-vs-throw

`Proxy.revocable(target, {})` + `revoke()` yields an object where `typeof` is
still `"object"` and `util.types.isProxy` still answers `true` — but
`Array.isArray(revoked)` raises `TypeError: Cannot perform 'IsArray' on a proxy
that has been revoked`.

A fail-closed parser that asks `Array.isArray(value)` before asking
`types.isProxy(value)` therefore ESCAPES as an exception instead of refusing
with a stable reason code: the caller learns nothing, no leg is named, and the
authority boundary raised rather than refused. Verified live in
`apps/daemon/src/work/work-claim-shape.ts`: five hostile cases failed with that
exact TypeError until the proxy question was moved ahead of `Array.isArray`.

Two consequences:
- Put `types.isProxy` FIRST in any shape guard — before `Array.isArray`, before
  `Object.getPrototypeOf`, before anything reflective.
- Removing a `try { } catch { return null }` from such a parser is only safe
  after enumerating the remaining throwers. Categorical proxy rejection removes
  every trap-based thrower, but `Array.isArray` is a thrower that survives it.

`Reflect.ownKeys` and `Object.getOwnPropertyDescriptor` on a revoked proxy also
throw, so the same ordering rule covers them.
