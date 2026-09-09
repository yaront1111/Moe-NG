/** Real human commands followed by the production contained criterion service. */
import { realpathSync } from "node:fs";
import { SqliteEventStore } from "@moe/store";
import { readDurableLedger, stateOf } from "../../../apps/daemon/src/bootstrap/bootstrap-ledger.js";
import type { CriterionEvidenceView } from "../../../apps/daemon/src/criterion-evidence/criterion-contracts.js";
import { createCriterionEvidenceService } from "../../../apps/daemon/src/criterion-evidence/criterion-service.js";
import type { MultiNodeScratch } from "./multi-node-graph-harness.js";
import { DEFAULT_MULTI_NODE_IDENTITY } from "./multi-node-identity.js";
import type { MultiNodeIdentity } from "./multi-node-identity.js";
import { withStore } from "./multi-node-reads.js";
import { type DaemonWire, type Frame, answered, asObject, command, offerFor, readSurface, send } from "./multi-node-wire.js";

async function read(wire: DaemonWire, goalRef: string): Promise<CriterionEvidenceView> {
  return answered("/criteria/read", "CRITERION_EVIDENCE", await wire.post("/criteria/read", { goalRef })) as unknown as CriterionEvidenceView;
}
const fromOffer = (offer: { commandKind: string; targetAggregateId: string; expectedVersion: number },
  commandId: string, payload: Frame) => command("multi-node-criterion", { ...offer, commandId, payload });

export async function approveAndRunCriteria(scratch: MultiNodeScratch, wire: DaemonWire,
  clock: () => string, identity: MultiNodeIdentity = DEFAULT_MULTI_NODE_IDENTITY): Promise<CriterionEvidenceView> {
  const { goalId, humanSecret } = identity;
  for (const criterion of identity.criteria) {
    const frame = await read(wire, goalId); const row = frame.criteria.find((item) => item.criterionId === criterion.criterionId);
    if (row?.approveOffer == null) throw new Error(`no criterion approval offer: ${JSON.stringify(frame)}`);
    await send(wire, fromOffer(row.approveOffer, `multi-approve-${criterion.criterionId}`, {
      goalRef: frame.goalRef, planningRunRef: frame.planningRunRef, contractRef: frame.contractRef,
      criterionId: criterion.criterionId, check: { checkId: `test-${criterion.criterionId}`, checkVersion: "1",
        program: process.execPath, args: [`${criterion.nodeKey}/test.mjs`], timeoutMs: 30_000 },
    }), humanSecret);
  }
  const ready = await read(wire, goalId);
  if (ready.verifyOffer === null || ready.integratedArtifact === null) throw new Error(`no verification offer: ${JSON.stringify(ready)}`);
  await send(wire, fromOffer(ready.verifyOffer, "multi-verify-all", {
    goalRef: ready.goalRef, planningRunRef: ready.planningRunRef, contractRef: ready.contractRef,
    integratedSha: ready.integratedArtifact.sha, approvals: ready.criteria.map((row) => {
      if (row.approval === null) throw new Error(`no approval for ${row.criterionId}`);
      return { criterionId: row.criterionId, approvalId: row.approval.approvalId };
    }),
  }), humanSecret);
  // Only this lifecycle is hosted here, allowing a separately built guarded artifact while
  // real HTTP approval/queueing and the service's repository/containment guards stay intact.
  const store = SqliteEventStore.openForProject(scratch.storePath, scratch.projectId);
  const service = createCriterionEvidenceService({ store, projectId: scratch.projectId,
    storeId: realpathSync.native(scratch.storePath), workspace: scratch.workspace, clock });
  try { await service.advance(); } finally { await service.close(); store.close(); }
  return read(wire, goalId);
}

export async function closeCompletedGoal(scratch: MultiNodeScratch, wire: DaemonWire,
  identity: MultiNodeIdentity = DEFAULT_MULTI_NODE_IDENTITY): Promise<void> {
  const goalRef = identity.goalId;
  const offer = offerFor(await readSurface(wire, scratch.projectId), "goal.close", goalRef);
  await send(wire, command("multi-node-closure", { commandId: "multi-close", commandKind: "goal.close",
    expectedVersion: Number(offer["expectedVersion"]), targetAggregateId: goalRef,
    payload: { goalId: goalRef, closureWitness: { declaredBy: "OPERATOR", truthClass: "HUMAN_APPROVED" },
      zeroAuthorityWitness: { declaredBy: "OPERATOR" } },
  }));
  const state = withStore(scratch, (store) => stateOf(readDurableLedger(store, scratch.projectId), goalRef));
  if (asObject(state)?.["lifecycle"] !== "COMPLETED") throw new Error(`goal did not complete: ${JSON.stringify(state)}`);
}
