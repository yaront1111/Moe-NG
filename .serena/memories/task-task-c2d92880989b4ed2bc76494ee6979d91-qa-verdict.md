# QA verdict: adapters/ IDE adapter contract — APPROVED

Reviewed by qa-ed8ebade, 2026-08-10. Task moved to DONE. Full evidence in task
comment-cdcd7777. Package `@moe/ide-adapter-contract` at `adapters/ide-contract/`.

## What I re-ran rather than trusted
- `pnpm typecheck && pnpm test` -> exit 0 / exit 0. 214 files, 4041 passed | 1 skipped.
  **Zero foreign red** — the planning-time scheduler `package-boundary.test.ts` red did NOT
  reproduce, so no path-attributed baseline was needed. Do not carry that expectation forward.
- `pnpm exec vitest list | grep -c "adapters/ide-contract"` -> **33**. This is the check that
  matters on any new workspace ROOT: the root vitest include had no `adapters/**` entry, so
  without the worker's one-line fix `pnpm test` would have exited 0 having collected none of it.
  A green suite is not evidence that a new package's tests ran. Count the collection.
- Plain-Node probe standalone from the package root (vitest resolves `.js` back to `.ts` and is
  structurally blind to a missing bridge).

## Five mutation drills, all red for the named reason, all restored byte-exact
1. `rm src/index.js` -> 3 failed. Bridge load-bearing; vitest alone stays green without it.
2. Flip the discovery refusing layer -> the UNKNOWN case reddens. Proves `layer` is pinned and
   not a constant. This only works because the contract has TWO refusing layers by design
   (PORT refused vs CONTRACT refused to trust the port). One layer = an unfalsifiable assertion.
3. Drop `EVIDENCE_MALFORMED` from the frozen tuple -> code sweep reddens AND the probe's
   `reasonCodeCount` 14->13. A shrinking vocabulary cannot pass quietly.
4. `ok("DAEMON_RUNNING")` on UNDETERMINED -> 2 red. Fail-closed is enforced by test, not prose.
5. Plant `vscode` in index.ts -> neutrality guard reddens.

Restores verified with `git hash-object`, never with an empty `git diff` — the files were
untracked when written, and by review time they were committed, so `git checkout -- <path>`
was the safe restore. `git status --porcelain` over owned paths empty afterwards.

## The judgement call worth reusing
The worker edited `tests/runtime/package-loadability.test.ts`, which is outside the task's named
files. I did not accept the prose justification. I checked the file out at base `1e3057ab` and ran
it: "tolerates a workspace glob whose base directory is absent" goes RED, because it pinned
`adapters/*` expanding to `[]` — the ABSENCE of this very deliverable. Forced, not scope creep,
and explicitly NOT path-excusable foreign red (this diff falsified it). The worker also kept
`expandWorkspacePattern`'s missing-directory property alive by re-pointing it at
`no-such-workspace-base/*` instead of deleting the assertion. See
`mem:qa-prove-an-out-of-plan-edit-was-forced`.

## Scope facts
Base-ref diff `1e3057ab..HEAD` over adapters/, vitest.config.ts, pnpm-workspace.yaml,
tests/runtime/package-loadability.test.ts = 9 files, 845+/3-. Per-FILE lines by `grep -c ''`:
index.ts 234, index.js 1, tests 362 / 216. Task-level LOC is not a bar and was not applied.
Lockfile contribution is exactly `adapters/ide-contract: {}`; the `@moe/mcp` hunk under
apps/daemon is foreign (commit 921ff53, task-f6c9011b). Committed bytes == gated bytes
(`git hash-object` == `git rev-parse HEAD:<path>`).

Downstream: task-9fd52b41 implements the ports; task-05ce9b8f schedules against the 14-code
vocabulary plus the layer label. Both named by task id in the module header and machine-checked.
