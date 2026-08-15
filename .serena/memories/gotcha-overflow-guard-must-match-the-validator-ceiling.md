# Guard accumulation at the VALIDATOR's ceiling, not at MAX_SAFE_INTEGER

In `@moe/scheduler`, `isCount` (`packages/scheduler/src/authority/authority-kernel.ts:150`) accepts a
counter only when `value <= MAX_AUTHORITY_COUNT`, which is `Number.MAX_SAFE_INTEGER - 1_000_000`
(`:77`). Every counter a module EMITS must survive a round trip through the validator that will read
it back.

So a guard written as `Number.isSafeInteger(sum)` leaves a **1,000,000-wide hole**: a sum above
`MAX_AUTHORITY_COUNT` but below `MAX_SAFE_INTEGER` passes the guard, is returned as state, and is
then REFUSED by the very contract that produced it. The record becomes unparseable and therefore
unfixable — the kernel comment at `:70-76` describes exactly this for leases ("bricking the lease so
it could never even be revoked").

```ts
export function safeAdd(left: number, right: number): number | null {
  const sum = left + right;
  return Number.isSafeInteger(sum) && sum <= MAX_AUTHORITY_COUNT ? sum : null;
}
```

## Find every accumulation site, not the obvious one
On task-10cab3e5 the plan named ONE site (deficit advance). There were three:
1. round advance — resource weight added to a queue head;
2. residual carry — a selected head's leftover credit added to its successor;
3. **summing a list of counters** — `readFairnessItems` admits up to `MAX_AUTHORITY_ITEMS` = 128
   records, each individually `isCount`-valid at ~9.0e15, so the SUM reaches ~1.15e18 and leaves the
   safe range while every element was legal.

(3) is the one that hides: each input passes its own validator, so nothing looks wrong until the
fold. Any `for (…) total += x` over a bounded list of validated counters is a site.

## Where a guard is legitimately absent
State the reason in the module instead of adding an untestable branch. In `fairness-aging.ts`,
`provenBypasses` is COUNTED from attestations, which `readFairnessItems` already bounds at 128, and
nothing accumulates across calls — so the ladder arithmetic cannot leave the safe range. A guard
there would be dead code with no drill that can redden it.
