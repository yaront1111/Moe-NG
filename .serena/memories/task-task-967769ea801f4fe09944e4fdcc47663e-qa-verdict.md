# QA verdict: Lease presence core (task-967769ea) — APPROVED at c0b564e

Reviewer qa-813cd351, 2026-08-07. Commit `c0b564e feat(scheduler): add fenced lease authority
and presence kernel`, 21 files all under `packages/scheduler/src/authority/**`, +2535/-0, no
foreign path in the commit. Every gate re-run in the foreground from disk; nothing taken from
worker summaries.

## Gate evidence (mine, foreground)

| check | result |
| --- | --- |
| `pnpm --filter @moe/scheduler typecheck` (named command) | **exit 1, foreign-only** — 6 errors, ALL in `src/admission/admission-invariants.test.ts` |
| foreign attribution | `git ls-files packages/scheduler/src/admission` -> **0 files** (100% untracked, owner task-84e875f9); authority-path error count **0** |
| isolated typecheck (temp tsconfig, `exclude: src/admission/**`) | exit 0 |
| focused `vitest run packages/scheduler/src/authority`, twice | 6 files / **131 tests**, identical both runs |
| whole scheduler package suite | **25 of 26 files / 320 tests passed**; sole failure is the foreign admission RED |
| `git grep -nE "Date\.now\|Math\.random\|process\.\|@moe/\|require\("` in authority/ | zero production hits (only the invariants test naming them as assertions) |
| per-file sizes | production max **214** (lease-drain), test max **222** (lease-state.test) — every file <=250 |
| shims | 7 x one-line `export * from "./<mod>.ts";` |
| `index.ts` export | authority NOT exported (Branch-A precedent, 3rd instance) |
| scratch files | none; my `%TEMP%` tsconfig + tsbuildinfo deleted; `git status --porcelain -- src/authority` empty after review |

## Mutation testing — 4 mutants, 3 killed, 1 SURVIVED

Tree restored with `git checkout -- <path>` after each; porcelain verified empty every time.

| mutant | result |
| --- | --- |
| drop the `proof.leaseToken !== lease.leaseToken` check in `fenceAuthority` | **7 tests die** (DoD 1) |
| invert `strongerOf`: `delta > 0 ? left : right` -> `right : left` | **5 tests die** (drain monotonicity) |
| add `import { LEASE_STATES } from "./authority-kernel.js"` to `presence.ts` | **1 test dies** — DoD-2 static scan is genuinely live, not decorative |
| move `parseHandoff` from before the branch split to AFTER the `if (!settled)` DRAINING return | **SURVIVED, 131/131 green** — see residual (a) |

## DoD mapped to code, not prose

1. **Token+epoch on every mutation, stale has zero effect.** `fenceAuthority`
   (`lease-fencing.ts:97`) is the ONLY gate and all five commands route through it
   (`lease-state.ts:107,126,144,162`, `lease-drain.ts:199`). Design-749 order is explicit:
   token, epoch, hash, session, version, state; first failure decides the code, so no
   rejection reports two causes. Evidence: 5 mutations x 5 tampers = 25 tests each asserting
   the exact issue code, `record` deep-equal before/after, a security record with exact
   `expectedEpoch`/`observedEpoch`, and `JSON.stringify(result)` containing NEITHER token.
   8 malformed-shape cases assert `securityRecord === null` (design 749 scopes the security
   event to syntactically valid attempts). Successor-epoch revoke discriminates
   `AUTHORITY_SUPERSEDED_AUTHORITY` from `AUTHORITY_STALE_EPOCH`. Mutant 1 killed.
2. **Presence cannot touch a lease.** Proven by module graph, not behaviour:
   `presence.ts`'s import list is asserted EXACTLY `["../runtime-shape.js"]`; all 6 lease
   modules asserted to have zero `presence` specifier; a third test asserts the scanned
   production-file set equals the expected list so a NEW module cannot slip past the ban.
   Mutant 3 killed. `PresenceProjection` carries no epoch/version/token/lifecycle.
3. **Races end in one legal deterministic state.** `authority-races.test.ts`: 5 seeds x 240
   steps, 5-member pool built by ASSERTED-GOOD command sequences, 70/30 honest/tamper, 10-command
   alphabet incl. resource ops. Per step: caller record deep-equal unchanged, `versionDelta in
   {0,1}`, `epochDelta in {0,1}`, state change => versionDelta 1, epochDelta 1 => state REVOKED.
   Non-vacuity is an EXACT 18-entry outcome-set equality (not a >0 count), so a shrunken
   universe fails loudly. Bit-identical replay for seed 11; different for seed 12. Exactly-one-
   successor-epoch and no-caller-freeze are separately asserted. Mutant 2 killed.
4. **Focused gate.** Foreign-only red, attributed by `git ls-files`; owned surface typechecks
   at exit 0 and runs 131/131 twice.

## Residuals — recorded, not rejected

(a) **The surviving mutant.** `releaseWork` validates the handoff BEFORE composing any
    transition, which is what makes design-765 branch 3 correct. But the 5 invalid-handoff
    tests all run with `safeBoundaryObserved: true`, so the ORDER is unpinned: moving the
    check after the `if (!settled)` return makes an invalid handoff commit DRAINING and no
    test dies, violating the plan's explicit "NO DRAINING transition" promise. One case closes
    it: invalid handoff + `safeBoundaryObserved: false` must still refuse. See
    `mem:gotcha-check-order-unpinned-by-tests`.
(b) The DRAINING branch discards the parsed handoff and hardcodes `resumable: false`. The plan
    described a *tentative* handoff that a later stronger reason marks non-resumable; the landed
    shape stores no tentative handoff at all. Conservative and deterministic, but the resumable
    signal for a pause-drain is unavailable to the successor-claim task.
(c) `adapterFail` marks OTHER rows still in `PENDING_ACQUIRE` as `RELEASED`, not `QUARANTINED`
    (`lease-resource.ts:150-156`); only the reported row's `UNKNOWN` and non-fenceable ACTIVE
    rows quarantine. An unconfirmed external acquire may in fact be held by the adapter, so this
    asserts certainty the kernel lacks. Defensible because the effect intent is idempotent and
    reconciliation owns it — but state it, do not assume it.
(d) **LOC ruling.** +2535 / 21 files is 6.3x the 400-net-LOC QA batch bar. Not rejected:
    every file is <=250 (the human's PERMANENT per-file rule from `prop-2eaa632d`, which is
    the enforcement mechanism the human chose over the aggregate bar), the plan was approved at
    7 steps across four concerns, and a size-only reject on a landed commit leaves the worker an
    empty action space (`mem:gotcha-core-aggregate-loc-bar`). NOTE the exception granted for
    `bcdc2f6` was one-time and task-scoped — it does NOT cover this commit; this approval rests
    on the per-file rule plus the +1281/+1814 approval precedents. Architects should pre-split
    the remaining M1/M2 aggregates instead of relying on this reasoning again.
(e) The four local vocabulary clones (`LEASE_STATES`, `DRAIN_REASONS`, `TRUTH_CLASSES`,
    `SLOT_STATES`) are pinned only by hand-written literal comparisons in tests. Drift from the
    real registry would not be caught by any gate — same blind axis as
    `mem:gotcha-self-derived-universe-cannot-check-itself`. Unchanged from the approved plan.

Worker's own claims spot-checked and TRUE: three-state slot vocabulary, boot-id-does-not-make-
a-lease-due (`lease-state.ts:82`, with its own test), token present on accepted paths and absent
on every rejection, `releaseWork` NO_OP returning a same-version fresh record.

See `mem:task-task-967769ea801f4fe09944e4fdcc47663e-handoff`,
`mem:gotcha-authority-counter-ceiling`, `mem:gotcha-shared-tree-repo-gate`.
