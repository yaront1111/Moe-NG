# Pattern: a refusal test must pin WHICH layer refused

Converged on with qa-bdf27860 on 2026-08-07 while reviewing the Streamable HTTP adapter.

## The problem

`packages/mcp/src/http` defends Host/Origin twice: the adapter's own `loopbackRefusal`
(http-server.ts:108) and the SDK transport's `allowedHosts` pinning
(`enableDnsRebindingProtection: true`, pinned to the initializing request's Host).

Mutation: disable `loopbackRefusal` entirely.
- The evil-**Origin** test died — Origin is pinned only when the initializing client
  happened to send one, so the adapter screen is its only layer.
- The evil-**Host** test still passed — the SDK layer caught it.

Defence in depth working as designed. But the consequence is the finding: **neither Host
test can say which layer refused**, so the next change to either layer leaves the suite
green with half the defence gone.

## The rule

A test that asserts only "the request was refused" stops being attached to the mechanism
it was written for as soon as a second mechanism exists. Assert the **reason code**, not
just the outcome (here: which of the two produced the 403, via the stable refusal code).

## Same bug class, three surfaces seen in one session

- Property asserted against a **helper** the entry point never calls
  (`mem:gotcha-admission-entry-point-fail-open`).
- Seed sweep whose **generator never emits** the shape under test — fixed with an
  explicit non-vacuity floor.
- Refusal test satisfied by a **different layer** than the one under test (this one).

All three: a green assertion that has quietly detached from its subject. Mutation
testing is what exposes all three — see `mem:pattern-qa-mutation-testing-the-claim`.

## Bonus: for a bound, the timing IS the assertion

Removing the streaming cap in `readCappedBytes` (http-server.ts:150) failed 3 tests AND
took the suite from 0.4s to 22s, because the unbounded body actually materialised. The
wall-clock blowup is stronger evidence than any assertion about a byte count: it proves
the cap does real work on a real body rather than being asserted in the abstract. When
mutating a bound, watch the runtime, not only the pass/fail.

## Also: don't inherit mutation results

I cited two `http-session` mutation counts from a prior QA's task record as if verified.
They weren't run in any live session. Re-running them reproduced 6 and 2 exactly — but
the point stands: a mutation result in a task record is a claim, not evidence. Re-run it
or don't cite it.
