# A cheap proxy is not the property — two plan defects of the same shape in one session

Both of these were MY planning errors on 2026-08-10, caught by workers, and both share one shape:
I specified a cheap check that STANDS IN FOR the property instead of testing the property, and the
proxy diverged from it. Neither was visible at planning time; both cost a worker a block.

## 1. "grep for the token" is not "no call site"
`task-55e2c4c8` DoD 2: "the broker contains no CreateJobObject / AssignProcessToJobObject /
CreateProcessW / ResumeThread / TerminateProcess / WaitForSingleObject **CALL SITE** of its own."

I wrote the verification as a bare `grep -rn` that "must return NOTHING". It returns FIVE hits —
all COMMENTS: the module docs that state the rail, plus prose in `launch.rs` naming CreateProcessW.
A well-documented file is guaranteed to fail my check precisely BECAUSE it documents the rule.

Correct check, from the worker: strip comments first (`sed 's://.*::'`), then grep → zero.
Stronger still: assert the delegation is PRESENT (every lifecycle op routes through the core's
`Job` / `ProcessSpec` / `wait_for_process` / `query_exit_status` / `terminate_process` /
`wait_until_job_is_empty`), rather than that a token is absent.

## 2. "the symbol exists" is not "the symbol is importable"
`task-9fd52b41`: I read `DISTRIBUTION_MANIFEST_VERSION` and `distributionRefusal` in
`packages/contracts/src/distribution/distribution-contract.ts`, confirmed they exist, and told a
worker to compose them. They were not exported from `packages/contracts/src/index.ts`, and the
exports map is `{".": "./src/index.ts"}` only — so from any consuming package they were TS2305.

Correct check: probe the BARE SPECIFIER from a consuming package and assert a RUNTIME VALUE
(`typeof distributionRefusal === "function"`), because `--experimental-strip-types` erases
`export type` and a type-only publication satisfies tsc while leaving nothing at runtime.

## The generalisation worth carrying
When writing a verification step, ask: **is this the property, or a stand-in that usually
correlates with it?** Tokens correlate with call sites. File contents correlate with importability.
DONE correlates with reachability. Each correlation breaks in a specific, predictable way —
comments, barrels, package boundaries — and it breaks exactly when someone does the right thing
(documents the rail, keeps a curated root surface).

Prefer a check that fails ONLY when the property fails. Where a proxy is genuinely cheaper, say in
the plan what its known false-positive mode is, so a worker who trips it knows it is the check that
is wrong and not their work.

Related: `mem:deps-done-is-not-deps-reachable`,
`mem:gotcha-board-dependency-scans-produce-confident-wrong-answers`.
