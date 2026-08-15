# When a task rail says "split the task" and the global rail says "don't"

Recurring conflict on this board. A task rail often reads: *"the production module must remain <=250
physical lines; split the task before implementation if the contract cannot fit."* The project-wide custom
rule says the opposite for the LOC case:

> Do not SPIDR-split a task because its total diff is projected over 400 lines. Split when the plan exceeds
> the step/file thresholds, when a single production FILE would exceed 400 lines, or when responsibilities
> are genuinely separable. A large task made of small focused files is compliant.

**Resolution: split the FILE, keep the task** — provided responsibilities are genuinely separable and the
package already has that seam. Splitting the task instead serializes a chain that is usually already serial
and hands the next architect the same problem.

Consequences for the plan:
- Owned paths grow beyond the list in the task description. **Say so explicitly in the final step**, with
  the reason and the precedent, or QA reads it as scope creep.
- Watch the daemon sizing thresholds: >10 distinct affectedFiles is a hard reject, >5 warns. Each new
  production module in this repo costs TWO files (`.ts` + its `.js` bridge).

Precedent seams that already exist and are safe to copy:
- `packages/contracts/src/distribution/`: `-contract.ts` (vocabulary + types + frozen refusal factory),
  `-parser.ts`, `-verifier.ts` — 164/248/235 lines.
- `packages/contracts/src/document-work/`: `-contract.ts` + `-codec.ts`.
- `packages/store/src/recovery-install-contracts.ts` + `recovery-install.ts`.

Related: `mem:moe-epic-rails-override-qa-loc-bar` (per-FILE cap only; task-level LOC is never a rejection
reason), `mem:core-js-bridge-requires-index-reachability`.
