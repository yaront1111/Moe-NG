# QA verdict: task-4a3b5ec0 (launch lock / drain / restart) — APPROVED at reopen 1

Reviewed by qa-cbad3a29 2026-08-09T00:0xZ. Reopen scope was exactly two detached test
assertions; both are now load-bearing and I re-proved each with the mutant that used to survive.

## Reopen fixes verified (owned bytes: `git diff 34a3d11^ 34a3d11 -- launch-lock.test.ts restart-reconstruction.test.ts`)

1. `launch-lock.test.ts:184-235` — the six SUSPECT rows gained a literal expected-layer column
   (`"LAUNCH_LOCK"` on every row) and the body is now `expect(codeAndLayer(outcome)).toEqual({ code, layer })`.
   `codeAndLayer` returns exactly `{code, layer}` (:63-66), so `toEqual` pins both fields with no
   extra-key slack. The KERNEL arm stays a separate test at :237-241 pinning
   `EFFECT_CLAIM_MALFORMED / KERNEL`. The OR disjunction is gone.
   **MUTANT A re-run (the one that survived last round):** `duplicate-delivery.ts:123`
   `"LAUNCH_LOCK"` -> `"KERNEL"` = **KILLED**, 2 FAIL in launch-lock.test.ts
   (`AssertionError: expected { code: 'LAUNCH_LOCK_SUSPECT', …(1) } to deeply equal …`).
   Bonus: child 4's `supervisor-races.test.ts` kind-set sweep caught it too (3 more FAILs).
2. `restart-reconstruction.test.ts:250` — now `expect(labelOf(outcome)).toBe("post:UNKNOWN")`,
   the exact production answer at `restart-reconstruction.ts:131-133`.
   **MUTANT B:** line 132 `reconstructed("UNKNOWN")` -> `reconstructed("SUSPECT")` = **KILLED**,
   1 FAIL, `expected 'post:SUSPECT' to be 'post:UNKNOWN'`.

Both production files restored byte-identical after each drill:
`git hash-object` == `git rev-parse HEAD:<path>` (dd 5a145bc4, rr fd77aab2).

## Gate

`pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test` from repo root,
foreground, exit 0 — **20 files / 717 tests**, run before and after the drills. No flake seen.

## Rails at approval time

- Owned worktree diff EMPTY, staged index EMPTY. `git diff --stat 7528e00 HEAD -- supervisor/`
  shows ZERO drift in this task's production files since the prior QA baseline; only the two
  owned test files changed (+32/-12 and 1 line) plus child 4's additive `race-*.ts`.
- Per-file caps: launch-lock 138, duplicate-delivery 153, process-observation 88, drain-table 210,
  drain-reconciliation 227, restart-reconstruction 188; extended child-1 files kernel 266 /
  lifecycle 262. All under 400.
- Fence grep `child_process|spawn|kill(|Date.now|Math.random` over the six production modules: ZERO.
- Everything the prior verdict listed as clean (DoD 1/3/4, design fidelity vs the design FILE,
  append-only vocabulary, redaction sweep, 13-code reachability) was left alone by this reopen and
  is unchanged at HEAD — deliberately not re-derived.

## Attribution note, NOT a defect of this task

The two fixes were swept into foreign completion commit `34a3d11` by the runtime hook, so no owned
commit exists for them. Bytes are attributable with the path-limited parent diff above. See
`mem:gotcha-completion-hook-commits-whole-tree`; governors notified (msg-bbf4698b). Do not revert.

Related: `mem:gotcha-or-ed-layer-assertion-pins-neither-layer`,
`mem:task-task-4a3b5ec031f14079bce4141abf922905-handoff`.
