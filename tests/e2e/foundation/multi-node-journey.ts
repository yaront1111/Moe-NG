/**
 * THE JOURNEY that seals a 3-node graph on ONE goal, driven over the REAL daemon's own HTTP
 * routes with the SHIPPED command kinds and the SHIPPED payload builders.
 *
 *   the world (`multi-node-world.ts`: the seed's own prelude, through `project.activate`)
 *     -> goal.create_with_source: ONE goal, bound to ONE PRD
 *     -> product_contract.propose_revision: the planning seat writes THREE criteria
 *     -> product_contract.approve_gate_1: the human approves the contract
 *     -> planning.submit_decomposition: the seat submits the 3-node DAG; the DAEMON compiles
 *        it, seals the graph and drives the whole planning chain itself
 *     -> approval.decide_intent: THE ONE PLAN-APPROVAL DECISION, and it seals all three nodes
 *
 * NOTHING HERE COMPOSES AUTHORITY. Every authority byte is derived by the daemon inside
 * `runSubmitDecomposition` -> `compiledPlanAuthority`; this module sends plans and reads frames.
 *
 * NO WALL CLOCK AND NO RANDOM SOURCE: every clock reading is a PARAMETER (`nowMs`, `nowIso`)
 * the test file supplies, exactly as the shipped seed takes its `clock`.
 */
import {
  AGENT_SECRET,
  AGENT_SESSION,
  CONTRACT_ID,
  GOAL_CREATE_COMMAND_ID,
  GOAL_ID,
  HUMAN_SECRET,
  HUMAN_SESSION,
  MULTI_NODE_STRUCTURE,
  PRD_TEXT,
  REVISION_ID,
  revisionDraft,
} from "./multi-node-graph-harness.js";
import type { MultiNodeScratch } from "./multi-node-graph-harness.js";
import {
  type DaemonWire,
  type Frame,
  answered,
  asObject,
  command,
  daemonWire,
  offerFor,
  readSurface,
  send,
} from "./multi-node-wire.js";
import {
  CORRELATION_ID,
  mintHumanPrincipal,
  openSession,
  worldPrelude,
} from "./multi-node-world.js";
import type { JourneyClock } from "./multi-node-world.js";

/** Re-exported so a caller composes the journey from ONE module rather than two. */
export type { JourneyClock } from "./multi-node-world.js";

/** The goal's own PRD sha, read off the daemon rather than digested a second time here. */
async function sourceDigest(wire: DaemonWire): Promise<string> {
  const frame = answered(
    "/goals/source/read", "GOAL_SOURCE", await wire.post("/goals/source/read", { goalRef: GOAL_ID }),
  );
  const sha = frame["contentSha256"];
  if (typeof sha !== "string") throw new Error(`the goal source states no sha: ${JSON.stringify(frame)}`);
  return sha;
}

/** The Gate 1 card's own read: the pending revision plus the daemon-minted approval template. */
async function gate1Template(wire: DaemonWire): Promise<{ approval: Frame; ref: Frame }> {
  const frame = answered(
    "/product-contract/pending/read", "PENDING",
    await wire.post("/product-contract/pending/read", { goalRef: GOAL_ID }),
  );
  const approval = asObject(frame["approval"]);
  const ref = asObject(frame["ref"]);
  if (approval === null || ref === null) {
    throw new Error(`the pending read withheld the template: ${JSON.stringify(frame)}`);
  }
  return { approval, ref };
}

export interface SealedGraph {
  readonly gateRef: Frame;
  /** The run the daemon derived for this goal; never a value this journey chose. */
  readonly runId: string;
}

/**
 * Drives the whole journey and returns once the plan-approval decision is durable. Every leg
 * throws with the daemon's own refusal frame, so a failure names the fence that answered.
 */
export async function sealMultiNodeGraph(
  scratch: MultiNodeScratch, origin: string, clock: JourneyClock,
): Promise<SealedGraph> {
  const wire = daemonWire(origin, scratch.credential);
  for (const planned of worldPrelude(scratch, clock)) await send(wire, planned);

  await send(wire, command(CORRELATION_ID, {
    commandId: GOAL_CREATE_COMMAND_ID,
    commandKind: "goal.create_with_source",
    payload: {
      instructions: "Build the three-node graph in one goal.",
      source: { displayPath: "prd.md", mediaType: "text/markdown", text: PRD_TEXT },
      title: "Three nodes, one goal",
    },
    targetAggregateId: GOAL_ID,
  }));

  await openSession(wire, AGENT_SESSION, AGENT_SECRET);
  await openSession(wire, HUMAN_SESSION, HUMAN_SECRET);
  mintHumanPrincipal(scratch, clock, HUMAN_SESSION);

  await send(wire, command(CORRELATION_ID, {
    commandId: "cmd-multi-node-propose-revision",
    commandKind: "product_contract.propose_revision",
    payload: { draft: revisionDraft(await sourceDigest(wire)), goalRef: GOAL_ID },
    targetAggregateId: GOAL_ID,
  }), AGENT_SECRET);

  const template = await gate1Template(wire);
  await send(wire, command(CORRELATION_ID, {
    commandId: String(template.approval["commandId"]),
    commandKind: "product_contract.approve_gate_1",
    payload: {
      authentication: {
        issuedAt: clock.nowMs,
        kind: "BEARER",
        requestDigest: template.approval["requestDigest"],
        requestId: template.approval["commandId"],
      },
      contractId: template.ref["contractId"],
      revisionDigest: template.ref["revisionDigest"],
      revisionId: template.ref["revisionId"],
    },
    targetAggregateId: String(asObject(template.approval["affordance"])?.["targetAggregateId"]),
  }), HUMAN_SECRET);

  const gateRef = Object.freeze({
    contractId: CONTRACT_ID,
    revisionDigest: template.ref["revisionDigest"],
    revisionId: REVISION_ID,
  });
  await send(wire, command(CORRELATION_ID, {
    commandId: "cmd-multi-node-submit-decomposition",
    commandKind: "planning.submit_decomposition",
    payload: { gateRef, goalRef: GOAL_ID, structure: MULTI_NODE_STRUCTURE },
    targetAggregateId: GOAL_ID,
  }), AGENT_SECRET);

  // THE ONE APPROVAL DECISION. It is offered against the run the daemon derived, and the
  // offer is read off the surface rather than assembled here, so the identity the human
  // approves is the daemon's own.
  const offer = offerFor(await readSurface(wire, scratch.projectId), "approval.decide_intent");
  const runId = String(offer["targetAggregateId"]);
  await send(wire, command(CORRELATION_ID, {
    commandId: String(offer["commandId"]),
    commandKind: "approval.decide_intent",
    expectedVersion: Number(offer["expectedVersion"]),
    payload: {
      decision: "APPROVE",
      decisionReason: null,
      dependencyChanges: { additions: [], challenges: [], removals: [] },
      runId,
    },
    targetAggregateId: runId,
  }), HUMAN_SECRET);

  return Object.freeze({ gateRef, runId });
}
