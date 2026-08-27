import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// Root gate topology, bounded on purpose.
//
// Vitest 4 runs the `forks` pool with maxWorkers = availableParallelism() when
// nothing is set - 32 forked workers on this host. 64 of the 373 roster files
// spawn their own children (git, tar, node, the Rust broker) and 9 open SQLite
// temp stores, so an unbounded pool multiplies into hundreds of concurrent
// CreateProcess calls and temp-dir writes. On Windows that contention is what
// turns a slow host into timeout-only failures and fatal V8 worker exits while
// every one of those files passes standalone.
//
// Capping the workers is a RESOURCE bound, not a timeout bump, a retry, or an
// exclusion: the include list is unchanged, every roster file still executes,
// and each test keeps its own timeout and assertions. VITEST_MAX_WORKERS still
// wins when an operator sets a usable value.
const WORKER_FLOOR = 2;
const WORKER_CEILING = 8;

function boundedWorkers(): number {
  const override = Number(process.env.VITEST_MAX_WORKERS);
  if (Number.isInteger(override) && override > 0) {
    return override;
  }
  return Math.max(WORKER_FLOOR, Math.min(WORKER_CEILING, Math.floor(availableParallelism() / 4)));
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["adapters/**/*.test.ts", "packages/**/*.test.ts", "tests/**/*.test.ts", "tools/**/*.test.ts"],
    passWithNoTests: false,
    pool: "forks",
    isolate: true,
    fileParallelism: true,
    maxWorkers: boundedWorkers(),
    sequence: {
      concurrent: false,
    },
  },
});
