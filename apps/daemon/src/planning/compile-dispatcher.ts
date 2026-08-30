/**
 * `planning.submit_decomposition` — the MIDDLE of the PRD product: an agent
 * submits plan STRUCTURE; the daemon verifies the human's Gate 1 approval,
 * compiles the approved Product Contract revision into sealed authority bodies
 * (`compiledPlanAuthority`), and DRIVES the planning chain itself.
 *
 * Authority discipline, stated where it is enforced:
 * - The gate is resolved through `resolveProductContractGate1` — the durable
 *   approval, never a caller-presented grant — and the compile reads EXACTLY the
 *   revision the approval names (snapshot-freeze: the digest is compared, so a
 *   later revision cannot retarget an old approval).
 * - Provenance: the approved revision must cite the goal's own PRD sha
 *   (`validateRevisionProvenance`), so an approval for one product cannot plan
 *   another goal.
 * - The agent's structure never carries authority bytes; the chain's witnesses
 *   are DAEMON-COMPOSED here (refs derived from the revision digest), retiring
 *   the caller-stamped witness idiom for this path.
 * - Command ids are DERIVED from the revision digest, and the run's aggregate
 *   version gates each leg, so a crash-restart re-dispatch resumes instead of
 *   duplicating (the store dedupes replayed decisions by command id).
 * - A finalize refused at the run-policy leg (`RUN_POLICY_UNCLASSIFIABLE`)
 *   PARKS with the refusal forwarded — the operator installs the tiers; the
 *   compiler never installs policy over its own plan.
 */
import type { SqliteEventStore } from "@moe/store";

import { BOOTSTRAP_HANDLERS, runBootstrapCommand } from "../bootstrap/bootstrap-services.js";
import { BOOTSTRAP_SCHEMA_VERSION } from "../bootstrap/bootstrap-contracts.js";
import type { HandlerTable } from "../bootstrap/bootstrap-ledger.js";
import { GOAL_HANDLERS } from "../goals/goal-services.js";
import { PLANNING_HANDLERS } from "./planning-services.js";
import { resolveProductContractGate1 } from "../product-contract/product-contract-gate-1-resolver.js";
import { readProductContractRevision } from "../product-contract/product-contract-revision-reader.js";
import { validateRevisionProvenance } from "../product-contract/product-contract-provenance.js";
import { compiledPlanAuthority } from "./compiled-authority-bodies.js";
import { COMPILED_NODE_RISK_PROFILE } from "./compiled-authority-contracts.js";
import type { CompiledNodeInput } from "./compiled-authority-contracts.js";

const LAYER = "COMPILE_DISPATCHER";
const hex = (digit: string, width = 64): string => digit.repeat(width);

export const SUBMIT_DECOMPOSITION_PAYLOAD_KEYS = Object.freeze([
  "gateRef", "goalRef", "structure",
] as const);

export const SUBMIT_DECOMPOSITION_CODES = Object.freeze([
  "SUBMIT_DECOMPOSITION_MALFORMED",
  "SUBMIT_DECOMPOSITION_GATE_DIGEST_MISMATCH",
  "SUBMIT_DECOMPOSITION_ALREADY_FINALIZED",
  "SUBMIT_DECOMPOSITION_MULTI_NODE_INITIAL",
] as const);

export interface SubmitDecompositionInput {
  readonly correlationId: string;
  readonly decidedAt: string;
  /** Falsifiability floor roster; null disables (composition without a catalog). */
  readonly knownCapabilities?: readonly string[] | null;
  readonly payload: unknown;
  readonly principalId: string;
  readonly projectId: string;
}

export interface SubmitDecompositionAccepted {
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly graphContentHash: string;
  readonly ok: true;
  readonly runId: string;
  readonly submissionHash: string;
}
export interface SubmitDecompositionRefused {
  readonly code: string;
  readonly layer: string;
  readonly ok: false;
  /** True when the plan sealed up to the policy gate: install tiers, re-dispatch. */
  readonly parked?: true;
}
export type SubmitDecompositionResult =
  | SubmitDecompositionAccepted
  | SubmitDecompositionRefused;

const COMPILE_HANDLERS: HandlerTable = Object.freeze({
  ...BOOTSTRAP_HANDLERS,
  ...GOAL_HANDLERS,
  ...PLANNING_HANDLERS,
});

function refused(code: string, layer: string = LAYER): SubmitDecompositionRefused {
  return Object.freeze({ code, layer, ok: false });
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function stringField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** One derived identity family per approved revision: restartable by construction. */
function idsOf(revisionDigest: string): Record<string, string> {
  const stem = `compile-${revisionDigest.slice(0, 12)}`;
  return {
    claim: `${stem}-claim`, create: `${stem}-create`, finalize: `${stem}-finalize`,
    propose: `${stem}-propose`, ready: `${stem}-ready`, stem,
  };
}

function dispatch(
  store: SqliteEventStore,
  input: SubmitDecompositionInput,
  commandId: string,
  runId: string,
  commands: readonly Record<string, unknown>[],
): ReturnType<typeof runBootstrapCommand> {
  return runBootstrapCommand(store, new TextEncoder().encode(JSON.stringify({
    commandId,
    correlationId: input.correlationId,
    decidedAt: input.decidedAt,
    expectedVersion: 0,
    kind: "plan.propose",
    payload: { commands, runId },
    principalId: input.principalId,
    projectId: input.projectId,
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
  })), COMPILE_HANDLERS);
}

export function runSubmitDecomposition(
  store: SqliteEventStore,
  input: SubmitDecompositionInput,
): SubmitDecompositionResult {
  const payload = record(input.payload);
  if (payload === null
    || Object.keys(payload).length !== SUBMIT_DECOMPOSITION_PAYLOAD_KEYS.length) {
    return refused("SUBMIT_DECOMPOSITION_MALFORMED");
  }
  const gateRef = record(payload["gateRef"]);
  const structure = record(payload["structure"]);
  const goalRef = payload["goalRef"];
  if (gateRef === null || structure === null || !stringField(goalRef)
    || !stringField(gateRef["contractId"]) || !stringField(gateRef["revisionId"])
    || !stringField(gateRef["revisionDigest"])) {
    return refused("SUBMIT_DECOMPOSITION_MALFORMED");
  }
  const ref = {
    contractId: gateRef["contractId"] as string,
    revisionDigest: gateRef["revisionDigest"] as string,
    revisionId: gateRef["revisionId"] as string,
  };

  // THE HUMAN GATE, resolved durably; then the exact approved revision.
  const gate = resolveProductContractGate1(store, { projectId: input.projectId, ref });
  if (!gate.ok) return refused(gate.code, "layer" in gate ? String(gate.layer) : LAYER);
  if (gate.revisionDigest !== ref.revisionDigest) {
    return refused("SUBMIT_DECOMPOSITION_GATE_DIGEST_MISMATCH");
  }
  const revisionRead = readProductContractRevision(store, { projectId: input.projectId, ref });
  if (!revisionRead.ok) {
    return refused(revisionRead.code, "layer" in revisionRead ? String(revisionRead.layer) : LAYER);
  }
  const revision = revisionRead.revision;

  const provenance = validateRevisionProvenance(
    store, input.projectId, goalRef, revision.sourceDocumentDigests,
  );
  if (!provenance.ok) return refused(provenance.code, provenance.layer);
  const runId = provenance.planningRunRef;

  const completionNodeKey = structure["completionNodeKey"];
  const nodes = structure["structureNodes"] ?? structure["nodes"];
  if (!stringField(completionNodeKey) || !Array.isArray(nodes)) {
    return refused("SUBMIT_DECOMPOSITION_MALFORMED");
  }
  // CORE DESIGN, discovered at the finalize reducer (planning-run-submission.ts):
  // an INITIAL run seals exactly ONE execution-bearing node — "plan the smallest
  // complete slice" is a fence, not advice. Growth is the EXPANSION machinery's
  // (graph.request_expansion), whose runs are inherently multi-node. Refusing
  // here, with the path named, beats sealing a plan finalize must reject.
  if (nodes.length > 1) {
    return refused("SUBMIT_DECOMPOSITION_MULTI_NODE_INITIAL");
  }
  // THE RISK FACTS ARE THE DAEMON'S, never the agent's. The agent's structure
  // carries the PLAN — nodeKey, objective, criterion bindings, build order —
  // and the dispatcher states capability/scopes/resources/recipes from the
  // closed COMPILED_NODE_RISK_PROFILE the host's policy slice classifies. An
  // agent-invented scope string is not honored risk metadata; it is an
  // unclassifiable fact id that parks every real submission at finalize.
  const sealedNodes: CompiledNodeInput[] = [];
  for (const raw of nodes) {
    const node = record(raw);
    const criterionIds = node?.["criterionIds"];
    const dependsOn = node?.["dependsOn"] ?? [];
    if (node === null || !stringField(node["nodeKey"]) || !stringField(node["objective"])
      || !Array.isArray(criterionIds) || !Array.isArray(dependsOn)) {
      return refused("SUBMIT_DECOMPOSITION_MALFORMED");
    }
    sealedNodes.push(Object.freeze({
      capability: COMPILED_NODE_RISK_PROFILE.capability,
      criterionIds: criterionIds as readonly string[],
      dependsOn: dependsOn as readonly string[],
      nodeKey: node["nodeKey"] as string,
      objective: node["objective"] as string,
      readScopes: [...COMPILED_NODE_RISK_PROFILE.readScopes],
      resources: [...COMPILED_NODE_RISK_PROFILE.resources],
      verificationRecipeRefs: [...COMPILED_NODE_RISK_PROFILE.verificationRecipeRefs],
      writeScopes: [...COMPILED_NODE_RISK_PROFILE.writeScopes],
    }));
  }
  const compiled = compiledPlanAuthority({
    authorRef: input.principalId,
    completionNodeKey,
    criteria: revision.criteria.map((criterion) => ({
      criterionId: criterion.criterionId, statement: criterion.statement,
    })),
    graphRevisionRef: `graph-rev-${ref.revisionDigest.slice(0, 16)}`,
    idPrefix: `${runId}-c${ref.revisionDigest.slice(0, 8)}`,
    knownCapabilities: input.knownCapabilities ?? null,
    nodes: sealedNodes,
  });
  if (!compiled.ok) return refused(compiled.code, compiled.layer);

  const ids = idsOf(ref.revisionDigest);
  // MEASURED, not inferred: the whole propose fold commits ONE run event (v1)
  // and the finalize a second (v2) - the chain items' 0..4 are fold-internal.
  const runVersion = store.getAggregateVersion(runId);
  if (runVersion >= 2) {
    return Object.freeze({
      disposition: "REPLAYED" as const,
      graphContentHash: compiled.graphContentHash,
      ok: true as const,
      runId,
      submissionHash: compiled.submissionHash,
    });
  }

  const witness = (fields: Record<string, string>): Record<string, unknown> =>
    Object.freeze({ ...fields, truthClass: "DAEMON_VERIFIED" });

  if (runVersion === 0) {
    const proposed = dispatch(store, input, ids["propose"] as string, runId, [
      {
        commandId: ids["create"], expectedVersion: 0, goalRef, kind: "planning.create_draft",
        runId, runKind: "INITIAL",
      },
      {
        commandId: ids["ready"], expectedVersion: 1, kind: "planning.ready",
        witness: witness({
          acceptanceCriteriaRef: `${ids["stem"]}-criteria`,
          intentBaseRef: `${ids["stem"]}-intent`,
          planningBudgetRef: `${ids["stem"]}-budget`,
        }),
      },
      {
        commandId: ids["claim"], expectedVersion: 2, kind: "planning.claim",
        witness: witness({
          attemptRef: `${ids["stem"]}-attempt`, contextRef: `${ids["stem"]}-context`,
          leaseRef: `${ids["stem"]}-lease`, providerSlotRef: `${ids["stem"]}-slot`,
        }),
      },
      {
        authority: compiled.authority,
        commandId: `${ids["stem"]}-terminal`,
        effectTerminalProof: witness({
          effectTerminalRef: `${ids["stem"]}-effect`,
          resourcesTerminalRef: `${ids["stem"]}-resources`,
        }),
        expectedVersion: 3,
        graphContentBytesBase64: compiled.graphContentBytesBase64,
        kind: "plan.propose",
        proposalKind: "INITIAL",
        submissionHash: compiled.submissionHash,
        witness: witness({
          attemptRef: `${ids["stem"]}-attempt`, submissionRef: `${ids["stem"]}-submission`,
        }),
      },
    ]);
    if (!proposed.ok) return refused(proposed.code, "DAEMON_PLANNING");
  } else if (runVersion !== 1) {
    // A run someone else advanced to an unexpected shape is not this seam's to force.
    return refused("SUBMIT_DECOMPOSITION_ALREADY_FINALIZED");
  }

  const finalized = dispatch(store, input, ids["finalize"] as string, runId, [{
    commandId: `${ids["stem"]}-finalize-cmd`,
    expectedVersion: 4,
    kind: "planning.finalize_submission",
    revision: {
      dependencyHash: hex("d"),
      graphContentHash: compiled.graphContentHash,
      graphRevisionRef: `graph-rev-${ref.revisionDigest.slice(0, 16)}`,
      planHash: compiled.submissionHash,
      qualityHash: hex("e"),
    },
    witness: {
      attemptTerminalRef: `${ids["stem"]}-attempt-terminal`,
      effectTerminalRef: `${ids["stem"]}-effect`,
      nodeSummaries: sealedNodes.map((node) => ({
        executionBearing: true, nodeKey: node.nodeKey,
      })),
      providerSlotTerminalRef: `${ids["stem"]}-slot-terminal`,
      resourcesTerminalRef: `${ids["stem"]}-resources`,
      truthClass: "DAEMON_VERIFIED",
    },
  }]);
  if (!finalized.ok) {
    // The policy park: sealed to the gate, waiting on operator-installed tiers.
    if (finalized.code === "RUN_POLICY_UNCLASSIFIABLE") {
      return Object.freeze({
        code: finalized.code, layer: "RUN_POLICY", ok: false as const, parked: true as const,
      });
    }
    return refused(finalized.code, "DAEMON_PLANNING");
  }
  return Object.freeze({
    disposition: "DECIDED" as const,
    graphContentHash: compiled.graphContentHash,
    ok: true as const,
    runId,
    submissionHash: compiled.submissionHash,
  });
}
