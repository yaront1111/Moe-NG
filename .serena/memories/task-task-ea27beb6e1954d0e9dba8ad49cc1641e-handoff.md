# Blocked handoff: stale provider normalization task

Task `task-ea27beb6e1954d0e9dba8ad49cc1641e` was remeasured at HEAD `6ca5da0` and reported BLOCKED with an archive recommendation; no bytes were written.

## Root cause
DONE task `task-159f4c21ef9149e8a65f24735c9c1475` already landed and published the full runner+scheduler authority:
- `@moe/runner.normalizeProviderUsage` maps one `ClaudeTelemetryHandoff` to four token-meter measurements, calls production scheduler normalization with per-meter priors, and preserves runner wrapper plus scheduler issue provenance.
- `@moe/runner.buildProviderRunRecord` consumes it and returns a deeply frozen public record.
- The handoff contains token facts, not a raw usage-envelope array. The prior plan's envelope loop was based on a nonexistent surface and would duplicate the landed authority.

## Why a thin daemon adapter is unsafe
- Runner and daemon define incompatible `ProviderRunRecord` shapes under the same literal `moe-provider-run-record/1`.
- The daemon codec validates only canonicality and the version literal before casting JSON, so it can seal a runner record as the incompatible daemon type.
- Runner `ProviderUsageRefusal` carries its own code/layer plus scheduler issues; daemon `usageRefusals` can store only scheduler issues. A mapping necessarily drops or fabricates provenance.
- No public runner validator snapshots an unknown handoff; the public record builder is typed, so the old malformed-raw-handoff DoD cannot be met without copying validation.
- Live daemon dispatch receives `ClaudeLaunchResult`; `launchClaudeWithTelemetry` launches itself. There is no public already-executed-result-to-handoff seam, so composing it after the existing launch would relaunch.

## Verified edge
The daemon manifest and lock importer already contain `@moe/runner` and `@moe/scheduler`. A trap-deleted in-package bare-root TypeScript probe importing the exact runner record-builder/types and scheduler clock type exited 0. No draft adapter/call site exists; relevant paths were clean.

## Required governance action
Archive this stale task. Create/approve:
1. A widened daemon contract/codec reconciliation with a new durable-envelope version, public runner record/result embedded rather than remapped, daemon clocks outside it, a digest-less draft, and exact runtime schema validation.
2. A public seam that derives telemetry from the already executed launch result without relaunching.
3. Rewire ledger task `task-1a7ff170ee544a3a8a10962c25e2ca5b` to those prerequisites instead of treating this task as satisfiable by a lossy wrapper.
