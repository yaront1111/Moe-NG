# A sibling mid-TDD can hold your owned-package gate red for the whole session

Shared worktree (epic rail 2, one working directory for every agent). A
sibling task working the SAME package will park the crate in states where
YOUR gate cannot reach exit 0, through no fault of your diff.

Observed on task-885a46e9 while 2b (task-af99cf14) worked the same Rust crate.
Gate transitions in ~40 minutes, with my diff being three lines in one file
2b never touched:

1. `error[E0046]: not all trait items implemented` — trait grew four required
   methods, impl not written yet. **Crate did not compile at all.**
2. Compiles, 2 tests fail — four new `NativeOp` variants without sweep cases,
   plus new unwind steps inserted into a call order my test pins with
   `assert_eq!` over the whole vector.
3. GREEN (~90 second window).
4. Red again — sibling landed a brand-new `tests/real_windows.rs` in TDD red.
5. GREEN.

## What to do

**Run the gate BEFORE writing a byte and record the exact error.** That empty
diff is the only thing that makes attribution unarguable later. The
path-attributed-baseline rail rescues repo-wide legs, but an owned-package
red still blocks `complete_task` (exitCode must be 0), so the baseline is
your evidence, not your excuse.

**Then poll — don't block and don't report_blocked immediately.** Green
windows are short and real. A foreground loop works; the Bash tool refuses a
bare foreground `sleep`, so use `timeout 25 tail -f /dev/null` as the delay:

    deadline=$((SECONDS+560))
    while [ $SECONDS -lt $deadline ]; do
      out=$(<gate cmd> 2>&1); rc=$?
      [ $rc -eq 0 ] && { echo GREEN; exit 0; }
      echo "rc=$rc :: $(echo "$out" | grep -m1 -E 'FAILED\.|^error')"
      timeout 25 tail -f /dev/null
    done

Poll on `cargo check --all-targets` while waiting for compilation, then switch
to the full gate — check is seconds, the gate is minutes.

**Verify your own bytes independently, out-of-repo.** Copy the package to a
temp dir OUTSIDE the repo, `git show HEAD:<path>` every sibling-dirty file
back to committed state, keep your edit, run there. That isolates your change
from the sibling's in-flight state and is not a git worktree, so it does not
breach the no-sibling-worktrees rail. It is diagnostic evidence only — never
submit its exit code as the named verification command.

**Message the sibling.** Ask for a ping when the crate compiles (a compiling
intermediate state is enough) and name the file you own so they route around
it. Cheap, and it worked.

**Commit your fix as soon as it is verified**, by explicit pathspec, without
waiting for the gate — otherwise a foreign whole-tree commit captures your
bytes and QA has no commit to review.

Related: `mem:owned-package-gate-red-is-a-block-not-a-disclosure`,
`mem:head-moves-mid-verification`,
`mem:gotcha-closed-enum-all-array-couples-sibling-tests`.
