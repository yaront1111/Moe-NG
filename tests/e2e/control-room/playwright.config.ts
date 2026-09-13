import { defineConfig } from "@playwright/test";

/**
 * Browser journeys over the current product workspace: production bundle smoke,
 * explicit development examples, and real daemon-backed operator workflows.
 * Each spec states its evidence and any process doubles. Static examples do not
 * certify live acceptance; daemon journeys retain their own receipt assertions.
 *
 * `testMatch` is the load-bearing line. The root `vitest.config.ts` includes
 * `tests/**\/*.test.ts` under `environment: "node"`, and root `test:e2e` ends in
 * `vitest run tests/e2e`. Restricting this lane to `*.spec.ts` keeps the two
 * lanes disjoint BY NAMING, with no change to `test:e2e`'s definition: the Node
 * lane cannot see a browser spec, and this lane cannot see the pure-logic
 * `harness.test.ts` that proves the lifecycle's reason codes without a browser.
 *
 * There is deliberately no `webServer` block. Playwright's built-in serve and
 * readiness handling reports Playwright's messages, and this harness owes the
 * operator its OWN stable reason codes (see `harness.ts`), so the lifecycle is
 * owned in `static-ports.ts` or `daemon-ports.ts` and driven inside each journey.
 *
 * One browser, one worker, no retries: shared bundle builders run serially and
 * a failure remains visible rather than disappearing behind an automatic retry.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  // A stray `.only` would silently shrink the lane to a subset; refuse it.
  forbidOnly: true,
  fullyParallel: false,
  // The journey builds the real bundle before serving it, so the default 30s
  // per-test budget is not the right one. Still bounded: the harness's own
  // readiness budget refuses with E2E_READINESS_TIMEOUT well inside this.
  timeout: 180_000,
  retries: 0,
  workers: 1,
  // A missing or disabled control should identify its own action, not spend a
  // long provider/landing journey budget before the browser records the failure.
  use: { actionTimeout: 30_000 },
  reporter: [["list"]],
  // Failure diagnostics and explicitly requested QA screenshots stay in the
  // directory excluded by this lane's .gitignore.
  outputDir: "./test-results",
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
