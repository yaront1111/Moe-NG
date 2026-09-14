import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { expect, it, vi } from "vitest";

import { driveThrough, envelope, send } from "../bootstrap/bootstrap-test-fixtures.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { GOAL_ID, PRD, PROJECT_ID, approveGate1, committedRevision }
  from "../planning/plan-reject-test-fixtures.js";
import { readWorkClaimLedger } from "../work/work-claim-services.js";
import { createAgentWrapper } from "./agent-wrapper.js";
import type { SpawnRequest } from "./agent-wrapper.js";
import { createCompilerMissionInputs } from "./wrapper-mission-inputs.js";

const INSTRUCTIONS = "REPLAN: put the shared queue contributor before phase validation.\n"
  + "Operator choice: server-backed sessions. Preserve every criterion.\n"
  + 'Literal evidence marker: <<<OPERATOR INSTRUCTIONS>>> "quoted".';
const FOREIGN = "Foreign goal: use a different account provider.";
const OPERATOR = "private-design-context-operator";

function world() {
  const directory = mkdtempSync(join(tmpdir(), "moe-design-context-"));
  const storePath = join(directory, "store.sqlite");
  const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  installTestRecoveryBinding(store);
  driveThrough(store, "goal.create");
  for (const [commandId, instructions] of [["1", INSTRUCTIONS], ["2", FOREIGN]] as const) {
    const result = send(store, envelope("goal.create_with_source", 0, {
      instructions, source: { displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD },
      title: `Design context ${commandId}`,
    }, commandId));
    expect(result.ok).toBe(true);
  }
  approveGate1(store, committedRevision(store));
  const provider = createStoreDependencies({
    credential: OPERATOR, principalId: "operator-local", projectId: PROJECT_ID, storePath,
  });
  const affordances = provider.affordances?.();
  if (affordances === undefined) throw new Error("missing real affordance port");
  const inputs = createCompilerMissionInputs({ projectId: PROJECT_ID, store });
  const started: SpawnRequest[] = [];
  let nonce = 0;
  let finish = (): void => undefined;
  return {
    affordances, inputs, started, store, finish: () => finish(),
    wrapper: (read = inputs.compilerInstructions) => createAgentWrapper({
      affordances, claimTtlMs: 60_000, clock: Date.now, compilerInstructions: read,
      deps: provider.provide(), maxAgents: 1,
      mintSecret: () => `${String(++nonce).padStart(6, "0")}-design-context-${"0".repeat(28)}`,
      operatorCredential: OPERATOR, projectId: PROJECT_ID,
      spawnAgent: async (request) => {
        started.push(request);
        return { exit: new Promise<void>((resolve) => { finish = resolve; }), ok: true, pid: 909_090 };
      },
    }),
    close: () => {
      provider.close(); store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

it("hands the real design seat its exact durable goal instructions", async () => {
  const w = world();
  try {
    const surface = w.affordances.readSurface();
    expect(surface.outcome).toBe("SURFACE");
    if (surface.outcome !== "SURFACE") throw new Error(surface.code);
    expect(surface.steps).toContainEqual(expect.objectContaining({
      aggregateId: `design:${GOAL_ID}`, kind: "design.submit", status: "READY",
    }));
    expect(w.inputs.compilerInstructions(GOAL_ID)).toBe(INSTRUCTIONS);
    expect(w.inputs.compilerInstructions("goal-2")).toBe(FOREIGN);
    const reader = vi.fn(w.inputs.compilerInstructions);
    const wrapper = w.wrapper(reader);
    const report = await wrapper.runOnce();
    w.finish();
    await wrapper.settle();
    expect(report.spawned).toEqual([expect.objectContaining({
      outcome: "SPAWNED", workItemId: `design.submit@design:${GOAL_ID}`,
    })]);
    expect(w.started).toHaveLength(1);
    expect(w.started[0]!.mission).toContain(JSON.stringify(INSTRUCTIONS));
    expect(w.started[0]!.mission).not.toContain(FOREIGN);
    expect(reader.mock.calls).toEqual([[GOAL_ID]]);
    expect(w.started[0]!.mission).toContain(`targetAggregateId "design:${GOAL_ID}"`);
    expect(readWorkClaimLedger(w.store, PROJECT_ID).claims
      .get(w.started[0]!.workItemId)?.status).toBe("RELEASED");
    expect(readSessionLedger(w.store, PROJECT_ID).sessions
      .get(w.started[0]!.sessionId)?.status).toBe("CLOSED");
  } finally { w.close(); }
});

it.each([
  ["REPLAN_CONTEXT_UNAVAILABLE", "REPLAN_CONTEXT_UNAVAILABLE"],
  ["private database error: secret-fixture", "AGENT_SETUP_FAILED:mission:UNEXPECTED_ERROR"],
])("contains a goal reader failure %s with safe outcome %s", async (cause, outcome) => {
  const w = world();
  try {
    const wrapper = w.wrapper(() => { throw new Error(cause); });
    const report = await wrapper.runOnce();
    w.finish();
    await expect(wrapper.settle()).rejects.toThrow(outcome);
    expect(report.spawned).toEqual([expect.objectContaining({
      outcome,
      workItemId: `design.submit@design:${GOAL_ID}`,
    })]);
    expect(w.started).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("secret-fixture");
    expect(readWorkClaimLedger(w.store, PROJECT_ID).claims
      .get(`design.submit@design:${GOAL_ID}`)?.status).toBe("RELEASED");
    expect(readSessionLedger(w.store, PROJECT_ID).sessions
      .get(report.spawned[0]!.sessionId!)?.status).toBe("CLOSED");
  } finally { w.close(); }
});

it("keeps absent optional goal context distinct from an unreadable replan", async () => {
  const w = world();
  try {
    const wrapper = w.wrapper(() => null);
    const report = await wrapper.runOnce();
    w.finish();
    await wrapper.settle();
    expect(report.spawned[0]?.outcome).toBe("SPAWNED");
    expect(w.started[0]!.mission).not.toContain("GOAL INSTRUCTIONS");
    expect(w.started[0]!.mission).toContain("APPROVED Gate 1 contract");
  } finally { w.close(); }
});
