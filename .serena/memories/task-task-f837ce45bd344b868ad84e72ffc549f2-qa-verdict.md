# QA verdict: task-f837ce45 Session coordination fabric — APPROVED

Reviewed 2026-08-09 by qa-cbad3a29. Worker commits `2428083` + `bee5159`, both exclusively
`packages/coordination/**`. QA restoration commit `a3c16f0` (see incident below).

## Evidence re-run by QA, not taken from the worker's summary

`pnpm --filter @moe/coordination typecheck && pnpm --filter @moe/coordination test`
-> exit 0, 2 test files, 40 tests. Run three times (initial, post-drill-damage, post-repair).

Per-file physical lines, all production `.ts` under the 250 target:
mailbox 247, service 238, codec 235, parts 195, contracts 192, mailbox-ids 163, shape 117,
mailbox-reads 111, ports 91, service-input 69, index 40.

Tracked files: 26 — 10 production `.ts` + 10 one-line `.js` bridges + `index.ts` + 2 test
files + 1 smoke worker `.mjs` + `package.json` + `tsconfig.json`. No scratch or evidence
files. `pnpm-lock.yaml` was not staged by the worker.

## Mutation drills — all 8 went RED (this is the part a green suite cannot tell you)

frozen-binding bypass, terminal-binding bypass, idempotency-conflict mapping, cursor-gap
detection, advisoryOnly pin, sender-owns-identity, forbidden-field scan, expired-send
refusal. Every one flipped at least one named test. Epic rail 6 satisfied on the production
surface, not on a test helper.

Failure tests assert the exact code AND the refusing layer; every sweep asserts a positive
generated count (`expect(generated).toBe(...)`, `expect(cases.length).toBeGreaterThan(0)`).
Store-error mapping is exercised against the real `DurableStoreError` class as well as a
hand-shaped stub, so the mapping cannot pass on a stub-only shape.

## DoD mapping

1. Authenticated / capability-scoped / versioned / bounded / addressed / correlated /
   durably sequenced — each endpoint digests its exact request bytes, requires an exact
   capability string derived through `coordinationCapability`, carries fixed envelope and
   endpoint versions, bounds every string/depth/page/TTL, resolves BOTH sender and recipient
   through the registry, and takes its sequence from `aggregateSequence`.
2. Dedupe + typed outcomes — DEDUPLICATED on identical resend, IDEMPOTENCY_CONFLICT on
   same-id/different-bytes, CURSOR_GAP, MAILBOX_FULL at N+1, EXPIRED surfaced as a
   sequence-bearing item rather than filtered, RECIPIENT_UNKNOWN, OUTCOME_UNKNOWN never
   claiming delivery, restart proven against a real file-backed SqliteEventStore.
3. Terminal binding + advisory — TERMINAL_BINDING_INVALID at ADDRESS; `advisoryOnly` is
   structurally `true`; the service object is frozen with exactly
   `acknowledge/read/replay/send`; CONTROL is a closed non-lifecycle vocabulary.
4. Focused gate exits 0.

## Nits recorded, deliberately NOT rejected

- `@moe/core` is a declared dependency that nothing imports. Plan step 1 mandated the
  dependency; the ports are structural by design.
- `DurableMailbox.lookup` swallows a store throw and returns null, so a RESPONSE whose
  REQUEST lookup hit a store failure refuses as `COORDINATION_REPLY_TARGET_MISSING` at
  CORRELATION rather than a STORE code. Fails closed and stays typed; the code is just less
  precise than it could be. Worth tightening if the lookup seam ever grows.

## Incident during review (repaired)

A QA mutation drill was mid-flight when the whole-tree completion hook fired for
`task-1e512b95`; commit `c42b578` captured the drill edit in `coordination-parts.ts`,
disabling the advisoryOnly pin at HEAD. `git status` reported clean because HEAD itself had
moved. Repaired in `a3c16f0` by pathspec checkout from `34a3d11` + pathspec commit;
`git diff --stat 34a3d11 HEAD -- packages/coordination` is blank. Full write-up in
`mem:gotcha-mutation-drill-swept-by-foreign-completion-hook`.

Related: `mem:task-task-f837ce45bd344b868ad84e72ffc549f2-handoff`,
`mem:gotcha-completion-hook-commits-whole-tree`.
