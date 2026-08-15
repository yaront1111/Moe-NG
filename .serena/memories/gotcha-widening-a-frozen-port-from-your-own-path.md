# Gotcha: widen a frozen port in YOUR path instead of blocking on its owner

Recurring shape on this board: your task needs one extra parameter on a port owned by
another task that has already landed and moved to REVIEW. Editing their file invalidates
their QA; blocking parks your whole task for a round trip.

Third option, usually correct: declare the WIDER interface in your own owned path.
TypeScript assignability makes it one-directional and safe.

## The rule that makes it work

A function with FEWER parameters is assignable to a type declaring MORE. A narrower return
type is assignable to a union that includes it. So:

```ts
// theirs (frozen, 1 arg, sync)
dispatchCommandBytes(bytes: Uint8Array): Uint8Array

// yours (owned path) — every existing implementation is still assignable
dispatchCommandBytes(bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> | Uint8Array
```

Their port, and any shared test fake built to their shape, drops straight into your wider
type. The reverse is NOT needed — do not try to pass your wide port where the narrow one is
expected.

PROVE IT, don't assume it: write a throwaway probe that returns the narrow method as the
wide signature, run `tsc`, then delete the probe and confirm `git status` is clean. That is
a ~2 minute check that turns a design argument into a compiler fact.

## What makes it honest rather than a fork

- It is a SUPERSET, not a divergence: nothing that satisfied the old shape stops satisfying
  the new one, so the shared conformance suite runs unmodified against both transports.
- Guard the duplication executably. When you also have to duplicate construction logic
  (because their module is frozen), add a test that pushes identical inputs through BOTH
  implementations and byte-compares what each port RECEIVED. Drift then fails a test instead
  of shipping. That comparison is stronger evidence than sharing a helper would have been.
- Say plainly in a task comment that you widened and why, and that a ~3-line change on both
  sides can unify later. Do not do it quietly.
- Do not claim behaviour you did not implement. Threading a signal an implementation ignores
  is fine; reporting a cancellation the daemon never performed is not.

## When to block anyway

If the missing surface cannot be expressed as a superset from your side — a changed return
SHAPE, a renamed method, a semantic change to an existing parameter — widening is a real
fork. Block then.

Applied on `task-6c732e0032534cc0abe9196ad467308f` (Streamable HTTP adapter) against the
stdio port from `task-c9a9bf3cb2a046a68ee99efa5b296f8c`.
