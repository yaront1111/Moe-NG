# A refusal test pins code AND layer only if EACH mutation reddens it ALONE

Epic rail 6 demands a failure-path test assert the stable reason code *and* the refusing layer. The
cheap check — mutate the refusal and watch the test go red — CANNOT distinguish these three states:

1. both halves asserted (compliant);
2. only the code asserted, layer unasserted;
3. only the layer asserted, code unasserted.

Any single mutation that changes both fields reddens the test in all three cases. So does a
mutation that changes one field when the *other* is the asserted one, because the test is red either
way once you look at a whole-refusal swap.

## The drill that actually settles it
Run TWO mutations at the SAME refusal site, each touching exactly one field:
- LAYER ONLY: `refuseX(CODE, "RING", ...)` -> `refuseX(CODE, "RESOURCE", ...)`
- CODE ONLY: `refuseX(CODE_A, "RING", ...)` -> `refuseX(CODE_B, "RING", ...)`

Both must redden, and each must redden ALONE. If only one of the two reddens, the other half is
unasserted and the test is one refactor from being vacuous.

Verified on task-10cab3e5 (packages/scheduler/src/fairness): each drill produced exactly
`1 failed | 236 passed` on the same test name, which is the compliant signature.

## Harness notes that cost me a cycle
- Anchor the replacement on the EXACT source text including indentation and line breaks; abort when
  `src.count(anchor) != 1`. My first attempt used 6-space indent against a 4-space source and
  reported `anchor count = 0` — a silent no-op that would have read as "drill passed" had I not
  printed the abort.
- On Windows, `subprocess.run(..., text=True)` decodes vitest output as cp1252 and CRASHES on the
  `×` failure marker and on RTL-override characters in hostile-identifier fixtures. Pass
  `errors="replace"`. The crash left a mutation ON DISK; restore with `git checkout --` before
  anything else, then re-verify with `git hash-object`.
- Restore by rewriting the ORIGINAL string you read, then compare `git hash-object` to the
  pre-drill hash. See `mem:mutation-drills-in-shared-worktree` — a foreign whole-tree hook can
  commit a drill edit while `git status` looks clean.

Related: `mem:refusal-test-answered-by-earlier-guard`,
`mem:qa-generated-table-cannot-police-its-own-generator`.
