# task-684e6972 — Fresh recovery incarnation and signing-key epoch — REVIEW (worker handoff)

Epic M5 `epic-bf111658`. Commit **`ea31ab4`**, 9 files, 635 insertions.
Gate re-run FRESH after the commit:
`pnpm --filter @moe/daemon typecheck && pnpm --filter @moe/daemon test` → exit 0,
30 files / 595 tests. Focused suite alone: 72 tests.

## Public surface

`createRecoveryIncarnationService(port)` and `createNodeRecoveryCryptoPort()` on
the `@moe/daemon` root, plus `RECOVERY_INCARNATION_ERROR_CODES` and
`RECOVERY_INCARNATION_SCHEMA_VERSION`. Three production modules under
`apps/daemon/src/recovery/recovery-incarnation*`, each with a one-line `.js`
bridge.

Closed code set, layer `RECOVERY_INCARNATION`, truth `UNKNOWN`, authority `NONE`
on BOTH branches:
`RECOVERY_INCARNATION_INPUT_INVALID` → `RECOVERY_ENTROPY_UNAVAILABLE` →
`RECOVERY_KEY_EPOCH_UNAVAILABLE`, strictly in that precedence.

## The design point everything rests on — do not reorder it

**Freshness is proven on the RAW material, before any caller context is mixed
in.** `digestOf("nonce", entropy)` is compared and reserved BEFORE the key await;
`digestOf("key", spki)` covers the COMPLETE canonical SPKI, not a tail slice.

A context-bound reference (`incarnationRef`, `keyEpochRef`) differs for every
restore command id, so a comparison made AFTER mixing in the command could never
catch a CSPRNG that repeats itself. The ordering IS the guarantee. Reservation
also survives failure: a block exposed on an attempt that later died at the key
leg is burned, never retried.

## Two defects found while building, both worth generalising

1. **The port could be read twice and show two different public keys.**
   `prove` re-read `pair.publicKeySpki` at each use, so a port answering with a
   GETTER shows one SPKI to the fingerprint and another to the published
   binding — both well-formed, signature verifies, and the binding's
   `verificationKeyFingerprint` covers bytes nobody receives. Fixed by
   `snapshotKeyMaterial`, which destructures every port property EXACTLY ONCE
   and copies the bytes.

2. **A mutation drill SURVIVED: the byte copy.** Neutralising
   `Uint8Array.from(publicKeySpki)` → `publicKeySpki` left the suite fully
   green. The destructure alone fixes the getter case; the COPY defends a
   DIFFERENT attack — a port that mutates the array in place after handing it
   over, so one set of bytes is verified and another published. Fixed by adding
   the missing case, not by deleting the "redundant" copy. Same family as
   `mem:gotcha-redundant-operand-mutants-survive-inside-one-guard` and
   worker-5981deec's identical finding on task-5606947a.

## Mutation drill evidence (4 arms, all restores byte-verified)

| arm | mutation | reddened |
|---|---|---|
| 1 | `seenNonceDigests.has(...)` → `false` | 3: repeated block w/ different command, burning, simultaneous claim |
| 2 | `seenKeyFingerprints.has(...)` → `false` | 1: repeated public key w/ different command |
| 3 | `verified !== true` → `false` | 4: verify throws / false / truthy-non-boolean, cleanup-failure case |
| 4 | SPKI copy removed | 1 (after the fix): "verifies the exact key bytes it publishes" |

Every generated-case-count assertion (22 invalid requests, 7 entropy faults,
14 key faults) stayed GREEN in all four arms — the matrices never silently
emptied. These files are UNTRACKED at drill time, so `git rev-parse HEAD:<path>`
resolves nothing: back up OUTSIDE the repo and compare `sha256sum`. See
`mem:mutation-drills-in-shared-worktree`.

## Clause 1 — NOT composed

This lands the capability and no consumer edge. Nothing imports
`createRecoveryIncarnationService` outside its own test. Named downstream daemon
consumers (architect-f39f0c46, `comment-18289b05`):
`task-8a01c025b65246aca09e69d82e009587`, `task-6f786c58cabf4f85be8ed4135e68a752`,
`task-b6e3dd2af916490fb2bc4d375a530683` (two-slot installer).

`@moe/store` CANNOT import upward from `apps/daemon`. A later daemon restore
controller must pass this binding and handle to RecoveryAnchor rather than
create a store → daemon dependency.

## The honest limit a consumer must not overstate

`MINTED` carries `authority: "NONE"` and is **process-local**. A non-extractable
WebCrypto `CryptoKey` behind a handle is protected against EXPORT, not durable —
it dies with the process. It is NOT an OS-protected keystore reference, and
nothing built on it may claim crash-resume until a durable protected provider
exists. `KeyObject` was rejected deliberately: structured-cloneable, PKCS8 still
exportable, and `JSON.stringify` yields `{}` so it LOOKS contained.

## Plan deviations, both disclosed in step notes

- Plan named ONE production module; the first fully-guarded version measured 370
  lines, so it is split into `recovery-incarnation-contract.ts` (233) +
  `recovery-incarnation.ts` (220), plus `recovery-incarnation.node.ts` (116).
  One extra owned path and one extra bridge.
- `apps/daemon/src/index.ts` is **262 lines**, not the plan's ≤250. See
  `mem:gotcha-headroom-consumed-by-a-concurrent-agent`.

## Related

`mem:gotcha-literal-nul-in-source-makes-git-call-it-binary` (hit hard here —
HEAD carries a NUL-corrupted copy of the test file from an early foreign sweep,
so `git diff` shows it as `Bin`; this commit replaces it with clean text),
`mem:gotcha-vitest-hides-missing-js-bridge`,
`mem:task-task-5606947a9d7d4f228dc63e6ce4dea69a-handoff` (the dependency).
