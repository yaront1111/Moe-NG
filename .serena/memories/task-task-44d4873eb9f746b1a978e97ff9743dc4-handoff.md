# Durable verification receipt dispatch planning handoff

- Task `task-44d4873eb9f746b1a978e97ff9743dc4` was claimed for planning, re-measured, and reported BLOCKED rather than given a speculative plan.
- Hard dependencies in the task comment: Verification process wrapper `task-69f2b6f785ca4ba3a932a8256b0edfb8` and Durable Claude attempt dispatch `task-6cbff01023b14b26a78fc5e3eb1dd8a9`.
- Board state at measurement: verifier wrapper DONE; durable attempt dispatch BLOCKED on the Windows Claude launcher chain.
- Disk evidence: all five owned verification-dispatch paths are absent/clean, and all `apps/daemon/src/work/foundation-attempt-{contracts,service}.{ts,js}` prerequisite paths are absent. Production search found no `FoundationAttempt`, `foundation-attempt`, `readCurrentEffectSessionBinding`, `inputManifestId`, or `resultManifestId` attempt authority surface.
- The landed runner prerequisite is real and public: production grep confirmed `runVerifierProcess`, `buildEvidenceReceipt`, `VerificationRecipe`, and `EvidenceReceipt` exported through the runner evidence surface.
- Block reason: without the durable attempt producer, an architect cannot name the exact stored manifest/runtime/recipe loaders, atomic verification activation/replay keys, or persisted read-model transaction without guessing or recreating authority in this evidence task.
- Resume only after `task-6cbff01023b14b26a78fc5e3eb1dd8a9` is DONE. Re-probe its exact production symbols and public daemon reachability before planning, because task descriptions are stale by default.
- Do not narrow the DoD, deep-import, or use a mock-backed attempt journey. The downstream real consumer remains review-qualified goal closure `task-8f9305b9bb5e4b8db327a55981b2ea0e`.
