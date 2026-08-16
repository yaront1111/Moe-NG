import { createHash } from "node:crypto";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { VERIFIER_FAILURE_RULE } from "../http/affordance-read.js";
import { handleCommandRequest } from "../http/http-adapter.js";
import type { CommandAdapterDeps } from "../http/http-contract.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { readReviewLedger } from "../review/review-read-model.js";
import {
  readVerifierReceipt,
  recordVerifierReceipt,
} from "../review/verifier-receipt-ledger.js";
import type { VerifierAuthorityFacts } from "../review/verifier-receipt-ledger.js";
import { verifierReceiptId } from "../review/verifier-receipt-contracts.js";
import type { NodeMission } from "./agent-wrapper.js";

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

const PACKAGE_ITEM_FILL = (seed: string): string =>
  (seed.replace(/[^0-9a-f]/gu, "0") + "0".repeat(64)).slice(0, 64);

const encoder = new TextEncoder();

function failureRoundPayload(
  subjectRef: string, round: number, capture: VerifierRunCapture,
): JsonObject {
  const tail = capture.output.slice(-600);
  return {
    findings: [{
      detail: `verifier run exited ${String(capture.exitCode)} (output sha256 ${capture.sha256}): ${tail}`,
      ruleId: VERIFIER_FAILURE_RULE,
      severity: "MAJOR",
      subject: { kind: "NODE", locator: subjectRef },
    }],
    packageItems: [
      { digest: PACKAGE_ITEM_FILL("c1"), kind: "CRITERION", locator: "criterion-1" },
      { digest: capture.sha256, kind: "DAEMON_RECEIPT", locator: `verifier:${subjectRef}:round-${String(round)}` },
      { digest: PACKAGE_ITEM_FILL("6a"), kind: "GRAPH_HASH", locator: "graph-1" },
      { digest: PACKAGE_ITEM_FILL("f1"), kind: "INTEGRATED_TREE", locator: "tree-1" },
      { digest: PACKAGE_ITEM_FILL("b1"), kind: "PLAN_HASH", locator: "plan-1" },
      { digest: PACKAGE_ITEM_FILL("2b"), kind: "RUBRIC", locator: "rubric-1" },
      { digest: PACKAGE_ITEM_FILL("5b"), kind: "SUBMITTED_BYTES", locator: "submitted-1" },
    ],
    round,
    subjectRef,
  };
}

export function createNodeVerifier(config: NodeVerifierConfig) {
  const dispatch = (
    kind: string, payload: JsonObject, target: string, expectedVersion: number,
    commandId?: string,
  ): { code: string; ok: boolean } => {
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
    const result = handleCommandRequest(config.deps, {
      body: encoder.encode(JSON.stringify(envelope)),
      credential: config.operatorCredential,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    }) as { ok: boolean; outcome: string;
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
      const receiptId = verifierReceiptId(config.projectId, nodeRef, latest.decisionId);
      const pending = readVerifierReceipt(config.store, config.projectId, receiptId);
      if (pending.ok) {
        if (pending.decision.currentVersion !== review.version) {
          reports.push({ detail: "stale verifier receipt", nodeRef, outcome: "VERIFIER_RECEIPT_STALE" });
          continue;
        }
        const sent = dispatch(
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
      const capture = await config.runTest(brief);
      if (capture.exitCode === 0) {
        const recorded = recordVerifierReceipt(config.store, {
          authority,
          decidedAt: new Date().toISOString(),
          execution: {
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
        const sent = dispatch(
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
        const sent = dispatch(
          "review.submit", failureRoundPayload(nodeRef, round, capture),
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
