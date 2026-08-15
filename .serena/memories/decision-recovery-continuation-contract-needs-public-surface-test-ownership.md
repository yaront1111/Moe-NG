# Decision: a strict public runner contract migration owns its root surface test

When an implementation changes the exact request shape of a runner function already exported from `@moe/runner`, grep `packages/runner/src/index-surface.test.ts` before planning. If that test calls the old shape, the migration cannot truthfully claim the runner package gate while the test is outside ownership.

Do not preserve an admitting legacy overload/default merely to keep the old surface test green when the objective is to require new durable authority evidence. Missing classification must fail closed. Amend ownership to update the public-root contract test; if a new named constant must be package-root-visible, also own `packages/runner/src/surface/recovery-surface.ts`, whose named allowlist does not grow automatically.

Motivating task: `task-5855a9c6b8da4a428dd0e75ed9ae36d1`. A live five-class probe proved every classification currently binds when callers supply release/handoff, while the unowned root test expects the classification-free admitting API.
