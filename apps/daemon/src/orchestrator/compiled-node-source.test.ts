/**
 * Compiled-plan nodes become buildable board work. The graph fixture is the
 * REAL compile: `compiledPlanAuthority` seals content through the production
 * codecs and `decodeGraphContent` reads it back, so the definitions this source
 * walks are byte-for-byte what an approved compiled plan carries. The reader is
 * injected per arm (the projection has its own suite); the statement join runs
 * over a REAL store with the same production `goal.create_with_source` fixture
 * the lane suite uses.
 */
import { decodeGraphContent } from "@moe/scheduler";
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
import { createGoalSourceReadPort } from "../documents/document-source-full-read.js";
import { compiledPlanAuthority } from "../planning/compiled-authority-bodies.js";
import type { ActiveCompiledGraph } from "./compiled-node-source.js";
import { deriveProductContractRevisionAggregateId }
  from "../product-contract/product-contract-revision-store.js";
import { createCompiledNodeSource } from "./compiled-node-source.js";
import { compiledExecutionRef } from "./compiled-execution-ref.js";

const PRD = "# Compile me\n\nA PRD whose approved plan must build itself.\n";
const CONTRACT_ID = "contract-source-1";
const REVISION_ID = "rev-source-1";
const STATEMENT = "identities.ts exports a stable BeliefKey identity codec.";
const encoder = new TextEncoder();
/** The submitted build order, asserted back verbatim off the sealed graph. */
const CHAIN = Object.freeze([
  Object.freeze({ dependsOn: Object.freeze([] as readonly string[]), nodeKey: "node-a" }),
  Object.freeze({ dependsOn: Object.freeze(["node-a"]), nodeKey: "node-b" }),
  Object.freeze({ dependsOn: Object.freeze(["node-b"]), nodeKey: "node-c" }),
]);

afterEach(closeStores);

const ref = (key: string): string => compiledExecutionRef(PROJECT_ID,
  key === "node-kernel" ? activeGraphFor(GOAL_ID) : chainGraphFor(GOAL_ID), key);

function activeGraphFor(goalRef: string): ActiveCompiledGraph {
  const compiled = compiledPlanAuthority({
    authorRef: "principal-compiler",
    completionNodeKey: "node-kernel",
    criteria: [{ criterionId: "crit-1", statement: STATEMENT }],
    graphRevisionRef: "graph-revision-compiled-1",
    idPrefix: "compiled-source-test",
    knownCapabilities: null,
    nodes: [{
      capability: "capability-implement",
      criterionIds: ["crit-1"],
      dependsOn: [],
      nodeKey: "node-kernel",
      objective: "Implement the belief-key identity kernel.",
      readScopes: ["src"],
      resources: ["resource-a"],
      verificationRecipeRefs: ["recipe-a"],
      writeScopes: ["src/kernel"],
    }],
  });
  if (!compiled.ok) throw new Error(`fixture compile refused: ${compiled.code}`);
  const decoded = decodeGraphContent(Buffer.from(compiled.graphContentBytesBase64, "base64"));
  if (!decoded.ok) throw new Error("fixture graph did not decode");
  return Object.freeze({ content: decoded.value.content, goalRef });
}

/** The a -> b -> c chain, sealed through the same production compile. The
 *  completion node must be the chain's TAIL: a node depending on the
 *  completion node is refused by structure admission. */
function chainGraphFor(goalRef: string): ActiveCompiledGraph {
  const compiled = compiledPlanAuthority({
    authorRef: "principal-compiler",
    completionNodeKey: "node-c",
    criteria: [{ criterionId: "crit-1", statement: STATEMENT }],
    graphRevisionRef: "graph-revision-compiled-chain",
    idPrefix: "compiled-source-chain",
    knownCapabilities: null,
    nodes: CHAIN.map((node) => ({
      capability: "capability-implement",
      criterionIds: ["crit-1"],
      dependsOn: node.dependsOn,
      nodeKey: node.nodeKey,
      objective: `Build ${node.nodeKey}.`,
      readScopes: ["src"],
      resources: ["resource-a"],
      verificationRecipeRefs: ["recipe-a"],
      writeScopes: [`src/${node.nodeKey}`],
    })),
  });
  if (!compiled.ok) throw new Error(`chain fixture compile refused: ${compiled.code}`);
  const decoded = decodeGraphContent(Buffer.from(compiled.graphContentBytesBase64, "base64"));
  if (!decoded.ok) throw new Error("chain fixture graph did not decode");
  return Object.freeze({ content: decoded.value.content, goalRef });
}

function sourceFor(
  store: SqliteEventStore, active: readonly ActiveCompiledGraph[],
  overrides: { testCommand?: string | null; workspace?: string | null } = {},
) {
  return createCompiledNodeSource({
    projectId: PROJECT_ID,
    readActive: () => active,
    store,
    testCommand: overrides.testCommand === undefined ? "pnpm test" : overrides.testCommand,
    workspace: overrides.workspace === undefined ? "D:/projects/unai" : overrides.workspace,
  });
}

function boundWorld(): { sha: string; store: SqliteEventStore } {
  const store = openStore();
  driveThrough(store, "goal.create");
  const outcome = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Compile and build this PRD.",
    source: { displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD },
    title: "Self-building goal",
  }, GOAL_CREATE_COMMAND_ID));
  if (!outcome.ok) throw new Error(`fixture bind refused: ${outcome.code}`);
  const read = createGoalSourceReadPort({ projectId: PROJECT_ID, store }).read(GOAL_ID);
  if (!read.ok) throw new Error(`fixture source read refused: ${read.code}`);
  return { sha: read.contentSha256, store };
}

function commitRow(
  store: SqliteEventStore, suffix: string, aggregateId: string, result: object,
): void {
  const bytes = encoder.encode(JSON.stringify(result));
  const response = store.commitExpectedVersionDecision({
    commandKind: "source.fixture",
    committedResultBytes: bytes,
    correlationId: `corr-source-${suffix}`,
    decidedAt: "2026-08-31T12:00:00.000Z",
    events: [{
      domainSchemaVersion: "source-fixture/1",
      eventId: `source-fixture-event-${suffix}`,
      eventType: "SourceFixtureCommitted",
      payload: bytes,
    }],
    expectedVersion: 0,
    key: {
      commandId: `cmd-source-${suffix}`, principalId: "operator-local", projectId: PROJECT_ID,
    },
    requestBytes: bytes,
    targetAggregateId: aggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`fixture row refused: ${response.decision.resultCode}`);
  }
}

describe("createCompiledNodeSource", () => {
  it("lists every execution-bearing sealed node, titled by its objective", () => {
    const store = openStore();
    expect(sourceFor(store, [activeGraphFor(GOAL_ID)]).nodes()).toEqual([
      { dependsOn: [], nodeRef: ref("node-kernel"), title: "Implement the belief-key identity kernel." },
    ]);
  });

  it("carries each sealed node's hard dependencies through, exactly as submitted", () => {
    const store = openStore();
    const nodes = sourceFor(store, [chainGraphFor(GOAL_ID)]).nodes();
    // The whole chain seals, so the arm cannot pass by producing fewer nodes.
    expect(nodes.map((node) => node.nodeRef)).toEqual(["node-a", "node-b", "node-c"].map(ref));
    // EQUALITY per node against the submitted build order — not merely that the
    // member is present. An always-empty producer fails here, which is the one
    // failure mode that would leave the readiness gate green and useless.
    expect(nodes.map((node) => [...node.dependsOn]))
      .toEqual(CHAIN.map((node) => node.dependsOn.map(ref)));
    expect(nodes.map((node) => [...node.dependsOn])).toEqual([[], [ref("node-a")], [ref("node-b")]]);
  });

  it("lists nothing while no graph is active, and for an unknown nodeRef briefs nothing", () => {
    const store = openStore();
    const source = sourceFor(store, []);
    expect(source.nodes()).toEqual([]);
    expect(source.mission(ref("node-kernel"))).toBeNull();
    expect(sourceFor(store, [activeGraphFor(GOAL_ID)]).mission("node-that-never-was")).toBeNull();
  });

  it("briefs a sealed node from host facts plus the sealed objective", () => {
    const store = openStore();
    const mission = sourceFor(store, [activeGraphFor(GOAL_ID)]).mission(ref("node-kernel"));
    expect(mission).not.toBeNull();
    expect(mission?.workspace).toBe("D:/projects/unai");
    expect(mission?.test).toBe("pnpm test");
    expect(mission?.title).toBe("Implement the belief-key identity kernel.");
    expect(mission?.instructions).toContain("Implement the belief-key identity kernel.");
    // No approved revision resolvable in this store: the brief carries the
    // objective alone rather than inventing criterion statements.
    expect(mission?.instructions).not.toContain("Acceptance criteria");
  });

  it("refuses to brief without the host workspace or test command — fail closed", () => {
    const store = openStore();
    const graph = [activeGraphFor(GOAL_ID)];
    expect(sourceFor(store, graph, { workspace: null }).mission(ref("node-kernel"))).toBeNull();
    expect(sourceFor(store, graph, { testCommand: null }).mission(ref("node-kernel"))).toBeNull();
    // Listing is unaffected: the board may show the node; only staffing needs the brief.
    expect(sourceFor(store, graph, { workspace: null }).nodes()).toHaveLength(1);
  });

  it("joins the approved revision's criterion statements into the brief", () => {
    const { sha, store } = boundWorld();
    commitRow(store, "revision",
      deriveProductContractRevisionAggregateId(PROJECT_ID, CONTRACT_ID, REVISION_ID),
      { contractId: CONTRACT_ID,
        criteria: [
          { criterionId: "crit-1", statement: STATEMENT },
          { criterionId: "crit-other", statement: "A criterion no node here cites." },
        ],
        revisionId: REVISION_ID, sourceDocumentDigests: [sha] });
    commitRow(store, "gate", "product-contract-gate-1-sourcetest", {
      contractId: CONTRACT_ID, gateId: "gate-1", grant: {},
      revisionDigest: "e".repeat(64), revisionId: REVISION_ID, workRef: "work-source-1",
    });
    const mission = sourceFor(store, [activeGraphFor(GOAL_ID)]).mission(ref("node-kernel"));
    expect(mission?.instructions).toContain("Acceptance criteria");
    expect(mission?.instructions).toContain(`- [crit-1] ${STATEMENT}`);
    // Only the criteria THIS node cites: the uncited one stays out of the brief.
    expect(mission?.instructions).not.toContain("crit-other");
  });
});
