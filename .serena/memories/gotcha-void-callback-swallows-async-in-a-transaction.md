# Gotcha: a `=> void` callback accepts `async` and silently commits behind it

Found in my own diff during adversarial self-review on task-bfc39542, before commit. Two
bugs, one theme: the seam looked correct and would have shipped broken.

## 1. TypeScript's void-return rule lets an async callback through

```ts
export type CommitApply = (context: CommitApplyContext) => void;
```
`async (ctx) => { ... }` returns `Promise<void>`, and TS deliberately allows ANY return type
where `void` is expected (so `arr.forEach(x => set.add(x))` compiles). So an async apply
typechecks, gets invoked, returns a pending promise nobody awaits, and the transaction
COMMITs and reports success while the caller's work has not run. No error anywhere — the
exact partial-write class the seam exists to prevent.

There is no type-level fix that keeps ergonomic callbacks. Guard at runtime:

```ts
function isThenable(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  return typeof (value as { then?: unknown }).then === "function";
}
```
Capture the return value, and if it is thenable throw the domain error so the transaction
rolls back. Applies to ANY synchronous callback seam inside a transaction, not just this one.

## 2. `String(error)` is not total — it can throw out of your catch block

```ts
catch (error) {
  throw new DomainError("CODE", error instanceof Error ? error.message : String(error));
}
```
`String(x)` THROWS a TypeError for a Symbol ("Cannot convert a Symbol value to a string") and
for a null-prototype object ("Cannot convert object to primitive value"). `throw Symbol()` is
legal JS. The TypeError then escapes the catch, bypasses your stable error code, and — in
@moe/store — gets renamed to STORE_UNAVAILABLE by `normalizeOperationalError`
(store-runtime.ts:282-291). The error formatter reintroduces exactly the trap the wrap exists
to close. Use a total describe helper with its own try/catch fallback.

Both were caught by reading my own diff hostilely, not by any test I had thought to write.
