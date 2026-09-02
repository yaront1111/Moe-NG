/**
 * The MIDDLE, drilled end to end over ONE durable world: PRD bound by the
 * production `goal.create_with_source`, revision committed by the production
 * writer, Gate 1 approved by a REAL paired bearer session through the production
 * gate command, then `runSubmitDecomposition` compiles the APPROVED revision and
 * drives create→ready→claim→propose→finalize through the production planning
 * handlers. The run ends REVIEWABLE — exactly where the browser's ApprovePlan
 * gate picks it up. Refusal arms: no Gate 1 approval; digest retarget;
 * crash-restart resume (second dispatch REPLAYS, no duplicate records).
 */
import { createHash } from "node:crypto";

import { productContractGate1Authority } from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_CREATE_COMMAND_ID,
  GOAL_ID,
  PROJECT_ID,
  RUN_ID,
  closeStores,
  driveThrough,
  envelope,
  openStore,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { OPERATOR_CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createSessionAuthority } from "../identity/session-authority.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import {
  createProductContractGate1Authority, runProductContractGate1Command,
} from "../product-contract/product-contract-gate-1-command.js";
import { PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION, productContractGate1SubjectDigest }
  from "../product-contract/product-contract-gate-1-contract.js";
import {
  runProductContractProposeRevision,
} from "../product-contract/product-contract-propose-service.js";
import type { ProductContractRevisionRef } from "@moe/core";
import { runSubmitDecomposition } from "./compile-dispatcher.js";

const PRD = "# Build the widget\n\nRequirements the operator wrote.\n";
const PRD_SHA = createHash("sha256").update(PRD, "utf8").digest("hex");
const NOW_MS = Date.parse("2026-08-30T12:00:00.000Z");
const encoder = new TextEncoder();

afterEach(closeStores);

function boundWorld(): SqliteEventStore {
  const store = openStore();
  installTestRecoveryBinding(store);
  driveThrough(store, "goal.create");
  const outcome = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Bind a PRD for the dispatcher journey.",
    source: { displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD },
    title: "Dispatcher journey goal",
  }, GOAL_CREATE_COMMAND_ID));
  if (!outcome.ok) throw new Error(`fixture bind refused: ${outcome.code}`);
  return store;
}

function committedRevision(store: SqliteEventStore): ProductContractRevisionRef {
  const committed = runProductContractProposeRevision(store, {
    correlationId: "corr-dispatch-writer",
    decidedAt: "2026-08-30T12:00:00.000Z",
    payload: {
      draft: {
        authorRef: "compiler-agent-1",
        contractId: "contract-widget",
        criteria: [
          {
            criterionId: "crit-api", requirementId: "req-api",
            statement: "The API answers a signed request with the record.",
            supersedesCriterionId: null,
          },
          {
            criterionId: "crit-ui", requirementId: "req-ui",
            statement: "The page renders the record the API answered.",
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
          {
            requirementId: "req-ui",
            statement: "Operators can see the record in the page.",
            supersedesRequirementId: null,
          },
        ],
        retiredCriterionIds: [],
        retiredRequirementIds: [],
        revisionId: "revision-0001",
        sourceDocumentDigests: [PRD_SHA],
      },
      goalRef: GOAL_ID,
    },
    principalId: "compiler-agent-1",
    projectId: PROJECT_ID,
  });
  if (!committed.ok) throw new Error(`writer refused: ${committed.code}`);
  return committed.ref;
}

/** Gate 1 through the PRODUCTION command: a real paired session approves over the
 *  BEARER arm, which the transport-origin fence now admits from MCP transports only
 *  (the browser journey signs instead - task-ffa05408 family). */
function approveGate1(store: SqliteEventStore, ref: ProductContractRevisionRef): void {
  const minted = createOperatorSessionHandshakePort({
    capabilities: OPERATOR_CAPABILITIES,
    clock: () => NOW_MS,
    operatorPrincipalId: "principal-1",
    projectId: PROJECT_ID,
    sessionTtlMs: 60 * 60 * 1000,
    store,
  }).mint();
  if (!minted.ok) throw new Error(`pairing mint refused: ${minted.code}`);
  const authority = createProductContractGate1Authority({
    projectId: PROJECT_ID,
    sessions: createSessionAuthority(store, { clock: () => NOW_MS, projectId: PROJECT_ID }),
    store,
  });
  const gate = productContractGate1Authority(ref);
  const commandId = "cmd-gate1-approve";
  const requestDigest = productContractGate1SubjectDigest({
    commandId, projectId: PROJECT_ID, workRef: gate.workRef,
  });
  const outcome = runProductContractGate1Command(store, encoder.encode(JSON.stringify({
    commandId,
    correlationId: "corr-gate1",
    decidedAt: "2026-08-30T12:00:30.000Z",
    expectedVersion: 0,
    kind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
    payload: {
      authentication: { issuedAt: NOW_MS, kind: "BEARER", requestDigest, requestId: commandId },
      contractId: ref.contractId,
      revisionDigest: ref.revisionDigest,
      revisionId: ref.revisionId,
    },
    principalId: minted.principalId,
    projectId: PROJECT_ID,
    schemaVersion: PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
  })), authority, { sessionId: minted.principalId, transportOrigin: "MCP_HTTP" });
  if (!outcome.ok) throw new Error(`gate 1 refused: ${outcome.code}`);
}

const NODE_SCOPES = Object.freeze({
  capability: "capability-implement",
  readScopes: ["services/api/src"],
  resources: ["resource-a"],
  verificationRecipeRefs: ["recipe-a"],
  writeScopes: ["services/api/src/node"],
});

function structureOf(): Record<string, unknown> {
  // ONE node: an INITIAL run seals exactly one execution-bearing node by core
  // design (multi-node arrives through EXPANSION runs). The single slice covers
  // every criterion of the approved revision.
  return {
    completionNodeKey: "node-slice",
    nodes: [
      { ...NODE_SCOPES, criterionIds: ["crit-api", "crit-ui"], dependsOn: [],
        nodeKey: "node-slice", objective: "Land the record read and its page." },
    ],
  };
}

function submit(
  store: SqliteEventStore, ref: ProductContractRevisionRef,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof runSubmitDecomposition> {
  return runSubmitDecomposition(store, {
    correlationId: "corr-submit-decomp",
    decidedAt: "2026-08-30T12:01:00.000Z",
    payload: {
      gateRef: {
        contractId: ref.contractId, revisionDigest: ref.revisionDigest,
        revisionId: ref.revisionId,
      },
      goalRef: GOAL_ID,
      structure: structureOf(),
      ...overrides,
    },
    principalId: "principal-1",
    projectId: PROJECT_ID,
  });
}

describe("runSubmitDecomposition", () => {
  it("drives the approved contract to a REVIEWABLE single-slice plan, and resumes idempotently", () => {
    const store = boundWorld();
    const ref = committedRevision(store);
    approveGate1(store, ref);

    const first = submit(store, ref);
    if (!first.ok) throw new Error(`dispatch refused: ${first.code}`);
    expect(first.disposition).toBe("DECIDED");
    expect(first.runId).toBe(RUN_ID);
    // Proposed (one fold decision) + finalized (a second): the ApprovePlan shape.
    expect(store.getAggregateVersion(RUN_ID)).toBe(2);

    const again = submit(store, ref);
    if (!again.ok) throw new Error(`re-dispatch refused: ${again.code}`);
    expect(again.disposition).toBe("REPLAYED");
    expect(store.getAggregateVersion(RUN_ID)).toBe(2);
    expect(again.submissionHash).toBe(first.submissionHash);
  });

  it("canonicalizes the agent's criterion set: listing order and repeats are not plan facts", () => {
    const canonicalStore = boundWorld();
    const canonicalRef = committedRevision(canonicalStore);
    approveGate1(canonicalStore, canonicalRef);
    const canonical = submit(canonicalStore, canonicalRef);
    if (!canonical.ok) throw new Error(`canonical refused: ${canonical.code}`);

    const store = boundWorld();
    const ref = committedRevision(store);
    approveGate1(store, ref);
    const structure = structureOf();
    const node = (structure["nodes"] as Record<string, unknown>[])[0]!;
    const shuffled = submit(store, ref, {
      structure: {
        ...structure,
        nodes: [{ ...node, criterionIds: ["crit-ui", "crit-api", "crit-ui"] }],
      },
    });
    if (!shuffled.ok) throw new Error(`shuffled refused: ${shuffled.code}`);
    expect(shuffled.disposition).toBe("DECIDED");
    expect(shuffled.submissionHash).toBe(canonical.submissionHash);
    expect(shuffled.graphContentHash).toBe(canonical.graphContentHash);
  });

  it("refuses node text the plan codec cannot admit as a SHAPE refusal, never a producer throw", () => {
    const store = boundWorld();
    const ref = committedRevision(store);
    approveGate1(store, ref);
    const structure = structureOf();
    const node = (structure["nodes"] as Record<string, unknown>[])[0]!;
    const refusalOf = (overrides: Record<string, unknown>): string => {
      const result = submit(store, ref, { structure: { ...structure, nodes: [{ ...node, ...overrides }] } });
      return result.ok ? "ACCEPTED" : result.code;
    };
    expect(refusalOf({ objective: "\0bad" })).toBe("SUBMIT_DECOMPOSITION_MALFORMED");
    expect(refusalOf({ objective: "é" })).toBe("SUBMIT_DECOMPOSITION_MALFORMED");
    expect(refusalOf({ criterionIds: ["crit-api", 7] })).toBe("SUBMIT_DECOMPOSITION_MALFORMED");
    expect(refusalOf({ dependsOn: [null] })).toBe("SUBMIT_DECOMPOSITION_MALFORMED");
    expect(store.getAggregateVersion(RUN_ID)).toBe(0);
  });

  it("refuses when no Gate 1 approval exists — the human gate is not optional", () => {
    const store = boundWorld();
    const ref = committedRevision(store);
    const outcome = submit(store, ref);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toContain("GATE_1");
    expect(store.getAggregateVersion(RUN_ID)).toBe(0);
  });

  it("refuses a gateRef retargeted at a digest the approval never named", () => {
    const store = boundWorld();
    const ref = committedRevision(store);
    approveGate1(store, ref);
    const outcome = submit(store, ref, {
      gateRef: {
        contractId: ref.contractId, revisionDigest: "ab".repeat(32),
        revisionId: ref.revisionId,
      },
    });
    expect(outcome.ok).toBe(false);
    expect(store.getAggregateVersion(RUN_ID)).toBe(0);
  });

  it("refuses malformed payloads by shape, touching nothing durable", () => {
    const store = boundWorld();
    const ref = committedRevision(store);
    approveGate1(store, ref);
    for (const payload of [null, {}, { gateRef: {}, goalRef: GOAL_ID, structure: {} }]) {
      const outcome = runSubmitDecomposition(store, {
        correlationId: "c", decidedAt: "2026-08-30T12:01:00.000Z", payload,
        principalId: "principal-1", projectId: PROJECT_ID,
      });
      expect(outcome).toMatchObject({ code: "SUBMIT_DECOMPOSITION_MALFORMED", ok: false });
    }
    expect(store.getAggregateVersion(RUN_ID)).toBe(0);
  });
});
