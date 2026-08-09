import { defineConfig } from "@playwright/test";

/**
 * Browser lane for the static control-room smoke journey.
 *
 * WHAT THIS LANE IS. The served application renders COMMITTED FIXTURES through
 * ControlRoomScaffold. No daemon is attached and no transport exists in this
 * repository, so a green run here certifies that the bundle mounts — nothing
 * about a connected system.
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
 * owned in `static-ports.ts` and driven from inside the journey.
 *
 * ONE browser, one worker, no retries: a smoke gate must be cheap and must not
 * be able to hide a flake behind a retry.
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
  reporter: [["list"]],
  // Generated on failure only; ignored by this directory's .gitignore so no
  // evidence artifact can reach a commit.
  outputDir: "./test-results",
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
