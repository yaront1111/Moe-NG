import { createHash } from "node:crypto";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { handleAsyncCommandRequest } from "../http/http-adapter.js";
import type { CommandAdapterDeps } from "../http/http-contract.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { readSubmittedReviewWorkspace } from "../review/review-submission-read.js";
import {
  readVerifierReceipt,
  recordVerifierReceipt,
} from "../review/verifier-receipt-ledger.js";
import type { VerifierAuthorityFacts } from "../review/verifier-receipt-ledger.js";
import { verifierReceiptId } from "../review/verifier-receipt-contracts.js";
import type { NodeMission } from "./agent-wrapper.js";
import type { VerifiedWorkspacePort } from "../repository/verified-workspace-contracts.js";
import { sameVerifiedWorkspace } from "../repository/verified-workspace-contracts.js";
import { checkVerifiedWorkspace, runBoundVerification } from "./node-verifier-workspace.js";
import { verifierFailurePayload } from "./node-verifier-failure.js";

/**
 * The daemon-side verifier: acceptance is EARNED from a test run the daemon
 * performed itself, never taken from an agent's word.
 *
 * For every node whose latest round is a clean agent submit (awaiting
 * verification), the verifier runs the spec's test in the spec's workspace,
 * captures the output, and commits ONE durable consequence through the normal
 * adapter under the operator credential:
 * - exit 0 → integration.accept_output whose DAEMON_RECEIPT package item
 *   carries the REAL sha-256 of the captured output — the acceptance is bound
 *   to the run, not to a fixture digest;
 * - anything else → a review.submit round with a `verifier-test-failed`
 *   finding carrying the exit code and output tail, which puts the node back
 *   in READY for a coding agent to fix.
 *
 * DISCLOSED SCOPE: the test runs as a bounded child process in the daemon's
 * trust domain. The sealed hermetic verifier wrapper (recipe seals, workspace
 * manifests, activation grants — the receipt-dispatch board tasks) supersedes
 * this runner; the derivation and binding here are built to survive that swap.
 */

export interface VerifierRunCapture {
  /** Total raw stdout/stderr bytes observed, including bytes outside `output`. */
  readonly byteCount: number;
  readonly exitCode: number | null;
  /** Bounded output tail for operator-facing failure detail. */
  readonly output: string;
  /** SHA-256 over every raw stdout/stderr byte in observed event order. */
  readonly sha256: string;
}

export interface NodeVerifierConfig {
  /** Daemon-owned immutable artifact capture; absence refuses before test or acceptance. */
  readonly verifiedWorkspace?: Pick<VerifiedWorkspacePort, "capture">;
  readonly deps: CommandAdapterDeps;
  readonly mintId: () => string;
  readonly nodeMission: (nodeRef: string) => NodeMission | null;
  readonly nodes: () => readonly { nodeRef: string }[];
  readonly operatorCredential: string;
  readonly projectId: string;
  /** Runs the spec's test in its workspace; injectable for tests. */
  readonly runTest: (brief: NodeMission) => Promise<VerifierRunCapture>;
  readonly store: SqliteEventStore;
  /** Host-owned authority facts. Missing authority refuses before any test or write. */
  readonly verificationAuthority: (
    nodeRef: string,
    brief: NodeMission,
  ) => VerifierAuthorityFacts | null;
}

export interface VerifyReport {
  readonly detail: string;
  readonly nodeRef: string;
  readonly outcome: "ACCEPTED" | "FAILED_ROUND_RECORDED" | string;
}

const encoder = new TextEncoder();

export function createNodeVerifier(config: NodeVerifierConfig) {
  const dispatch = async (
    kind: string, payload: JsonObject, target: string, expectedVersion: number,
    commandId?: string,
  ): Promise<{ code: string; ok: boolean }> => {
    const envelope = {
      commandId: commandId ?? `verify-${config.mintId()}`,
      commandKind: kind,
      correlationId: "node-verifier",
      expectedVersion,
      payload,
      requestDigest: createHash("sha256")
        .update(encoder.encode(JSON.stringify(payload))).digest("hex"),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: config.operatorCredential,
      targetAggregateId: target,
    };
    const result = await handleAsyncCommandRequest(config.deps, {
      body: encoder.encode(JSON.stringify(envelope)),
      credential: config.operatorCredential,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    }, "NODE_VERIFIER") as { ok: boolean; outcome: string;
      decision?: { resultCode: string }; refusal?: { code: string }; error?: { code: string }; };
    return result.ok
      ? { code: result.decision?.resultCode ?? "ACCEPTED", ok: true }
      : { code: result.refusal?.code ?? result.error?.code ?? result.outcome, ok: false };
  };

  const verifyOnce = async (): Promise<readonly VerifyReport[]> => {
    const reports: VerifyReport[] = [];
    for (const { nodeRef } of config.nodes()) {
      const review = readReviewLedger(config.store, config.projectId, nodeRef);
      if (review.accepted !== undefined || review.unreadable || review.version === 0) continue;
      const latest = review.rounds[review.rounds.length - 1];
      if (latest === undefined || latest.routing.route !== "ACCEPT") continue;
      const brief = config.nodeMission(nodeRef);
      if (brief === null) {
        reports.push({ detail: "no spec brief", nodeRef, outcome: "NODE_BRIEF_MISSING" });
        continue;
      }
      const submitted = readSubmittedReviewWorkspace(config.store, config.projectId, nodeRef, latest);
      if (submitted.status === "INVALID") {
        reports.push({ detail: "submitted review evidence is unreadable", nodeRef, outcome: "REVIEW_SUBMISSION_EVIDENCE_INVALID" });
        continue;
      }
      const receiptId = verifierReceiptId(config.projectId, nodeRef, latest.decisionId);
      const pending = readVerifierReceipt(config.store, config.projectId, receiptId);
      if (pending.ok) {
        if (submitted.status === "PRESENT" && (pending.receipt.execution.workspaceBinding === undefined
          || !sameVerifiedWorkspace(submitted.binding, pending.receipt.execution.workspaceBinding))) {
          reports.push({ detail: "verifier receipt does not bind the submitted workspace", nodeRef, outcome: "VERIFIER_WORKSPACE_CHANGED" });
          continue;
        }
        if (pending.decision.currentVersion !== review.version) {
          reports.push({ detail: "stale verifier receipt", nodeRef, outcome: "VERIFIER_RECEIPT_STALE" });
          continue;
        }
        const unchanged = pending.receipt.execution.test !== brief.test || pending.receipt.execution.workspace !== brief.workspace
          ? { code: "VERIFIER_WORKSPACE_CHANGED", detail: "verification command or workspace changed" }
          : await checkVerifiedWorkspace(brief, pending.receipt.execution.workspaceBinding, config.verifiedWorkspace);
        if (unchanged !== null) {
          reports.push({ detail: unchanged.detail, nodeRef, outcome: unchanged.code });
          continue;
        }
        const sent = await dispatch(
          "integration.accept_output",
          { receiptId, subjectRef: nodeRef },
          nodeRef,
          review.version,
          `verify-accept-${receiptId}`,
        );
        reports.push({ detail: sent.code, nodeRef, outcome: sent.ok ? "ACCEPTED" : sent.code });
        continue;
      }
      if (pending.code === "VERIFIER_RECEIPT_INVALID") {
        reports.push({ detail: pending.code, nodeRef, outcome: pending.code });
        continue;
      }
      const authority = config.verificationAuthority(nodeRef, brief);
      if (authority === null) {
        reports.push({
          detail: "host verifier authority unavailable",
          nodeRef,
          outcome: "VERIFICATION_AUTHORITY_UNAVAILABLE",
        });
        continue;
      }
      const verified = await runBoundVerification(brief, config.runTest, config.verifiedWorkspace,
        submitted.status === "PRESENT" ? submitted.binding : undefined);
      if (!verified.ok) {
        reports.push({ detail: verified.detail, nodeRef, outcome: verified.code });
        continue;
      }
      const { capture } = verified;
      if (capture.exitCode === 0) {
        const recorded = recordVerifierReceipt(config.store, {
          authority,
          decidedAt: new Date().toISOString(),
          execution: {
            workspaceBinding: verified.binding,
            byteCount: capture.byteCount,
            outputSha256: capture.sha256,
            test: brief.test,
            workspace: brief.workspace,
          },
          projectId: config.projectId,
          source: {
            aggregateVersion: latest.aggregateVersion,
            decisionId: latest.decisionId,
            resultSha256: latest.resultSha256,
          },
          subjectRef: nodeRef,
        });
        if (!recorded.ok) {
          reports.push({ detail: recorded.code, nodeRef, outcome: recorded.code });
          continue;
        }
        const sent = await dispatch(
          "integration.accept_output",
          { receiptId: recorded.receipt.receiptId, subjectRef: nodeRef },
          nodeRef,
          recorded.decision.currentVersion,
          `verify-accept-${recorded.receipt.receiptId}`,
        );
        reports.push({
          detail: sent.code, nodeRef,
          outcome: sent.ok ? "ACCEPTED" : sent.code,
        });
      } else {
        const round = review.lineage.highestRound + 1;
        const sent = await dispatch(
          "review.submit", verifierFailurePayload(nodeRef, round, capture, authority.packageItems),
          nodeRef, review.version,
        );
        reports.push({
          detail: sent.ok ? `exit ${String(capture.exitCode)}` : sent.code, nodeRef,
          outcome: sent.ok ? "FAILED_ROUND_RECORDED" : sent.code,
        });
      }
    }
    return reports;
  };

  return Object.freeze({ verifyOnce });
}
