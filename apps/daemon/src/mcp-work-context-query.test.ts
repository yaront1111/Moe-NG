import type { NextAllowedCommand } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import type {
  AffordanceRefused, AffordanceSurface, ChainStep,
} from "./http/affordance-contract.js";
import { workItemIdFor } from "./http/affordance-read.js";
import {
  SURFACE_ITEM, WORK_ITEM_UNKNOWN, answerWorkContextQuery,
} from "./mcp-work-context-query.js";
import type { SurfaceItem } from "./mcp-work-context-query.js";

const RUN = "run-item-query";
const GOAL = "goal-item-query";
const READ_AT = "2026-09-04T12:00:00.000Z";

function step(overrides: Partial<ChainStep>): ChainStep {
  return Object.freeze({
    aggregateId: null,
    claim: null,
    claimAggregateVersion: 0,
    kind: "kind.placeholder",
    missing: Object.freeze([]),
    status: "READY" as const,
    version: null,
    ...overrides,
  });
}

/** The two steps that share RUN under different kinds - the identity trap this row exists for. */
const CLAIMED = step({
  aggregateId: RUN,
  claim: Object.freeze({ claimedBy: "worker-item", expiresAt: READ_AT, version: 9 }),
  claimAggregateVersion: 9,
  kind: "plan.propose",
  version: 4,
});
const SIBLING = step({
  aggregateId: RUN,
  claimAggregateVersion: 2,
  kind: "approval.decide",
  missing: Object.freeze(["plan.propose"]),
  status: "BLOCKED" as const,
});
const UNKEYED = step({ aggregateId: GOAL, claimAggregateVersion: 1, kind: "goal.close" });
const ORPHAN = step({ aggregateId: null, kind: "node.deliver" });

function offer(commandId: string, targetAggregateId: string): NextAllowedCommand {
  return Object.freeze({
    commandEnvelopeVersion: "moe-runtime-command/1" as const,
    commandId,
    commandKind: "plan.propose" as const,
    expectedVersion: 4,
    inputSchemaVersion: "moe-runtime-command/1",
    targetAggregateId,
  });
}

const MATCHING_OFFER = offer("cmd-run", RUN);
const OTHER_OFFER = offer("cmd-goal", GOAL);

const AUTHORITY = Object.freeze({
  authority: Object.freeze({ kind: "fixture" }),
  goalRef: GOAL,
  graphContentBytesBase64: "Zml4dHVyZQ==",
  graphContentHash: "a".repeat(64),
  graphRevisionRef: `${RUN}-graph-revision`,
  runId: RUN,
  submissionHash: "b".repeat(64),
});

const SURFACE: AffordanceSurface = Object.freeze({
  nextAllowedCommands: Object.freeze([MATCHING_OFFER, OTHER_OFFER]),
  outcome: "SURFACE" as const,
  planningAuthorityByRun: Object.freeze({ [RUN]: AUTHORITY }),
  planningGoalRefs: Object.freeze({ [RUN]: GOAL }),
  planningGoalRef: GOAL,
  steps: Object.freeze([
    CLAIMED, SIBLING, UNKEYED, ORPHAN,
    ...Array.from({ length: 18 }, (_unused, index) => step({
      aggregateId: `aggregate-${index}`,
      claimAggregateVersion: index,
      kind: `kind.filler-${index}`,
      status: "COMMITTED" as const,
      version: index,
    })),
  ]),
});

const REFUSED: AffordanceRefused = Object.freeze({
  code: "AFFORDANCE_PROJECT_MISMATCH",
  detail: "the authenticated principal is bound to another project",
  layer: "AFFORDANCE_SURFACE",
  outcome: "REFUSED" as const,
});

function itemFor(workItemId: string): SurfaceItem {
  const answer = answerWorkContextQuery({ workItemId }, SURFACE, READ_AT);
  if (!("outcome" in answer) || answer.outcome !== SURFACE_ITEM) {
    throw new Error(`expected a SURFACE_ITEM for ${workItemId}, got ${JSON.stringify(answer)}`);
  }
  return answer;
}

describe("answerWorkContextQuery", () => {
  it("passes a refused surface through by reference, whatever the payload", () => {
    expect(answerWorkContextQuery(undefined, REFUSED, READ_AT)).toBe(REFUSED);
    expect(answerWorkContextQuery(
      { workItemId: workItemIdFor("plan.propose", RUN) }, REFUSED, READ_AT,
    )).toBe(REFUSED);
  });

  it("returns the SAME surface object when no workItemId is named", () => {
    // Byte identity of the payload-less answer depends on this reference, not on a rebuild.
    expect(answerWorkContextQuery(undefined, SURFACE, READ_AT)).toBe(SURFACE);
    expect(answerWorkContextQuery({}, SURFACE, READ_AT)).toBe(SURFACE);
    expect(answerWorkContextQuery({ projectId: "proj-x" }, SURFACE, READ_AT)).toBe(SURFACE);
  });

  it("refuses INPUT_INVALID for a payload that is not a record or names a bad id", () => {
    const payloads: readonly unknown[] = [
      null, [], "work", 7, { workItemId: "" }, { workItemId: 7 },
      { workItemId: null }, { workItemId: ["a"] },
    ];
    for (const payload of payloads) {
      const answer = answerWorkContextQuery(payload, SURFACE, READ_AT);
      expect({ code: (answer as { code?: string }).code, payload })
        .toEqual({ code: "INPUT_INVALID", payload });
      expect("outcome" in answer).toBe(false);
    }
  });

  it("refuses WORK_ITEM_UNKNOWN, at the affordance-surface layer, for an id no step has", () => {
    const answer = answerWorkContextQuery(
      { workItemId: "plan.propose@ghost" }, SURFACE, READ_AT,
    ) as AffordanceRefused;

    expect(answer.code).toBe(WORK_ITEM_UNKNOWN);
    expect(answer.code).toBe("WORK_ITEM_UNKNOWN");
    expect(answer.layer).toBe("AFFORDANCE_SURFACE");
    expect(answer.outcome).toBe("REFUSED");
    expect(answer.detail).toContain("plan.propose@ghost");
  });

  it("selects by kind AND aggregateId, not by aggregateId alone", () => {
    const claimed = itemFor(workItemIdFor("plan.propose", RUN));
    const sibling = itemFor(workItemIdFor("approval.decide", RUN));

    expect(claimed.step).toBe(CLAIMED);
    expect(claimed.step.claim?.claimedBy).toBe("worker-item");
    expect(claimed.step.claimAggregateVersion).toBe(9);
    expect(sibling.step).toBe(SIBLING);
    expect(sibling.step.claim).toBeNull();
    expect(sibling.step.claimAggregateVersion).toBe(2);
    expect(claimed.readAt).toBe(READ_AT);
    expect(claimed.outcome).toBe("SURFACE_ITEM");
  });

  it("resolves a null-aggregate step through the dash key convention", () => {
    const orphan = itemFor(workItemIdFor("node.deliver", null));

    expect(orphan.step).toBe(ORPHAN);
    expect(orphan.nextAllowedCommands).toEqual([]);
    expect(orphan.planningGoalRef).toBeNull();
    expect(orphan.planningAuthority).toBeNull();
  });

  it("carries only the offers and planning material keyed to the step's aggregate", () => {
    const claimed = itemFor(workItemIdFor("plan.propose", RUN));
    expect(claimed.nextAllowedCommands).toEqual([MATCHING_OFFER]);
    expect(claimed.nextAllowedCommands).not.toContain(OTHER_OFFER);
    expect(claimed.planningGoalRef).toBe(GOAL);
    expect(claimed.planningAuthority).toBe(AUTHORITY);

    const unkeyed = itemFor(workItemIdFor("goal.close", GOAL));
    expect(unkeyed.nextAllowedCommands).toEqual([OTHER_OFFER]);
    expect(unkeyed.planningGoalRef).toBeNull();
    expect(unkeyed.planningAuthority).toBeNull();
  });

  it("answers prototype-key ids with a refusal instead of throwing or inheriting", () => {
    const ids = ["constructor", "__proto__", "toString",
      "plan.propose@constructor", "plan.propose@__proto__"];
    for (const workItemId of ids) {
      const answer = answerWorkContextQuery({ workItemId }, SURFACE, READ_AT);
      expect({ code: (answer as { code?: string }).code, workItemId })
        .toEqual({ code: "WORK_ITEM_UNKNOWN", workItemId });
    }
  });

  it("bounds what an unbounded caller-chosen id can make the refusal echo back", () => {
    // The query path does no bounded decode, so an id is unbounded wire input: echoing it
    // whole would let the caller pick the size of the daemon's own answer.
    const huge = `plan.propose@${"x".repeat(50_000)}`;
    const answer = answerWorkContextQuery({ workItemId: huge }, SURFACE, READ_AT) as
      AffordanceRefused;

    expect(answer.code).toBe("WORK_ITEM_UNKNOWN");
    expect(answer.detail).toContain("plan.propose@xxxx");
    expect(answer.detail).not.toContain(huge);
    expect(JSON.stringify(answer).length).toBeLessThan(512);
  });

  it("serialises the step FIRST so a truncating harness cannot cut the claim version", () => {
    // planningAuthority carries graphContentBytesBase64 — as big as the graph — so the
    // member this row exists to expose must not sit behind it in the wire order.
    const claimed = itemFor(workItemIdFor("plan.propose", RUN));
    const keys = Object.keys(claimed);

    expect(keys[0]).toBe("step");
    expect(keys.indexOf("step")).toBeLessThan(keys.indexOf("planningAuthority"));
    const encoded = JSON.stringify(claimed);
    expect(encoded.indexOf("claimAggregateVersion"))
      .toBeLessThan(encoded.indexOf("planningAuthority"));
  });

  it("freezes the item and every array it hands out", () => {
    const claimed = itemFor(workItemIdFor("plan.propose", RUN));
    expect(Object.isFrozen(claimed)).toBe(true);
    expect(Object.isFrozen(claimed.nextAllowedCommands)).toBe(true);
    expect(Object.isFrozen(claimed.step)).toBe(true);
  });

  it("stays far under the 8 KB an MCP harness will truncate, on a 22-step surface", () => {
    expect(SURFACE.steps.length).toBeGreaterThanOrEqual(20);
    const claimed = itemFor(workItemIdFor("plan.propose", RUN));

    expect(JSON.stringify(claimed).length).toBeLessThan(8192);
    expect(JSON.stringify(claimed).length).toBeLessThan(JSON.stringify(SURFACE).length);
  });
});
