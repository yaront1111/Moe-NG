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

Related: `mem:gotcha-package-boundary-test-matches-comments`,
`mem:gotcha-boundary-test-greps-prose-not-imports`,
`mem:gotcha-naive-grep-counts-comments-and-ban-fixtures-as-imports`,
`mem:gotcha-gate-narrowed-by-exclude-reads-as-green`.
