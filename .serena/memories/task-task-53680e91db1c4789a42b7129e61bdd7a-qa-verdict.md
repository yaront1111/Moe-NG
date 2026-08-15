# QA verdict: APPROVED — runner supervisor root surface (commit 9bfaa3b)

qa-cbad3a29, 2026-08-09. `task-53680e91db1c4789a42b7129e61bdd7a`, blocker-fix 2 of 3 for
`task-ba3a45f9`. Worker: worker-964ae3f0. Worker handoff:
`mem:task-task-53680e91db1c4789a42b7129e61bdd7a-handoff`.

## What I re-ran rather than read

`pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test && pnpm --filter
@moe/daemon typecheck` — **exit 0, twice**, fresh from `D:/projexts/moe-next`.
`Test Files 22 passed (22) | Tests 799 passed (799)`.

## The check that actually decided it: I mutation-drilled the surface myself

Epic rail 6 says a failure-path test is verified by mutating the **production** surface. Two
drills on `packages/runner/src/index.ts`, restored after each:

| Mutation | Result |
|---|---|
| comment out `withLeg,` | 3 red, **named**: `publishes withLeg on the package root as a function`, `expected [Array(65)] to deeply equal [Array(66)] - "withLeg"`, plus a real call site |
| add `isRef,` to the shape block | 1 red: set equality `+ "isRef"` |

Both directions bite, so the 66-entry list is genuinely hand-written and not self-derived.

**The subtler pass:** the red run reported **`78 passed/failed` — cases were still COLLECTED**,
not `(0 test)`. That is the discriminator from
`mem:gotcha-fixture-derived-from-export-under-test-hides-every-assertion`: a module-scope
fixture that dereferences the subject aborts collection and collapses the diagnostic to one
`TypeError`. Here `const surface = runner` (line 68) is a bare alias with no `.map`/`.length`/
index, and every record fixture is a hand-written literal. Clean.

Restored byte-identical: `git diff --exit-code 9bfaa3b -- packages/runner/src/index.ts`.

## DoD, item by item

1. **40 values + 32 types.** I cross-checked every published name against
   `grep -E '^export (const|function|class)|^export \{'` on all seven modules: kernel 14/14,
   parse 9/9, lifecycle 3/3, grant 6/6, activation 1, lease-mirror 1, shape 6 of 18.
   No duplicate export: `effect-activation.ts:36` re-exports the same five grant symbols, and
   `index.ts` sources them from `effect-grant.js` **only**.
2. **Root specifier only.** `@moe/runner` at lines 16 and 25; no relative or deep path in the
   file. `packages/runner/package.json` is `{".": "./src/index.ts"}`, exclusive.
3. **Set equality both directions** (line 74) + cardinality guard `=== 66` (line 70). Drilled.
4. **`LifecycleOutcome` survives publication.** `REFUSED` keys asserted exactly
   `["failure","kind"]` (line 153); `MUST_DRAIN` keys `["drainRequired","intent","kind",
   "versionDelta"]` **plus** explicit `"ok" in outcome === false` (line 220). All three kinds
   obtained by CALLING the exported `applyEffectCommand`, never constructed as literals.
5. **Zero behaviour change.** `git show --name-only` = exactly the two owned paths. 0 `.js`,
   0 `supervisor/`, 0 `package.json`. Fixture module unexported and its 16 names asserted absent.
6. Gate exit 0. `index.ts` **162** lines by `wc -l` (< 250 per-FILE cap; test 304 < 400).
   32 types are machine-checked as used — runner `tsconfig` includes `src/**/*.ts` and the base
   sets `noUnusedLocals`.

## Before/after: I derived it independently instead of trusting the note

Full suite 799 tests / 22 files, minus the new file alone (78 tests / 1 file) = **721 / 21**,
exactly the claimed pre-task count. Zero regressions, and the arithmetic closes without ever
checking out the parent commit in the shared worktree.

## Narrowing vs the approved plan — accepted, and why

`MIRRORED_LEASE_KEYS` / `MIRRORED_PROOF_KEYS` were on plan step 2 and were **withheld**. I
verified the reason on disk rather than accepting it: `effect-shape.ts:60` and `:74` are the
**only** arrays in the file without `Object.freeze`, and `parseMirroredLease` /
`parseMirroredProof` read them on every call — publishing one puts a live, mutable validation
table on the package surface. Freezing them would mean editing a supervisor module, banned by
task rail 1. See `mem:gotcha-publishing-an-unfrozen-array-is-a-tamper-vector`.
The test compensates with something strictly stronger than republishing the list:
`parseMirroredLease({...LEASE, extra: 1}) === null` pins the exact-own-key contract
**behaviourally**. Shape's ten generic guards also stay internal — no domain meaning, no
consumer, not named by DoD 1. A narrowing with a verified reason is not scope drift.

## Blemish recorded, not rejected

Step-6 and step-7 notes state `801 tests / 80 new cases`; committed reality is `799 / 78`. The
notes went stale when step 8 removed the two key-list exports (68 -> 66 `it.each` cases). The
DoD-5 relation holds on the committed artifact and I measured it myself, so rejecting would be
ping-pong over a stale intermediate number. Pattern:
`mem:gotcha-step-note-counts-go-stale-after-a-later-step`.

## Carry-forward for `task-ba3a45f9` (child 3, the consumer)

The daemon typecheck leg proves **no regression, NOT composability**: `apps/daemon/package.json`
still declares only contracts/core/scheduler/store, and no daemon `.ts` imports `@moe/runner`.
Adding that dependency is child 3's approved `package.json` ownership amendment. The scheduler
half is already on its root (`mem:task-task-8ee125d0f05f4966abfcc49db37bbbf5-handoff`).
`@moe/runner` remains unloadable under plain Node — the `.js` bridge sweep is `task-eb9ff081`,
which also has a declared file collision on `packages/runner/src/index.ts`; it must rebase onto
9bfaa3b's 92 added lines.

Unrelated: an untracked foreign `packages/review/` appeared mid-review (00:40, another agent).
Untouched, not in this commit.
