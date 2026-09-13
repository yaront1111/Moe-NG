import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import { activateV2Directly } from "../cutover/v2-activation-test-fixtures.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { createPlaneFollowingDeps } from "../http/command-plane-deps.js";
import type { CommandAdapterDeps } from "../http/http-contract.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import { readWorkClaimLedger } from "../work/work-claim-services.js";
import { createAgentWrapper } from "./agent-wrapper.js";

/**
 * THE WRAPPER FOLLOWS THE CUTOVER PLANE. Every world is the shipped composition over a real
 * temp store, a real offer surface, and a spawn stub whose child exits at once, so the whole
 * staffing path runs: session.open (operator), work.claim (the agent), then on exit
 * work.release and session.close (the agent's own secret). Nothing decides the plane but the
 * durable cutover marker, committed mid-test through the production codecs. The subject is
 * what ONE wrapper instance answers before and after that marker, because a wrapper process
 * outlives an activation and its deps must not be pinned to the plane current at its start.
 */
const OPERATOR = "wrapper-plane-operator";

type Provider = ReturnType<typeof createStoreDependencies>;

interface World {
  readonly decisions: () => number;
  readonly dispose: () => void;
  readonly projectId: string;
  readonly store: SqliteEventStore;
  readonly wrapper: ReturnType<typeof createAgentWrapper>;
}

function world(label: string, depsOf: (provider: Provider) => CommandAdapterDeps): World {
  const sandbox = mkdtempSync(join(tmpdir(), `moe-wrapper-plane-${label}-`));
  const projectId = `proj-wrapper-plane-${label}`;
  const storePath = join(sandbox, "store.db");
  const provider = createStoreDependencies({
    credential: OPERATOR, principalId: "operator-local", projectId, storePath,
  });
  const store = SqliteEventStore.openForProject(storePath, projectId);
  const affordances = provider.affordances?.();
  if (affordances === undefined) throw new Error("affordances unavailable");
  // DELTA from the composition's own boot writes, as mcp-dispatch-port-plane.test.ts counts.
  const baseline = store.readCommandDecisionsAfter(0n, 1_000).items.length;
  let minted = 0;
  const wrapper = createAgentWrapper({
    affordances, claimTtlMs: 60_000, clock: () => Date.now(), deps: depsOf(provider),
    maxAgents: 1, maxItemAttempts: 3,
    mintSecret: () => `plane-${String(++minted).padStart(6, "0")}${"0".repeat(28)}`,
    operatorCredential: OPERATOR,
    spawnAgent: async () => ({ exit: Promise.resolve(), ok: true, pid: 909_090 }),
  });
  return {
    decisions: () => store.readCommandDecisionsAfter(0n, 1_000).items.length - baseline,
    dispose: () => {
      store.close();
      provider.close();
      rmSync(sandbox, { force: true, recursive: true });
    },
    projectId, store, wrapper,
  };
}

/** The binary's composition: both shipped planes and the shipped reader. */
function planeFollowing(provider: Provider): CommandAdapterDeps {
  const commandAuthorityPlane = provider.commandAuthorityPlane?.();
  const v2Deps = provider.provideV2?.();
  if (commandAuthorityPlane === undefined || v2Deps === undefined) throw new Error("no /2 plane");
  return createPlaneFollowingDeps({ commandAuthorityPlane, deps: provider.provide(), v2Deps });
}

describe("the wrapper follows the command authority plane per dispatch", () => {
  it("ONE wrapper instance staffs on /1, then on /2 after the marker commits, cleanup included", async () => {
    const opened = world("follows", planeFollowing);
    try {
      const before = await opened.wrapper.runOnce();
      expect(before.spawned[0]).toMatchObject({ outcome: "SPAWNED" });
      await expect(opened.wrapper.settle()).resolves.toBeUndefined();
      const seat = before.spawned[0];
      if (seat === undefined || seat.sessionId === null) throw new Error("nothing staffed");
      const committedOnV1 = opened.decisions();
      expect(committedOnV1).toBeGreaterThan(0);

      activateV2Directly(opened.store, opened.projectId);

      // THE SAME WRAPPER, nothing rebuilt: the /2 plane opens the session, claims, and on
      // exit releases and closes; all four commit, none answers the retirement the /1
      // plane now gives (the control arm below proves that is what /1 answers).
      const after = await opened.wrapper.runOnce();
      expect(after.surfaceOutcome).toBe("SURFACE");
      expect(after.spawned[0]).toMatchObject({ outcome: "SPAWNED", workItemId: seat.workItemId });
      await expect(opened.wrapper.settle()).resolves.toBeUndefined();
      const second = after.spawned[0];
      if (second === undefined || second.sessionId === null) throw new Error("nothing restaffed");
      expect(opened.decisions()).toBeGreaterThan(committedOnV1);
      expect(readWorkClaimLedger(opened.store, opened.projectId).claims.get(seat.workItemId)?.status)
        .toBe("RELEASED");
      expect(readSessionLedger(opened.store, opened.projectId).sessions.get(second.sessionId)?.status)
        .toBe("CLOSED");
    } finally {
      opened.dispose();
    }
  });

  it("CONTROL: deps captured from provider.provide() (the prior shape) are stranded on /1", async () => {
    // What agent-wrapper-main.ts passed before this row: the /1 value, frozen at start. After
    // the flip every READY item answers V1_AUTHORITY_RETIRED as its outcome, each pass charges
    // the attempt, and the item exhausts without a seat ever starting.
    const opened = world("stranded", (provider) => provider.provide());
    try {
      const before = await opened.wrapper.runOnce();
      expect(before.spawned[0]).toMatchObject({ outcome: "SPAWNED" });
      await expect(opened.wrapper.settle()).resolves.toBeUndefined();
      const seat = before.spawned[0];
      if (seat === undefined) throw new Error("nothing staffed");
      const committedOnV1 = opened.decisions();

      activateV2Directly(opened.store, opened.projectId);

      const second = await opened.wrapper.runOnce();
      expect(second.surfaceOutcome).toBe("SURFACE");
      expect(second.spawned.length).toBeGreaterThan(0);
      expect(second.spawned.every((entry) => entry.outcome === "V1_AUTHORITY_RETIRED")).toBe(true);
      const third = await opened.wrapper.runOnce();
      expect(third.spawned.find((entry) => entry.workItemId === seat.workItemId)?.outcome)
        .toBe("V1_AUTHORITY_RETIRED");
      const fourth = await opened.wrapper.runOnce();
      expect(fourth.spawned.find((entry) => entry.workItemId === seat.workItemId)?.outcome)
        .toBe("STAFFING_ATTEMPTS_EXHAUSTED");
      // Refusals only: nothing committed on the retired plane.
      expect(opened.decisions()).toBe(committedOnV1);
      await expect(opened.wrapper.settle()).resolves.toBeUndefined();
    } finally {
      opened.dispose();
    }
  });
});
