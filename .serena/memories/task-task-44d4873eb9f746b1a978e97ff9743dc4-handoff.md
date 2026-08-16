# task-44d4873e (Durable verification receipt dispatch) — DONE handoff

Landed 2026-08-16 at commit `6e25dd8`. Seven owned paths under
`apps/daemon/src/evidence/`: `foundation-verification-{contracts,service,store}.ts`
each with a one-line LF `.js` bridge, plus `foundation-verification-service.test.ts`.
Lines by `grep -c ''`: contracts 247, service 186, store 183. 21 focused tests.

## Composition facts worth reusing (measured, not assumed)

- **The runner evidence seam is complete on the ROOT specifier.** `packages/runner/src/index.ts:164`
  does `export * from "./surface/evidence-surface.js"`, so a root-barrel grep for
  `buildEvidenceReceipt` finds nothing while the bare import works. No deep import
  is ever needed from apps/daemon. `canonicalDigest` is the one thing NOT published.
- **The durable attempt record carries no runtime observation**, only its digests
  (`quotedRuntimeDigest`, `freshRuntimeDigest`). The wrapper's launch gate demands a
  full PROVEN `ProviderRuntimeObservation`, so this slice seals it alongside the
  recipe in the `RECIPE_SEALED` event. See `mem:decision-foundation-verification-recipe-seals-the-runtime`.
- **No durable recipe store existed.** `buildVerificationRecipe`/`VerificationRecipe`
  had zero non-test references in apps/daemon and packages/store. Recipe sealing is
  therefore part of THIS slice (`sealRecipe`).
- **`runVerifierProcess` keeps a MODULE-LEVEL run registry keyed by grantId.** Two
  tests sharing an effect intent share a grant, and the second silently ADOPTS the
  first one's run. Every case derives its own intent from its label.
- **The wrapper's answer space is narrower than it looks**: `ok` only ever carries
  disposition COMPLETED (exit 0) or FAILED (nonzero), at `verifier-process-run.ts:194`.
  Truncation interrupts and REFUSES at `:107-111`. So a daemon code for "truncated"
  or "unverified execution" has no reachable producer.

## Fixture chain for a durable PROVEN attempt

`readyStore` -> `runEffectActivateCommand` -> `readFoundationActivationHistory` ->
`createFoundationLauncherAuthority` GRANT_CONSUMED / PREFLIGHT_REGISTERED /
PROCESS_OBSERVED -> `readDurableFoundationObservation` -> **RESERVED event via
`commitFoundationPhase` at expectedVersion 0** -> `recordProvenFoundationAttempt`.
Skipping the RESERVED step makes `settleFoundationAttempt` (which commits at
expectedVersion 1) silently write nothing and the record reads ABSENT — that cost a
cycle. Read the digest back with `readFoundationAttemptRecord`, never from the
writer's return value: the UNKNOWN ground's writer answers with a refusal.
An UNKNOWN ground comes from the same writer with a capture answer missing its keys.

## Gotchas that cost real time

- `pnpm --filter @moe/daemon test` runs `vitest run --root . --config package.json src`.
  A focused run needs BOTH flags: `cd apps/daemon && pnpm exec vitest run --root .
  --config package.json src/evidence`. With `--root .` alone the ROOT config's include
  (adapters/**, packages/**, tests/**) matches nothing and it exits "No test files found".
- The store VALIDATES the commit identity. Hardcoding `principalId`/`projectId` made
  every commit silently fail and ten cases failed identically. They are deps now.
- Passing `""` as projectId to `readFoundationActivationHistory` makes it fail, and
  folding that into a refusal code gives eight cases a plausible-but-wrong code. A
  test asserting only "refused" stays green through it.
- `MAX_VERIFIER_RUN_MS` is 15 minutes; a timeout case needs a `timeoutMs` dep override.

## Verification

`pnpm --filter @moe/runner test && pnpm --filter @moe/daemon typecheck && pnpm
--filter @moe/daemon test && pnpm typecheck` -> EXIT 0. Runner 66 files / 2216 passed
| 1 skipped. Daemon 103 files / 2122 passed (baseline was 102 / 2101; the delta is
exactly this slice). Repo typecheck clean. The path-attributed baseline was EMPTY
before and after — the foreign in-flight security-lane work lives under tests/security/**
which none of these four gates reaches, so no red here is ever excusable as a peer's.

## Consumers

`task-8f9305b9bb5e4b8db327a55981b2ea0e` (Review-qualified goal closure), then the
Foundation canary `task-97554aa4293e40eab56c0b642e18513a`. Both hash the BYTES, which
is why the read model re-encodes and byte-compares rather than deep-comparing.
