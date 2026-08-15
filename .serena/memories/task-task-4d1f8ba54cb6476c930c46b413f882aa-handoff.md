# task-4d1f8ba54cb6476c930c46b413f882aa QA final handoff

## Verdict
APPROVED on reopened QA after repair commit `c4d9c55`. Current HEAD was `fcf2cfbbd42f400599adc63347a6b4561a063092`; `c4d9c55` is an ancestor and no later commit changed `packages/runner/src/platform/windows/**`. Owned working/staged bytes were clean.

## Rejection repair verified
- `readArgv` now rejects own iterator behavior, snapshots each exact validated data descriptor, freezes the snapshot, and passes only that snapshot to encoding.
- The path guard now rejects Win32-invalid component characters, ASCII controls 0-31, and `CONIN$` / `CONOUT$`.
- Production boundary tests cover hostile iterator and a hand-pinned 39-case path table in both executable/cwd positions. Each asserts exact PROCESS_BOUNDARY code, `WINDOWS_PROCESS_REQUEST`, and an empty resolver/spawn call log.
- Direct production probes returned:
  - invalid path -> `WINDOWS_PROCESS_REQUEST/PROCESS_BOUNDARY_EXECUTABLE_REJECTED []`
  - console device -> same exact refusal with empty call log
  - hostile argv -> `WINDOWS_PROCESS_REQUEST/PROCESS_BOUNDARY_ARGV_REJECTED []`
- Independent QA mutations disabled the iterator arm and invalid-character predicate separately. Each reddened its named production-boundary test; original bytes restored exactly; focused repaired cases then passed 41/41.

## Fresh commands
- `pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test`: exit 0, 54 files / 1664 tests.
- `npx vitest run --root . packages/runner/src/platform/windows/windows-boundary.smoke.test.ts --reporter=verbose`: exit 0, 4/4; real close/cancel/timeout parent+detached-grandchild cases executed.
- Earlier in the same QA session, the unchanged locked Rust broker suite exited 0, including containment, detached-grandchild premise, descriptor, framing, idempotence, Node-loadability and session tests.

## Rails
All DoD items now map to production and tests. No taskkill/PID-only fallback or public launcher export. Consumer remains `task-acf73253a204435aba590894799814f2`. Every task production source is under 250 lines (largest session 247; repaired launch request 243). Repair commit contains only four owned runner paths and no artifact/binary.