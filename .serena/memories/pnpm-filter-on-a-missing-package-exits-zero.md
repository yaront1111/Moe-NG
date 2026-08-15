# `pnpm --filter @moe/<pkg> test` exits 0 when the package does not exist

## Reproduced at HEAD a967199

    $ pnpm --filter @moe/benchmark test
    No projects matched the filters in "D:\projexts\moe-next"
    EXIT=0

`packages/benchmark` does not exist. The command still **succeeds**. The message goes to stdout,
not stderr, and nothing about the exit code distinguishes "all tests passed" from "no tests ran".

## Why this is dangerous here

`task-b937811e` (Benchmark telemetry harness) names exactly that command as its **verification**.
A worker could satisfy the DoD's "Focused benchmark tests pass" with a green run that executed zero
tests against a package that was never created. Two prior architects flagged it (first at HEAD
2b15b8f) and it still reproduces, which is why it belongs in a memory rather than one task's notes.

This is the gate-level form of the epic's reason-code rail: "a generated or swept case must assert
that the case was actually generated; a sweep that silently produces zero cases passes while
testing nothing." A filter matching zero packages is that sweep.

## Rule

For any task whose verification is a `--filter` run, require a **nonzero executed test count**, not
exit 0. Concretely, one of:

- read vitest's own summary line (`Test Files N passed`, `Tests M passed`) and assert N,M > 0;
- confirm the package directory and its `package.json` `test` script exist before trusting the leg;
- `pnpm --filter <pkg> exec node -e "process.exit(0)"` first — it also exits 0 on no match, so it
  is NOT a substitute; prefer the directory check.

Architects: when a plan's gate step names a `--filter` leg for a package the task CREATES, say in
the step that exit 0 is insufficient and name the count assertion. Workers: never report a
`--filter` leg as green without the summary line in the evidence.

## Related traps in the same family

- `mem:gotcha-a-gate-narrowed-by-exclude-reads-as-green` — narrowing by `--exclude`.
- `mem:root-vitest-excludes-apps` — root `pnpm test` skips `apps/**` entirely.
- `mem:daemon-focused-vitest-finds-zero-tests` — a focused daemon run without `--root .` matches
  ZERO tests and reads exactly like a pass.
- `mem:semicolon-chained-gate-run-masks-a-red-suite` and
  `mem:piped-gate-run-reports-tail-exit-code` — the exit-code plumbing versions.

The common shape: **exit 0 means "nothing went wrong", never "the thing you wanted actually ran."**
