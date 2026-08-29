import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, describe, expect, it } from "vitest";

import { createStoreDependencies } from "../daemon-store-dependencies.js";
import type { AffordancePort } from "../http/affordance-contract.js";
import { workItemIdFor } from "../http/affordance-read.js";
import type { CommandAdapterDeps } from "../http/http-contract.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { WORK_CLAIM_SCHEMA_VERSION } from "../work/work-claim-contracts.js";
import { readWorkClaimLedger, runWorkClaimCommand } from "../work/work-claim-services.js";
import { SqliteEventStore } from "@moe/store";
import type { AgentSpawnStartResult, SpawnReport,
  SpawnStartRefusal } from "./agent-spawn-contract.js";
import { SPAWN_INVOCATION_LAYER } from "./agent-spawn-invocation.js";
import type { SpawnInvocationRefusalCode } from "./agent-spawn-invocation.js";
import { createAgentSessionFence } from "./agent-session-fence.js";
import type { AgentSessionFence } from "./agent-session-fence.js";
import { claudeSpawnStarter } from "./agent-spawner.js";
import { codeMission, createAgentWrapper } from "./agent-wrapper.js";
import type { SpawnRequest } from "./agent-wrapper.js";

/**
 * Integration over the REAL provider and store: the wrapper's session, claim,
 * and fence are durable facts, so the assertions read them back off the
 * affordance surface rather than off any wrapper state.
 */

/** A stand-in child pid for spawn stubs. Never this process's own: the fence
 * probes the CHILD, and a stub reusing `process.pid` would read as alive for
 * the wrong reason and hide a probe aimed at the wrapper. */
const CHILD_PID = 909090;

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
  // Admitted, then held open: the agents stay "running" for the whole file, so
  // any report these tests read was produced without waiting for a child exit.
  spawnAgent: async (request) => {
    spawned.push(request);
    return { exit: new Promise<void>(() => undefined), ok: true, pid: CHILD_PID };
  },
});

describe("createAgentWrapper", () => {
  it("staffs unclaimed READY steps up to maxAgents, claiming under agent identities", async () => {
    const report = await wrapper.runOnce();
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

  it("does not double-staff: the next pass sees the claims and spawns nothing", async () => {
    const report = await wrapper.runOnce();
    expect(report.spawned).toHaveLength(0);
    expect(report.active).toBe(2);
  });

  it("never staffs the human approval or goal-closure actions", async () => {
    const forbidden = createAgentWrapper({
      affordances: {
        boundProjectId: "proj-human-actions",
        readSurface: () => ({
          nextAllowedCommands: [],
          outcome: "SURFACE",
          goalCreatePlanningRunRef: null,
          planningGoalRef: null,
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

    expect(await forbidden.runOnce()).toEqual({
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
        spawnAgent: async () => ({ exit: Promise.resolve(), ok: true, pid: CHILD_PID }),
      });

      const report = await finite.runOnce();
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

  it("revokes a newly opened session when the work claim is refused", async () => {
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

      const report = await refusing.runOnce();
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

  it("does not spawn when work.claim is durably decided without effects", async () => {
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

      const report = await refusing.runOnce();
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

  it("claims a READY step at its previously released claim aggregate version", async () => {
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
        // Admission resolves, lifetime does not: a never-settling promise here
        // used to mean "agent still running", but it is now the ADMISSION
        // handle, so returning one would hang the report instead of holding a
        // child open.
        spawnAgent: async (request) => {
          spawned = request;
          return { exit: new Promise<void>(() => undefined), ok: true, pid: CHILD_PID };
        },
      });

      const report = await reclaiming.runOnce();
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

  // Both halves of the split the start contract makes: a start that never got
  // admitted, and a start that WAS admitted and then died. Each has to surface
  // and clean up, and neither may be reported as a healthy SPAWNED agent.
  it.each([
    ["synchronous spawn throw", "sync-spawn-throw", "SYNC_SPAWN_FAILURE",
      (): Promise<AgentSpawnStartResult> => { throw new Error("SYNC_SPAWN_FAILURE"); }],
    ["rejected child exit", "rejected-child-exit", "AGENT_PROCESS_FAILED:EXIT_NONZERO:1",
      async (): Promise<AgentSpawnStartResult> => ({
        exit: Promise.reject(new Error("AGENT_PROCESS_FAILED:EXIT_NONZERO:1")),
        ok: true,
        pid: CHILD_PID,
      })],
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

      const report = await throwing.runOnce();
      const staffed = report.spawned[0];
      if (staffed?.sessionId === null || staffed?.sessionId === undefined) {
        throw new Error("no session spawned");
      }
      await expect(throwing.settle()).rejects.toThrowError(failureMessage);
      expect(await throwing.runOnce()).toEqual({
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
        spawnAgent: async (spawnedRequest) => {
          request = spawnedRequest;
          return { exit: Promise.resolve(), ok: true, pid: CHILD_PID };
        },
      });

      const report = await racing.runOnce();
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
        spawnAgent: async (spawnedRequest) => {
          request = spawnedRequest;
          return { exit: Promise.resolve(), ok: true, pid: CHILD_PID };
        },
      });

      const staffed = (await refusing.runOnce()).spawned[0];
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
      expect(await refusing.runOnce()).toEqual({
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
        spawnAgent: async () => ({ exit: Promise.resolve(), ok: true, pid: CHILD_PID }),
      });

      const staffed = (await refusing.runOnce()).spawned[0];
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
      expect((await refusing.runOnce()).surfaceOutcome).toBe(failure.message);
      expect(readWorkClaimLedger(reader, projectId).claims.get(staffed.workItemId))
        .toMatchObject({ status: "OPEN", version: 1 });
      expect(readSessionLedger(reader, projectId).sessions.get(staffed.sessionId))
        .toMatchObject({ status: "OPEN", version: 1 });
    } finally {
      reader.close();
      harness.dispose();
    }
  });

  it("closes a minted session when command-id minting fails before claim ownership", async () => {
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

      const report = await failing.runOnce();
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

  it("releases the exact claim and closes the session when payload hints throw", async () => {
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

      const report = await failing.runOnce();
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

  it("cleans authority when a coding brief accessor throws after the claim", async () => {
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

      const report = await failing.runOnce();
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

/**
 * Startup admission is a different fact from process lifetime, and the wrapper
 * used to report neither: it called the lifetime-shaped boundary, discarded the
 * admission fact, and printed SPAWNED unconditionally. These cases drive the
 * REAL `claudeSpawnStarter` — never a stand-in for it — because a hand-written
 * fake of the refusal would assert the fake's vocabulary rather than the
 * producer's.
 */

/** The one trigger per producer refusal code. `Record` over the union is the
 *  sweep's second opinion: a code added or removed upstream stops this
 *  compiling, which a list derived from the union could never do. */
const REFUSAL_TRIGGER: Record<SpawnInvocationRefusalCode, string> = {
  // `&` is in agent-spawn-invocation's UNQUOTABLE set, and the wrapper's session
  // id reaches cmd.exe as the `--mcp-config` path, so this is a real argument.
  SPAWN_ARGUMENT_UNQUOTABLE: "&",
};

/**
 * A fake OS child for the ADMITTED control. It admits by emitting `spawn` and
 * then stays alive, so the exit promise is genuinely pending while the report is
 * read. `taskkill` is answered as well, so `close()` settles instead of ageing
 * into a containment failure and failing the test for an unrelated reason.
 */
function admittingSpawn(): (file: string, args: readonly string[], options: unknown) => never {
  let agent: EventEmitter | null = null;
  return ((file: string) => {
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      kill: () => true, pid: 4242, stdin: new PassThrough(), unref: () => undefined,
    });
    if (file.includes("taskkill")) {
      setImmediate(() => {
        agent?.emit("close", 0, null);
        emitter.emit("close", 0, null);
      });
      return child;
    }
    agent = emitter;
    setImmediate(() => { emitter.emit("spawn"); });
    return child;
  }) as never;
}

/** Whether a promise is still unsettled after the timers have had a turn. */
async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  const settled = promise.then(() => "settled" as const, () => "settled" as const);
  const raced = await Promise.race([
    settled,
    new Promise<"pending">((resolve) => { setTimeout(() => { resolve("pending"); }, 25); }),
  ]);
  return raced === "pending";
}

describe("agent spawn admission truth", () => {
  it("reports the real spawner's coded refusal with its refusing layer", async () => {
    const projectId = "proj-wrapper-admission-refused";
    const harness = isolatedHarness(projectId);
    const reader = SqliteEventStore.openForProject(harness.storePath, projectId);
    // `platform: "win32"` is what makes the cmd.exe quoting path reachable at
    // all: agent-spawn-invocation returns unquoted on every other platform, so
    // without it this case can never refuse and would pass while proving nothing.
    const starter = claudeSpawnStarter("http://127.0.0.1:8099", {
      environment: { SYSTEMROOT: "C:\\Windows" },
      log: () => undefined,
      platform: "win32",
      spawn: admittingSpawn(),
    });
    try {
      let suffix = 0;
      const refused = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        // The session id becomes the `--mcp-config` path, so the unquotable
        // character travels into the argument the spawner refuses.
        mintSecret: () =>
          `amp${REFUSAL_TRIGGER.SPAWN_ARGUMENT_UNQUOTABLE}${String(suffix += 1)
            .padStart(4, "0")}${"0".repeat(26)}`,
        operatorCredential: OPERATOR,
        spawnAgent: starter,
      });

      const report = await refused.runOnce();
      const staffed = report.spawned[0];
      if (staffed?.sessionId === null || staffed?.sessionId === undefined) {
        throw new Error("nothing staffed");
      }

      // Both facts, literally: the code AND the layer that answered. A
      // non-SPAWNED string alone would be satisfied by any wrapper-local guess.
      expect(staffed.outcome).toBe("SPAWN_ARGUMENT_UNQUOTABLE");
      expect(staffed.refusal).toEqual({
        code: "SPAWN_ARGUMENT_UNQUOTABLE",
        layer: "agent-spawn-invocation",
        ok: false,
      });
      expect(staffed.refusal?.layer).toBe(SPAWN_INVOCATION_LAYER);

      // The refusal came from the SPAWNER, not an earlier wrapper guard: the
      // durable ledger shows the session was opened and the item really was
      // claimed under it, so session.open and work.claim both passed before the
      // spawner answered. A wrapper-side refusal would have short-circuited one
      // of them and left no claim to release.
      expect(readWorkClaimLedger(reader, projectId).claims.get(staffed.workItemId))
        .toMatchObject({ status: "RELEASED", version: 2 });
      expect(readSessionLedger(reader, projectId).sessions.get(staffed.sessionId))
        .toMatchObject({ status: "CLOSED", version: 2 });
    } finally {
      await starter.close();
      reader.close();
      harness.dispose();
    }
  });

  it("sweeps every producer refusal code, and proves the sweep ran", async () => {
    const codes = Object.keys(REFUSAL_TRIGGER) as readonly SpawnInvocationRefusalCode[];
    // A sweep that silently generates zero cases passes while testing nothing.
    expect(codes.length).toBeGreaterThan(0);
    const observed: string[] = [];
    for (const code of codes) {
      const projectId = `proj-wrapper-sweep-${code.toLowerCase()}`;
      const harness = isolatedHarness(projectId);
      const starter = claudeSpawnStarter("http://127.0.0.1:8099", {
        environment: { SYSTEMROOT: "C:\\Windows" },
        log: () => undefined,
        platform: "win32",
        spawn: admittingSpawn(),
      });
      try {
        let suffix = 0;
        const swept = createAgentWrapper({
          affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
          deps: harness.isolated.provide(), maxAgents: 1,
          mintSecret: () => `swp${REFUSAL_TRIGGER[code]}${String(suffix += 1)
            .padStart(4, "0")}${"0".repeat(26)}`,
          operatorCredential: OPERATOR,
          spawnAgent: starter,
        });
        const staffed = (await swept.runOnce()).spawned[0];
        expect(staffed?.refusal).toMatchObject({ code, layer: SPAWN_INVOCATION_LAYER });
        observed.push(staffed?.refusal?.code ?? "NONE");
      } finally {
        await starter.close();
        harness.dispose();
      }
    }
    expect(observed).toEqual([...codes]);
  });

  it("reports SPAWNED while the admitted child is still running", async () => {
    const projectId = "proj-wrapper-admission-held";
    const harness = isolatedHarness(projectId);
    const starter = claudeSpawnStarter("http://127.0.0.1:8099", {
      environment: { SYSTEMROOT: "C:\\Windows" },
      log: () => undefined,
      platform: "win32",
      spawn: admittingSpawn(),
    });
    let held: Promise<void> | null = null;
    try {
      let suffix = 0;
      const admitted = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `held-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        // Pass-through: the real starter answers, the test only keeps the exit
        // handle so it can prove the report did not wait for it.
        spawnAgent: async (request) => {
          const result = await starter(request);
          if (result.ok) held = result.exit;
          return result;
        },
      });

      const report = await admitted.runOnce();
      const staffed = report.spawned[0];
      expect(staffed?.outcome).toBe("SPAWNED");
      expect(staffed?.refusal).toBeNull();
      // The whole point: reporting completed while the child is still alive.
      if (held === null) throw new Error("no exit handle captured");
      expect(await stillPending(held)).toBe(true);
      expect(admitted.activeCount()).toBe(1);
    } finally {
      await starter.close();
      harness.dispose();
    }
  });

  it("never books a refused start into the active map", async () => {
    const projectId = "proj-wrapper-admission-unbooked";
    const harness = isolatedHarness(projectId);
    try {
      let suffix = 0;
      const refusing = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `book-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        spawnAgent: async () => Object.freeze({
          code: "SPAWN_ARGUMENT_UNQUOTABLE" as const,
          layer: SPAWN_INVOCATION_LAYER,
          ok: false as const,
        }),
      });

      const before = refusing.activeCount();
      const report = await refusing.runOnce();
      expect(report.spawned[0]?.refusal?.code).toBe("SPAWN_ARGUMENT_UNQUOTABLE");
      // Exactly the prior value: a refused start owns no slot, so it can neither
      // consume maxAgents nor make the next pass believe an agent is working.
      expect(refusing.activeCount()).toBe(before);
      expect(report.active).toBe(before);
    } finally {
      harness.dispose();
    }
  });

  it("deletes an admitted start from the active map when its exit settles", async () => {
    const projectId = "proj-wrapper-admission-settles";
    const harness = isolatedHarness(projectId);
    try {
      let suffix = 0;
      let release: (() => void) | null = null;
      const settling = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `settle-${String(suffix += 1).padStart(4, "0")}${"0".repeat(26)}`,
        operatorCredential: OPERATOR,
        spawnAgent: async () => Object.freeze({
          exit: new Promise<void>((resolve) => { release = resolve; }),
          ok: true as const,
          pid: CHILD_PID,
        }),
      });

      expect((await settling.runOnce()).spawned[0]?.outcome).toBe("SPAWNED");
      expect(settling.activeCount()).toBe(1);
      if (release === null) throw new Error("no exit resolver captured");
      (release as () => void)();
      await settling.settle();
      expect(settling.activeCount()).toBe(0);
    } finally {
      harness.dispose();
    }
  });

  it("never reports SPAWNED for an unclassified start failure", async () => {
    const projectId = "proj-wrapper-admission-unclassified";
    const harness = isolatedHarness(projectId);
    try {
      let suffix = 0;
      const failing = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `uncl-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        // No stable code was earned, so this must fail closed rather than be
        // relabelled into the producer's vocabulary or reported as SPAWNED.
        spawnAgent: async () => { throw new Error("UNCLASSIFIED_START_FAILURE"); },
      });

      const staffed = (await failing.runOnce()).spawned[0];
      expect(staffed?.outcome).not.toBe("SPAWNED");
      expect(staffed?.refusal).toBeNull();
      expect(failing.activeCount()).toBe(0);
      await expect(failing.settle()).rejects.toThrowError("UNCLASSIFIED_START_FAILURE");
    } finally {
      harness.dispose();
    }
  });

  it("serialises overlapping passes instead of double-staffing one item", async () => {
    const projectId = "proj-wrapper-admission-overlap";
    const harness = isolatedHarness(projectId);
    try {
      let suffix = 0;
      let admit: (() => void) | null = null;
      const held = new Promise<void>((resolve) => { admit = resolve; });
      const requests: string[] = [];
      const overlapping = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `lap-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        // Admission parks until released, holding the first pass open across the
        // exact window a second caller could interleave into.
        spawnAgent: async (request) => {
          requests.push(request.workItemId);
          await held;
          return { exit: new Promise<void>(() => undefined), ok: true, pid: CHILD_PID };
        },
      });

      // Both launched before either can finish: the second must queue behind the
      // first, not read the same pre-staffing snapshot.
      const first = overlapping.runOnce();
      const second = overlapping.runOnce();
      if (admit === null) throw new Error("no admission resolver captured");
      (admit as () => void)();
      const [one, two] = await Promise.all([first, second]);

      expect(one.spawned.map((entry) => entry.outcome)).toEqual(["SPAWNED"]);
      // The second pass sees the first pass's booking and staffs nothing.
      expect(two.spawned).toHaveLength(0);
      expect(requests).toHaveLength(1);
      expect(overlapping.activeCount()).toBe(1);
    } finally {
      harness.dispose();
    }
  });

  it("cannot represent a refusal code outside the producer's vocabulary", () => {
    // The runtime assertions below can never fail; the compiler is the assertion.
    // `@ts-expect-error` FAILS `pnpm --filter @moe/daemon typecheck` if the
    // marked line ever starts compiling, so widening the refusal type back to a
    // loose string reddens the gate instead of passing silently.
    //
    // Both the alias AND the field the report actually promises are pinned. A
    // drill proved that is not redundant: widening only `SpawnReport["refusal"]`
    // left an alias-only assertion completely green, so the guard would have
    // detached from the surface a caller reads while still looking present.
    type Reported = NonNullable<SpawnReport["refusal"]>;
    const real: SpawnStartRefusal = {
      code: "SPAWN_ARGUMENT_UNQUOTABLE", layer: SPAWN_INVOCATION_LAYER, ok: false,
    };
    const foreignAlias: SpawnStartRefusal = {
      // @ts-expect-error a code outside SpawnInvocationRefusalCode is unrepresentable
      code: "SPAWN_CODE_THE_PRODUCER_NEVER_DECLARED", layer: SPAWN_INVOCATION_LAYER, ok: false,
    };
    const foreignReported: Reported = {
      // @ts-expect-error the REPORT's own refusal field is closed to the same union
      code: "SPAWN_CODE_THE_PRODUCER_NEVER_DECLARED", layer: SPAWN_INVOCATION_LAYER, ok: false,
    };
    expect(real.code).toBe("SPAWN_ARGUMENT_UNQUOTABLE");
    expect(foreignAlias.layer).toBe("agent-spawn-invocation");
    expect(foreignReported.layer).toBe("agent-spawn-invocation");
  });
});

/**
 * THE REPORTED DEFECT, end to end.
 *
 * Two live agent sessions on ONE work item. It happens when the durable claim
 * EXPIRES while the child it fenced is still running: `activeClaim` nulls the
 * expired record, the affordance surface therefore projects `claim: null`
 * (measured at affordance-read.ts:74-76), and the item reads exactly like a
 * fresh unclaimed one. The wrapper's only surviving guard is its in-process
 * `active` map — which a restarted wrapper does not have.
 *
 * So the second pass here comes from a SECOND wrapper instance holding a fence
 * on a REOPENED store handle. That is the honest reproduction: a same-instance
 * second pass would be refused by the in-process map and would prove nothing
 * about durability.
 *
 * The surface's `claim: null` is injected rather than waited for. The expiry
 * projection itself is measured in step 1 and driven against a REAL expired
 * claim in agent-session-fence.test.ts; reproducing it here by sleeping past a
 * real TTL would make this a clock race, and a test that fails on a slow box
 * teaches the next reader to rerun it rather than to believe it.
 */
/**
 * A journal fence, for ORDER assertions. The wrapper's calling discipline —
 * provisional record BEFORE spawn admission, pid upgrade after, retire on every
 * aborted start — is invisible to the real fence's fold, which keeps only the
 * last transition. This port writes each call into a shared journal instead, so
 * a test can pin the sequence itself; `recordFailure`, when set, makes every
 * record commit refuse the way a closed store handle would.
 */
function journalFence(journal: string[], recordFailure?: Error): AgentSessionFence {
  return {
    admit: () => ({ ok: true }),
    recordLiveChild: (record) => {
      journal.push(
        `record:${record.childPid === undefined ? "provisional" : String(record.childPid)}`,
      );
      return recordFailure === undefined ? [] : [recordFailure];
    },
    retireLiveChild: (workItemId) => {
      journal.push(`retire:${workItemId}`);
      return [];
    },
  };
}

describe("createAgentWrapper — durable staffing fence", () => {
  it("refuses a second wrapper's pass while the first child is live, and spawns ONCE", async () => {
    const projectId = "proj-wrapper-fence-race";
    const harness = isolatedHarness(projectId);
    const store = SqliteEventStore.openForProject(harness.storePath, projectId);
    const stores: SqliteEventStore[] = [];
    try {
      const opening = harness.port.readSurface();
      if (opening.outcome !== "SURFACE") throw new Error(opening.code);
      const first = opening.steps.find((step) =>
        step.status === "READY" && step.claim === null
        && !step.kind.startsWith("session.")
        && step.kind !== "approval.decide" && step.kind !== "goal.close");
      if (first === undefined) throw new Error("no staffable step on the surface");
      const target = workItemIdFor(first.kind, first.aggregateId);

      // ONE staffable item, so "spawnAgent was called exactly once" is exact
      // rather than "once for this item, plus whatever else the board offered".
      const soloPort: AffordancePort = {
        boundProjectId: projectId,
        readSurface: () => {
          const surface = harness.port.readSurface();
          if (surface.outcome !== "SURFACE") return surface;
          return {
            ...surface,
            steps: surface.steps
              .filter((step) => workItemIdFor(step.kind, step.aggregateId) === target),
          };
        },
      };

      const spawnCalls: string[] = [];
      const spawnAgent = async (request: SpawnRequest): Promise<AgentSpawnStartResult> => {
        spawnCalls.push(request.workItemId);
        // Admitted and held open: the child is still running for the whole test.
        return { exit: new Promise<void>(() => undefined), ok: true, pid: CHILD_PID };
      };

      const firstStore = SqliteEventStore.openForProject(harness.storePath, projectId);
      stores.push(firstStore);
      let suffix = 0;
      const firstWrapper = createAgentWrapper({
        affordances: soloPort, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `fencea${String(suffix += 1).padStart(4, "0")}${"0".repeat(26)}`,
        operatorCredential: OPERATOR,
        spawnAgent,
        staffingFence: createAgentSessionFence({ isProcessAlive: () => true, projectId, store: firstStore }),
      });

      const firstReport = await firstWrapper.runOnce();
      expect(firstReport.spawned).toMatchObject([{ outcome: "SPAWNED", workItemId: target }]);
      expect(spawnCalls).toEqual([target]);
      const agentSession = firstReport.spawned[0]?.sessionId;
      if (agentSession === null || agentSession === undefined) throw new Error("no session");

      // THE DEFECT STATE, produced durably rather than faked in the port: the
      // claim is gone from the store while the child is still running. A
      // released claim and an expired one are the same fact to every reader
      // here — `activeClaim` returns null for both — and release is reachable
      // deterministically, where expiry would need a real 60s sleep or a TTL so
      // short it also expires the agent's own session mid-handshake.
      const claimed = readWorkClaimLedger(store, projectId).claims.get(target);
      if (claimed === undefined) throw new Error("no durable claim to retire");
      writeClaim(
        store, projectId, "work.release", agentSession, target,
        claimed.version, "fence-race-reap",
      );

      // The precondition, asserted rather than assumed: the item now reads
      // UNCLAIMED on the real surface, so nothing there can refuse the next
      // pass and the durable claim layer cannot answer either.
      const aged = soloPort.readSurface();
      if (aged.outcome !== "SURFACE") throw new Error(aged.code);
      expect(aged.steps).toMatchObject([{ claim: null, status: "READY" }]);

      // A RESTARTED wrapper: empty `active` map, fence on a reopened handle.
      firstStore.close();
      stores.pop();
      const secondStore = SqliteEventStore.openForProject(harness.storePath, projectId);
      stores.push(secondStore);
      const secondWrapper = createAgentWrapper({
        affordances: soloPort, claimTtlMs: 60_000, clock: () => NOW + 120_000,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `fenceb${String(suffix += 1).padStart(4, "0")}${"0".repeat(26)}`,
        operatorCredential: OPERATOR,
        spawnAgent,
        staffingFence: createAgentSessionFence({ isProcessAlive: () => true, projectId, store: secondStore }),
      });

      const secondReport = await secondWrapper.runOnce();
      // THE COUNT FIRST, deliberately. It is the assertion that states the
      // defect — two children on one item — and a second spawn that failed
      // afterwards would still have put both in the shared worktree. Removing
      // the fence makes this line, not the outcome line, the one that reddens.
      expect(spawnCalls).toEqual([target]);
      expect(secondReport.spawned).toMatchObject([
        { outcome: "AGENT_STAFFING_CHILD_LIVE", sessionId: null, workItemId: target },
      ]);
    } finally {
      store.close();
      while (stores.length > 0) stores.pop()?.close();
      harness.dispose();
    }
  });

  it("does not charge a fence refusal against the attempt budget, so a dead orphan is restaffed", async () => {
    // The fence's CHILD_LIVE answer is the correct one for as long as the orphan
    // runs, and it is minted BEFORE any identity: nothing was spent. Counting it
    // as an attempt exhausted the item after maxItemAttempts passes, and the
    // exhaustion outlived the orphan: the surface keeps the item READY and
    // unclaimed, so the counter never re-armed, and the item was lost to the
    // restarted wrapper for good. The same shape as the race above: wrapper A's
    // child outlives its claim, a restarted wrapper B polls past the budget
    // while the child lives, then the child dies and B must staff it.
    const projectId = "proj-wrapper-fence-budget";
    const harness = isolatedHarness(projectId);
    const store = SqliteEventStore.openForProject(harness.storePath, projectId);
    const stores: SqliteEventStore[] = [];
    try {
      const opening = harness.port.readSurface();
      if (opening.outcome !== "SURFACE") throw new Error(opening.code);
      const first = opening.steps.find((step) =>
        step.status === "READY" && step.claim === null
        && !step.kind.startsWith("session.")
        && step.kind !== "approval.decide" && step.kind !== "goal.close");
      if (first === undefined) throw new Error("no staffable step on the surface");
      const target = workItemIdFor(first.kind, first.aggregateId);
      const soloPort: AffordancePort = {
        boundProjectId: projectId,
        readSurface: () => {
          const surface = harness.port.readSurface();
          if (surface.outcome !== "SURFACE") return surface;
          return {
            ...surface,
            steps: surface.steps
              .filter((step) => workItemIdFor(step.kind, step.aggregateId) === target),
          };
        },
      };

      const spawnCalls: string[] = [];
      const spawnAgent = async (request: SpawnRequest): Promise<AgentSpawnStartResult> => {
        spawnCalls.push(request.workItemId);
        return { exit: new Promise<void>(() => undefined), ok: true, pid: CHILD_PID };
      };

      const firstStore = SqliteEventStore.openForProject(harness.storePath, projectId);
      stores.push(firstStore);
      let suffix = 0;
      const firstWrapper = createAgentWrapper({
        affordances: soloPort, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `budgta${String(suffix += 1).padStart(4, "0")}${"0".repeat(26)}`,
        operatorCredential: OPERATOR,
        spawnAgent,
        staffingFence: createAgentSessionFence({ isProcessAlive: () => true, projectId, store: firstStore }),
      });
      const firstReport = await firstWrapper.runOnce();
      expect(firstReport.spawned).toMatchObject([{ outcome: "SPAWNED", workItemId: target }]);
      const agentSession = firstReport.spawned[0]?.sessionId;
      if (agentSession === null || agentSession === undefined) throw new Error("no session");

      // The claim goes while the child stays: the orphan state, produced durably.
      const claimed = readWorkClaimLedger(store, projectId).claims.get(target);
      if (claimed === undefined) throw new Error("no durable claim to retire");
      writeClaim(
        store, projectId, "work.release", agentSession, target,
        claimed.version, "fence-budget-reap",
      );
      const aged = soloPort.readSurface();
      if (aged.outcome !== "SURFACE") throw new Error(aged.code);
      expect(aged.steps).toMatchObject([{ claim: null, status: "READY" }]);

      // A RESTARTED wrapper whose probe is the only thing that changes below.
      firstStore.close();
      stores.pop();
      const secondStore = SqliteEventStore.openForProject(harness.storePath, projectId);
      stores.push(secondStore);
      let orphanAlive = true;
      const maxItemAttempts = 3;
      const secondWrapper = createAgentWrapper({
        affordances: soloPort, claimTtlMs: 60_000, clock: () => NOW + 120_000,
        deps: harness.isolated.provide(), maxAgents: 1, maxItemAttempts,
        mintSecret: () => `budgtb${String(suffix += 1).padStart(4, "0")}${"0".repeat(26)}`,
        operatorCredential: OPERATOR,
        spawnAgent,
        staffingFence: createAgentSessionFence({
          isProcessAlive: () => orphanAlive, projectId, store: secondStore,
        }),
      });

      // One past the budget, deliberately: with refusals charged, the fourth
      // pass is the one that reads STAFFING_ATTEMPTS_EXHAUSTED instead.
      for (let pass = 0; pass <= maxItemAttempts; pass += 1) {
        const report = await secondWrapper.runOnce();
        expect(report.spawned, `pass ${String(pass + 1)}`).toMatchObject([
          { outcome: "AGENT_STAFFING_CHILD_LIVE", sessionId: null, workItemId: target },
        ]);
      }
      expect(spawnCalls).toEqual([target]);

      // The orphan dies. The gate admits; the wrapper must still be willing.
      orphanAlive = false;
      const restaffed = await secondWrapper.runOnce();
      expect(restaffed.spawned).toMatchObject([{ outcome: "SPAWNED", workItemId: target }]);
      expect(spawnCalls).toEqual([target, target]);
    } finally {
      store.close();
      while (stores.length > 0) stores.pop()?.close();
      harness.dispose();
    }
  });

  it("records the pid the SPAWNER reported, never the wrapper's own", async () => {
    // Found by a SURVIVING mutant: replacing `childPid: start.pid` with
    // `childPid: process.pid` left all 112 tests green. Every other case here
    // injects its own probe, so none of them observes WHICH pid was written —
    // and the fence's own unit test calls recordLiveChild directly, so it proves
    // the fence, not the wrapper's choice of what to hand it.
    //
    // That substitution is the unsound design step 2 rejected: the child is
    // detached and survives a SIGKILLed wrapper, so recording the wrapper's pid
    // makes a live orphan read as dead and re-opens the defect. Nothing bound
    // the wrapper to the spawner's pid until this case.
    const projectId = "proj-wrapper-fence-pid";
    const harness = isolatedHarness(projectId);
    const store = SqliteEventStore.openForProject(harness.storePath, projectId);
    try {
      const opening = harness.port.readSurface();
      if (opening.outcome !== "SURFACE") throw new Error(opening.code);
      const first = opening.steps.find((step) =>
        step.status === "READY" && step.claim === null
        && !step.kind.startsWith("session.")
        && step.kind !== "approval.decide" && step.kind !== "goal.close");
      if (first === undefined) throw new Error("no staffable step on the surface");
      const target = workItemIdFor(first.kind, first.aggregateId);

      // Deliberately not CHILD_PID and not process.pid, so neither a shared
      // constant nor the ambient process can make this pass by coincidence.
      const SPAWNED_PID = 777_001;
      expect(SPAWNED_PID).not.toBe(process.pid);

      const fence = createAgentSessionFence({ isProcessAlive: () => true, projectId, store });
      let suffix = 0;
      const wrapper = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `fencep${String(suffix += 1).padStart(4, "0")}${"0".repeat(26)}`,
        operatorCredential: OPERATOR,
        spawnAgent: async () => ({
          exit: new Promise<void>(() => undefined), ok: true, pid: SPAWNED_PID,
        }),
        staffingFence: fence,
      });

      expect((await wrapper.runOnce()).spawned[0]).toMatchObject({ outcome: "SPAWNED" });

      // Read the DURABLE record back through production: a capturing probe on a
      // fresh fence sees exactly the pid that was persisted. Asked past expiry so
      // the claim gate is silent and only the live-child record can answer.
      const probed: number[] = [];
      const reader = createAgentSessionFence({
        isProcessAlive: (pid) => { probed.push(pid); return true; }, projectId, store,
      });
      reader.admit(target, new Date(NOW + 120_000).toISOString());

      expect(probed).toStrictEqual([SPAWNED_PID]);
      expect(probed).not.toContain(process.pid);
    } finally {
      store.close();
      harness.dispose();
    }
  });

  it("re-staffs after a SIGKILLED wrapper, because the orphaned child probes DEAD", async () => {
    // The deadlock QA blocked the first attempt on, proven at the WRAPPER level.
    //
    // SIGKILL runs no exit handler, so the ADMITTED record is never retired. The
    // sibling case above proves a LIVE record refuses; without a liveness probe
    // that refusal is permanent and the item is unstaffable FOREVER — strictly
    // worse than the 30-minute expiry exposure this fence replaces. Same setup as
    // the race case, one variable changed: the restarted wrapper's probe answers
    // DEAD. A record TTL is deliberately NOT the mechanism; a TTL equal to the
    // claim TTL would reintroduce the very expiry defect the fence closes.
    const projectId = "proj-wrapper-fence-orphan";
    const harness = isolatedHarness(projectId);
    const store = SqliteEventStore.openForProject(harness.storePath, projectId);
    const stores: SqliteEventStore[] = [];
    try {
      const opening = harness.port.readSurface();
      if (opening.outcome !== "SURFACE") throw new Error(opening.code);
      const first = opening.steps.find((step) =>
        step.status === "READY" && step.claim === null
        && !step.kind.startsWith("session.")
        && step.kind !== "approval.decide" && step.kind !== "goal.close");
      if (first === undefined) throw new Error("no staffable step on the surface");
      const target = workItemIdFor(first.kind, first.aggregateId);

      const soloPort: AffordancePort = {
        boundProjectId: projectId,
        readSurface: () => {
          const surface = harness.port.readSurface();
          if (surface.outcome !== "SURFACE") return surface;
          return {
            ...surface,
            steps: surface.steps
              .filter((step) => workItemIdFor(step.kind, step.aggregateId) === target),
          };
        },
      };

      const spawnCalls: string[] = [];
      const spawnAgent = async (request: SpawnRequest): Promise<AgentSpawnStartResult> => {
        spawnCalls.push(request.workItemId);
        return { exit: new Promise<void>(() => undefined), ok: true, pid: CHILD_PID };
      };

      const firstStore = SqliteEventStore.openForProject(harness.storePath, projectId);
      stores.push(firstStore);
      let suffix = 0;
      const firstWrapper = createAgentWrapper({
        affordances: soloPort, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `orphna${String(suffix += 1).padStart(4, "0")}${"0".repeat(26)}`,
        operatorCredential: OPERATOR,
        spawnAgent,
        staffingFence: createAgentSessionFence({
          isProcessAlive: () => true, projectId, store: firstStore,
        }),
      });

      const firstReport = await firstWrapper.runOnce();
      expect(firstReport.spawned).toMatchObject([{ outcome: "SPAWNED", workItemId: target }]);
      const agentSession = firstReport.spawned[0]?.sessionId;
      if (agentSession === null || agentSession === undefined) throw new Error("no session");

      // The claim goes, the ADMITTED record STAYS — exactly the state a SIGKILL
      // leaves behind, since no exit handler ever ran to retire it.
      const claimed = readWorkClaimLedger(store, projectId).claims.get(target);
      if (claimed === undefined) throw new Error("no durable claim to retire");
      writeClaim(
        store, projectId, "work.release", agentSession, target,
        claimed.version, "orphan-reap",
      );

      firstStore.close();
      stores.pop();
      const secondStore = SqliteEventStore.openForProject(harness.storePath, projectId);
      stores.push(secondStore);
      const secondWrapper = createAgentWrapper({
        affordances: soloPort, claimTtlMs: 60_000, clock: () => NOW + 120_000,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `orphnb${String(suffix += 1).padStart(4, "0")}${"0".repeat(26)}`,
        operatorCredential: OPERATOR,
        spawnAgent,
        // The ONLY difference from the race case above. If this case and that one
        // ever agree, the probe has stopped being consulted.
        staffingFence: createAgentSessionFence({
          isProcessAlive: () => false, projectId, store: secondStore,
        }),
      });

      const secondReport = await secondWrapper.runOnce();
      expect(secondReport.spawned).toMatchObject([
        { outcome: "SPAWNED", workItemId: target },
      ]);
      // The count, as in the race case: two spawns is the CORRECT answer here,
      // because the first child is genuinely gone. Asserting the outcome alone
      // would not distinguish re-staffing from a report that never spawned.
      expect(spawnCalls).toEqual([target, target]);
    } finally {
      store.close();
      while (stores.length > 0) stores.pop()?.close();
      harness.dispose();
    }
  });

  it("retires the record when the child dies on the REJECTION path, so the item is staffable again", async () => {
    // The wedge case, and the one that would be worse than the race it fixes: a
    // crashed child whose record is never retired makes the item unstaffable
    // FOREVER, breaking resume-after-crash (task rail 2).
    //
    // The claim is released by cleanup on this path, so the claim gate cannot be
    // what answers afterwards — only the live-child record can. That is what
    // makes the final ADMIT a real assertion about the retire call rather than
    // about claim cleanup.
    const projectId = "proj-wrapper-fence-rejected";
    const harness = isolatedHarness(projectId);
    const store = SqliteEventStore.openForProject(harness.storePath, projectId);
    try {
      const opening = harness.port.readSurface();
      if (opening.outcome !== "SURFACE") throw new Error(opening.code);
      const first = opening.steps.find((step) =>
        step.status === "READY" && step.claim === null
        && !step.kind.startsWith("session.")
        && step.kind !== "approval.decide" && step.kind !== "goal.close");
      if (first === undefined) throw new Error("no staffable step on the surface");
      const target = workItemIdFor(first.kind, first.aggregateId);

      const fence = createAgentSessionFence({ isProcessAlive: () => true, projectId, store });
      let killChild: (error: Error) => void = () => undefined;
      const exit = new Promise<void>((_resolve, reject) => { killChild = reject; });
      let suffix = 0;
      const dying = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `fencex${String(suffix += 1).padStart(4, "0")}${"0".repeat(26)}`,
        operatorCredential: OPERATOR,
        // The child's death is DEFERRED so the live window is observable. An
        // already-rejected promise retires on the first microtask, before any
        // assertion could see the fenced state, and the "while live" check
        // below would then be asserting nothing.
        spawnAgent: async () => ({ exit, ok: true, pid: CHILD_PID }),
        staffingFence: fence,
      });

      const report = await dying.runOnce();
      expect(report.spawned[0]).toMatchObject({ outcome: "SPAWNED" });

      // Asked PAST the claim's expiry on purpose. At `NOW` the claim is still
      // active and CLAIM_HELD answers first, which would say nothing about the
      // child record; past expiry the claim gate is silent, so only the
      // live-child record can produce this refusal.
      const afterExpiry = new Date(NOW + 120_000).toISOString();
      expect(fence.admit(target, afterExpiry))
        .toMatchObject({ code: "AGENT_STAFFING_CHILD_LIVE", ok: false });

      killChild(new Error("AGENT_PROCESS_FAILED:EXIT_NONZERO:1"));
      await expect(dying.settle()).rejects
        .toThrowError("AGENT_PROCESS_FAILED:EXIT_NONZERO:1");

      // Dead predecessor, item staffable again. This is the assertion drill 3
      // reddens: with the rejection-branch retire removed the record stays live
      // and the item is wedged forever.
      expect(fence.admit(target, afterExpiry)).toMatchObject({ ok: true });
    } finally {
      store.close();
      harness.dispose();
    }
  });

  it("writes a provisional record BEFORE spawn admission, then upgrades it with the pid", async () => {
    // THE ADMISSION WINDOW. The record used to go down only AFTER `spawnAgent`
    // resolved, so a wrapper killed — or a record commit refused — between
    // spawn admission and record left a live, claim-holding child with NO
    // durable record: the exact orphan/double-staffing state the fence exists
    // to prevent. The ORDER is the whole assertion here, which is why the
    // journal captures the spawn call in the same sequence as the fence calls;
    // a real fence could only show the folded end state.
    const projectId = "proj-wrapper-fence-order";
    const harness = isolatedHarness(projectId);
    try {
      const journal: string[] = [];
      let suffix = 0;
      const ordered = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `order-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        spawnAgent: async (request) => {
          journal.push(`spawn:${request.workItemId}`);
          return { exit: new Promise<void>(() => undefined), ok: true, pid: CHILD_PID };
        },
        staffingFence: journalFence(journal),
      });

      const report = await ordered.runOnce();
      const staffed = report.spawned[0];
      expect(staffed?.outcome).toBe("SPAWNED");
      // Provisional first, admission second, pid upgrade third — and the happy
      // path still ends holding the probeable pid-bearing record.
      expect(journal).toEqual([
        "record:provisional",
        `spawn:${staffed?.workItemId ?? "missing"}`,
        `record:${String(CHILD_PID)}`,
      ]);
    } finally {
      harness.dispose();
    }
  });

  it("never spawns past a refused provisional commit, and releases its authority", async () => {
    // Fail closed at the WRITE, not only the read: if the store cannot durably
    // say "a child may exist here", no child may come to exist. Spawning
    // anyway would recreate the recordless-child window the provisional write
    // closes — with a real process already running this time.
    const projectId = "proj-wrapper-fence-record-refused";
    const harness = isolatedHarness(projectId);
    try {
      const journal: string[] = [];
      let suffix = 0;
      const refused = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `norec-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        spawnAgent: () => { throw new Error("a recordless start must never spawn"); },
        staffingFence: journalFence(
          journal, new Error("AGENT_STAFFING_RECORD_FAILED:HANDLE_CLOSED"),
        ),
      });

      const report = await refused.runOnce();
      const staffed = report.spawned[0];
      if (staffed?.sessionId === null || staffed?.sessionId === undefined) {
        throw new Error("no staffed session reported");
      }
      expect(staffed.outcome).toBe("AGENT_STAFFING_RECORD_FAILED:UNSPAWNED");
      // One record attempt, no spawn, and no retire: a commit that failed left
      // nothing to clear, and if it half landed, the fence's UNREADABLE
      // refusal is the correct standing answer.
      expect(journal).toEqual(["record:provisional"]);
      await expect(refused.settle()).rejects
        .toThrowError("AGENT_STAFFING_RECORD_FAILED:HANDLE_CLOSED");
      const reader = SqliteEventStore.openForProject(harness.storePath, projectId);
      try {
        expect(readSessionLedger(reader, projectId).sessions.get(staffed.sessionId))
          .toMatchObject({ status: "CLOSED", version: 2 });
        expect(readWorkClaimLedger(reader, projectId).claims.get(staffed.workItemId))
          .toMatchObject({ status: "RELEASED", version: 2 });
      } finally {
        reader.close();
      }
    } finally {
      harness.dispose();
    }
  });

  it("retires the provisional record when spawn admission throws", async () => {
    // Without this retire the throw path leaves the pid-less record standing:
    // it folds UNREADABLE, refuses restaffing forever, and the item is wedged
    // — the permanent deadlock the fence must never trade the admission-window
    // race for.
    const projectId = "proj-wrapper-fence-throw-retire";
    const harness = isolatedHarness(projectId);
    try {
      const journal: string[] = [];
      let suffix = 0;
      const throwing = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `retthr-${String(suffix += 1).padStart(4, "0")}${"0".repeat(27)}`,
        operatorCredential: OPERATOR,
        spawnAgent: () => { throw new Error("SYNC_SPAWN_FAILURE"); },
        staffingFence: journalFence(journal),
      });

      const report = await throwing.runOnce();
      expect(report.spawned[0]?.outcome).toBe("AGENT_SPAWN_FAILED:UNADMITTED");
      // Recorded, aborted, retired — in that order and with the ITEM's id, so
      // the aborted start clears its own record instead of wedging the item.
      expect(journal).toEqual([
        "record:provisional",
        `retire:${report.spawned[0]?.workItemId ?? "missing"}`,
      ]);
      await expect(throwing.settle()).rejects.toThrowError("SYNC_SPAWN_FAILURE");
    } finally {
      harness.dispose();
    }
  });

  it("retires the provisional record when the spawner refuses the start", async () => {
    // The same wedge as the throw path, reached through the OTHER arm of the
    // start contract: a coded refusal earned no child either, so the record it
    // was provisioned for must not outlive the report.
    const projectId = "proj-wrapper-fence-refusal-retire";
    const harness = isolatedHarness(projectId);
    try {
      const journal: string[] = [];
      let suffix = 0;
      const refusing = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `retref-${String(suffix += 1).padStart(4, "0")}${"0".repeat(27)}`,
        operatorCredential: OPERATOR,
        spawnAgent: async () => Object.freeze({
          code: "SPAWN_ARGUMENT_UNQUOTABLE" as const,
          layer: SPAWN_INVOCATION_LAYER,
          ok: false as const,
        }),
        staffingFence: journalFence(journal),
      });

      const report = await refusing.runOnce();
      // A refused start frees its slot, so ONE pass may try several steps.
      // Every one of them must journal the same record-then-retire pair, and
      // none may reach a spawn — a spawn entry would break the pairing.
      expect(report.spawned.length).toBeGreaterThan(0);
      expect(report.spawned.every((entry) =>
        entry.refusal?.code === "SPAWN_ARGUMENT_UNQUOTABLE")).toBe(true);
      expect(journal).toEqual(report.spawned.flatMap((entry) => [
        "record:provisional", `retire:${entry.workItemId}`,
      ]));
    } finally {
      harness.dispose();
    }
  });

  it("refuses the SUPERSEDED session's work.renew at the work-claim layer, mutating nothing", () => {
    // DoD 2 in moe-next's vocabulary. The DoD names old-Moe tools (heartbeat,
    // complete_step, chat_send); none of them exist here. The real equivalents
    // are work.renew — the claim holder's keepalive, and the first command a
    // superseded session actually hits — and session authentication below.
    const projectId = "proj-wrapper-fence-superseded";
    const harness = isolatedHarness(projectId);
    const store = SqliteEventStore.openForProject(harness.storePath, projectId);
    try {
      const item = "policy.install@policy-superseded";
      writeClaim(store, projectId, "work.claim", "sess-first", item, 0, "superseded-first");
      writeClaim(store, projectId, "work.release", "sess-first", item, 1, "superseded-release");
      writeClaim(store, projectId, "work.claim", "sess-second", item, 2, "superseded-second");

      const before = readWorkClaimLedger(store, projectId).claims.get(item);
      expect(before).toMatchObject({ claimedBy: "sess-second", status: "OPEN", version: 3 });
      const beforeBytes = JSON.stringify(before);

      const refused = runWorkClaimCommand(store, new TextEncoder().encode(JSON.stringify({
        commandId: "superseded-renew", correlationId: "superseded",
        decidedAt: new Date(NOW).toISOString(), expectedVersion: 3, kind: "work.renew",
        payload: { expiresAt: new Date(NOW + 120_000).toISOString(), workItemId: item },
        principalId: "sess-first", projectId, schemaVersion: WORK_CLAIM_SCHEMA_VERSION,
      })));

      // The CODE and the LAYER that answered. Two layers can refuse a superseded
      // session — this prerequisite gate and session authentication — so a test
      // asserting only `ok === false` goes vacuous the moment the other one
      // starts answering first.
      expect(refused).toMatchObject({
        code: "WORK_CLAIM_NOT_CLAIMANT", ok: false, refusedBy: "DAEMON_PREREQUISITE",
      });

      // Refused means REFUSED: the durable aggregate is byte-identical after.
      const after = readWorkClaimLedger(store, projectId).claims.get(item);
      expect(JSON.stringify(after)).toBe(beforeBytes);
      expect(after).toMatchObject({ claimedBy: "sess-second", version: 3 });
    } finally {
      store.close();
      harness.dispose();
    }
  });

  it("stops restaffing an unmoved item after maxItemAttempts spawn cycles", async () => {
    // Live run 2026-08-20: policy.validate refused BOOTSTRAP_POLICY_UNKNOWN for every input,
    // the agent released its claim, and the wrapper respawned another agent at the same READY
    // step every pass — a real model per cycle, forever. This runs the honest cycle over the
    // REAL surface: spawn, immediate exit, durable release, step unmoved, respawn.
    const projectId = "proj-wrapper-breaker";
    const harness = isolatedHarness(projectId);
    try {
      let suffix = 0;
      const started: SpawnRequest[] = [];
      const breaker = createAgentWrapper({
        affordances: harness.port,
        claimTtlMs: 60_000,
        clock: () => NOW,
        deps: harness.isolated.provide(),
        maxAgents: 1,
        maxItemAttempts: 3,
        mintSecret: () => `breaker-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        // The child exits immediately without doing the step's work, so the step
        // stays READY and unclaimed on the next pass — the live pathology exactly.
        spawnAgent: async (request) => {
          started.push(request);
          return { exit: Promise.resolve(), ok: true, pid: CHILD_PID };
        },
      });

      const first = await breaker.runOnce();
      expect(first.spawned[0]?.outcome).toBe("SPAWNED");
      const itemId = first.spawned[0]?.workItemId;
      if (itemId === undefined) throw new Error("nothing staffed");
      await breaker.settle();
      for (let round = 0; round < 2; round += 1) {
        const report = await breaker.runOnce();
        expect(report.spawned.find((entry) => entry.workItemId === itemId)?.outcome)
          .toBe("SPAWNED");
        await breaker.settle();
      }
      expect(started.filter((request) => request.workItemId === itemId)).toHaveLength(3);

      // Fourth pass: the exhaustion is REPORTED, not silent, and the item is not respawned.
      const exhausted = await breaker.runOnce();
      expect(exhausted.spawned.find((entry) => entry.workItemId === itemId)).toMatchObject({
        outcome: "STAFFING_ATTEMPTS_EXHAUSTED",
      });
      expect(started.filter((request) => request.workItemId === itemId)).toHaveLength(3);
      await breaker.settle();
    } finally {
      harness.dispose();
    }
  });

  it("re-arms an exhausted item once it leaves the READY surface", async () => {
    // Counter semantics only, so the surface is a stub and every staffing TRY counts —
    // spawned or refused at the durable claim. Movement is defined as leaving the READY
    // surface; a claim alone is the staffed child's own working state and must NOT reset.
    const projectId = "proj-wrapper-rearm";
    const harness = isolatedHarness(projectId);
    try {
      let suffix = 0;
      const step = {
        aggregateId: "rearm-policy", claim: null, claimAggregateVersion: 0,
        kind: "policy.install", missing: [], status: "READY", version: 0,
      };
      let present = true;
      const rearm = createAgentWrapper({
        affordances: {
          boundProjectId: projectId,
          readSurface: () => ({
            nextAllowedCommands: [],
            outcome: "SURFACE",
            steps: present ? [{ ...step }] : [],
          }),
        } as never,
        claimTtlMs: 60_000,
        clock: () => NOW,
        deps: harness.isolated.provide(),
        maxAgents: 1,
        maxItemAttempts: 2,
        mintSecret: () => `rearm-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        spawnAgent: async () => ({ exit: Promise.resolve(), ok: true, pid: CHILD_PID }),
      });
      const itemId = workItemIdFor("policy.install", "rearm-policy");
      const outcomeOf = async (): Promise<string | undefined> => {
        const report = await rearm.runOnce();
        await rearm.settle();
        return report.spawned.find((entry) => entry.workItemId === itemId)?.outcome;
      };

      // Attempt 1 spawns; the stub hides the durable claim from cleanup, so attempt 2
      // refuses at the claim — BOTH count: each try burns identity and possibly a model.
      expect(await outcomeOf()).toBe("SPAWNED");
      const second = await outcomeOf();
      expect(second).not.toBe("STAFFING_ATTEMPTS_EXHAUSTED");
      expect(await outcomeOf()).toBe("STAFFING_ATTEMPTS_EXHAUSTED");

      // One pass with the step gone — movement — then back: tried again, not suppressed.
      present = false;
      await rearm.runOnce();
      present = true;
      const retried = await outcomeOf();
      expect(retried).toBeDefined();
      expect(retried).not.toBe("STAFFING_ATTEMPTS_EXHAUSTED");
    } finally {
      harness.dispose();
    }
  });

  it("refuses an unopened session credential at the identity layer", () => {
    // The second layer that can answer for a superseded session. It answers with
    // a VERDICT and no reason code — worth pinning literally, because a reader
    // assuming a coded refusal here would write an assertion that never matches.
    // The AUTHENTICATED control is what keeps this from being an authenticator
    // that simply refuses everything.
    const projectId = "proj-wrapper-fence-identity";
    const harness = isolatedHarness(projectId);
    try {
      const { authenticator } = harness.isolated.provide();
      expect(authenticator.authenticate("secret-a-session-that-was-never-opened"))
        .toEqual({ verdict: "UNAUTHENTICATED" });
      expect(authenticator.authenticate(OPERATOR)).toMatchObject({ verdict: "AUTHENTICATED" });
    } finally {
      harness.dispose();
    }
  });
});

describe("createAgentWrapper - bearer and claim horizons", () => {
  it("opens the bearer on the session TTL while the claim keeps the claim TTL", async () => {
    // Live shape: a long task renews its claim past the 30-minute bearer, the
    // child exits, and every exit-path release under the dead secret is refused
    // as unauthenticated, which wedges the wrapper on AGENT_CLEANUP_FAILED. The
    // two horizons are separate knobs, and the durable records prove which
    // received which.
    const projectId = "proj-wrapper-session-ttl";
    const harness = isolatedHarness(projectId);
    const reader = SqliteEventStore.openForProject(harness.storePath, projectId);
    const requests: SpawnRequest[] = [];
    try {
      let suffix = 0;
      const split = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `ttl-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        sessionTtlMs: 600_000,
        spawnAgent: async (request) => {
          requests.push(request);
          return { exit: new Promise<void>(() => undefined), ok: true, pid: CHILD_PID };
        },
      });

      const staffed = (await split.runOnce()).spawned[0];
      expect(staffed?.outcome).toBe("SPAWNED");
      if (staffed?.sessionId === null || staffed?.sessionId === undefined) {
        throw new Error("nothing staffed");
      }
      expect(readSessionLedger(reader, projectId).sessions.get(staffed.sessionId))
        .toMatchObject({ expiresAt: new Date(NOW + 600_000).toISOString(), status: "OPEN" });
      expect(readWorkClaimLedger(reader, projectId).claims.get(staffed.workItemId))
        .toMatchObject({ expiresAt: new Date(NOW + 60_000).toISOString(), status: "OPEN" });
      // The mission names the CLAIM horizon: that is the one the agent renews.
      expect(requests[0]?.expiresAt).toBe(new Date(NOW + 60_000).toISOString());
    } finally {
      reader.close();
      harness.dispose();
    }
  });

  it("binds the bearer to the claim TTL only when no session TTL is configured", async () => {
    const projectId = "proj-wrapper-session-ttl-fallback";
    const harness = isolatedHarness(projectId);
    const reader = SqliteEventStore.openForProject(harness.storePath, projectId);
    try {
      let suffix = 0;
      const bound = createAgentWrapper({
        affordances: harness.port, claimTtlMs: 60_000, clock: () => NOW,
        deps: harness.isolated.provide(), maxAgents: 1,
        mintSecret: () => `tfb-${String(suffix += 1).padStart(4, "0")}${"0".repeat(28)}`,
        operatorCredential: OPERATOR,
        spawnAgent: async () =>
          ({ exit: new Promise<void>(() => undefined), ok: true, pid: CHILD_PID }),
      });

      const staffed = (await bound.runOnce()).spawned[0];
      if (staffed?.sessionId === null || staffed?.sessionId === undefined) {
        throw new Error("nothing staffed");
      }
      expect(readSessionLedger(reader, projectId).sessions.get(staffed.sessionId))
        .toMatchObject({ expiresAt: new Date(NOW + 60_000).toISOString(), status: "OPEN" });
    } finally {
      reader.close();
      harness.dispose();
    }
  });
});
