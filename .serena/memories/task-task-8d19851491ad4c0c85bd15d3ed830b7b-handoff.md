# task-8d19851491ad4c0c85bd15d3ed830b7b handoff

Status: implementation complete and ready for QA.

## Reopen repair
- Commit `de1298a` contains only `packages/scheduler/src/package-boundary.test.ts` (+74/-6).
- Added static zero-interpolation template-literal specifier support for `import()`, `require()`, and `from`, covering both `@moe/scheduler/<internal>` and relative `scheduler/src/<internal>` forms.
- Interpolated template specifiers remain non-static; template expressions are bracketed during tokenization so constant-string interpolation cannot masquerade as a static specifier, while nested dynamic imports inside expressions remain visible.
- Added context-aware regex-literal skipping and newline-failing quoted-token parsing so a regex containing an odd quote cannot silently swallow a later genuine import.
- Repository sweep wraps parse errors with the exact repository-relative path.

## TDD and mutation evidence
- Initial reopen RED: 4 failures (three backtick specifier forms plus regex-with-quote followed by a genuine import).
- Additional adversarial RED: constant-string interpolation was initially misclassified; fixed by expression bracketing.
- Final focused suite: 40/40.
- Removing static template-token publication made exactly the 3 backtick cases fail; restored exact file hash `559dd736edb35bb434d8ae5fe2d0c87bad5343b7` before commit.
- Disabling regex skipping made the dedicated regex/import case fail loudly; restored exact same hash.

## Verification
Fresh post-commit exact gate:
`pnpm typecheck && pnpm test && pnpm --filter @moe/scheduler test`
- exit 0
- root: 163 files, 3016 passed, 1 skipped
- scheduler: 32 files, 593 passed
- Scheduler increased 587 -> 593 from the six permanent reopen regressions. Root increased 2890 -> 3016 because concurrent foreign work added 120 tests in addition to these six; none were lost.
- `packages/scheduler/src/index.ts` working/HEAD hash: `a0ab48fbdd5ccf85838dbb024c9efe74ce79c050`.
- `packages/testkit/src/foundation/foundation-fault-schedule.ts` working/HEAD hash: `b741559711913d8da2214b4351ed341834e7f3f9`.
- `git show --stat de1298a` shows only the owned package-boundary test.

## Attribution
- Original clean task commit `d03c42f` holds the prior boundary hardening and runner comment change.
- Harness sweep commit `9e0f123` captured foreign `.moe/.codex` and daemon WIP; do not revert it and do not attribute those paths to this worker.
- Foreign current WIP under daemon, control-room timeline, runner materialization, and runtime `.moe/**` was preserved untouched.