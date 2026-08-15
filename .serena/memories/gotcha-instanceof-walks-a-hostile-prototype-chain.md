# Gotcha: `instanceof` is a reflection call a hostile value can throw from

`value instanceof Type` invokes `Type[Symbol.hasInstance]` and then walks `value`'s prototype
chain. A `Proxy` with a `getPrototypeOf` trap — or a plain object whose chain contains one —
makes the check THROW rather than return false.

Found twice in the Claude launcher while adversarially reviewing an otherwise-total decoder:

1. `signalValue instanceof AbortSignal` in the launch-option snapshot. A hostile
   `options.signal` rejected the PUBLIC promise, defeating the whole fail-closed contract.
2. `stream instanceof Readable` in the boundary adapter. Worse than a rejection: the throw
   escaped `adaptBoundaryOpen` AFTER `cancel`/`close` had already been captured, so the
   caller's catch collapsed an OWNED boundary to UNOWNED and the child process was never
   killed. Losing a validation is recoverable; losing a cleanup handle is a leak.

Fix pattern — reject proxies first, then contain the check:

```ts
export function isInstance<T>(value: unknown, type: { readonly prototype: T }): value is T {
  try { return value instanceof (type as Function); } catch { return false; }
}
// use: isSafeObject(v) && isInstance(v, Readable)
```

`{ readonly prototype: T }` is the parameter type that both narrows via the predicate AND
accepts `AbortSignal`, whose Node type declares no public constructor (so `NewableFunction`
and `abstract new (...) => T` both fail to typecheck).

REVIEW CUE: a module can be scrupulous about `readOwnDataProperty` / `exactRecord` and still
have `instanceof`, `in`, `Object.keys`, spread, or a template-literal interpolation as an
unguarded reflection call on the same untrusted value. Grep for those separately.

RELATED: the ordering rail — capture cleanup capabilities BEFORE any other validation, so a
throw anywhere later still leaves something that can kill the process.
