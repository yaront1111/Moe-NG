# Gotcha: a frozen refusal-code vocabulary silently detaches from what production emits

Found on `task-9011e3b32c414e9ca0d49f49fdfaaf08` (2026-08-09) during adversarial
self-review, in `apps/daemon/src/review/`.

## The defect

`submitRound` emitted `REVIEW_ESCALATION_REQUIRED`. The module's own frozen
`REVIEW_PREREQUISITE_REFUSAL_CODES` did not list it. **Every test was green.**

Why nothing caught it: each refusal case pins its OWN code (`expect(outcome.code)
.toBe("REVIEW_ESCALATION_REQUIRED")`), which passes whether or not the vocabulary
declares it. The gap lives BETWEEN the cases — no single case can see a code that
exists in production and in no vocabulary. The type system is no help either,
because the helper's parameter is `code: string`, which accepts anything.

This is epic rail 6's failure mode exactly: an assertion that quietly detached
from the thing it was written to pin.

## The fix that costs zero call sites: overload on the refusing layer

```ts
export function refuse(kind, code: ReviewDaemonRefusalCode,
  refusedBy: "DAEMON_INGRESS" | "DAEMON_PREREQUISITE"): ReviewRefused;
export function refuse(kind, code: string,
  refusedBy: "REVIEW_KERNEL" | "CORE_POLICY" | "DURABLE_STORE",
  kernelLayer?, error?): ReviewRefused;
export function refuse(kind, code: string, refusedBy: ReviewRefusedBy,
  kernelLayer = null, error = null): ReviewRefused { /* ... */ }
```

Daemon-layer calls resolve to overload 1, so an undeclared code is
`error TS2769: No overload matches this call`. Upstream layers keep the wide
`string` — `@moe/review`, `@moe/core` and the store own their own code sets and
restating them locally would be the second source of truth. **No call site
changed**; overload resolution does the work.

## The test that covers the other direction

A type guard stops an invented code. It does NOT stop a DEAD vocabulary entry
that no longer corresponds to any production path. Drive every code through the
production entry point and assert set equality against a HAND-WRITTEN list, both
directions, plus the case count:

```ts
expect(emitted.length).toBe(EXPECTED.length);   // a sweep of zero cannot pass
expect(new Set(emitted)).toEqual(new Set(EXPECTED));
expect(new Set([...INGRESS, ...PREREQUISITE])).toEqual(new Set(EXPECTED));
```

Deriving `EXPECTED` from the vocabularies would be vacuous — the same array on
both sides, and a thirteenth code appears on both and stays green.

## How to look for this elsewhere

Grep any surface with a frozen `*_CODES`/`*_KINDS` array for string literals
passed to a `code: string` parameter. `work/work-ingress.ts`,
`recovery/doctor-commands.ts` and `bootstrap-contracts.ts` all carry
domain-scoped vocabularies of this shape.

Related: `mem:task-task-9011e3b32c414e9ca0d49f49fdfaaf08-handoff`.
