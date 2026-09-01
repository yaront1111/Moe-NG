# Moe Next

Moe is a trustworthy autonomous software company: give it a PRD, and it
designs, builds, verifies, deploys, and improves the product — from PRD to
production, with a trace that survives an adversary. The local-first
orchestration control plane, the authority system, and the evidence model in
this repository are the engine that makes that promise provable; they are not
the promise. The vision, the human gates, and the staged roadmap live in
[docs/VISION.md](./docs/VISION.md).

This repository is independent from legacy Moe. Legacy implementation code is not copied or imported.

Implementation modules stay deliberately focused; see [CONTRIBUTING.md](./CONTRIBUTING.md) for the split-review guardrail. Durable project policy lives in [AGENTS.md](./AGENTS.md).

## What runs today

The full agent loop runs on the durable pipeline; it was live-proven end to end
on 2026-08-09/10 — operational evidence from that dated run, not a release or
security-boundary claim (see
[docs/agent-stack-runbook.md](./docs/agent-stack-runbook.md) for the exact
entry points, environment, and knobs):

- **Daemon** (`apps/daemon`): loopback HTTP ingress serving `/command`,
  `/events/read`, `/events/ack`, `/affordances/read`, `/documents/dossier/read`. Boots
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
- **Control room** (`apps/control-room`): the truth-preserving board and the
  operating surface. Packaged Windows runs serve it from the manager or the
  selected project's own loopback daemon and attach through a one-use pairing
  ticket; the Vite proxy remains a development path. Every step the daemon marks
  READY dispatches from its card — the daemon's own gates answer each click,
  refusals render verbatim, and cards move only when the ledger does. Frozen fixtures
  are available only from the Vite development server behind `?fixtures=1`; production
  entry routing strips that selector and the Windows pack gate rejects fixture bytes.
  A build with no credentials shows a configuration notice, never fixtures in their place.
- **Packages**: `contracts` (dependency-free types, limits, codecs), `core`,
  `scheduler` (zero-authority structural preview), `store` (durable event and
  decision storage, subscriptions, snapshots, recovery), `runner`,
  `coordination`, `review`, `context`, `mcp`, `import` (deterministic read-only
  legacy import), `control-room-client` / `control-room-model`, `skills`,
  `benchmark` (DEVELOPMENT_ONLY, parked to v0.2), `testkit` (DEVELOPMENT_ONLY /
  NOT_CONFIRMATORY references). Adapters under `adapters/` (IDE contract,
  JetBrains) are integration boundaries; IDE/portability work is parked to v0.2
  under the 2026-08-18 scope freeze.

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

This repository is stamped `0.1.0` under the MIT [LICENSE](./LICENSE), and every
workspace package stays `private: true`. The version marks the scope-frozen v0.1
line (Windows + Claude + linear execution + local single node); it is not a
published release. The repository now carries a Windows supervised-MVP artifact
pipeline (`pnpm pack:windows`) with a built control room and a `moe` CLI for
`projects`, `init`, `start`, help, and version. It refuses dirty shipped paths by
default and is still not a signed, auto-updating, Node-bundled, or npm-published
product. The self-host canary is not green either — its chain is still open. The
current verifier is not an adversarial trust boundary:
it runs a shell recipe from an agent-modifiable workspace under the wrapper's OS
account; for v0.1 it ships as a documented trusted-workspace limitation (human
decision 2026-08-18), and a hermetic verifier is v0.2. The unsigned artifact and
the unproven canary remain release blockers, not operator configuration issues.
The next major milestone is Stage 1 of the vision — a small but real PRD taken
to a proof-carrying, verified pull request (see [docs/VISION.md](./docs/VISION.md)).

## Windows: start your first project

The extracted supervised-MVP artifact is manager-first. Export one supported
agent credential, then keep this command running in its PowerShell window:

```powershell
.\moe.cmd projects
```

Open the printed
`http://127.0.0.2:39122/?projects=1#manager=<one-use-ticket>` URL manually within
60 seconds. Create a new Windows project or register an existing initialized
directory, select Start, then Open. The manager owns one contained daemon and
SQLite store per running project; use its rows to move between project tabs.
Goals, tasks, and boards remain bound to the project daemon/session that opened
the tab. Ctrl-C in the manager console stops the manager and every project
runtime it owns.

A newly created directory is immediately usable for project switching and its
isolated setup board, but it is not silently marked activated. **New Goal** stays
disabled until that project has legitimate durable repository, provider,
distribution, backup, credential, and store receipts. The current fresh-project
browser flow does not mint those authorities; its exact blocked cards are an
honest product limitation, not a credential or UI failure.

For a single project without the manager UI, `moe init <dir>` followed by
`moe start <dir>` remains supported. It runs that project in the foreground and
prints a one-use `#pair=` URL with the same 60-second window. Moe never launches
a bearer-bearing URL for you; see the
[agent stack runbook](./docs/agent-stack-runbook.md) for credentials, switching,
ticket recovery, and the exact containment boundary.

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
