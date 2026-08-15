# Moe Next

Moe Next is a greenfield, local-first orchestration control plane for reliable multi-agent software work.

This repository is independent from legacy Moe. Legacy implementation code is not copied or imported.

Implementation modules stay deliberately focused; see [CONTRIBUTING.md](./CONTRIBUTING.md) for the split-review guardrail. Durable project policy lives in [AGENTS.md](./AGENTS.md).

## What runs today

The full agent loop runs on the durable pipeline and is live-proven end to end
(see [docs/agent-stack-runbook.md](./docs/agent-stack-runbook.md) for the exact
entry points, environment, and knobs):

- **Daemon** (`apps/daemon`): loopback HTTP ingress serving `/command`,
  `/events/read`, `/affordances/read`, `/documents/dossier/read`. Boots
  fail-closed on a fresh SQLite store, mints genesis recovery binding, and
  refuses unauthenticated, cross-origin, stale-protocol, or malformed requests
  with stable reason codes from the runtime error registry.
- **Scoped MCP surface**: the standalone stdio entry is
  `apps/daemon/src/mcp-main.ts`; the wrapper uses one trusted loopback HTTP host
  and per-agent bearer credentials. The daemon's decoder stays the only payload
  authority.
- **Wrapper** (`apps/daemon/src/orchestrator/agent-wrapper-main.ts`): staffs
  READY, unclaimed non-human steps with a scoped agent session and a real
  `claude -p` process; human approval and goal closure are never delegated. A
  daemon-side development verifier reruns a node test before acceptance.
- **Control room** (`apps/control-room`): the truth-preserving board; `?live=1`
  over the Vite proxy renders the daemon's own offer surface and dispatches
  offers back verbatim.
- **Packages**: `contracts` (dependency-free types, limits, codecs), `core`,
  `scheduler` (zero-authority structural preview), `store` (durable event and
  decision storage, subscriptions, snapshots, recovery), `runner`,
  `coordination`, `review`, `context`, `mcp`, `import` (deterministic read-only
  legacy import), `control-room-client` / `control-room-model`, `skills`,
  `testkit` (DEVELOPMENT_ONLY / NOT_CONFIRMATORY references). Adapters under
  `adapters/` (IDE contract, JetBrains) are integration boundaries.

Authority, persistence, provider effects, and presentation stay separated;
missing or unverifiable evidence is `UNKNOWN` and gains no authority.

## What this is not

Nothing here is a readiness, GA, or comparative claim. The design's Phase 0
freeze manifest and independent `FREEZE_READY` decision are not recorded; the
`node:sqlite` driver decision in
[docs/plans/2026-08-09-node-sqlite-driver-decision.md](./docs/plans/2026-08-09-node-sqlite-driver-decision.md)
is `PROPOSED — AWAITING HUMAN RATIFICATION`; the pinned benchmark specification
is unresolved (see
[docs/plans/2026-08-09-benchmark-spec-hash-resolution.md](./docs/plans/2026-08-09-benchmark-spec-hash-resolution.md)).
Development fixtures and payload hints are `DEVELOPMENT_ONLY` and confirm
nothing. Phase 0 tooling can capture and check evidence in memory but never
returns an authoritative `decision: GO`, `status: VERIFIED`, or freeze-decision
bytes; a non-caller-mintable trust boundary is still required before any
authoritative decision can exist.

The current verifier is not an adversarial trust boundary: it runs a shell
recipe from an agent-modifiable workspace under the wrapper's OS account. The
live event feed also lacks durable exact-cursor acknowledgement, and the release
inventory records source subjects rather than runnable daemon/control-room
artifacts. These are release blockers, not operator configuration issues.

## Commands

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test                       # packages/** and tests/**
pnpm --filter @moe/daemon test  # apps/** is not discovered by the root gate
pnpm verify:foundation
pnpm verify:store
pnpm test:integration           # run from PowerShell (MSYS tar breaks it)
pnpm test:fault
pnpm test:security
pnpm test:property
pnpm test:e2e
pnpm test:e2e:browser
```

Never claim success without a fresh foreground run and its exit status.
