# Planning source size guard — DONE, in REVIEW

Task `task-74508e0de86b40829eda1cd343742336` on `moe/work-2026-08-08`. Final hardening child of
the planning decomposition (parent task-1ade51c0). Commit `508b118`, one file, 136 lines.

## What it is

`packages/core/src/planning/planning-source-size.test.ts` — mechanical enforcement of the
250-physical-line ceiling over EVERY `.ts` in `packages/core/src/planning`: production, tests,
fixtures, drivers, support. No allowlist, no suffix exception, no self-exemption. 9 tests.

## If this test is red, it is probably not this file's fault

The failure names the offending file and its exact count, e.g.
`[{"file": "planning-validation.ts", "lines": 250}]`. **Fix the named file. Never add an
exception here** — an exception defeats the entire task. The header says so in place.

## The one operator decision that matters

Threshold is `> 250`, NOT `>= 250`. `planning-validation.ts` is currently **exactly 250 lines**,
so `>=` would have redded a compliant file the day this landed. A two-sided boundary test pins
250-passes / 251-fails for LF, CRLF, and CR with and without a trailing terminator, so the
operator cannot silently drift.

## Physical-line definition (reuse this if you write a sibling guard)

Split on `/\r\n|\r|\n/`; LF, CRLF, and lone CR each terminate one line. A trailing terminator
ends the last line rather than starting a phantom empty one (drop the final empty segment). A
leading BOM (`"﻿"`) is stripped and is not a line. Empty file = 0 lines. This matches the
counter used across this session's other tasks — `(text.split(/\r\n|\r|\n/)).length - 1` when a
trailing newline is present.

## How the guard avoids passing for the wrong reason

Each vacuity hole is closed by its own test, which is the part worth copying:

- **Empty sweep** — minimum swept-file count (>=15; 20 exist) AND `sweepTypeScriptSources` takes
  the directory as a PARAMETER so a test can assert it THROWS on a missing directory. A
  mis-resolved path fails loudly instead of returning `[]`.
- **Silent exclusion** — swept filenames compared against an independent `readdirSync`; adding
  any filter later breaks that test.
- **Detector that always returns `[]`** — a test re-runs the sweep at a deliberately strict
  threshold (100), asserting offenders are non-empty AND sorted.
- **Self-exemption** — a test asserts this file's own basename is in the swept set.

## Portability

Directory resolved via `fileURLToPath(import.meta.url)` + `dirname` — **never `process.cwd()`**,
because vitest is rooted at the repository, not the package. All joins through `node:path`;
sorting uses an explicit comparator, not locale-dependent default sort. Read-only: only
`readdirSync`/`readFileSync`, zero writes, so no scratch file can be swept into a foreign commit
(`mem:gotcha-shared-index-commit-capture`).

## Verification

Named gate `pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test` -> exit 0,
15 files / 235 tests (baseline was 14/226; the delta is exactly this guard).
Repo `pnpm typecheck` exit 0 and `pnpm test` -> 117 files / 1629 passed / 1 skipped, exit 0.

Mutation red-team run live, not reasoned: ceiling lowered to 100 and to 240 -> red both times
with the offender named; restored and verified byte-identical via `git hash-object` before/after.

## Directory state at landing (20 files, all compliant)

planning-contract 63, graph-revision-results 73, planning-invariant-fixtures 88,
graph-revision-test-fixtures 96, graph-revision-validation 115, planning-results 121,
planning-invariants.test 129, planning-source-size.test 136, planning-snapshot 145,
graph-revision-contract 156, planning-run-test-fixtures 156, planning-event-contract 163,
planning-run-authority.test 180, planning-run-submission 186, planning-run-reducer 192,
graph-revision-reducer 206, planning-command-contract 216, graph-revision-reducer.test 222,
planning-run-reducer.test 228, planning-invariant-drivers 235, planning-validation 250.

Tightest headroom: planning-validation (0 lines spare), planning-invariant-drivers (15).
