# task-44d4873e (Durable verification receipt dispatch) — QA APPROVED

Graded at commit `6e25dd8` (7 owned paths under `apps/daemon/src/evidence/`).
Production lines by `grep -c ''`: contracts 247, service 186, store 183 — all
under 250. Test file 1131 lines / 21 focused tests.

## Gates re-run by QA (foreground, each leg separate, count lines read)

- `pnpm --filter @moe/runner test` -> EXIT 0, `Test Files 66 passed`, `Tests 2216 passed | 1 skipped`
- `pnpm --filter @moe/daemon typecheck` -> EXIT 0
- `pnpm --filter @moe/daemon test` -> EXIT 0, `Test Files 103 passed`, `Tests 2122 passed`
- `pnpm typecheck` (repo) -> EXIT 0

All four ran while the evidence dir was byte-identical to `6e25dd8`
(`git status --porcelain -- apps/daemon/src/evidence/` empty at HEAD 8151ade).

## QA mutation drills — 4 red on the intended assertion, 1 honest equivalent

Snapshot to `/tmp/qa-drill-snap` first; `git checkout --` is unusable here because
HEAD moves under you (see the gotcha below).

- drop `sameBytes(again.bytes, event.payload)` in store.ts:97 -> "not the canonical bytes" RED
- replay returns `prior` unconditionally -> "materially different candidate" RED
- verdict pinned to `"PASSED"` -> line 814 RED, `Expected "FAILED" Received "PASSED"`
- pass `null` instead of `run.capture` on the wrapper-refusal path -> truncation case RED
- DELETE the ACTIVATED commit -> "never leaves a run with no activation" RED
- MOVE the ACTIVATED commit to after the run but before the `!run.ok` return -> GREEN.
  Honest equivalent mutant: durable state is identical on every path a test can
  build. The suite pins "no run without an activation", which is the direction the
  plan specified and the safe one. Catching true precedence needs a launcher that
  asserts the ACTIVATED row exists AT launch time — `mutatingLauncher` already has
  the hook if a later slice wants it.

## Composition facts worth reusing (worker-measured, QA-confirmed)

- The runner evidence seam is complete on the ROOT specifier; `packages/runner/src/index.ts`
  does `export * from "./surface/evidence-surface.js"`, so a root-barrel grep for
  `buildEvidenceReceipt` finds nothing while the bare import works. No deep import needed.
- The durable attempt record carries no runtime observation, only its digests, so
  this slice seals the runtime alongside the recipe in `RECIPE_SEALED`.
- `runVerifierProcess` keeps a MODULE-LEVEL run registry keyed by grantId — two
  cases sharing an effect intent share a grant and the second ADOPTS the first run.
  Every case derives its intent from its label.
- The wrapper only ever answers `ok` with disposition COMPLETED or FAILED; truncation
  interrupts and REFUSES. Daemon codes for "truncated"/"unverified execution" would
  be orphans. See `mem:gotcha-wrapper-refuses-before-a-daemon-truncation-code-can-fire`.
- Fixture chain for a PROVEN attempt: `readyStore` -> `runEffectActivateCommand` ->
  `readFoundationActivationHistory` -> `createFoundationLauncherAuthority` ->
  `readDurableFoundationObservation` -> **RESERVED via `commitFoundationPhase` at
  expectedVersion 0** -> `recordProvenFoundationAttempt`. Skipping RESERVED makes the
  settle write nothing and the record reads ABSENT.
- Focused run needs BOTH flags: `cd apps/daemon && pnpm exec vitest run --root .
  --config package.json src/evidence`.

## Two hardenings a PEER landed on top, mid-review — not DoD gaps

While QA was reviewing, task-2259196e's session edited these same files and added
what QA had independently flagged as the two soft spots:

1. `candidateRoot` joined the replay-conflict clause and the receipt body. As
   delivered, the conflict compared recipeSha256 + recordDigest + attemptAggregateId,
   and the conflict TEST co-varied recipe AND candidateRoot, so only the recipe
   clause answered. DoD 4 was still met — the candidate's durable identity is
   `expectedRecordDigest` — but a replay varying only the root was answered from
   the prior receipt with no run.
2. `FOUNDATION_VERIFICATION_RECEIPT_UNCOMMITTED` split out of `RECEIPT_AMBIGUOUS`.
   The delivered service used AMBIGUOUS (">1 row") for a RECEIPTED write that
   landed ZERO rows — fails closed, but the code names the opposite durable state,
   and that emit site had no test.

Neither was rejected: both are hardenings beyond the DoD as written, and a peer was
already mid-flight in the same files, so a reject would have been a shared-worktree
collision.

## Consumers

`task-8f9305b9bb5e4b8db327a55981b2ea0e` (Review-qualified goal closure), then the
Foundation canary `task-97554aa4293e40eab56c0b642e18513a`. Both hash the BYTES,
which is why the read model re-encodes and byte-compares rather than deep-comparing.
