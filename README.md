# Moe Next

Moe Next is a greenfield, local-first orchestration control plane for reliable multi-agent software work.

This repository is independent from legacy Moe. Legacy implementation code is not copied or imported.

Implementation modules stay deliberately focused; see [CONTRIBUTING.md](./CONTRIBUTING.md) for the split-review guardrail.

## Current status

The repository is a provisional pre-freeze foundation spike. It contains test infrastructure, contract-neutral evidence primitives, a durable SQLite event and decision store (`pnpm verify:store`), bounded-JSON input contracts, a control-room truth-presentation kernel, a DEVELOPMENT_ONLY / NOT_CONFIRMATORY scheduler-fairness aging reference, and a pure structural graph-analysis kernel. Each of these is a substrate, and none of them is authority:

- The graph kernel validates bounded HARD-edge DAG shapes and reports structural/frontier facts; it has no persistence, command, approval, provider, lease, budget, or execution authority.
- The event store persists events and decisions and refuses to open below a minimum SQLite version (`SQLITE_VERSION_UNSUPPORTED`). It is storage only and grants no command, approval, or execution authority. Its `node:sqlite` driver was adopted without the design-required packaging/fault spike; the retroactive record in [docs/plans/2026-08-09-node-sqlite-driver-decision.md](./docs/plans/2026-08-09-node-sqlite-driver-decision.md) is `PROPOSED — AWAITING HUMAN RATIFICATION`, not a ratified decision.
- The bounded-JSON contracts bound and reject untrusted input; accepting a document says nothing about whether any caller was authorized to send it.
- The truth-presentation kernel maps truth classes to display descriptors. It renders what a fact's provenance already is and can never upgrade one, and `UNKNOWN` is a representable outcome rather than a failure to compute.
- The fairness reference is an executable DEVELOPMENT_ONLY model explicitly marked NOT_CONFIRMATORY. It is not the production scheduler and confirms nothing about one.

This does not count as Phase 1 completion until the six-document Phase 0 manifest and independent `FREEZE_READY` decision are recorded. It is not a production daemon, is not benchmark evidence, and makes no readiness or comparative claim. The benchmark specification the design pins is itself unresolved; see [docs/plans/2026-08-09-benchmark-spec-hash-resolution.md](./docs/plans/2026-08-09-benchmark-spec-hash-resolution.md).

Phase 0 tooling can capture exact files through a fail-closed Node/Git adapter and evaluate their internal consistency in memory. The result is only an `EVIDENCE_CONSISTENT` candidate whose claimed Yaron authorization and claimed reviewer verdict are explicitly unauthenticated; it never returns an authoritative `decision: GO`, `status: VERIFIED`, or freeze-decision bytes. It also exposes no command that writes the named manifest or decision. A future non-caller-mintable trust boundary is required before any authoritative decision can exist. The real artifacts remain forbidden until the missing Moe review contains the required five-input review receipt and Yaron gives a separate post-review design-freeze `GO` through that trusted boundary.

## Commands

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:meta
pnpm verify:foundation
pnpm verify:store
```
