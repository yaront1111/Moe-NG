/**
 * The writer, measured over the production wire: a PRD bound by
 * `goal.create_with_source`, a draft citing that PRD's sha, and the commit the
 * writer-less store has waited for. Fences each answer with their own code and
 * the store's content-addressed commandId makes the replay arm a REPLAYED
 * disposition, not a second aggregate.
 */
import { createHash } from "node:crypto";

import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_CREATE_COMMAND_ID,
  GOAL_ID,
  PROJECT_ID,
  closeStores,
  driveThrough,
  envelope,
  openStore,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { runProductContractProposeRevision } from "./product-contract-propose-service.js";
import type { ProposeRevisionInput } from "./product-contract-propose-service.js";

const PRD = "# Build the widget\n\nRequirements the operator wrote.\n";
const PRD_SHA = createHash("sha256").update(PRD, "utf8").digest("hex");

afterEach(closeStores);

function boundWorld(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "goal.create");
  const outcome = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Bind a PRD for the writer drills.",
    source: { displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD },
    title: "Writer journey goal",
  }, GOAL_CREATE_COMMAND_ID));
  if (!outcome.ok) throw new Error(`fixture bind refused: ${outcome.code}`);
  return store;
}

function draftOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    authorRef: "compiler-agent-1",
    contractId: "contract-widget",
    criteria: [
      {
        criterionId: "crit-api", requirementId: "req-api",
        statement: "The API answers a signed request with the record.",
        supersedesCriterionId: null,
      },
    ],
    lineage: null,
    requirements: [
      {
        requirementId: "req-api",
        statement: "Operators can read the record over the API.",
        supersedesRequirementId: null,
      },
    ],
    retiredCriterionIds: [],
    retiredRequirementIds: [],
    revisionId: "revision-0001",
    sourceDocumentDigests: [PRD_SHA],
    ...overrides,
  };
}

function inputOf(
  payload: unknown, extras: Partial<ProposeRevisionInput> = {},
): ProposeRevisionInput {
  return {
    correlationId: "corr-propose-1",
    decidedAt: "2026-08-30T12:00:00.000Z",
    payload,
    principalId: "compiler-agent-1",
    projectId: PROJECT_ID,
    ...extras,
  };
}

describe("runProductContractProposeRevision", () => {
  it("commits a provenance-proven draft, and a replay REPLAYS rather than re-minting", () => {
    const store = boundWorld();
    const first = runProductContractProposeRevision(
      store, inputOf({ draft: draftOf(), goalRef: GOAL_ID }),
    );
    if (!first.ok) throw new Error(`commit refused: ${first.code}`);
    expect(first.disposition).toBe("DECIDED");
    expect(first.revision.sourceDocumentDigests).toEqual([PRD_SHA]);
    expect(first.revision.advisoryOnly).toBe(true);

    const replay = runProductContractProposeRevision(
      store, inputOf({ draft: draftOf(), goalRef: GOAL_ID }),
    );
    if (!replay.ok) throw new Error(`replay refused: ${replay.code}`);
    expect(replay.disposition).toBe("REPLAYED");
    expect(replay.ref).toEqual(first.ref);
  });

  it("refuses a draft that quietly omits the goal's PRD sha", () => {
    const store = boundWorld();
    const outcome = runProductContractProposeRevision(store, inputOf({
      draft: draftOf({ sourceDocumentDigests: ["ab".repeat(32)] }), goalRef: GOAL_ID,
    }));
    expect(outcome).toMatchObject({
      code: "PRODUCT_CONTRACT_PROVENANCE_DIGEST_MISSING", ok: false,
    });
  });

  it("refuses lineage in v0 - re-revision belongs to the clarification row", () => {
    const store = boundWorld();
    const outcome = runProductContractProposeRevision(store, inputOf({
      draft: draftOf({
        lineage: { parentRevisionDigest: "cd".repeat(32), parentRevisionId: "revision-0000" },
      }),
      goalRef: GOAL_ID,
    }));
    expect(outcome).toMatchObject({
      code: "PRODUCT_CONTRACT_PROPOSE_LINEAGE_UNSUPPORTED", ok: false,
    });
  });

  it("refuses submission while a MATERIAL clarification is open", () => {
    const store = boundWorld();
    const outcome = runProductContractProposeRevision(store, inputOf(
      { draft: draftOf(), goalRef: GOAL_ID },
      { clarifications: { openMaterialClarificationIds: () => ["clar-1"] } },
    ));
    expect(outcome).toMatchObject({
      code: "PRODUCT_CONTRACT_PROPOSE_CLARIFICATION_OPEN", ok: false,
    });
  });

  it("forwards core admission refusals unrestamped", () => {
    const store = boundWorld();
    // Criteria out of ascending order - core's admission owns this refusal.
    const outcome = runProductContractProposeRevision(store, inputOf({
      draft: draftOf({
        criteria: [
          {
            criterionId: "crit-z", requirementId: "req-api",
            statement: "z first", supersedesCriterionId: null,
          },
          {
            criterionId: "crit-api", requirementId: "req-api",
            statement: "a second", supersedesCriterionId: null,
          },
        ],
      }),
      goalRef: GOAL_ID,
    }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code.startsWith("PRODUCT_CONTRACT_PROPOSE")).toBe(false);
  });

  it("refuses malformed payloads by shape", () => {
    const store = boundWorld();
    for (const payload of [null, [], "x", {}, { draft: draftOf() },
      { draft: draftOf(), extra: 1, goalRef: GOAL_ID }, { draft: "x", goalRef: GOAL_ID }]) {
      expect(runProductContractProposeRevision(store, inputOf(payload))).toMatchObject({
        code: "PRODUCT_CONTRACT_PROPOSE_MALFORMED", ok: false,
      });
    }
  });
});
