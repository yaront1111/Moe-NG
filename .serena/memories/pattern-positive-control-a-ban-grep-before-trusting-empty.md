# An empty ban-grep is only evidence if you prove the grep still works

Found 2026-08-10 on task-55e2c4c8, verifying a DoD written as "verified by grep that the package
contains no CreateJobObject / AssignProcessToJobObject / CreateProcessW / ResumeThread /
TerminateProcess / WaitForSingleObject **call site of its own**".

## Two failure modes, opposite directions

**FALSE POSITIVE — the grep matches its own documentation.** The naive run returned five hits and
read as a flat rail violation. Every one was a COMMENT: module docs that STATE the rail
("this crate restates no `CreateProcessW`..."), and prose naming the symbol. A well-documented
codebase is the one most likely to fail its own ban-grep. Strip comments first:

```sh
for f in $(find src -name '*.rs'); do
  sed 's://.*::' "$f" | grep -Hn "PatternA\|PatternB" | sed "s|^|$f:|"
done
```

**FALSE NEGATIVE — the empty result is a broken command.** A mistyped path, a bad escape, a glob
that matched nothing, or a `--exclude` all produce silence that reads exactly like compliance. This
is the dangerous direction, because the conclusion you draw is "clean".

## The habit worth keeping: run a POSITIVE CONTROL

Point the SAME command at a place the pattern is known to exist, and require a nonzero count:

```sh
# subject: must be empty
for f in $(find broker/src -name '*.rs'); do sed 's://.*::' "$f" | grep -H "CreateProcessW\|ResumeThread"; done
# positive control: the core really does call these
sed 's://.*::' src/win32/system_process.rs | grep -c "CreateProcessW\|ResumeThread"   # -> 4
```

Without the control, "no output" means *either* compliance *or* a command that cannot find
anything. With it, the empty result is a fact.

Also true of counts: `grep -c` on a pattern that never matches returns 0 and looks like a passing
threshold.

## The control must share the pathspec, and `| wc -l` removes the last signal (2026-08-22)

Measured at HEAD `1d9d84c` while hardening a DoD clause of the form "this grep returns zero".

`git grep` makes both failure modes worse than the generic case:

**It exits 1 on no match.** So a clause whose SUCCESS is an empty result runs a command that
reports FAILURE — it aborts an `&&` chain and reads as a red. The obvious fix is to assert the
number instead of the exit code:

```sh
git grep -n "<dead-id>" -- apps packages scripts | wc -l    # must print 0
```

**But that fix opens the false-negative hole, because the pipe discards git's exit code.** A wrong
pathspec is SILENT — no fatal, no stderr, no clue:

```sh
git grep -n "a91e9fe2" -- nonexistent-dir     | wc -l   # -> 0
git grep -n "a91e9fe2" -- apps packages scripts | wc -l # -> 4
```

**Worst case is a typo in ONE element of a multi-element pathspec**, masked by the valid ones:

```sh
git grep -n "a91e9fe2" -- app packages scripts | wc -l  # -> 0   <- `app` missing the s
```

`packages` and `scripts` are real and simply hold no hits; all real hits lived under `apps`. One
missing character reads as a clean, entirely wrong zero. Widening a pathspec for coverage
ENLARGES this surface — it is still usually right, just no longer self-checking.

### The control must use the IDENTICAL pathspec, or it does not interlock

```sh
git grep -n "<dead-id>" -- apps packages scripts | wc -l   # (a) must print 0
git grep -n "<live-id>" -- apps packages scripts | wc -l   # (b) must print >= 1
```

On any broken pathspec (b) also reads 0 and fails, so the pair cannot both go green on a broken
path — while either alone can. Point (b) at something that reads **0 today** and only becomes
nonzero through the work being graded; if it is already nonzero the clause grades green on work
nobody did.

### When this is written as a DoD clause, (b) will look deletable

To a quick reader (b) is redundant — "we already assert the dead id is gone, why also assert the
live one is present?" Deleting it silently converts (a) back into a zero that cannot fail. Say so
IN the clause: same pathspec text character for character, graded as one clause.

Generalisation: **an assertion of absence needs a companion assertion of presence through the
identical instrument, or the instrument's own breakage is indistinguishable from the absence it
is meant to prove.**

Related: `mem:gotcha-package-boundary-test-matches-comments`,
`mem:gotcha-boundary-test-greps-prose-not-imports`,
`mem:gotcha-naive-grep-counts-comments-and-ban-fixtures-as-imports`,
`mem:gotcha-gate-narrowed-by-exclude-reads-as-green`.
