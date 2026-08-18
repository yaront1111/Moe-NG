# Foundation MCP dispatch host — worker handoff (2nd block, different cause)

Task `task-49ed1e6d73544fc6ae09b3951a573848`. Reopened by governor after
`task-5e43a9e2` (Foundation daemon ingress surface) landed. Re-measured at HEAD
**8222b9e**, step-1 completed, blocked inside **step-2**.

Supersedes the earlier planning handoff: the `@moe/mcp` HTTP-root gap it named is
CLOSED. The new block is a different, deeper one.

## Step 1 landed (no code)

Re-scope comment posted: `comment-303782aba93540b7ae787a8264b49c40`. Every plan
measurement reconfirmed identical from a42ae2f to 8222b9e:

- `grep -rn "StdioDispatchPort|HttpDispatchPort" tests/` -> **ZERO**. The task
  description's premise (a fake dispatch port injected in the E2E harness) is FALSE.
  `tests/e2e/foundation/e2e-process.ts:96` spawns real children via
  `spawn(process.execPath, …)`.
- The host already exists TWICE: `apps/daemon/src/mcp-main.ts` (58 lines, stdio,
  `createStdioMcpServer` + `connectStdioTransport` + `readBootstrapCredential`) and
  `apps/daemon/src/mcp-http/mcp-http-main.ts` + `mcp-http/mcp-http-host.ts`
  (Streamable HTTP via `createHttpMcpAdapter`). `apps/daemon/src/host/` does not exist.
- `apps/daemon/package.json` already declares `@moe/mcp` — DoD 5's manifest addition
  is a NO-OP. Do not run `pnpm install`; do not commit package.json or pnpm-lock.yaml.
- File sizes: vocabulary 123, registry 226, daemon-entry 244, daemon-main 99,
  mcp-main 58, mcp-dispatch-port 108, registry.test 549.

## Why step 2/3/7 are impossible in owned paths

Full detail in `mem:gotcha-foundation-kinds-are-not-runtime-command-kinds`. Summary:
`"foundation.dispatch"` and `"foundation.verification"` are not members of the frozen
92-entry `RUNTIME_COMMAND_KINDS` in `packages/contracts/src/runtime/runtime-vocabulary.ts`
(NOT an owned path). Four independent blockers, two of which survive closing the enum:
closed enum (TS2322, compiled probe); envelope refusal at `runtime-envelope.ts:141`
before the registry is consulted; sync `CommandHandler` vs async `dispatch`/`verify`;
`Uint8Array activationRequestBytes` vs `JsonObject` payload. Plus
`FoundationAttemptDeps.captureResult` has zero production producers.

## What IS still buildable

Steps 4-6 — the pure receipts module at `apps/daemon/src/host/foundation-receipts.ts`
(+ mandatory `.js` bridge, see `mem:new-ts-module-needs-a-js-bridge-invisible-to-tsc-and-vitest`)
emitted from `daemon-main.ts` (99 lines, owns `onStarted` at :82 and SIGINT/SIGTERM at
:89-96) and `mcp-main.ts` (58 lines, has NO signal handling at all). That closes DoD 3
alone. It was NOT landed: steps 2 and 3 precede it and the plan's step-6 justification
depends on the host composition that cannot happen. Deliberately did not half-build
under an approved plan whose shape is invalid.

`grep -rn "readinessReceipt|ReadinessRecord|shutdownReceipt|ReadyReceipt" apps/daemon/src`
still returns ZERO; readiness is a log line at `daemon-entry.ts:227`. Do not edit
`daemon-entry.ts` — 244 of a 250 target.

## Already satisfied — do NOT rebuild

Restart reconciliation (`boot-reconciliation.ts`, ordered before the listener per
`daemon-entry.ts:202`); graceful shutdown with `DAEMON_ENTRY_ALREADY_STOPPED`
(`daemon-entry.ts:189-190`); transport parity — both transports already reach
`createMcpDispatchPort` -> `handleCommandRequest` (`mcp-dispatch-port.ts:62-71`).

## Named prerequisite for the architect

A `packages/contracts`-owned task adding both kinds to `RUNTIME_COMMAND_KINDS` with
`satisfies RuntimeCommandKind` at each definition, AND an `apps/daemon`-owned task
resolving the async-handler and binary-payload seams (either an async `CommandHandler`
variant or a JSON-expressible dispatch request), AND a producer for `captureResult`.
Until all three land, DoD 1/2/4's Foundation reach is unreachable from any transport.

Final certifier remains Foundation canary `task-97554aa4293e40eab56c0b642e18513a`.
