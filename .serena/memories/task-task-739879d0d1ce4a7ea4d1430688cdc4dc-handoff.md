# Distribution manifest packaging — worker handoff

Task: task-739879d0d1ce4a7ea4d1430688cdc4dc (epic M4 Portability).
Merge-base `1ce0059`; delivered at `174c07b`. 11 files, +2234 insertions.

## Review this by base-ref diff, NOT by commit
```
git diff 1ce0059..HEAD -- package.json packages/contracts/src/distribution tools/packaging tests/integration/distribution
```
Commit `174c07b` holds only 4 of the 11 files. The other 7 (all of
`packages/contracts/src/distribution/**`) were swept into foreign commits
`588a0f6` (task-f5d1dae) and `0075790` (task-ab8c9489) mid-task. Not amended, not
reset. See `mem:moe-finished-task-may-have-no-commit`.

## What landed

Three contract modules under `packages/contracts/src/distribution/`:
- `distribution-contract.ts` (164) — closed vocabularies (5 component kinds incl.
  IDE_ADAPTER, 2 refusal layers, 34 reasons), all types, `distributionRefusal`,
  `normalizeLogicalPath`, canonical sorted-key JSON codec.
- `distribution-parser.ts` (248) — untrusted-input gate.
- `distribution-verifier.ts` (228) — pure set-admission kernel.

Two tooling modules under `tools/packaging/`:
- `distribution-build.ts` (197) — Ed25519 signing edge.
- `distribution-startup.ts` (116) — production startup choke point.

Root `package.json` gained `test:integration` and `typecheck:packaging`.

## Design decisions worth keeping

**The signature has no field.** `DistributionManifest` deliberately omits it; the
signature sits beside the manifest on the container. "Excluded from the bytes it
signs" is then structural, with no skip list to get wrong.

**Trust is never self-derived.** Every comparison is manifest-versus-supplied
`StartupDistributionExpectation`; nothing is compared component-to-component. An
entirely stale build is perfectly self-consistent, so agreement is not evidence.
See `mem:gotcha-self-derived-universe-cannot-check-itself`.

**Nothing launches until the whole set is admitted.** A per-component launch loop
would start a valid daemon beside a tampered control room.

**Ordering is load-bearing and pinned:** duplicate-component check BEFORE the
set-equality check (`[a,b,a]` has the right ID *set*); trusted-key check BEFORE
the signature port (asserted with a spy that must record zero calls).

**Existing authorities composed, not restated.** `createCompatGate` remains the
control room's authority; this gate only supplies the expected values that layer
deliberately does not hold. The integration suite proves the packaged manifest is
admitted by that real gate, with two negative controls.

## Gotchas hit, each with its own memory

- Plan named 1 contract module; honest impl was 345 lines vs the 250 rail. Split
  along a real seam. `mem:convention-contracts-250-line-splits`.
- `tools/**` is outside every tsconfig project — would have shipped untypechecked.
  Closed with a config-free `tsc --noEmit` chained into `test:integration`.
  `mem:gotcha-tests-dir-outside-every-gate`.
- No `node_modules/@moe` at repo root, so `tools/` must import the contracts and
  skills packages by RELATIVE path into their `.js` bridges.
  `mem:gotcha-bare-moe-specifier-unresolvable-from-repo-root`.
- The Write tool emitted two literal NUL bytes where spaces belonged inside a
  template literal. `file` reported the source as `data`, and Edit could not match.
  Now scanning every owned file byte-by-byte. `mem:gotcha-nul-byte-in-source`.
- **New, see `mem:gotcha-proto-key-write-path-is-silently-dropped`** — the real
  defect adversarial review found.

## Verification

`pnpm test:integration` exit 0 — typecheck leg clean, 36 tests.
Repo-wide at HEAD: typecheck exit 0; `pnpm test` 189 files / 3428 passed
(baseline 187 / 3317, delta exactly my 75 + 36); daemon 26 / 483 (the +3 is the
foreign REVIEW_HANDLERS publish, not mine). Failing-path delta EMPTY.

9 mutation drills, 8 killed their target, 1 (D8) survived and is reported as an
uninformative drill rather than a missing test — it mutated both the signing and
verifying side identically, so it isolated nothing. Restores verified by captured
sha256, never by `git status`, because the files were swept mid-task.

## Open / not in scope

- IDE_ADAPTER is a declared kind exercised only by a labelled contract fixture.
  Real consumer is task-9fd52b41f3ea4aad8c0c07bbe6fd3025; `adapters/` is absent.
- Shipped built-in skill bundles are 0. `.moe/skills/` is workspace state under a
  different schema (`moeGeneratedSha`), not product content. The suite asserts the
  literal 0 so a future built-in must turn it red before being registered.
- Release publication, key provisioning and secret persistence stay out of scope
  (task-9449ce65 owns the release gate; it shares `package.json` with this task).
