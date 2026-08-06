# Moe Next

Moe Next is a greenfield, local-first orchestration control plane for reliable multi-agent software work.

This repository is independent from legacy Moe. Legacy implementation code is not copied or imported.

Implementation modules stay deliberately focused; see [CONTRIBUTING.md](./CONTRIBUTING.md) for the split-review guardrail.

## Current status

The repository is a provisional pre-freeze foundation spike. It contains test infrastructure and contract-neutral evidence primitives only. It does not count as Phase 1 completion until the six-document Phase 0 manifest and independent `FREEZE_READY` decision are recorded. It is not a production daemon, is not benchmark evidence, and makes no readiness or comparative claim.

Phase 0 tooling can capture exact files through a fail-closed Node/Git adapter and evaluate their internal consistency in memory. The result is only an `EVIDENCE_CONSISTENT` candidate whose claimed Yaron authorization and claimed reviewer verdict are explicitly unauthenticated; it never returns an authoritative `decision: GO`, `status: VERIFIED`, or freeze-decision bytes. It also exposes no command that writes the named manifest or decision. A future non-caller-mintable trust boundary is required before any authoritative decision can exist. The real artifacts remain forbidden until the missing Moe review contains the required five-input review receipt and Yaron gives a separate post-review design-freeze `GO` through that trusted boundary.

## Commands

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:meta
pnpm verify:foundation
pnpm verify:store
```
