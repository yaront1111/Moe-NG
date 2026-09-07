/**
 * THE CODEX SEAT, OFFLINE, OVER THE REAL MCP WIRE.
 *
 * A scripted codex double drives a REAL daemon end to end: the planning reads, then
 * `planning.submit_decomposition`, then a `node.deliver` reaching verifier ACCEPTED and lander
 * COMMITTED. Every verdict below is read from the DURABLE STORE after the processes are dead -
 * never from the double's exit code and never from its stdout, because a double that exits 0
 * having landed nothing is exactly the failure the negative arm exists to catch.
 *
 * WHICH REGISTRY SERVES `planning.submit_decomposition`, settled rather than assumed.
 * `daemon-v2-command-registry.ts` WITHHOLDS that kind from the v2 roster until its `/2` service
 * consumes the authority-safe compiler. The v2 plane is entered only when the durable cutover
 * marker names it (`resolveCommandPlane` in mcp-dispatch-port.ts reads it fresh per dispatch and
 * defaults to V1), and nothing in this directory ever activates that marker - so this journey
 * runs on a fresh store against the V1 registry, where the kind IS served. THAT IS THE BRANCH
 * THIS FILE TAKES: the happy path asserts the submit COMMITTED. If a future world here activates
 * the cutover marker, this arm must be re-aimed at the exact roster refusal instead of relaxed.
 *
 * The real `codex exec` run is another row's (task-c090faae); the spawn-surface parity itself is
 * task-48932bec's. Neither is exercised here - this is the OFFLINE proof.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { killTree, startDaemon } from "./j1-loop-harness.js";
import type { ProcessRun } from "./j1-loop-harness.js";
import {
  CODEX_NODE_KEY,
  type CodexScratch,
  type SpawnRecord,
  compiledPlanDecisions,
  createCodexScratch,
  decisionsOfKind,
  isVersionProbe,
  missionsOfKind,
  readDeliveryView,
  runCodexPass,
  spawnRecords,
  writeCodexShim,
} from "./codex-journey-harness.js";
import type { DeliveryView } from "./codex-journey-harness.js";
import { decidePlan, preludeThroughGate1, sealedNodeKeysOf } from "./j5-plan-reject-harness.js";
import { delivered, removeMultiNodeScratches } from "./multi-node-reads.js";
import { daemonWire, readSurface } from "./multi-node-wire.js";

const JOURNEY_TIMEOUT_MS = 900_000;
const NEGATIVE_TIMEOUT_MS = 600_000;
const PLANNING_KIND = "planning.submit_decomposition";
const RELEASE_KIND = "work.release";
/** The prefix the codex double stamps on its OWN release, so the wrapper's cleanup is separable. */
const DOUBLE_RELEASE_PREFIX = "codex-release-";

const scratches: CodexScratch[] = [];
afterAll(() => removeMultiNodeScratches(scratches));

/** The daemon needs the compiled-execution facts the multi-node repository is built around. */
function daemonEnvironment(scratch: CodexScratch): Record<string, string> {
  return {
    MOE_NODE_SPECS_DIR: "",
    MOE_NODE_TEST_COMMAND: "node test.mjs",
    MOE_NODE_WORKSPACE: scratch.workspace,
  };
}

interface CodexRun {
  readonly passes: readonly ProcessRun[];
  readonly runId: string | null;
  readonly scratch: CodexScratch;
}

/**
 * ONE PASS OF THE WHOLE JOURNEY, parameterised only by the shim the wrapper is handed.
 *
 * The operator's plan APPROVE is sent over HTTP by the TEST, not by the seat: this row certifies
 * the codex seat, and a human decision the seat made itself would be a different claim.
 */
async function driveCodexJourney(
  shimOptions: Parameters<typeof writeCodexShim>[1], deliver: boolean,
): Promise<CodexRun> {
  const scratch = createCodexScratch();
  scratches.push(scratch);
  const daemon = await startDaemon(scratch, daemonEnvironment(scratch));
  const wire = daemonWire(daemon.origin, scratch.credential);
  const passes: ProcessRun[] = [];
  let runId: string | null = null;
  try {
    await preludeThroughGate1(scratch, wire, {
      nowIso: new Date().toISOString(), nowMs: Date.now(),
    });
    const shim = writeCodexShim(scratch, shimOptions);
    passes.push(await runCodexPass(scratch, shim));
    if (deliver) {
      const decision = await decidePlan(wire, await readSurface(wire, scratch.projectId),
        "APPROVE", null);
      runId = decision.runId;
      passes.push(await runCodexPass(scratch, shim));
    }
  } finally {
    await killTree(daemon.child);
  }
  return { passes, runId, scratch };
}

/** The one codex spawn surface every arm reads; a pass with none never staffed a seat at all. */
function firstSpawn(scratch: CodexScratch): SpawnRecord {
  const records = spawnRecords(scratch);
  if (records.length === 0) throw new Error("no seat recorded a spawn surface");
  return records[0] as SpawnRecord;
}

describe("a scripted codex double drives the real MCP wire", () => {
  let happy: CodexRun;
  let view: DeliveryView;

  beforeAll(async () => {
    happy = await driveCodexJourney({}, true);
    view = readDeliveryView(happy.scratch, CODEX_NODE_KEY);
  }, JOURNEY_TIMEOUT_MS);

  it("reaches planning.submit_decomposition, verifier ACCEPTED and lander COMMITTED", () => {
    // The seat was really staffed on the planning lane, and it read the daemon's own mission.
    expect(missionsOfKind(happy.scratch, PLANNING_KIND).length).toBeGreaterThanOrEqual(1);

    // THE V1 BRANCH (see this file's header): the kind is SERVED, so the submit was ACCEPTED
    // and the daemon compiled the plan. Its durable trace is the compiled planning chain, not a
    // decision row of the submitted kind - `compiledPlanDecisions` records why.
    const compiled = compiledPlanDecisions(happy.scratch);
    expect(compiled.length).toBeGreaterThanOrEqual(1);
    for (const row of compiled) {
      expect(row.effectDisposition).toBe("EFFECTS_COMMITTED");
      expect(row.resultCode).toBe("EFFECTS_COMMITTED");
    }

    // The graph the codex seat planned, read off the sealed run rather than off its stdout.
    expect(happy.runId).not.toBeNull();
    expect(sealedNodeKeysOf(happy.scratch, happy.runId as string)).toEqual([CODEX_NODE_KEY]);

    // The deliverable, the verifier receipt and the landing sha - all durable, all after death.
    expect(delivered(happy.scratch, CODEX_NODE_KEY)).toContain("export const multiply");
    expect(view.rounds).toBeGreaterThanOrEqual(1);
    expect(view.acceptedReceiptId).not.toBeNull();
    expect(view.landingOutcome).toBe("COMMITTED");
    expect(view.landingSha).toMatch(/^[0-9a-f]{40}$/u);
  }, JOURNEY_TIMEOUT_MS);

  it("releases its own work item on the first try, with an EFFECTS_COMMITTED decision", () => {
    // The wrapper's own cleanup also issues `work.release`; the double's are separated by the
    // commandId it stamps, so this arm grades the SEAT rather than the janitor behind it.
    const releases = decisionsOfKind(happy.scratch, RELEASE_KIND)
      .filter((row) => row.key.commandId.startsWith(DOUBLE_RELEASE_PREFIX));
    expect(releases.length).toBeGreaterThanOrEqual(1);

    // ONE decision per work item is what "on the first try" means: a seat that swept versions
    // would leave a NO_BUSINESS_EFFECT / EXPECTED_VERSION_CONFLICT row beside the committed one.
    const perItem = new Map<string, number>();
    for (const row of releases) {
      perItem.set(row.targetAggregateId, (perItem.get(row.targetAggregateId) ?? 0) + 1);
    }
    expect(perItem.size).toBe(releases.length);
    expect([...perItem.values()].filter((count) => count !== 1)).toEqual([]);
    for (const row of releases) {
      expect(row.effectDisposition).toBe("EFFECTS_COMMITTED");
      expect(row.resultCode).toBe("EFFECTS_COMMITTED");
    }
  }, JOURNEY_TIMEOUT_MS);

});

describe("the codex branch is what actually ran", () => {
  /**
   * ON A WORLD OF ITS OWN, and that is a MEASURED requirement rather than tidiness. Drilled by
   * misnaming the shim: the claude branch then runs, the double refuses the credential path it
   * cannot find, nothing is submitted, and the happy path's `beforeAll` dies at the missing
   * approval offer - which SKIPS every arm inside it. An arm that can be skipped by an upstream
   * failure is not a guard against the failure it was written for, so this one stands alone and
   * needs only the planning pass.
   */
  it("proves the CODEX branch ran, from the spawn surface, not the shim's filename", async () => {
    const run = await driveCodexJourney({}, false);
    // The wrapper's one-per-provider `--version` probe reaches the double through the same
    // invocation path as a seat, so it lands in this sweep without being a seat. It is REMOVED
    // rather than tolerated: relaxing the assertions below to accommodate it would stop them
    // pinning the codex spawn surface, which is the only thing this arm exists to prove.
    const swept = spawnRecords(run.scratch);
    const probes = swept.filter(isVersionProbe);
    const records = swept.filter((record) => !isVersionProbe(record));
    // A filter is only safe if it cannot swallow a real seat: every excluded record is asserted
    // to be a probe on its own terms, and nothing excluded carries the seat's stdin marker.
    for (const probe of probes) {
      expect(probe.argv.at(-1)).toBe("--version");
      expect(probe.argv).not.toContain("-");
    }
    // A sweep that yields zero cases passes silently, so the sweep is asserted AFTER the filter -
    // before it, the guard would be satisfied by a run whose only record was the probe.
    expect(records.length).toBeGreaterThanOrEqual(1);
    for (const record of records) {
      // A filename assertion would be circular - it proves only what the harness wrote. This is
      // what the SPAWNER handed the child, recorded by the child before anything could refuse.
      expect(record.argv).toContain("exec");
      expect(record.argv).toContain("--ignore-user-config");
      expect(record.argv).toContain("--skip-git-repo-check");
      expect(record.argv).toContain("--ephemeral");
      expect(record.argv).toContain("--sandbox");
      expect(record.argv).toContain(
        "mcp_servers.moe-next.bearer_token_env_var=MOE_AGENT_MCP_BEARER",
      );
      expect(record.argv.at(-1)).toBe("-");
      // THE CREDENTIAL INVERSION ITSELF: bearer in the env, origin on argv, no config file.
      expect(record.bearerFromEnvironment).toBe(true);
      expect(record.mcpConfigFlagPresent).toBe(false);
      expect(record.originFromArgv).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      // Claude's own flags must be absent, or the branch under test is not the one that ran.
      for (const claude of ["-p", "--strict-mcp-config", "--allowedTools", "--setting-sources"]) {
        expect(record.argv).not.toContain(claude);
      }
    }
  }, NEGATIVE_TIMEOUT_MS);
});

describe("the journey reads the store, not the process", () => {
  it("fails a double that exits 0 having submitted nothing", async () => {
    const run = await driveCodexJourney({ arm: "skip-submit" }, false);

    // The seat really ran, really received its mission, and really took the clean-exit path.
    expect(firstSpawn(run.scratch).bearerFromEnvironment).toBe(true);
    expect(missionsOfKind(run.scratch, PLANNING_KIND).length).toBeGreaterThanOrEqual(1);
    expect(run.passes[0]?.output).toContain("arm=skip-submit exiting without");

    // And the durable store says nothing happened. An assertion reading the exit code instead
    // would read green here, which is the whole reason this arm exists.
    expect(compiledPlanDecisions(run.scratch)).toEqual([]);
    expect(readDeliveryView(run.scratch, CODEX_NODE_KEY)).toStrictEqual({
      acceptedReceiptId: null, executionRef: null, landingOutcome: null, landingSha: null,
      rounds: 0,
    });
  }, NEGATIVE_TIMEOUT_MS);
});

describe("the shim's basename is what selects the provider", () => {
  it("runs the CLAUDE branch under agent-codex.cmd, so a rename cannot silently revert this", async () => {
    // `isCodexCommand` is `/(?:^|[\\/])codex(?:\.[a-z]+)?$/iu`: the character before "codex" here
    // is a hyphen, which is neither a path separator nor start-of-string. This arm is the drill
    // that keeps the arm above load-bearing, committed rather than performed by hand once.
    const run = await driveCodexJourney({ basename: "agent-codex" }, false);
    const record = firstSpawn(run.scratch);

    expect(record.bearerFromEnvironment).toBe(false);
    expect(record.mcpConfigFlagPresent).toBe(true);
    expect(record.originFromArgv).toBeNull();
    expect(record.argv).toContain("-p");
    expect(record.argv).not.toContain("exec");
    // The double refuses to work without its own credential path, so nothing reached the store.
    expect(compiledPlanDecisions(run.scratch)).toEqual([]);
  }, NEGATIVE_TIMEOUT_MS);
});
