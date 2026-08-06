# Moe Next

Moe Next is a greenfield, local-first orchestration control plane for reliable multi-agent software work.

This repository is independent from legacy Moe. Legacy implementation code is not copied or imported.

Implementation modules stay deliberately focused; see [CONTRIBUTING.md](./CONTRIBUTING.md) for the split-review guardrail.

## Current status

The repository is a provisional pre-freeze foundation spike. It contains test infrastructure and contract-neutral evidence primitives only. It does not count as Phase 1 completion until the six-document Phase 0 manifest and independent `FREEZE_READY` decision are recorded. It is not a production daemon, is not benchmark evidence, and makes no readiness or comparative claim.

## Commands

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:meta
pnpm verify:foundation
pnpm verify:store
```
