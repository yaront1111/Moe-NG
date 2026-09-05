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

import { dispatchCompiledPlanning as dispatch } from "./compiled-planning-dispatch.js";
import { COMPILED_CONTRACT_BINDING_VERSION, readCompiledContractBinding } from "./compiled-contract-binding.js";
import { resolveProductContractGate1 } from "../product-contract/product-contract-gate-1-resolver.js";
import { readProductContractRevision } from "../product-contract/product-contract-revision-reader.js";
import { validateRevisionProvenance } from "../product-contract/product-contract-provenance.js";
import { compiledPlanAuthority } from "./compiled-authority-bodies.js";
import { idsOf, resolveCompileRun, sealedSubmissionHash } from "./compile-run-resolution.js";
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
  "SUBMIT_DECOMPOSITION_RUN_UNREADABLE",
  "SUBMIT_DECOMPOSITION_SUBMISSION_CONFLICT",
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
  /** The refusing authority's own words when it has any; absent, the code is the whole story. */
  readonly detail?: string;
  readonly layer: string;
  readonly ok: false;
  /** True when the plan sealed up to the policy gate: install tiers, re-dispatch. */
  readonly parked?: true;
}
export type SubmitDecompositionResult =
  | SubmitDecompositionAccepted
  | SubmitDecompositionRefused;

function refused(
  code: string, layer: string = LAYER, detail?: string,
): SubmitDecompositionRefused {
  return Object.freeze(
    detail === undefined ? { code, layer, ok: false } : { code, detail, layer, ok: false },
  );
}

/** An upstream refusal's `detail`, forwarded verbatim when it carries one. */
function detailOf(value: object): string | undefined {
  const detail = (value as { readonly detail?: unknown }).detail;
  return typeof detail === "string" && detail.length > 0 ? detail : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

/**
 * The plan codec's text rule (non-empty, no NUL, well-formed, NFC), applied at THIS boundary so
 * an agent's malformed text answers as a coded shape refusal here instead of surfacing as the
 * compiled-plan producer's throw (which the listener reports as a bare 500).
 */
function canonicalText(value: unknown): value is string {
  return stringField(value) && !value.includes("\0") && value.isWellFormed()
    && value.normalize("NFC") === value;
}

function stringField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function runSubmitDecomposition(
  store: SqliteEventStore,
  input: SubmitDecompositionInput,
): SubmitDecompositionResult {
  const payload = record(input.payload);
  if (payload === null
    || Object.keys(payload).length !== SUBMIT_DECOMPOSITION_PAYLOAD_KEYS.length) {
    return refused(
      "SUBMIT_DECOMPOSITION_MALFORMED", LAYER,
      "payload must be exactly {gateRef, goalRef, structure}",
    );
  }
  const gateRef = record(payload["gateRef"]);
  const structure = record(payload["structure"]);
  const goalRef = payload["goalRef"];
  if (gateRef === null || structure === null || !stringField(goalRef)
    || !stringField(gateRef["contractId"]) || !stringField(gateRef["revisionId"])
    || !stringField(gateRef["revisionDigest"])) {
    return refused(
      "SUBMIT_DECOMPOSITION_MALFORMED", LAYER,
      "goalRef must be a string and gateRef exactly {contractId, revisionDigest, revisionId}",
    );
  }
  const ref = {
    contractId: gateRef["contractId"] as string,
    revisionDigest: gateRef["revisionDigest"] as string,
    revisionId: gateRef["revisionId"] as string,
  };

  // THE HUMAN GATE, resolved durably; then the exact approved revision.
  const gate = resolveProductContractGate1(store, { projectId: input.projectId, ref });
  if (!gate.ok) {
    return refused(gate.code, "layer" in gate ? String(gate.layer) : LAYER, detailOf(gate));
  }
  if (gate.revisionDigest !== ref.revisionDigest) {
    return refused("SUBMIT_DECOMPOSITION_GATE_DIGEST_MISMATCH");
  }
  const revisionRead = readProductContractRevision(store, { projectId: input.projectId, ref });
  if (!revisionRead.ok) {
    return refused(
      revisionRead.code, "layer" in revisionRead ? String(revisionRead.layer) : LAYER,
      detailOf(revisionRead),
    );
  }
  const revision = revisionRead.revision;

  const provenance = validateRevisionProvenance(
    store, input.projectId, goalRef, revision.sourceDocumentDigests,
  );
  if (!provenance.ok) return refused(provenance.code, provenance.layer, provenance.detail);
  // THE GOAL'S CURRENT RUN, not the one it was created with. `planningRunRef` is immutable on the
  // goal record, so after a REJECT it still names the run that was rejected; the run that can
  // accept a plan is its successor. A stale walk refuses rather than compiling onto a last-good id.
  const target = resolveCompileRun(store, provenance.planningRunRef);
  if (target === null) return refused("SUBMIT_DECOMPOSITION_RUN_UNREADABLE");
  const runId = target.runId;

  const completionNodeKey = structure["completionNodeKey"];
  const nodes = structure["structureNodes"] ?? structure["nodes"];
  if (!stringField(completionNodeKey) || !Array.isArray(nodes)) {
    return refused(
      "SUBMIT_DECOMPOSITION_MALFORMED", LAYER,
      "structure must be {completionNodeKey, nodes: [{nodeKey, objective, criterionIds, "
      + "dependsOn}]}",
    );
  }
  // NODE COUNT IS UNCONSTRAINED HERE: an INITIAL run seals the WHOLE graph. What a plan must
  // satisfy is DAG COHERENCE, enforced by `compiledPlanAuthority` below — an unknown or
  // self-referential `dependsOn` target and a dependency on the completion node refuse
  // COMPILED_PLAN_MALFORMED, a criterion bound by no node refuses
  // COMPILED_PLAN_CRITERION_UNBOUND, and COMPILED_PLAN_NODE_BUDGET caps the roster.
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
    if (node === null || !canonicalText(node["nodeKey"]) || !canonicalText(node["objective"])
      || !Array.isArray(criterionIds) || !criterionIds.every(canonicalText)
      || !Array.isArray(dependsOn) || !dependsOn.every(canonicalText)) {
      return refused(
        "SUBMIT_DECOMPOSITION_MALFORMED", LAYER,
        `node ${String(sealedNodes.length + 1)}: nodeKey and objective must be non-empty NFC `
        + "strings, criterionIds and dependsOn arrays of such strings",
      );
    }
    sealedNodes.push(Object.freeze({
      capability: COMPILED_NODE_RISK_PROFILE.capability,
      // A SET, never the agent's listing: order and repeats are not plan facts, and the
      // plan codec admits only an ascending, duplicate-free set.
      criterionIds: Object.freeze([...new Set(criterionIds)].sort()),
      // The build order is a set too: a producer named twice is ONE edge, and the graph
      // codec refused the repeat one layer down, where the reason named no node.
      dependsOn: Object.freeze([...new Set(dependsOn as readonly string[])].sort()),
      nodeKey: node["nodeKey"] as string,
      objective: node["objective"] as string,
      readScopes: [...COMPILED_NODE_RISK_PROFILE.readScopes],
      resources: [...COMPILED_NODE_RISK_PROFILE.resources],
      verificationRecipeRefs: [...COMPILED_NODE_RISK_PROFILE.verificationRecipeRefs],
      writeScopes: [...COMPILED_NODE_RISK_PROFILE.writeScopes],
    }));
  }
  // THE ROSTER IS A SET AS WELL. The graph codec admits node authorities only in strictly
  // ascending nodeKey order (code-unit order, its own comparison), and a planner naturally
  // lists the completion node LAST: every real seat submission on 2026-09-05 refused
  // GRAPH_CONTENT_FIELD_INVALID on that alone, across seven graph shapes. Sorting here makes
  // "listing order is not a plan fact" true for nodes, as it already was for criteria.
  sealedNodes.sort((left, right) => (
    left.nodeKey < right.nodeKey ? -1 : left.nodeKey > right.nodeKey ? 1 : 0
  ));
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
  if (!compiled.ok) return refused(compiled.code, compiled.layer, compiled.detail);

  const contractBinding = Object.freeze({ version: COMPILED_CONTRACT_BINDING_VERSION,
    projectId: input.projectId, goalRef, planningRunRef: runId, contractRef: ref,
    graphContentHash: compiled.graphContentHash, submissionHash: compiled.submissionHash });

  const ids = idsOf(ref.revisionDigest, runId);
  // MEASURED, not inferred: the whole propose fold commits ONE run event and
  // the finalize a second - the chain items' 0..4 are fold-internal.
  // The thresholds are OFFSETS from the run's own base head, not literals: an INITIAL run starts
  // at 0, a REVISION successor at 1 because the rejection already minted its `PlanningRunCreated`
  // (see `resolveCompileRun`). With baseVersion 0 every comparison below is byte-identical in
  // behaviour to the literals it replaced, which is why the INITIAL path is unchanged.
  const runVersion = store.getAggregateVersion(runId);
  if (runVersion >= target.baseVersion + 2) {
    const existing = readCompiledContractBinding(store, input.projectId, runId);
    if (!existing.ok) return refused(existing.code);
    if (existing.binding.contractRef.contractId !== ref.contractId
      || existing.binding.contractRef.revisionId !== ref.revisionId
      || existing.binding.contractRef.revisionDigest !== ref.revisionDigest
      || existing.binding.goalRef !== goalRef || existing.binding.graphContentHash !== compiled.graphContentHash) {
      return refused("SUBMIT_DECOMPOSITION_SUBMISSION_CONFLICT");
    }
    // FAIL CLOSED ON A CHANGED SUBMISSION. This branch dispatches no leg, so the store's own
    // command-bytes conflict never sees a resubmission that arrives here: without this check a
    // DIFFERENT structure under the same derived command ids answers `ok` carrying the hashes of
    // a plan that was never sealed on the run. Measured 2026-09-05 on a compiled REVISION run:
    // the caller got REPLAYED with submissionHash a28e4ab2... while the run held f6c57f28...
    // A genuine crash-restart re-dispatch submits the same bytes and still replays.
    if (sealedSubmissionHash(store, input.projectId, runId) !== compiled.submissionHash) {
      return refused("SUBMIT_DECOMPOSITION_SUBMISSION_CONFLICT");
    }
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

  if (runVersion === target.baseVersion) {
    const proposed = dispatch(store, input, ids["propose"] as string, runId, [
      {
        commandId: ids["create"], expectedVersion: 0, goalRef, kind: "planning.create_draft",
        runId, runKind: target.runKind,
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
        // MUST track the run's own kind: the core refuses a proposal whose kind differs from the
        // run's with ILLEGAL_TRANSITION (planning-run-submission.ts:118), which is exactly what
        // keeps an INITIAL authority path from being replayed onto a REVISION run and back.
        proposalKind: target.runKind,
        submissionHash: compiled.submissionHash,
        witness: witness({
          attemptRef: `${ids["stem"]}-attempt`, submissionRef: `${ids["stem"]}-submission`,
        }),
      },
    ], contractBinding);
    if (!proposed.ok) return refused(proposed.code, "DAEMON_PLANNING", detailOf(proposed));
  } else if (runVersion !== target.baseVersion + 1) {
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
