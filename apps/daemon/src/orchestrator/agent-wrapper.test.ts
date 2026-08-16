import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createStoreDependencies } from "../daemon-store-dependencies.js";
import type { AffordancePort } from "../http/affordance-contract.js";
import type { CommandAdapterDeps } from "../http/http-contract.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { WORK_CLAIM_SCHEMA_VERSION } from "../work/work-claim-contracts.js";
import { readWorkClaimLedger, runWorkClaimCommand } from "../work/work-claim-services.js";
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

function isolatedHarness(projectId: string) {
  const sandbox = mkdtempSync(join(tmpdir(), "moe-wrapper-cleanup-"));
  const storePath = join(sandbox, "store.db");
  const isolated = createStoreDependencies({
    credential: OPERATOR, principalId: "operator-local", projectId, storePath,
  });
  const port = isolated.affordances?.();
  if (port === undefined) throw new Error("provider serves no affordances");
  return {
    dispose: () => {
      isolated.close();
      rmSync(sandbox, { force: true, recursive: true });
    },
    isolated,
    port,
    storePath,
  };
}

function renewClaim(
  store: SqliteEventStore, projectId: string, request: SpawnRequest,
  expectedVersion: number, commandId: string,
): void {
  const renewed = runWorkClaimCommand(store, new TextEncoder().encode(JSON.stringify({
    commandId, correlationId: "race", decidedAt: new Date(NOW).toISOString(),
    expectedVersion, kind: "work.renew",
    payload: {
      expiresAt: new Date(NOW + 120_000).toISOString(),
      workItemId: request.workItemId,
    },
    principalId: request.sessionId, projectId,
    schemaVersion: WORK_CLAIM_SCHEMA_VERSION,
  })));
  if (!renewed.ok) throw new Error(renewed.code);
}

function writeClaim(
  store: SqliteEventStore, projectId: string, kind: "work.claim" | "work.release",
  principalId: string, workItemId: string, expectedVersion: number, commandId: string,
): void {
  const outcome = runWorkClaimCommand(store, new TextEncoder().encode(JSON.stringify({
    commandId, correlationId: "wrapper-reclaim", decidedAt: new Date(NOW).toISOString(),
    expectedVersion, kind,
    payload: kind === "work.release"
      ? { workItemId }
      : { expiresAt: new Date(NOW + 120_000).toISOString(), workItemId },
    principalId, projectId, schemaVersion: WORK_CLAIM_SCHEMA_VERSION,
  })));
  if (!outcome.ok) throw new Error(outcome.code);
}

function withReleaseConflict(
  deps: CommandAdapterDeps, conflict: () => boolean,
): CommandAdapterDeps {
  const release = deps.registry.get("work.release");
  if (release === undefined) throw new Error("work.release is not registered");
  const registry = new Map(deps.registry);
  registry.set("work.release", {
    ...release,
    handler: (input) => conflict()
      ? {
        commandId: input.envelope.commandId,
        disposition: "DECIDED",
        effectId: null,
        resultCode: "EXPECTED_VERSION_CONFLICT",
      }
      : release.handler(input),
  });
  return { ...deps, registry };
}

function withSessionCloseConflict(deps: CommandAdapterDeps): CommandAdapterDeps {
  const close = deps.registry.get("session.close");
  if (close === undefined) throw new Error("session.close is not registered");
  const registry = new Map(deps.registry);
  registry.set("session.close", {
    ...close,
    handler: (input) => ({
      commandId: input.envelope.commandId,
      disposition: "DECIDED",
      effectId: null,
      resultCode: "EXPECTED_VERSION_CONFLICT",
    }),
  });
  return { ...deps, registry };
}

function withClaimConflict(deps: CommandAdapterDeps): CommandAdapterDeps {
  const claim = deps.registry.get("work.claim");
  if (claim === undefined) throw new Error("work.claim is not registered");
  const registry = new Map(deps.registry);
  registry.set("work.claim", {
    ...claim,
    handler: (input) => ({
      commandId: input.envelope.commandId,
      disposition: "DECIDED",
      effectId: null,
      resultCode: "EXPECTED_VERSION_CONFLICT",
    }),
  });
  return { ...deps, registry };
}

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
              aggregateId: "plan-human-1", claim: null, claimAggregateVersion: 0,
              kind: "approval.decide",
              missing: [], status: "READY", version: 1,
            },
            {
              aggregateId: "goal-human-1", claim: null, claimAggregateVersion: 0,
              kind: "goal.close",
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
    const harness = isolatedHarness("proj-wrapper-revoke");
    try {
      let suffix = 0;
      const finite = createAgentWrapper({
        affordances: harness.port,
        claimTtlMs: 60_000,
        clock: () => NOW,
        deps: harness.isolated.provide(),
        maxAgents: 1,
        mintSecret: () => `revoke-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        spawnAgent: async () => undefined,
      });

      const report = finite.runOnce();
      const sessionId = report.spawned[0]?.sessionId;
      if (sessionId === null || sessionId === undefined) throw new Error("no session spawned");
      await finite.settle();

      const reader = SqliteEventStore.openForProject(harness.storePath, "proj-wrapper-revoke");
      try {
        expect(readSessionLedger(reader, "proj-wrapper-revoke").sessions.get(sessionId))
          .toMatchObject({ sessionId, status: "CLOSED", version: 2 });
      } finally {
        reader.close();
      }
      const surface = harness.port.readSurface();
      if (surface.outcome !== "SURFACE") throw new Error(surface.code);
      const staffed = surface.steps.find((step) =>
        `${step.kind}@${step.aggregateId ?? "-"}` === report.spawned[0]?.workItemId);
      expect(staffed?.claim).toBeNull();
    } finally {
      harness.dispose();
    }
  });

  it("revokes a newly opened session when the work claim is refused", () => {
    const harness = isolatedHarness("proj-wrapper-claim-refusal");
    try {
      let suffix = 0;
      const refusing = createAgentWrapper({
        affordances: harness.port,
        claimTtlMs: 60_000,
        // The session opens durably, then authenticates as expired when it
        // attempts the claim against the provider's real clock.
        clock: () => 0,
        deps: harness.isolated.provide(),
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
        harness.storePath,
        "proj-wrapper-claim-refusal",
      );
      try {
        expect(readSessionLedger(reader, "proj-wrapper-claim-refusal").sessions.get(sessionId))
          .toMatchObject({ sessionId, status: "CLOSED", version: 2 });
      } finally {
        reader.close();
      }
    } finally {
      harness.dispose();
    }
  });

  it("does not spawn when work.claim is durably decided without effects", () => {
    const projectId = "proj-wrapper-claim-no-effect";
    const harness = isolatedHarness(projectId);
    try {
      let suffix = 0;
      const refusing = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: withClaimConflict(harness.isolated.provide()), maxAgents: 1,
        mintSecret: () => `no-effect-${String(suffix += 1).padStart(4, "0")}${"0".repeat(24)}`,
        operatorCredential: OPERATOR,
        spawnAgent: () => { throw new Error("a no-effect claim must never spawn"); },
      });

      const report = refusing.runOnce();
      const refused = report.spawned[0];
      if (refused?.sessionId === null || refused?.sessionId === undefined) {
        throw new Error("no opened session reported");
      }
      expect(refused.outcome).toBe("EXPECTED_VERSION_CONFLICT");
      expect(report.active).toBe(0);
      const reader = SqliteEventStore.openForProject(harness.storePath, projectId);
      try {
        expect(readSessionLedger(reader, projectId).sessions.get(refused.sessionId))
          .toMatchObject({ status: "CLOSED", version: 2 });
        expect(readWorkClaimLedger(reader, projectId).claims.get(refused.workItemId))
          .toBeUndefined();
      } finally {
        reader.close();
      }
    } finally {
      harness.dispose();
    }
  });

  it("claims a READY step at its previously released claim aggregate version", () => {
    const projectId = "proj-wrapper-reclaim";
    const harness = isolatedHarness(projectId);
    const claimStore = SqliteEventStore.openForProject(harness.storePath, projectId);
    try {
      const workItemId = `policy.install@${projectId}-policy`;
      writeClaim(
        claimStore, projectId, "work.claim", "prior-agent", workItemId, 0, "prior-claim",
      );
      writeClaim(
        claimStore, projectId, "work.release", "prior-agent", workItemId, 1, "prior-release",
      );
      const before = harness.port.readSurface();
      if (before.outcome !== "SURFACE") throw new Error(before.code);
      expect(before.steps.find((step) => step.kind === "policy.install")).toMatchObject({
        claim: null, claimAggregateVersion: 2, status: "READY",
      });

      let spawned: SpawnRequest | undefined;
      let suffix = 0;
      const reclaiming = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `reclaim-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        spawnAgent: (request) => {
          spawned = request;
          return new Promise(() => undefined);
        },
      });

      const report = reclaiming.runOnce();
      expect(report.spawned).toMatchObject([{ outcome: "SPAWNED", workItemId }]);
      expect(spawned?.workItemId).toBe(workItemId);
      expect(readWorkClaimLedger(claimStore, projectId).claims.get(workItemId)).toMatchObject({
        claimedBy: report.spawned[0]?.sessionId, status: "OPEN", version: 3,
      });
    } finally {
      claimStore.close();
      harness.dispose();
    }
  });

  it.each([
    ["synchronous spawn throw", "sync-spawn-throw", "SYNC_SPAWN_FAILURE",
      (): Promise<void> => { throw new Error("SYNC_SPAWN_FAILURE"); }],
    ["rejected child exit", "rejected-child-exit", "AGENT_PROCESS_FAILED:EXIT_NONZERO:1",
      async (): Promise<void> => { throw new Error("AGENT_PROCESS_FAILED:EXIT_NONZERO:1"); }],
  ] as const)("surfaces a %s after cleaning the claim and session", async (
    _case, projectSuffix, failureMessage, spawnAgent,
  ) => {
    const projectId = `proj-wrapper-${projectSuffix}`;
    const harness = isolatedHarness(projectId);
    try {
      let suffix = 0;
      const throwing = createAgentWrapper({
        affordances: harness.port,
        claimTtlMs: 60_000,
        clock: () => NOW,
        deps: harness.isolated.provide(),
        maxAgents: 1,
        mintSecret: () => `throw-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        spawnAgent,
      });

      const report = throwing.runOnce();
      const staffed = report.spawned[0];
      if (staffed?.sessionId === null || staffed?.sessionId === undefined) {
        throw new Error("no session spawned");
      }
      await expect(throwing.settle()).rejects.toThrowError(failureMessage);
      expect(throwing.runOnce()).toEqual({
        active: 0,
        spawned: [],
        surfaceOutcome: failureMessage,
      });

      const reader = SqliteEventStore.openForProject(harness.storePath, projectId);
      try {
        expect(readSessionLedger(reader, projectId).sessions
          .get(staffed.sessionId)).toMatchObject({ status: "CLOSED", version: 2 });
        expect(readWorkClaimLedger(reader, projectId).claims
          .get(staffed.workItemId)).toMatchObject({ status: "RELEASED", version: 2 });
      } finally {
        reader.close();
      }
    } finally {
      harness.dispose();
    }
  });

  it("refreshes and retries a stale work.release after a concurrent renewal", async () => {
    const projectId = "proj-wrapper-release-race";
    const harness = isolatedHarness(projectId);
    const raceStore = SqliteEventStore.openForProject(harness.storePath, projectId);
    try {
      let request: SpawnRequest | null = null;
      let raced = false;
      let cleanupReads = 0;
      const racingPort: AffordancePort = {
        boundProjectId: projectId,
        readSurface: () => {
          const stale = harness.port.readSurface();
          if (request !== null && !raced && stale.outcome === "SURFACE") {
            cleanupReads += 1;
            const claim = stale.steps.find((step) =>
              `${step.kind}@${step.aggregateId ?? "-"}` === request?.workItemId)?.claim;
            if (claim === null || claim === undefined) throw new Error("claim not visible");
            renewClaim(raceStore, projectId, request, claim.version, "race-renew");
            raced = true;
          } else if (request !== null) {
            cleanupReads += 1;
          }
          return stale;
        },
      };
      let suffix = 0;
      let conflicts = 1;
      const racing = createAgentWrapper({
        affordances: racingPort, claimTtlMs: 60_000, clock: () => NOW,
        deps: withReleaseConflict(harness.isolated.provide(), () => conflicts-- > 0),
        maxAgents: 1,
        mintSecret: () => `race-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        spawnAgent: async (spawnedRequest) => { request = spawnedRequest; },
      });

      const report = racing.runOnce();
      await racing.settle();

      expect(raced).toBe(true);
      expect(cleanupReads).toBeGreaterThanOrEqual(2);
      expect(readWorkClaimLedger(raceStore, projectId).claims
        .get(report.spawned[0]?.workItemId ?? "missing"))
        .toMatchObject({ status: "RELEASED", version: 3 });
    } finally {
      raceStore.close();
      harness.dispose();
    }
  });

  it("surfaces a bounded series of stale cleanup command outcomes", async () => {
    const projectId = "proj-wrapper-cleanup-refused";
    const harness = isolatedHarness(projectId);
    const raceStore = SqliteEventStore.openForProject(harness.storePath, projectId);
    try {
      let request: SpawnRequest | null = null;
      let renewals = 0;
      const refusingPort: AffordancePort = {
        boundProjectId: harness.port.boundProjectId,
        readSurface: () => {
          const stale = harness.port.readSurface();
          if (request === null || stale.outcome !== "SURFACE") return stale;
          const claim = stale.steps.find((step) =>
            `${step.kind}@${step.aggregateId ?? "-"}` === request?.workItemId)?.claim;
          if (claim === null || claim === undefined) return stale;
          // This injector targets the bounded work.release retry loop. The
          // independent session.close cleanup reads the surface afterward.
          if (renewals >= 3) return stale;
          renewals += 1;
          renewClaim(raceStore, projectId, request, claim.version, `refuse-renew-${renewals}`);
          return stale;
        },
      };
      let suffix = 0;
      const refusing = createAgentWrapper({
        affordances: refusingPort, claimTtlMs: 60_000, clock: () => NOW,
        deps: withReleaseConflict(harness.isolated.provide(), () => true), maxAgents: 1,
        mintSecret: () => `fail-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        spawnAgent: async (spawnedRequest) => { request = spawnedRequest; },
      });

      const staffed = refusing.runOnce().spawned[0];
      if (staffed?.sessionId === null || staffed?.sessionId === undefined) {
        throw new Error("nothing spawned");
      }
      const settlement = await refusing.settle().then(
        () => "RESOLVED",
        (error: unknown) => error instanceof Error ? error.message : "NON_ERROR",
      );
      expect(renewals).toBe(3);
      expect(readWorkClaimLedger(raceStore, projectId).claims.get(staffed.workItemId))
        .toMatchObject({ status: "OPEN", version: 4 });
      expect(readSessionLedger(raceStore, projectId).sessions.get(staffed.sessionId))
        .toMatchObject({ status: "CLOSED", version: 2 });
      expect(settlement).toBe("AGENT_CLEANUP_FAILED:work.release:EXPECTED_VERSION_CONFLICT");
      await expect(refusing.settle()).rejects.toThrow(settlement);
      expect(refusing.runOnce()).toEqual({
        active: 0,
        spawned: [],
        surfaceOutcome: settlement,
      });
    } finally {
      raceStore.close();
      harness.dispose();
    }
  });

  it("retains release and close failures in deterministic order", async () => {
    const projectId = "proj-wrapper-dual-cleanup-failure";
    const harness = isolatedHarness(projectId);
    const reader = SqliteEventStore.openForProject(harness.storePath, projectId);
    try {
      let suffix = 0;
      const refusing = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: withSessionCloseConflict(withReleaseConflict(
          harness.isolated.provide(), () => true,
        )),
        maxAgents: 1,
        mintSecret: () => `dual-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        spawnAgent: async () => undefined,
      });

      const staffed = refusing.runOnce().spawned[0];
      if (staffed?.sessionId === null || staffed?.sessionId === undefined) {
        throw new Error("nothing spawned");
      }
      const failure = await refusing.settle().then(
        () => null,
        (error: unknown) => error,
      );
      if (!(failure instanceof AggregateError)) throw new Error("expected AggregateError");
      const messages = failure.errors.map((error: unknown) =>
        error instanceof Error ? error.message : "NON_ERROR");
      expect(messages).toEqual([
        "AGENT_CLEANUP_FAILED:session.close:EXPECTED_VERSION_CONFLICT",
        "AGENT_CLEANUP_FAILED:work.release:EXPECTED_VERSION_CONFLICT",
      ]);
      expect(failure.message).toBe(
        "AGENT_CLEANUP_FAILED:session.close:EXPECTED_VERSION_CONFLICT" +
        "|AGENT_CLEANUP_FAILED:work.release:EXPECTED_VERSION_CONFLICT",
      );
      expect(refusing.runOnce().surfaceOutcome).toBe(failure.message);
      expect(readWorkClaimLedger(reader, projectId).claims.get(staffed.workItemId))
        .toMatchObject({ status: "OPEN", version: 1 });
      expect(readSessionLedger(reader, projectId).sessions.get(staffed.sessionId))
        .toMatchObject({ status: "OPEN", version: 1 });
    } finally {
      reader.close();
      harness.dispose();
    }
  });

  it("closes a minted session when command-id minting fails before claim ownership", () => {
    const projectId = "proj-wrapper-mint-setup-failure";
    const harness = isolatedHarness(projectId);
    try {
      let calls = 0;
      const failing = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => {
          calls += 1;
          if (calls >= 4) throw new Error("MINT_FAILED_AFTER_OPEN");
          return `mint-${String(calls).padStart(4, "0")}${"0".repeat(28)}`;
        },
        operatorCredential: OPERATOR,
        spawnAgent: () => { throw new Error("setup failure must never spawn"); },
      });

      const report = failing.runOnce();
      const failed = report.spawned[0];
      if (failed?.sessionId === null || failed?.sessionId === undefined) {
        throw new Error("no minted session reported");
      }
      expect(failed.outcome).toBe("AGENT_SETUP_FAILED:work.claim:UNEXPECTED_ERROR");
      expect(report.surfaceOutcome).toBe(failed.outcome);
      const reader = SqliteEventStore.openForProject(harness.storePath, projectId);
      try {
        expect(readSessionLedger(reader, projectId).sessions.get(failed.sessionId))
          .toMatchObject({ status: "CLOSED", version: 2 });
        expect(readWorkClaimLedger(reader, projectId).claims.get(failed.workItemId))
          .toBeUndefined();
      } finally {
        reader.close();
      }
    } finally {
      harness.dispose();
    }
  });

  it("releases the exact claim and closes the session when payload hints throw", () => {
    const projectId = "proj-wrapper-payload-setup-failure";
    const harness = isolatedHarness(projectId);
    try {
      let suffix = 0;
      const failing = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `hint-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        payloadHint: () => { throw new Error("PAYLOAD_HINT_FAILED"); },
        spawnAgent: () => { throw new Error("setup failure must never spawn"); },
      });

      const report = failing.runOnce();
      const failed = report.spawned[0];
      if (failed?.sessionId === null || failed?.sessionId === undefined) {
        throw new Error("no claimed session reported");
      }
      expect(failed.outcome).toBe("AGENT_SETUP_FAILED:mission:UNEXPECTED_ERROR");
      expect(report.surfaceOutcome).toBe(failed.outcome);
      const reader = SqliteEventStore.openForProject(harness.storePath, projectId);
      try {
        expect(readWorkClaimLedger(reader, projectId).claims.get(failed.workItemId))
          .toMatchObject({ status: "RELEASED", version: 2 });
        expect(readSessionLedger(reader, projectId).sessions.get(failed.sessionId))
          .toMatchObject({ status: "CLOSED", version: 2 });
      } finally {
        reader.close();
      }
    } finally {
      harness.dispose();
    }
  });

  it("cleans authority when a coding brief accessor throws after the claim", () => {
    const projectId = "proj-wrapper-node-mission-setup-failure";
    const harness = isolatedHarness(projectId);
    const reader = SqliteEventStore.openForProject(harness.storePath, projectId);
    try {
      const nodeRef = "node-mission-setup";
      const workItemId = `node.deliver@${nodeRef}`;
      const nodePort: AffordancePort = {
        boundProjectId: projectId,
        readSurface: () => {
          const live = harness.port.readSurface();
          if (live.outcome !== "SURFACE") return live;
          const record = readWorkClaimLedger(reader, projectId).claims.get(workItemId);
          return {
            ...live,
            steps: [{
              aggregateId: nodeRef,
              claim: record?.status === "OPEN" ? {
                claimedBy: record.claimedBy,
                expiresAt: record.expiresAt,
                version: record.version,
              } : null,
              claimAggregateVersion: record?.version ?? 0,
              kind: "node.deliver",
              missing: [],
              status: "READY",
              version: 1,
            }, ...live.steps.filter((step) => step.kind === "session.close")],
          };
        },
      };
      let suffix = 0;
      const failing = createAgentWrapper({
        affordances: nodePort, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `brief-${String(suffix += 1).padStart(4, "0")}${"0".repeat(27)}`,
        nodeMission: () => ({
          instructions: "implement", test: "pnpm test", title: "node",
          get workspace(): string { throw new Error("WORKSPACE_ACCESS_FAILED"); },
        }),
        operatorCredential: OPERATOR,
        spawnAgent: () => { throw new Error("setup failure must never spawn"); },
      });

      const report = failing.runOnce();
      const failed = report.spawned[0];
      if (failed?.sessionId === null || failed?.sessionId === undefined) {
        throw new Error("no claimed session reported");
      }
      expect(failed.outcome).toBe("AGENT_SETUP_FAILED:mission:UNEXPECTED_ERROR");
      expect(report.surfaceOutcome).toBe(failed.outcome);
      expect(readWorkClaimLedger(reader, projectId).claims.get(failed.workItemId))
        .toMatchObject({ status: "RELEASED", version: 2 });
      expect(readSessionLedger(reader, projectId).sessions.get(failed.sessionId))
        .toMatchObject({ status: "CLOSED", version: 2 });
    } finally {
      reader.close();
      harness.dispose();
    }
  });
});
