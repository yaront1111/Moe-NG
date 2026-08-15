import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { SqliteEventStore } from "@moe/store";
import { codeMission, createAgentWrapper } from "./agent-wrapper.js";
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
const setupStore = SqliteEventStore.openForProject(join(directory, "store.db"), "proj-wrapper");
installTestRecoveryBinding(setupStore);
setupStore.close();

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

  it("tells a code-node agent the exact work_release payload, so it need not guess", () => {
    // Live run 2026-08-15: a coding agent added a `reason` field to work_release and
    // was refused INPUT_INVALID because this mission, unlike the chain mission, never
    // stated the payload shape. The refusal is correct; the omission was ours.
    const text = codeMission("node.deliver@node-1", "node-1", "2026-01-01T00:00:00.000Z", {
      instructions: "do it", test: "node test.mjs", title: "T", workspace: "D:/ws",
    }, { accept: null, submit: null });
    expect(text).toContain('work_release with payload {"workItemId": "node.deliver@node-1"}');
    expect(text).toContain("no other fields");
  });

  it("never hands a coding agent an acceptance payload it is forbidden to submit", () => {
    const text = codeMission("node.deliver@node-1", "node-1", "2026-01-01T00:00:00.000Z", {
      instructions: "do it", test: "node test.mjs", title: "T", workspace: "D:/ws",
    }, {
      accept: { forgedAcceptanceMarker: "must-not-reach-the-agent" },
      submit: { findings: [], subjectRef: "node-1" },
    });

    expect(text).toContain("Suggested review.submit payload shape");
    expect(text).not.toContain("forgedAcceptanceMarker");
    expect(text).not.toContain("must-not-reach-the-agent");
  });

  it("does not double-staff: the next pass sees the claims and spawns nothing", () => {
    const report = wrapper.runOnce();
    expect(report.spawned).toHaveLength(0);
    expect(report.active).toBe(2);
  });

  it("never staffs the human approval or goal-closure actions", () => {
    const forbidden = createAgentWrapper({
      affordances: {
        boundProjectId: "proj-human-actions",
        readSurface: () => ({
          nextAllowedCommands: [],
          outcome: "SURFACE",
          steps: [
            {
              aggregateId: "plan-human-1", claim: null, kind: "approval.decide",
              missing: [], status: "READY", version: 1,
            },
            {
              aggregateId: "goal-human-1", claim: null, kind: "goal.close",
              missing: [], status: "READY", version: 2,
            },
          ],
        }),
      },
      claimTtlMs: 60_000,
      clock: () => NOW,
      deps: new Proxy({}, {
        get: () => { throw new Error("human-only steps must never dispatch"); },
      }) as never,
      maxAgents: 2,
      mintSecret: () => { throw new Error("human-only steps must never mint a credential"); },
      operatorCredential: OPERATOR,
      spawnAgent: () => { throw new Error("human-only steps must never spawn"); },
    });

    expect(forbidden.runOnce()).toEqual({
      active: 0,
      spawned: [],
      surfaceOutcome: "SURFACE",
    });
  });

  it("revokes the scoped session as soon as its agent exits", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "moe-wrapper-session-revoke-"));
    const storePath = join(sandbox, "store.db");
    const isolated = createStoreDependencies({
      credential: OPERATOR,
      principalId: "operator-local",
      projectId: "proj-wrapper-revoke",
      storePath,
    });
    try {
      const isolatedAffordances = isolated.affordances;
      if (isolatedAffordances === undefined) throw new Error("provider serves no affordances");
      let suffix = 0;
      const finite = createAgentWrapper({
        affordances: isolatedAffordances(),
        claimTtlMs: 60_000,
        clock: () => NOW,
        deps: isolated.provide(),
        maxAgents: 1,
        mintSecret: () => `revoke-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        spawnAgent: async () => undefined,
      });

      const report = finite.runOnce();
      const sessionId = report.spawned[0]?.sessionId;
      if (sessionId === null || sessionId === undefined) throw new Error("no session spawned");
      await finite.settle();

      const reader = SqliteEventStore.openForProject(storePath, "proj-wrapper-revoke");
      try {
        expect(readSessionLedger(reader, "proj-wrapper-revoke").sessions.get(sessionId))
          .toMatchObject({ sessionId, status: "CLOSED", version: 2 });
      } finally {
        reader.close();
      }
      const surface = isolatedAffordances().readSurface();
      if (surface.outcome !== "SURFACE") throw new Error(surface.code);
      const staffed = surface.steps.find((step) =>
        `${step.kind}@${step.aggregateId ?? "-"}` === report.spawned[0]?.workItemId);
      expect(staffed?.claim).toBeNull();
    } finally {
      isolated.close();
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  it("revokes a newly opened session when the work claim is refused", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "moe-wrapper-claim-refusal-"));
    const storePath = join(sandbox, "store.db");
    const isolated = createStoreDependencies({
      credential: OPERATOR,
      principalId: "operator-local",
      projectId: "proj-wrapper-claim-refusal",
      storePath,
    });
    try {
      const isolatedAffordances = isolated.affordances;
      if (isolatedAffordances === undefined) throw new Error("provider serves no affordances");
      let suffix = 0;
      const refusing = createAgentWrapper({
        affordances: isolatedAffordances(),
        claimTtlMs: 60_000,
        // The session opens durably, then authenticates as expired when it
        // attempts the claim against the provider's real clock.
        clock: () => 0,
        deps: isolated.provide(),
        maxAgents: 1,
        mintSecret: () => `refuse-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        spawnAgent: () => { throw new Error("a refused claim must never spawn"); },
      });

      const report = refusing.runOnce();
      const sessionId = report.spawned[0]?.sessionId;
      expect(report.spawned[0]?.outcome).toBe("AUTHENTICATION_FAILED");
      if (sessionId === null || sessionId === undefined) throw new Error("no opened session");

      const reader = SqliteEventStore.openForProject(
        storePath,
        "proj-wrapper-claim-refusal",
      );
      try {
        expect(readSessionLedger(reader, "proj-wrapper-claim-refusal").sessions.get(sessionId))
          .toMatchObject({ sessionId, status: "CLOSED", version: 2 });
      } finally {
        reader.close();
      }
    } finally {
      isolated.close();
      rmSync(sandbox, { force: true, recursive: true });
    }
  });
});
