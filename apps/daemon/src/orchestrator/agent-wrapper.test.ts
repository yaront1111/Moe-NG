import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { createAgentWrapper } from "./agent-wrapper.js";
import type { SpawnRequest } from "./agent-wrapper.js";

/**
 * Integration over the REAL provider and store: the wrapper's session, claim,
 * and fence are durable facts, so the assertions read them back off the
 * affordance surface rather than off any wrapper state.
 */

const OPERATOR = "wrapper-operator-credential";
const directory = mkdtempSync(join(tmpdir(), "moe-wrapper-"));
// Real time base: the provider's session authenticator judges expiry against
// the real clock, so a fictional epoch would make every minted session
// pre-expired and refuse the agent's own claim.
const NOW = Date.now();
const provider = createStoreDependencies({
  credential: OPERATOR,
  principalId: "operator-local",
  projectId: "proj-wrapper",
  storePath: join(directory, "store.db"),
});

afterAll(() => {
  provider.close();
  rmSync(directory, { force: true, recursive: true });
});

const spawned: SpawnRequest[] = [];
let minted = 0;

const affordances = provider.affordances;
if (affordances === undefined) throw new Error("provider serves no affordances");

const wrapper = createAgentWrapper({
  affordances: affordances(),
  claimTtlMs: 60_000,
  clock: () => NOW,
  deps: provider.provide(),
  maxAgents: 2,
  mintSecret: () => `secret-${String(minted += 1).padStart(4, "0")}${"0".repeat(28)}`,
  operatorCredential: OPERATOR,
  spawnAgent: (request) => {
    spawned.push(request);
    return new Promise(() => undefined); // agents stay "running" for the test
  },
});

describe("createAgentWrapper", () => {
  it("staffs unclaimed READY steps up to maxAgents, claiming under agent identities", () => {
    const report = wrapper.runOnce();
    expect(report.surfaceOutcome).toBe("SURFACE");
    expect(report.spawned).toHaveLength(2);
    expect(report.spawned.every((entry) => entry.outcome === "SPAWNED")).toBe(true);
    expect(spawned).toHaveLength(2);
    // The durable fence names the agent session, not the wrapper or operator.
    const surface = affordances().readSurface();
    if (surface.outcome !== "SURFACE") throw new Error(surface.code);
    const claimedSteps = surface.steps.filter((step) => step.claim !== null);
    expect(claimedSteps.length).toBeGreaterThanOrEqual(2);
    for (const step of claimedSteps) {
      expect(step.claim?.claimedBy).toMatch(/^sess-wrap-/u);
    }
  });

  it("gives the agent a mission naming its claimed item and the release contract", () => {
    const request = spawned[0];
    if (request === undefined) throw new Error("nothing spawned");
    expect(request.mission).toContain(request.workItemId);
    expect(request.mission).toContain("work_release");
    expect(request.credential).toMatch(/^secret-/u);
  });

  it("does not double-staff: the next pass sees the claims and spawns nothing", () => {
    const report = wrapper.runOnce();
    expect(report.spawned).toHaveLength(0);
    expect(report.active).toBe(2);
  });
});
