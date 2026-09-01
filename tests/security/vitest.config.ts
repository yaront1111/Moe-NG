/**
 * Security lane runner — isolated from the ordinary root suite.
 *
 * Only `*.security.ts` runs here. The ordinary root config discovers `*.test.ts`
 * only, so nothing in this lane is ever counted as ordinary regression evidence,
 * and the `*.fault.ts`/`*.test.ts`/`*.spec.ts` suffixes are excluded explicitly
 * so a file dropped into this tree cannot be executed by both lanes.
 *
 * Collecting this lane's cases confers NO security PASS of any kind. The lane
 * holds the boundary roster, completeness ratchet, runtime-provider slices,
 * transport/store/scheduler boundaries, and the lane smoke that certifies
 * discovery, typechecking and execution. Runtime-provider coverage is credited
 * only from run-scoped receipts written by cases that actually executed.
 *
 * The settings mirror the fault lane on purpose: one file at a time, one case at
 * a time, no retries, no focused tests, no swallowed unhandled rejections, and a
 * file order fixed by module id rather than by a previous run's cached timings.
 * Runtime-provider slices run before completeness so the final ratchet can read
 * every executed cross-fork receipt; all other files retain module-id order.
 * `passWithNoTests: false` makes an empty lane exit non-zero.
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

const isCompleteness = (file: TestSpecification): boolean =>
  file.moduleId.replaceAll("\\", "/").endsWith("/completeness.security.ts");

class SecurityLaneSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((left, right) => {
      const completenessOrder = Number(isCompleteness(left)) - Number(isCompleteness(right));
      return completenessOrder || byModuleId(left, right);
    });
  }
}

export default defineConfig({
  root: LANE_ROOT,
  test: {
    environment: "node",
    globalSetup: ["./lane-global-setup.ts"],
    pool: "forks",
    isolate: true,
    include: ["**/*.security.ts"],
    exclude: [...configDefaults.exclude, "**/*.fault.ts", "**/*.test.ts", "**/*.spec.ts"],
    passWithNoTests: false,
    allowOnly: false,
    retry: 0,
    dangerouslyIgnoreUnhandledErrors: false,
    fileParallelism: false,
    maxConcurrency: 1,
    sequence: {
      concurrent: false,
      shuffle: false,
      sequencer: SecurityLaneSequencer,
    },
  },
});
