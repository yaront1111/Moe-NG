# task-6cbff01023b14b26a78fc5e3eb1dd8a9 handoff

Status at 2026-08-16: step-6 adversarial review in progress; task must remain BLOCKED on production prerequisites. Do not trust comment-898cea's TypeScript-session hypothesis; comment-c0e805 is the correction.

## Current WIP
- Base-ref for owned review: `f4966b5`. Foreign whole-tree commit `6ca5da0` captured some bytes; never amend/reset/claim it.
- Owned daemon files:
  - foundation-attempt-contracts.ts/.js
  - foundation-attempt-codec.ts/.js
  - foundation-attempt-store.ts/.js
  - foundation-attempt-service.ts/.js
  - foundation-attempt-service.test.ts
  - untracked `foundation-attempt-windows.test.ts` was the temporary 10th path.
- Production sizes last measured: contracts 217, codec 194, store 155, service 243.
- Focused Linux daemon test passed 1 file / 21 tests; daemon typecheck passed.
- The service now removes the whole-launch override, accepts serializable runtime references, binds the full dispatch identity, gates replay before activation, exact-gates the runner OBSERVED result and its grant/registration/observation subrecords, and requires the durable GRANT_CONSUMED -> PREFLIGHT_REGISTERED -> PROCESS_OBSERVED tail. A 19-case exact nonzero substitution sweep is green.
- Do not complete: `FoundationAttemptDeps.runtimePorts` is still caller/test-composed authority and architect comment-58da requires replacing it with the producer below.

## Hard prerequisites
1. `task-32eddfd3c9644558b7218778e1f07e92` production Windows installed-runtime facts (currently BLOCKED on `task-ff589abd7dd84ee197a9abee729bef78`).
2. `task-75ee4a84bdd14d06b672abb18ed48cba` bare-root server-owned runtime-request hydrator, after #1. Once landed, remove runtimePorts from FoundationAttemptDeps and call the public factory.
3. `task-7ba898f5f587453f80c1e93e93e4977c` native Windows broker nonblocking control polling, created from the real conformance discovery.

## Real Windows evidence
Plain verification copy (not a git worktree): `/mnt/d/tmp/moe-next-win-task6cb` / `D:\tmp\moe-next-win-task6cb`. Windows Node 24.16 and Rust work through `/init /mnt/c/Windows/System32/cmd.exe /d /c ...`. Release broker build passed.

Actual broker + copied `where.exe`, `cmd.exe`, and `node.exe` could not reach public-launcher PROVEN. Natural runs last until the launcher timeout and return exact `CLAUDE_LAUNCH_STREAM_ERROR@OUTPUT`. Raw boundary only resolves at its timeout. Root cause is explicitly documented at `packages/runner/src/platform/windows/native/broker/src/watch.rs:23-43`: after one 50ms wait slice it synchronously reads silent-open fd0 and blocks, so later provider exit is not observed until the parent closes control. There is no pre-timeout COMPLETED frame, so editing `windows-boundary-session.ts::onCompleted` cannot fix it. No runner file was edited.

The temporary Windows test has three cases: real PROVEN+replay (red due prerequisite), timeout uncertainty/no-relaunch (green), reservation abort/zero runtime touch (green). On resumption after prerequisites, either keep it as the 10th path or fold it into the existing service test if scope needs a producer edge; never use a mock boundary or a sub-50ms executable loophole.

## Tooling
Linux:
`export PATH=/tmp/moe-next-audit.RmcOgKqO/node-v24.16.0-linux-x64/bin:/tmp/moe-task-bin:$PATH; export pnpm_config_verify_deps_before_run=`
Focused:
`pnpm --filter @moe/daemon exec vitest run --root . --config package.json src/work/foundation-attempt-service.test.ts --maxWorkers=1 --no-file-parallelism`

Preserve all foreign dirty paths and never edit .moe directly.