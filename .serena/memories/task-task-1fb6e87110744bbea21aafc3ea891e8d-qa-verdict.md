# QA verdict: APPROVED — crash-safe backup generation publish (audit register item 1/11)

Reviewed 2026-08-15 by qa-50f0d628 at HEAD `de936fe`. Worker handoff:
`mem:task-task-1fb6e87110744bbea21aafc3ea891e8d-handoff`.

## Gate I re-ran myself

`(pnpm --filter @moe/store typecheck && pnpm --filter @moe/store test)` EXIT=0,
42 files / 502 tests. `&&`-chained so no leg is masked
(`mem:semicolon-chained-gate-run-masks-a-red-suite`). `git status --porcelain -- packages/store/`
empty, so committed bytes == gated bytes.

## The four drills, and what each one actually proved

Base sha256 `57cc6c9b…` (publish.ts) / `d54a023c…` (backup-generation.ts), re-checked
with `sha256sum -c` after every restore.

1. **Reproduce the original defect.** `if (hadPrevious) await rename(finalPath, asidePath)`
   → `rm(finalPath, {force,recursive})`. 1 red, on the DISK-STATE assertion:
   `no manifest at …\generation\manifest.json`. The window the task exists to close.
2. **Recovery disabled** (`resolveInterruptedPublish` call replaced by `null`). 2 red.
   The third recovery test survived — see below.
3. **`generationIsComplete` inventory check skipped** (`return true` before the
   `database.sqlite` / declared-object existence loop). 2 red, INCLUDING
   "refuses when the published path is occupied by a half-populated generation".
4. **Catch-block aside restore removed.** 1 red, same disk-state assertion. Pins DoD 3.

### Why drill 2 leaving one test green is NOT a defect

Drill 2 left "half-populated generation" green — with recovery off, a leftover
`.previous` makes `rename(finalPath, asidePath)` fail on Windows anyway, so the test
detects a COLLISION rather than the completeness check. The worker disclosed exactly
this in the step-3 note. Drill 3 is the drill that settles it: skipping the inventory
check reddens that same test, so the assertion IS bound to completeness. Two drills
were needed because the two failure modes converge on one refusal.
Generalizes: `mem:qa-surviving-mutant-behind-stronger-downstream-guard`.

## DoD 4 verified structurally, not just by the pin

`git diff e6597e4..HEAD --stat -- packages/store/src/backup-generation-manifest.ts` is
EMPTY. `computeGenerationDigest` lives there and is untouched, so identical input bytes
produce a byte-identical digest by construction. The `DIGEST_FIXTURE` pin
(`ee01db28…`) locks it forward, and a sibling test pins the produced manifest's key set
against `MANIFEST_FIELDS` so a field added outside the canonical projection cannot
change the contract while leaving the digest still. Fixture, not a captured SQLite
image: `mem:gotcha-digest-pin-needs-a-fixture-not-a-captured-image`.

## Accepted honest limit — do not re-litigate

Rename-aside is not atomic; `finalPath` itself is briefly absent between the two
renames. The architect pre-ruled this in `planningNotes.approachesConsidered`:
continuously-present `finalPath` is the pointer-indirection design, REJECTED here
because it changes the `generationPath: finalPath` published contract, and routed as a
separate task. I graded against the written plan, not against my own preferred design
(`mem:qa-grade-against-the-written-requirement-not-your-own-suggestion`).

Also disclosed and accepted: two concurrent publishes to one destination share
`${dest}.staging` — pre-existing, unchanged, needs a destination lock.

## Caps and scope

`grep -c ''` (never PowerShell `Measure-Object -Line`,
`mem:powershell-measure-object-line-undercounts`): backup-generation.ts 213,
backup-generation-publish.ts 120. Both under 250. `.js` bridge present and committed
(`mem:new-ts-module-needs-a-js-bridge-invisible-to-tsc-and-vitest`). Four owned paths,
no scratch files. The `recovery-anchor-*` churn in the same base-ref range belongs to
register item 2, not this task.
