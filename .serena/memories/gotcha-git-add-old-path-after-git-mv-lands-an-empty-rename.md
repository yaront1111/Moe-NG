# `git add <old-path>` after `git mv` fails, and the commit still lands — as a 0-insertion rename

## The trap

After `git mv a/f.tsx b/f.tsx` you edit `b/f.tsx` (fix relative imports, etc.).
To commit "by explicit pathspec" you naturally name both ends:

```bash
git add a/f.tsx b/f.tsx     # fatal: pathspec 'a/f.tsx' did not match any files
git commit -F - <<'EOF'     # ...but this STILL RUNS
```

`git mv` already staged the rename and **deleted the old path**, so naming it is
a fatal pathspec error. `git add` then adds **nothing at all** — not even the
valid path in the same argument list. If the commit is on its own line (or after
`;` rather than `&&`), it commits the pre-existing staged state:

```
1 file changed, 0 insertions(+), 0 deletions(-)
rename a/f.tsx => b/f.tsx (100%)
```

**100% similarity / 0 insertions is the tell.** The rename landed; every content
edit stayed in the working tree.

## Why the suite does not catch it

Vitest/tsc read the **working tree**, which has the fix. The gate is green while
the committed bytes import `./ui-wide-core-fixtures.js` from a directory where
that file does not exist. Green suite, broken commit, and QA reviewing the diff
sees a rename with no content change and may read that as "pure move, fine".

Real instance 2026-08-09, task-fdf3e6aa: commit `5e61428` landed the moved
parity sweep with its three pre-move import specifiers; `089ebbf` repaired it.

## Rules

1. After `git mv`, stage **only the destination**: `git add b/f.tsx`.
2. Chain with `&&` so a failed `add` cannot reach the `commit`.
3. **Verify committed bytes, never the working tree**, before claiming the gate
   covered them:
   ```bash
   git show HEAD:b/f.tsx | grep -n 'the/thing/you/changed'
   git status --porcelain <owned paths>   # must be EMPTY, else the gate ran
                                          # different bytes than you committed
   ```
4. Re-run the gate with a clean tree for those paths, so "the suite passed" and
   "the commit is correct" are the same statement.

Cf. `mem:convention-commit-by-pathspec-in-a-shared-index`,
`mem:gotcha-qa-must-diff-the-workers-commit-not-head`.
