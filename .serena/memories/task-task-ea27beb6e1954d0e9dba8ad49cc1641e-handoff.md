# task-ea27beb6e1954d0e9dba8ad49cc1641e handoff

Blocked at step 1 with zero bytes: the planned daemon normalization gap is stale/closed by DONE task-159f4c21ef9149e8a65f24735c9c1475.

Measured landed production:
- bare-root `@moe/runner.normalizeProviderUsage`, published through `surface/provider-record-surface.ts` and pinned by root/runtime tests;
- `provider-usage-normalization.ts` already calls bare-root scheduler `normalizeUsageMeasurement` for each token meter, threads per-meter prior accepted NormalizedMeasurement, keeps UNKNOWN quantity null/PARTIAL bounds, and preserves authority issues;
- runner manifest already depends on scheduler; `buildProviderRunRecord` consumes it.

The approved task cannot be implemented literally: public `ClaudeTelemetryHandoff` has no raw usage-envelope array. Rebuilding envelopes in daemon would copy landed `sourceOf`, `rowFor`, token-meter and source/coverage decisions, which this task explicitly forbids. A wrapper around runner's already-composed surface would require a different plan/DoD and would not satisfy the current direct-scheduler wording.

Governance must archive/replan after measuring whether a daemon-only draft ProviderRunRecord adapter is still absent. Do not create provider-run-normalize.* under the current plan. See `mem:task-task-159f4c21ef9149e8a65f24735c9c1475-handoff`.