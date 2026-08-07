# Graph Preview Composition Slice

**Goal:** Expose one pure package-root function that validates an unknown graph snapshot, optionally validates caller-supplied frontier facts, and returns deterministic structural analysis without granting execution or approval authority.

**Boundary:** `@moe/scheduler` only. No persistence, command processing, graph mutation, approval, admission, dispatch, lease, budget, provider, or duration inference. An omitted or explicitly undefined frontier preserves all readiness widths as `null`; any other malformed supplied frontier fails closed. External adapters retain the existing 1 MiB body limit plus depth and string caps before invoking this bounded-value API.

## Work

- [x] Verify the existing validation, frontier, analysis, provenance, immutability, and package-boundary contracts.
- [x] Add RED package-root contract tests for the preview export.
- [x] Add RED behavior tests for closed outcomes, UNKNOWN preservation, determinism, and immutability.
- [x] Add focused preview model and composition modules with runtime bridges.
- [x] Export the API through the supported package root and runtime smoke path.
- [x] Run scheduler/root/typecheck/static gates and keep every new implementation file focused.
- [x] Obtain independent adversarial review, resolve findings, and commit exact reviewed bytes.

## Truth contract

The result is one of `OPTIONS_INVALID`, `POLICY_INVALID`, `GRAPH_INVALID`, `FRONTIER_INVALID`, or `ANALYZED`. Every preview is explicitly `authority: "NONE"` and `advisoryOnly: true`. `graphIdentity` binds structure only; the non-cryptographic `previewIdentity` additionally binds resolved policy and normalized frontier facts so policy/readiness variants cannot share a cache key. Neither is an authoritative content hash. Supplied frontier facts are labeled `CALLER_SUPPLIED_UNVERIFIED`, and numeric widths are conditional on those assertions. The composition never treats malformed supplied facts as absent, upgrades UNKNOWN dependencies, exposes validated internals, or turns structural findings into execution decisions.
