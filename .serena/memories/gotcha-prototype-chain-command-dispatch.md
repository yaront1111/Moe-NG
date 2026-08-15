# A bare index into a command map dispatches inherited members

FOUND 2026-08-09 by adversarial review in `apps/daemon/src/work/work-lifecycle.ts`
(task-ba3a45f9). No test caught it; the fix is one call.

A command table written as a plain object literal — even `Object.freeze`d —
still has `Object.prototype` on its chain:

```ts
const LIFECYCLE_COMMANDS = Object.freeze({ renew: {...}, release: {...} });
const spec = LIFECYCLE_COMMANDS[command];   // BUG
if (spec === undefined) return refuse();    // never fires for "constructor"
```

`LIFECYCLE_COMMANDS["constructor"]` returns `Object`, which is not `undefined`,
so the refusal guard is skipped and the inherited member is dispatched as a real
command. Downstream `spec.authority` is `undefined`, so the handler returned
**`ok: true` with `authority: undefined`** — authority granted for a command that
does not exist.

Reachable names on any plain object: `constructor`, `toString`, `valueOf`,
`hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`,
`__proto__`.

## Fix

```ts
const spec = Object.hasOwn(LIFECYCLE_COMMANDS, command)
  ? LIFECYCLE_COMMANDS[command] : undefined;
```

Alternatives: `Object.create(null)` for the table, a `Map`, or validating
`command` against a frozen array with `.includes()` FIRST. The ingress boundary
in the same task was already safe precisely because it used
`WORK_COMMANDS.includes(value)` — an array membership test has no prototype
exposure. The bug appeared only where a lookup replaced a membership check.

## Why no test caught it

Every test passed a plausible command name. Nobody writes
`applyWorkLifecycle("constructor", …)` from the happy-path mindset — it is
adversarial-review territory, not TDD territory. When testing a dispatcher,
add a case per inherited member and assert each is genuinely reachable
(`name in {}`) so the table cannot silently test nothing.

Reverting the `Object.hasOwn` guard kills 7 tests, so the guard is pinned.

Related: `mem:gotcha-prototype-chain-key-lookup`,
`mem:gotcha-vacuous-set-membership-clears-everyone`.
