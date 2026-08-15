# Handoff: task-cda6bddf (Same-bug circuit breaker) — DONE, commit d050258

Landed `packages/scheduler/src/convergence/` (breaker-contract 158, breaker 229,
failure-fingerprint 101, breaker.test 381) + three `.js` bridges, and
`@moe/context` in `packages/scheduler/package.json`. 38/38 focused tests green.

## The feature in one line
Fingerprint the TYPED fields only (`failureCode`, `primaryScope`, `recipeDigest`,
`baseDigest`, `environmentDigest`). Excluding `text`/`id`/`actorId`/`occurredAt`
IS the feature. Holds keyed BY FINGERPRINT, so unrelated work stays schedulable
by construction.

## Three real bugs adversarial review caught — all were mine, all shipped fixed

1. **Unlock by junk (the serious one).** `evaluateRetryUnlock` decides movement by
   digesting both sides, so an unparseable candidate digests to something that
   merely DIFFERS and reads as movement — `{}` released any hold. Anything
   delegating to a digest-comparison unlock needs a shape gate FIRST. See
   `mem:gotcha-digest-comparison-unlock-reads-junk-as-movement`.
2. **Hold captured the caller's predicate object** by reference; a caller could
   mutate what the hold waits on after the fact. Store `Object.freeze({...p})`.
3. **`id`/`retryPredicate` unvalidated.** The fingerprint function vouches only for
   the 5 fields it hashes; everything else read into hold state must be validated
   separately, not trusted from the declared TS type.

## Two vacuous tests found by drilling, not by reading

- The per-field counterexample table is DERIVED from `FINGERPRINT_FIELDS`, so
  dropping a field just stopped generating its case: 31→30 tests, **zero
  failures**. Fixed by a hand-transcribed `EXPECTED_FINGERPRINT_FIELDS` asserted
  set-equal to the production tuple. A derived table needs an independent pin.
- The collision fixture passed with framing removed **entirely**, because the
  canonical form interleaves each field NAME between values and the name was
  doing the separating. Fixture must absorb the separator too:
  `("x","recipeDigesty")` vs `("xrecipeDigest","y")`.

Drill restores were verified by **sha256sum, not `git diff`** — the files were
untracked, so git diff would have reported empty over a fully mutated tree.

## Cross-module refusal shape used here
Own frozen codes (`CONVERGENCE_BREAKER_CODES`) + the upstream refusal nested
**verbatim** in `refusedBy`, typed `Extract<RetryUnlockResult, {kind:"REFUSED"}>`
so it is bound to `@moe/context`'s type rather than restated. Keeps the
`RETRY_PREDICATE` layer visible. Matches `mem:decision-cross-module-refusal-passthrough`.

## Gate state a reviewer must not misread
`pnpm --filter @moe/scheduler test` exits **1** on a pre-existing FOREIGN failure —
see `mem:gotcha-scheduler-boundary-scanner-trips-on-shebang`. Baseline 674 pass /
1 fail → HEAD 712 pass / 1 fail, same failure. `pnpm typecheck` is also red on
`apps/daemon` (another worker's untracked `recovery-succession.ts` vs `index.ts`
exports). Neither is in this task's owned paths.

`pnpm-lock.yaml` deliberately NOT committed: a concurrent agent's `pnpm install`
picked up my manifest entry, but the file also carries an unrelated
`packages/coordination` deletion. Deps here are materialized as per-package
junctions — see `mem:gotcha-coordination-workspace-links-without-lockfile`.

## Not done, on purpose
No root export (`index-surface.test.ts` hand-transcribes that namespace; publication
belongs with the consumer, `task-351e09bd`). `entryIds` has no cap — bounded
truncation needs a reviewed policy and a way to signal it happened.
