import type { SqliteEventStore } from "@moe/store";
import { sameVerifiedWorkspace } from "../repository/verified-workspace-contracts.js";
import type { VerifiedWorkspaceBinding, VerifiedWorkspacePort, VerifiedWorkspaceRefusal } from "../repository/verified-workspace-contracts.js";
import { readVerifierReceipt } from "../review/verifier-receipt-ledger.js";
import type { NodeMission } from "./agent-wrapper.js";

export interface LandingVerificationInput {
  readonly brief: NodeMission;
  readonly nodeRef: string;
  readonly projectId: string;
  readonly receiptId: string;
  readonly store: SqliteEventStore;
  readonly port: VerifiedWorkspacePort | undefined;
  readonly readBinding: ((nodeRef: string, receiptId: string) => VerifiedWorkspaceBinding | null) | undefined;
}

/** Legacy verifier receipts remain readable history and can never authorize new Git effects. */
export async function checkLandingVerification(input: LandingVerificationInput):
Promise<{ readonly ok: true; readonly binding: VerifiedWorkspaceBinding; readonly port: VerifiedWorkspacePort } | VerifiedWorkspaceRefusal> {
  let binding: VerifiedWorkspaceBinding | null;
  if (input.readBinding !== undefined) binding = input.readBinding(input.nodeRef, input.receiptId);
  else {
    const receipt = readVerifierReceipt(input.store, input.projectId, input.receiptId);
    binding = receipt.ok && receipt.receipt.subjectRef === input.nodeRef
      && receipt.receipt.execution.workspace === input.brief.workspace && receipt.receipt.execution.test === input.brief.test
      ? receipt.receipt.execution.workspaceBinding ?? null : null;
  }
  if (binding === null) return { code: "LANDING_VERIFIER_BINDING_MISSING", detail: "verifier receipt has no matching tested workspace binding", ok: false };
  if (input.port === undefined) return { code: "LANDING_VERIFIED_WORKSPACE_UNCONFIGURED", detail: "verified workspace port unavailable", ok: false };
  const current = await input.port.capture(input.brief.workspace);
  if (!current.ok) return current;
  if (!sameVerifiedWorkspace(binding, current.binding)) return {
    code: "LANDING_VERIFIED_WORKSPACE_CHANGED", detail: "current workspace differs from the verified candidate", ok: false,
  };
  return { binding, ok: true, port: input.port };
}
