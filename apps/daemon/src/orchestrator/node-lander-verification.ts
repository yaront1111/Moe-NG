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

export type LandingVerificationClass = "STRUCTURAL" | "TRANSIENT";
/** What a code outside the table answers: neither class, so neither recorded nor retried. */
export const LANDING_VERIFICATION_UNCLASSIFIED = "LANDING_VERIFICATION_UNCLASSIFIED";

/**
 * EVERY refusal `checkLandingVerification` can return, classified. STRUCTURAL describes the receipt,
 * the composition or the repository's configuration and is recorded durably. TRANSIENT describes a
 * moment and is reported, not recorded, so the next pass retries — the rule the lander's observe path
 * already follows. CLOSED, no default: a default of TRANSIENT livelocks a new structural code, one of
 * STRUCTURAL burns an accepted delivery on a new transient one. node-lander-verification.test.ts reads
 * the reachable codes out of the capture sources and asserts this table names exactly that set.
 */
export const LANDING_VERIFICATION_REFUSALS: Readonly<Record<string, LandingVerificationClass>> = Object.freeze({
  LANDING_VERIFIER_BINDING_MISSING: "STRUCTURAL",
  LANDING_VERIFIED_WORKSPACE_UNCONFIGURED: "STRUCTURAL",
  // The parent row's delivery: bytes restored after verification are never the verified candidate.
  LANDING_VERIFIED_WORKSPACE_CHANGED: "STRUCTURAL",
  // Capture succeeded when the verifier ran, so each of these is configuration changed since.
  VERIFIED_WORKSPACE_SUBMODULE_UNSUPPORTED: "STRUCTURAL",
  VERIFIED_WORKSPACE_FILTER_UNSUPPORTED: "STRUCTURAL",
  VERIFIED_WORKSPACE_REF_BACKEND_UNSUPPORTED: "STRUCTURAL",
  // HEAD or the branch moved between the capture's first and final read.
  VERIFIED_WORKSPACE_DRIFT: "TRANSIENT",
  // The shared git invoker: a non-zero exit, a 30s timeout, a lock, a HEAD detached mid-rebase.
  VERIFIED_WORKSPACE_GIT_FAILED: "TRANSIENT",
  // The identity git calls failing moments after observe found a repository. A workspace that is
  // really gone is recorded by the observe path's NOT_A_REPOSITORY on the next pass instead.
  VERIFIED_WORKSPACE_IDENTITY_UNKNOWN: "TRANSIENT",
  // Any other throw: in practice a path that vanished or was locked between `git status` and the
  // read of its bytes. Recording it would destroy an accepted delivery over a cause nobody knows.
  VERIFIED_WORKSPACE_UNKNOWN: "TRANSIENT",
});

/** The table's class for a code, or null for a code the table does not name. */
export function landingVerificationClass(code: string): LandingVerificationClass | null {
  return Object.hasOwn(LANDING_VERIFICATION_REFUSALS, code) ? LANDING_VERIFICATION_REFUSALS[code] ?? null : null;
}

/** The report for a refusal the lander must NOT record, or null when it must be recorded. */
export function unrecordedLandingReport(refusal: VerifiedWorkspaceRefusal, nodeRef: string):
{ readonly detail: string; readonly nodeRef: string; readonly outcome: string } | null {
  const kind = landingVerificationClass(refusal.code);
  if (kind === "STRUCTURAL") return null;
  return kind === "TRANSIENT" ? { detail: refusal.detail, nodeRef, outcome: refusal.code }
    : { detail: `${refusal.code}: ${refusal.detail}`, nodeRef, outcome: LANDING_VERIFICATION_UNCLASSIFIED };
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
