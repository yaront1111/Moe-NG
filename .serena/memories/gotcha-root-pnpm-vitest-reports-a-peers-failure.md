# `pnpm vitest` from the repo root can report a PEER's failing test as yours

2026-08-15, task-bcea7056, shared worktree with several agents running suites concurrently.

`pnpm vitest run --root . packages/core/src/configuration` had worked minutes earlier (142 passed). Re-run, it
printed:

```
FAIL  src/recovery/durable-recovery-inventory.test.ts > ... > projects every ResourceRow onto its exact
      Tests  1 failed | 24 skipped (25)
[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command failed with exit code 1: vitest run --root . --config
      package.json src/recovery/durable-recovery-inventory.test.ts -t "projects every ResourceRow..."
```

A file I had never touched, in a package I was not working in, with `--config package.json` and a `-t` filter
I never passed. There is no root `vitest` script, so `pnpm <bin>` falls through to exec, and under concurrent
peer activity it reported a RECURSIVE run's first failure instead of running my command at all.

**The tell is `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` plus flags you did not type.** Read the echoed command
before reading the failure — if the argv is not yours, the result is not about your code. Believing it costs a
debugging detour into a peer's package, or worse, an "I broke something" conclusion in a completion note.

**Use a filtered invocation instead**, which pins the package and never goes recursive:
```
pnpm --filter @moe/core exec vitest run --root ../.. packages/core/src/configuration
```
`pnpm --filter <pkg> test` is equally safe. Both stayed correct across a dozen mutation-drill runs while the
root form was flaky.

**Before concluding a red is foreign, still resolve authorship** — a red your own diff caused is never
disclosable by path attribution. The cheap checks: `git status --porcelain <path>` (an `??` untracked file did
not exist at your baseline), and grep the failing file for any symbol or package you published. In this
session the repo-wide `pnpm typecheck` red also MOVED between two runs minutes apart — `apps/control-room`
first, then `packages/runner` — which is itself a signature of live peer edits rather than a stable
consequence of a landed diff.

Related: `mem:peer-write-during-test-run-fakes-a-red`, `mem:own-diff-red-in-foreign-file-is-not-excused`,
`mem:shared-worktree-blocks-root-gates`, `mem:pnpm-typecheck-from-subdir-is-not-repo-wide`.
