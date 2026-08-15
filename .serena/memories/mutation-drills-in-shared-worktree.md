# Mutation drills in the shared worktree — two ways the drill lies

Referenced by several plans as `mem:mutation-drills-in-shared-worktree`; the file did not exist
until 2026-08-09 (`task-e17da1c9`). Both failure modes below make a drill report a FALSE result,
and the second one was hit live.

## 1. `git checkout --` cannot restore a NEW file

If the files under drill are **untracked** (a greenfield directory, which is the common case for a
new task), `git checkout -- <path>` restores nothing and exits quietly. The mutation stays live
into the next drill, and every subsequent count is garbage.

Also, another agent's whole-tree commit hook can commit your drill edit mid-run, after which
`git status` reads clean while the edit is still on disk.

**Do this instead:** back up to a path **outside the repo**, restore with `cp`, and verify with
`cmp -s` (byte compare) rather than trusting `git status` or `git diff`.

```sh
bak=/tmp/moe-drill-$TASK/drill.bak
cp "$f" "$bak"
# ...mutate, run the suite...
cp "$bak" "$f"
cmp -s "$f" "$bak" && echo RESTORED_VERIFIED || echo RESTORE_FAILED
```

## 2. A mutation that NEVER APPLIED looks exactly like a surviving mutant

Hit live: `perl -i -pe "s|.*|$repl| if $. == 102"` where `$repl` contained `||`. The `||` collided
with the `s|||` delimiters, perl aborted with `syntax error at -e line 1, near "|| if"`, the file
was untouched, and the suite reported **975 passed**. Read as "mutant survived, the assertion has
detached" — it had not; the drill had simply not run.

**Do this instead:** echo the mutated line BEFORE the test run and the restored line after. A drill
that does not print what it changed cannot distinguish "survived" from "never applied". Use
`s{...}{...}` delimiters, or pass the replacement via `BEGIN{$r = "..."}` so its contents can never
collide with the delimiter.

```sh
perl -i -pe 'BEGIN{$r = "      false ||"} s{.*}{$r} if $. == 102' "$f"
echo "applied: $(sed -n '102p' "$f")"
```

Also treat a suspiciously round result — the mutant count exactly equal to the clean count — as
"prove the mutation applied" rather than as a finding.

## 3. Verify the RESTORE by re-running the gate that was RED, not by `git status`

Added 2026-08-09 by worker-2bc13005 on `task-5855a9c6`. The byte compare in §1
proves the file matches a snapshot **you** took; it does not prove the pre-drill
BEHAVIOUR is back — the backup itself could have been taken after a stray edit.

Full sequence:

1. Back up outside the repo; capture the sha BEFORE the edit.
2. Apply, run, record — printing the changed line (§2).
3. Restore from the BACKUP, never `git checkout`.
4. Verify bytes (`cmp -s` / `sha256sum`).
5. **Re-run the gate the drill made red and confirm it is red again.** That is
   the step that proves the edit is gone rather than committed-and-invisible.

## 4. A probe is an ENUMERATION tool, not only a verification one

Same task, and it generalises past drills. For a **required-field migration**,
applying the candidate edit and running a clean `typecheck` IS the complete list
of call sites needing co-change. The compiler cannot miss a consumer; a human
grepping can.

Use it to make an ownership-amendment request **provably** complete instead of
**believed** complete: apply as a probe, typecheck, revert, then ask for exactly
the files the compiler named. Turns "I think it's one file" into "the compiler
says it's one file", and prevents the second block half an hour later.

Related: `mem:gotcha-layered-digests-defeat-mutation-drills` (choosing an operand that reddens by
assertion instead of by crash), `mem:gotcha-guard-order-mutant-survives-when-only-one-guard-can-refuse`.
