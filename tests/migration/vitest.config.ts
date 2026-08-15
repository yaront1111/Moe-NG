/**
 * Migration lane runner — the lane that `pnpm test:migration` drives.
 *
 * Until this file landed there was no `test:migration` script and no
 * `tests/migration/tsconfig.json`, so everything under this tree — including the
 * already-committed importer determinism case — was typechecked by nothing and
 * runnable only as a side effect of the ordinary root suite.
 *
 * Unlike the fault and security lanes, this lane deliberately discovers the
 * ordinary `*.test.ts` suffix rather than a private one. Migration cases are
 * ordinary regression evidence: the root config's `tests/**\/*.test.ts` include
 * already runs them, and this lane exists to add the typecheck plus a
 * deterministic single-file order, not to hide them from the root suite.
 *
 * The runner settings mirror `tests/security/vitest.config.ts` on purpose: one
 * file at a time, one case at a time, no retries, no focused tests, no swallowed
 * unhandled rejections, and a file order fixed by module id rather than by a
 * previous run's cached timings. `passWithNoTests: false` makes an empty lane
 * exit non-zero instead of reporting a green with no subject.
 *
 * No `testTimeout` override is set here. The cutover drill's ten-second manifest
 * wait carries its own explicit per-case timeout so the wait is visible at the
 * case that needs it, and so the same case survives the root suite's default.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";
import type { TestSpecification } from "vitest/node";

const LANE_ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Compare by UTF-16 code unit on a separator-normalized id. `localeCompare` is
 * deliberately avoided: its ordering depends on the host's locale, so it would
 * make the executed order differ between machines.
 */
const byModuleId = (left: TestSpecification, right: TestSpecification): number => {
  const a = left.moduleId.replaceAll("\\", "/");
  const b = right.moduleId.replaceAll("\\", "/");
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

class MigrationLaneSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort(byModuleId);
  }
}

export default defineConfig({
  root: LANE_ROOT,
  test: {
    environment: "node",
    pool: "forks",
    isolate: true,
    include: ["**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.fault.ts", "**/*.security.ts", "**/*.spec.ts"],
    passWithNoTests: false,
    allowOnly: false,
    retry: 0,
    dangerouslyIgnoreUnhandledErrors: false,
    fileParallelism: false,
    maxConcurrency: 1,
    sequence: {
      concurrent: false,
      shuffle: false,
      sequencer: MigrationLaneSequencer,
    },
  },
});
