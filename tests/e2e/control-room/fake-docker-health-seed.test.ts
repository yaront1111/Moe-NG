import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createDockerDouble } from "../../../apps/daemon/src/deployment/deploy-ports.js";
import {
  copyEnvironmentArgv, createCandidateArgv, runCandidateArgv, startCandidateArgv,
} from "../../../apps/daemon/src/deployment/deploy-candidate-environment.js";
import type { ContainerState } from "../../../apps/daemon/src/deployment/deploy-ports.js";

/**
 * THE CONTROL-ROOM LANE'S HEALTH SEED, for both ways a candidate can be brought up.
 *
 * `fake-docker-dependencies.ts` is a dependency-provider module with import-time side effects — it
 * reads its store env and truncates a calls file — so this imports the ONE pure decision out of it
 * and drives it against the REAL double. That keeps the assertion on the shipped surface rather
 * than on a restatement of it: `seededCandidate` is the exact function the lane's `docker` runner
 * calls, not a copy written here.
 */

const root = mkdtempSync(join(tmpdir(), "moe-fake-docker-seed-"));
afterAll(() => {
  // Windows answers EPERM while the imported provider still holds its SQLite handle, exactly as
  // `deploy-candidate-environment.ts`'s own `remove()` documents. A bounded, empty temp directory
  // that outlives the run is visible and harmless; failing the suite over it is not.
  try { rmSync(root, { force: true, recursive: true }); } catch { /* see above */ }
});

const CANDIDATE = "moe-candidate-lane";
const SCRIPT: readonly ContainerState[] = ["STARTING", "HEALTHY"];

/** Two consecutive health probes, which is what a deploy does while it waits. */
const probe = async (double: ReturnType<typeof createDockerDouble>): Promise<readonly string[]> => [
  (await double.docker(["inspect", "--format", "{{.State.Health.Status}}", CANDIDATE])).stdout,
  (await double.docker(["inspect", "--format", "{{.State.Health.Status}}", CANDIDATE])).stdout,
];

describe("the control-room fake seeds health for both ways a candidate starts", async () => {
  // Imported dynamically because the module's top level throws without the store env it reads.
  process.env["MOE_DAEMON_CREDENTIAL"] ??= "c".repeat(64);
  process.env["MOE_PROJECT_ID"] ??= "proj-fake-docker-seed";
  process.env["MOE_STORE_PATH"] ??= join(root, "store.sqlite");
  const { seedCandidateHealth, seededCandidate } = await import("./fake-docker-dependencies.js");

  it("names the container for run, create and start, and for nothing else", () => {
    // The three verbs that bring a candidate up, each through the SHIPPED argv builder rather than
    // a hand-written argv — so a builder that stopped emitting `--name` would red here too.
    expect(seededCandidate(runCandidateArgv(CANDIDATE, "n", "t"))).toBe(CANDIDATE);
    expect(seededCandidate(createCandidateArgv(CANDIDATE, "n", "t"))).toBe(CANDIDATE);
    expect(seededCandidate(startCandidateArgv(CANDIDATE))).toBe(CANDIDATE);
    // `cp` moves bytes into a container that already exists; it brings nothing up.
    expect(seededCandidate(copyEnvironmentArgv(CANDIDATE))).toBeUndefined();
    expect(seededCandidate(["inspect", "--format", "{{.State.Health.Status}}", CANDIDATE])).toBeUndefined();
    expect(seededCandidate(["build", "--tag", "t", "-"])).toBeUndefined();
    // THE OLD BUG THIS REPLACES: `args[args.indexOf("--name") + 1]` returned `args[0]` when the
    // flag was absent, so a `start` would have seeded a script under the name "start".
    expect(seededCandidate(startCandidateArgv(CANDIDATE))).not.toBe("start");
  });

  it("gives a run-started candidate the SAME script it gets today", async () => {
    const health: Record<string, readonly ContainerState[]> = {};
    const double = createDockerDouble({ health });
    const argv = runCandidateArgv(CANDIDATE, "moe-net", "tag:1");

    expect(seedCandidateHealth(health, argv, SCRIPT)).toBe(true);
    await double.docker(argv);
    expect(health[CANDIDATE]).toEqual(SCRIPT);
    expect(await probe(double)).toEqual(["starting\n", "healthy\n"]);
  });

  it("gives a create-then-start candidate one too, seeded ONCE across the three calls", async () => {
    const health: Record<string, readonly ContainerState[]> = {};
    const double = createDockerDouble({ health });
    const seeded: boolean[] = [];
    for (const argv of [createCandidateArgv(CANDIDATE, "moe-net", "tag:1"),
      copyEnvironmentArgv(CANDIDATE), startCandidateArgv(CANDIDATE)]) {
      seeded.push(seedCandidateHealth(health, argv, SCRIPT));
      await double.docker(argv, argv[0] === "cp" ? "ARCHIVE" : undefined);
    }

    // OBSERVED, not inferred: `create` seeds, `cp` and `start` do not. Re-seeding on `start` would
    // hand a fresh script to a deploy midway through the first, so the HEALTHY answer it waits for
    // would keep receding. Asserting the effect alone cannot see this — the second write stores an
    // equal array — which is why the decision is returned.
    expect(seeded).toEqual([true, false, false]);
    expect(health[CANDIDATE]).toEqual(SCRIPT);
    expect(Object.keys(health)).toEqual([CANDIDATE]);
    expect(await probe(double)).toEqual(["starting\n", "healthy\n"]);
  });
});
