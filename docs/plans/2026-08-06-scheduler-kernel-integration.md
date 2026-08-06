# Scheduler Kernel Integration

**Goal:** Integrate Fable's structural graph kernel into current `main` without importing its known runtime, provenance, or resource-exhaustion gaps.

**Source:** `72ec04fb92a3e8172d42bf7e09998eab0ac9aa4a` + `2bedc287130027ec427736207d0a39573d58dc18` from `fable/scheduler-graph-kernel`.

## Work

- [x] Apply the scheduler package, lockfile importer, and truth-only README status update to current `main`.
- [x] Add RED tests for raw Node loading, forged validated graphs/frontiers, preflight collection limits, and malformed runtime policy input.
- [x] Add focused runtime bridges and opaque supported-API validation provenance.
- [x] Enforce resource limits before element traversal and correct unsupported complexity claims.
- [x] Run scheduler, root, typecheck, runtime-smoke, whitespace, NUL, and file-size gates.
- [x] Obtain independent hostile review, resolve every BLOCKER/MAJOR, and commit the exact reviewed bytes.

## Boundary

This remains a pure structural kernel. It does not activate multi-node execution, persist graph commands, infer semantic dependency truth, dispatch providers, approve work, or create Phase-0 evidence artifacts.

The kernel assumes external adapters reject raw command bodies over the pinned design's 1 MiB cap before parsing, then enforce JSON-depth and string-size caps during decode or before kernel invocation. Exact own-key schema checks operate only after that boundary; direct attacker-constructed objects without a byte cap are not a bounded-input interface.
