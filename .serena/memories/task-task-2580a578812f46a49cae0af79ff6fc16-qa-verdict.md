# QA verdict: Effect intent lifecycle + one-use activation gate — APPROVED

Reviewed by `qa-cbad3a29` 2026-08-08 against commit `72545bb` (11 files, 2559 lines,
all under `packages/runner/src/supervisor/`). Worker handoff:
`mem:task-task-2580a578812f46a49cae0af79ff6fc16-handoff`.

## Evidence I produced myself (not taken from the worker's summary)

- Gate re-run fresh: `pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test`
  exit 0 — **10 test files, 388/388 tests**. Matches the worker's claim exactly. The known
  `scope-observation` 5s flake did not fire.
- `wc -l` (NOT PowerShell Measure-Object, `mem:gotcha-powershell-measure-line-undercounts-blank-lines`):
  max production file 257 (`effect-activation.ts`), then 253 / 250 / 238 / 165 / 148 / 113.
  All under the 400 hard cap. Test files 340 / 304 / 300.
- Forbidden-API grep over all 11 files (`child_process|spawn|kill|Date.now|Math.random|new Date|
  performance.now|Uint8Array|process.hrtime`): **one hit, a comment** in `effect-kernel.ts:165`
  explaining why bytes are never `Uint8Array`. Zero code hits.
- `git show --stat 72545bb`: 11 files, every one an owned supervisor path. No `package.json`,
  no probe/scratch files.

## Independent mutation drill (I re-ran three, did not trust the worker's nine)

Backed by `git checkout --` restore; baseline re-confirmed 388/388 and `git status` clean after.

| Mutation | Result |
|---|---|
| disable the `tombstoneWitness` leg in `effect-activation.ts` | **6 tests red** |
| delete the `ARMED -> activate` row from `ADMITTED_EFFECT_TRANSITIONS` | **2 tests red** |
| drop the `state === "CONSUMED"` check in `consumeActivationGrant` | **4 tests red** |

The middle one is the load-bearing check: it proves the 54-cell matrix's expectations are the
hand-written `DESIGN_ARCS` list and are NOT derived from the production table they check
(`mem:gotcha-self-derived-universe-cannot-check-itself`). The failure-path tests are genuinely
red-able — epic rail 6 satisfied by demonstration, not by assertion.

## DoD mapping

1. **Arcs + generated matrix** — 54 cells (9 states x 6 commands), count asserted `>0`, `==`
   product, `== 54`. Refusals assert code AND `detail.state` AND `detail.command`.
   `EFFECT_TERMINAL_ABSORBED` vs `EFFECT_TRANSITION_NOT_ADMITTED` discriminated per cell.
2. **Tombstone dominance both directions** — 3 dominated states TRANSITIONED to CANCELLED with
   `versionDelta 1`; 6 states (ACTIVE, CANCEL_REQUESTED, 4 terminals) refused
   `EFFECT_TOMBSTONE_DOES_NOT_DOMINATE` with `detail.state`.
3. **One-use grant + together-or-neither** — `GRANT_ALREADY_CONSUMED` / `GRANT_WRAPPER_MISMATCH`;
   10-leg table with `LEGS.length` asserted, each leg pinning code + layer + leg name; refusal
   shape asserted `Object.keys == ["kind","failure"]` so a refusal structurally cannot carry a
   successor; input `canonicalDigest` compared before/after per leg.
4. **Both interleavings** — cancel-first (CANCEL_REQUESTED, CANCELLED, tombstoned) refuses with
   `"commit" in outcome === false`; activate-first then `requestCancel` yields `MUST_DRAIN`,
   asserted as neither `ok` nor `failure`.
5. **Digest mismatch** — `PROVIDER_CAPABILITY_CHANGED` at leg `runtimeObservation`, digest-string
   comparison per the wrapper convention.

Plus a 30-code refusal sweep driven from real production surfaces asserting `observed.length ==
SUPERVISOR_ERROR_CODES.length` AND set equality, so an unreachable code fails the suite.

## Two things I noted and deliberately did NOT reject on

1. **`EFFECT_TOMBSTONE_DOES_NOT_DOMINATE` covers two causes** — wrong state, and a tombstone
   naming a different intent (`effect-lifecycle.ts:244` folds both into one `if`). Both are
   tested explicitly, and the code is honest about what it says, so it is a granularity nit and
   not a rail-6 violation. If child 2 needs to tell them apart, split it then.
2. **Commit `ab1c2bd` carries this task's message but foreign content** (`task-791d`'s store
   files + `.moe` state). That is the wrapper auto-commit, `mem:gotcha-moe-wrapper-autocommit` —
   not the worker. The worker's own pathspec commit `72545bb` is clean: 11 owned files.

## Real forward risk, flagged not rejected

`@moe/runner` has zero `.js` bridges package-wide and no build step —
see `mem:gotcha-runner-package-does-not-load-under-plain-node`. Pre-existing, not introduced
here. Child 3 must handle it before the daemon depends on `@moe/runner`.
