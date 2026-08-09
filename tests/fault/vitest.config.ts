/**
 * Fault lane runner — isolated from the ordinary root suite.
 *
 * The root config discovers `*.test.ts` only, so the hostile `*.fault.ts`
 * suffix never becomes ordinary regression evidence. This lane runs those files
 * plus the committed Foundation `*.test.ts` cases, which are the reason the lane
 * is never empty.
 *
 * The lane is deliberately boring: one file at a time, one case at a time, no
 * retries, no focused tests, no swallowed unhandled rejections, and an explicit
 * file order that neither a previous run's cached timings nor the host locale
 * can change. `passWithNoTests: false` makes a lane that collected nothing exit
 * non-zero instead of reporting a green with no subject.
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

class FaultLaneSequencer extends BaseSequencer {
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
    include: ["foundation/**/*.test.ts", "**/*.fault.ts"],
    exclude: [...configDefaults.exclude, "**/*.security.ts"],
    passWithNoTests: false,
    allowOnly: false,
    retry: 0,
    dangerouslyIgnoreUnhandledErrors: false,
    fileParallelism: false,
    maxConcurrency: 1,
    sequence: {
      concurrent: false,
      shuffle: false,
      sequencer: FaultLaneSequencer,
    },
  },
});
