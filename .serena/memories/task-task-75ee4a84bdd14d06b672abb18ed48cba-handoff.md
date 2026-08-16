# task-75ee4a84 Claude runtime pin-request hydrator — LANDED (2026-08-16)

Supersedes the earlier BLOCKED note entirely: the prerequisite task-32eddfd3 is
DONE, `observeInstalledClaudeRuntime` exists at
`packages/runner/src/providers/claude/claude-host-runtime.ts:201`, and this task
shipped its consumer. Commit **7cdd714**, five owned paths.

## What shipped

`createClaudeRuntimePinRequest(input: unknown)` in
`providers/claude/claude-runtime-request.ts` (242 lines) + `.js` bridge + suite.
Published from the root via `surface/claude-surface.ts` with
`CLAUDE_RUNTIME_PIN_ERROR_CODES`, `CLAUDE_RUNTIME_PIN_LAYER` and 5 types.
Root export count 226 -> **229** in `index-surface.test.ts`.

**Synchronous, zero I/O.** `ClaudeRuntimePinRequest` has 6 fields; only
`{quotedObservation, installedRoot, pinRoot}` are data. `fs`/`facts`/`clock` are
minted inside the package after validation and are not acceptable as input.

## Four design decisions a future agent will otherwise re-litigate

1. **The derivation runs BEFORE `readQuote`, on purpose.** `readQuote`
   (claude-runtime-pin-closure.ts:138) already enforces exactly-one-EXECUTABLE.
   Put the factory's own guard *downstream* of it and the guard is DEAD — a
   mutation drill on it flips nothing. Placed first, it owns the rule and its own
   prose; a "pick the first" mutation still refuses (readQuote catches two) but on
   a DIFFERENT message. See `mem:gotcha-two-routes-one-code-need-an-exact-message-pin-plus-a-pin-count`.

2. **`executablePath` is derived, never an input.** `observeInstalledClaudeRuntime`
   needs one; accepting it publicly would let a caller name which binary the host
   observes. Derived from the single `EXECUTABLE` in the quoted closure. Zero and
   two both refuse — picking the first would let a caller steer the observation by
   padding the closure.

3. **The facts port throws, and the throw CARRIES the arm.**
   `ClaudeRuntimeFactsPort.observe` returns `Promise<ClaudeRuntimeFacts>` — no
   refusal channel — so an arm can only leave as a throw.
   `ClaudeRuntimeObservationRefused` carries `{code, layer, truthClass}` with
   `layer: null` exactly when the authority declares none (`ClaudeFailure` has no
   `layer` field). The Error message is `host observation refused (<code>)`,
   path-free; the observer's prose is never forwarded. `prepareClaudeRuntimePin`
   then converts it to `CLAUDE_RUNTIME_OBSERVATION_INVALID`/UNKNOWN.

4. **The port must NOT cache.** `prepareClaudeRuntimePin` calls `observe()` twice
   (before and after the copy) and compares `factsDigest`. A factory that observed
   once and handed back a cached value would silently defeat the drift comparison.

## Assert the arm against production's own answer

The pass-through test calls `observeInstalledClaudeRuntime` with the same input
and requires the thrown carrier's `{code, layer}` to EQUAL that result's — not a
hand-written expectation. Two reachable authorities with two different layers
(RUNTIME for a missing binary, BROKER_NATIVE for a non-image), so a hardcoded
layer cannot pass. Honest limit recorded in the completion: the
`ClaudeFailure<ClaudeObservationErrorCode>` arm is UNREACHABLE from bounded plain
input (the observer builds its own probe report), so it is covered by the rule,
not by a case.

## Gates at completion

- `pnpm --filter @moe/runner typecheck` EXIT 0
- `pnpm --filter @moe/runner test` EXIT 0, `Test Files 66 passed (66)` /
  `Tests 2216 passed | 1 skipped (2217)` (baseline was 65/2167)
- `pnpm typecheck` repo-wide EXIT 0, all 18 projects
- No foreign red. The `claude-launcher.windows.test.ts:178` red the plan warned
  about was already gone — see `mem:baseline-foreign-red-can-clear-mid-task`.

## For the next agent

**task-6cbff01023b14b26a78fc5e3eb1dd8a9** is the production consumer: replace its
temporary `FoundationAttemptDeps.runtimePorts` with this factory. The bare
specifier works — a compiled probe inside apps/daemon importing
`createClaudeRuntimePinRequest` from `@moe/runner` typechecked EXIT 0 and was
deleted in the same command.

`prepareClaudeRuntimePin` stays WITHHELD from the root (it is in the pre-existing
withheld list in index-surface.test.ts); the launcher applies it itself via
`ClaudeLauncherDependencies.prepareRuntime`, and the hydrated request is what
goes into `ClaudeLaunchRequest.runtime`.

Conformance needs both `where.exe claude.exe` to resolve AND
`dist/windows-job-native/release/moe-windows-job-broker.exe` to exist. Both were
true on this host, and the leg's one early exit is pinned with
`expect(brokerIsBuilt()).toBe(false)` so it cannot silently skip.
