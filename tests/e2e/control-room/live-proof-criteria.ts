/**
 * EVERY APPROVED CRITERION VERIFIED, n OF n, ON THE PRODUCT'S OWN LANDED CODE.
 *
 * WHAT THIS ANSWERS. task-161b7e9d's DoD 3 asks that the dossier "shows every approved criterion
 * VERIFIED (n/n)" at the released sha, and its plan step is explicit that "all verified" without
 * a DENOMINATOR hides a dossier that enumerated fewer criteria than the contract approved. So
 * this returns both numbers and the caller cross-checks the denominator against the PRD's own
 * roster in `live-proof-prd.ts` rather than against the daemon's header.
 *
 * NOTHING HERE JUDGES A CRITERION. The human approves a CHECK for each one over the daemon's own
 * offer, then spends the verify offer; the contained criterion evidence service inside the REAL
 * wrapper (`repository-delivery-runtime.ts:127`, ticked on every pass) runs those checks against
 * the workspace and writes the results. A check is `node checks/<criterionId>.mjs`, a file
 * committed into the product repository BEFORE any node was delivered -- so no criterion is
 * measured by bytes written after the delivery it judges.
 */
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { killTree } from "./daemon-children.js";
import { readWireProtocolVersion } from "./daemon-ports.js";
import type { DaemonLane, LaneScratch } from "./daemon-ports.js";
import { isRecord } from "./live-proof-arms.js";
import { startWrapper, WRAPPER_INTERVAL_MS, wrapperEnv } from "./wrapper-lane.js";

/** Each check is a node process over one committed file; generous, and bounded. */
const CHECK_TIMEOUT_MS = 60_000;
const VERIFY_BUDGET_MS = 240_000;

export interface CriterionRow {
  readonly approvalId: string | null;
  readonly criterionId: string;
  readonly status: string | null;
}

export interface LiveCriterionEvidence {
  readonly criteria: readonly CriterionRow[];
  /** Every dispatch answer, verbatim: a refusal must surface its CODE, never a bare miss. */
  readonly dispatched: readonly Readonly<Record<string, unknown>>[];
  readonly integratedSha: string | null;
  /** The daemon's own coverage totals, denominator included. */
  readonly totals: Readonly<Record<string, number>> | null;
  readonly verified: number;
}

async function post(
  lane: DaemonLane, path: string, body: unknown, credential: string = lane.credential,
): Promise<unknown> {
  const response = await fetch(`${lane.daemonOrigin}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json", origin: lane.daemonOrigin,
      "x-moe-csrf": lane.csrfToken, "x-moe-session-credential": credential,
      "x-moe-protocol-version": await readWireProtocolVersion(lane.repoRoot) ?? "",
    },
    method: "POST",
  });
  return response.json();
}

/**
 * Spends an offer the DAEMON minted, on a DURABLE HUMAN credential.
 *
 * MEASURED 2026-09-09: the configured operator wire is refused
 * `CRITERION_CHECK_HUMAN_REQUIRED @ CRITERION_EVIDENCE` 403, "a durable human principal is
 * required" -- approving a criterion check is a human act by design. `mintLaneOperatorSeat`
 * opens a real session through the production handshake seam and yields exactly that class,
 * which is the same stand-in this drive's boundary arm already uses and the only one available:
 * the paired browser's own plaintext credential is returned once and never stored.
 */
async function spend(
  lane: DaemonLane, offer: Readonly<Record<string, unknown>>, payload: unknown, tag: string,
  credential: string,
): Promise<unknown> {
  return post(lane, "/command", {
    commandId: `live-proof-${tag}`, commandKind: offer["commandKind"],
    correlationId: "live-proof-criteria", expectedVersion: offer["expectedVersion"], payload,
    requestDigest: "d".repeat(64), schemaVersion: "moe-runtime-command/1",
    sessionCredential: credential, targetAggregateId: offer["targetAggregateId"],
  }, credential);
}

const criteriaOf = (frame: unknown): readonly Readonly<Record<string, unknown>>[] =>
  isRecord(frame) && Array.isArray(frame["criteria"])
    ? (frame["criteria"] as readonly unknown[]).filter(isRecord) : [];

interface CriterionRunIdentity {
  readonly goalRef: string; readonly planningRunRef: string;
  readonly integratedSha: string; readonly runRef: string;
}

/** Take the run identity only from this command's accepted queue decision. */
export function criterionQueueIdentity(ready: unknown, response: unknown, commandId: string): CriterionRunIdentity {
  const decision = isRecord(response) && isRecord(response["decision"]) ? response["decision"] : null;
  if (!isRecord(response) || response["ok"] !== true || response["outcome"] !== "ACCEPTED"
    || decision?.["commandId"] !== commandId || decision["resultCode"] !== "CRITERION_CHECK_QUEUED"
    || !["DECIDED", "REPLAYED"].includes(String(decision["disposition"]))) {
    throw new Error(`criterion verification not accepted: ${JSON.stringify(isRecord(response) ? response["refusal"] ?? response : response)}`);
  }
  if (!isRecord(ready) || typeof ready["goalRef"] !== "string" || typeof ready["planningRunRef"] !== "string"
    || !isRecord(ready["integratedArtifact"]) || typeof ready["integratedArtifact"]["sha"] !== "string") {
    throw new Error("criterion queue identity is unreadable");
  }
  return { goalRef: ready["goalRef"], planningRunRef: ready["planningRunRef"],
    integratedSha: ready["integratedArtifact"]["sha"], runRef: commandId };
}

/** The wrapper may stop only after this accepted run is durably settled. */
export function criterionEvidenceSettled(frame: unknown, expected: CriterionRunIdentity): boolean {
  if (isRecord(frame) && frame["outcome"] === "REFUSED") throw new Error(`criterion read refused: ${JSON.stringify(frame)}`);
  if (isRecord(frame) && isRecord(frame["run"]) && frame["run"]["status"] === "BLOCKED") {
    throw new Error(`criterion run BLOCKED: ${String(frame["run"]["runRef"])}`);
  }
  if (!isRecord(frame) || !isRecord(frame["run"]) || frame["run"]["status"] !== "COMPLETED") return false;
  if (frame["goalRef"] !== expected.goalRef || frame["planningRunRef"] !== expected.planningRunRef
    || frame["run"]["runRef"] !== expected.runRef || frame["run"]["integratedSha"] !== expected.integratedSha
    || !isRecord(frame["integratedArtifact"]) || frame["integratedArtifact"]["sha"] !== expected.integratedSha) return false;
  const rows = criteriaOf(frame);
  return rows.length > 0 && rows.every((row) => isRecord(row["evidence"]));
}

/**
 * Runs the real wrapper until the criterion run reports every criterion, then stops it.
 *
 * A FIXED SLEEP WOULD BE A GUESS. The service advances once per wrapper pass and each check is a
 * real child process, so the exit condition is the daemon's own read answering with evidence for
 * every row AND a completed run. The final receipt precedes the completion append; killing
 * the wrapper between them leaves current coverage unverified. A run that never settles spends
 * the budget and is reported as such rather
 * than being called done.
 */
async function tickUntilVerified(
  lane: DaemonLane, scratch: LaneScratch, workspace: string, expected: CriterionRunIdentity,
): Promise<unknown> {
  const tracked: ChildProcess[] = [];
  startWrapper(lane.repoRoot, {
    ...wrapperEnv(scratch, "node --eval \"process.exit(0)\"", WRAPPER_INTERVAL_MS, true),
    MOE_NODE_TEST_COMMAND: "node verify.mjs",
    MOE_NODE_WORKSPACE: workspace,
  }, tracked);
  try {
    const deadline = Date.now() + VERIFY_BUDGET_MS;
    let frame = await post(lane, "/criteria/read", { goalRef: expected.goalRef });
    while (Date.now() < deadline) {
      if (criterionEvidenceSettled(frame, expected)) return frame;
      await delay(2_000);
      frame = await post(lane, "/criteria/read", { goalRef: expected.goalRef });
    }
    throw new Error(`criterion run did not settle: ${JSON.stringify(isRecord(frame) ? frame["run"] : frame)}`);
  } finally {
    for (const child of [...tracked].reverse()) await killTree(child);
  }
}

/**
 * Approves a check for every criterion, spends the verify offer, and reads the result back.
 *
 * `program` is `process.execPath` rather than the bare name because this travels as an ARGV
 * array, not as a command line -- the space in "C:\\Program Files\\nodejs\\node.exe" is only a
 * hazard where a string is split, which is why `MOE_NODE_TEST_COMMAND` uses the bare name and
 * this does not.
 */
export async function verifyLiveProofCriteria(
  lane: DaemonLane, scratch: LaneScratch, workspace: string, goalRef: string,
  criterionIds: readonly string[], humanCredential: string,
): Promise<LiveCriterionEvidence> {
  const dispatched: Readonly<Record<string, unknown>>[] = [];
  let frame = await post(lane, "/criteria/read", { goalRef });
  for (const criterionId of criterionIds) {
    const row = criteriaOf(frame).find((item) => item["criterionId"] === criterionId);
    const offer = row?.["approveOffer"];
    if (!isRecord(offer)) { dispatched.push({ criterionId, noOffer: true }); continue; }
    const answered = await spend(lane, offer, {
      check: {
        args: [`checks/${criterionId}.mjs`], checkId: `check-${criterionId}`,
        checkVersion: "1", program: process.execPath, timeoutMs: CHECK_TIMEOUT_MS,
      },
      contractRef: isRecord(frame) ? frame["contractRef"] : null,
      criterionId,
      goalRef: isRecord(frame) ? frame["goalRef"] : goalRef,
      planningRunRef: isRecord(frame) ? frame["planningRunRef"] : null,
    }, `criterion-approve-${criterionId}`, humanCredential);
    dispatched.push({ answer: isRecord(answered) ? (answered["refusal"] ?? answered["outcome"]) : answered, criterionId });
    frame = await post(lane, "/criteria/read", { goalRef });
  }
  const ready = frame;
  const verifyOffer = isRecord(ready) ? ready["verifyOffer"] : null;
  const artifact = isRecord(ready) ? ready["integratedArtifact"] : null;
  let queued: CriterionRunIdentity;
  if (isRecord(verifyOffer) && isRecord(artifact)) {
    const verified = await spend(lane, verifyOffer, {
      approvals: criteriaOf(ready).map((row) => ({
        approvalId: isRecord(row["approval"]) ? row["approval"]["approvalId"] : null,
        criterionId: row["criterionId"],
      })),
      contractRef: isRecord(ready) ? ready["contractRef"] : null,
      goalRef: isRecord(ready) ? ready["goalRef"] : goalRef,
      integratedSha: artifact["sha"],
      planningRunRef: isRecord(ready) ? ready["planningRunRef"] : null,
    }, "criterion-verify-all", humanCredential);
    dispatched.push({ answer: isRecord(verified) ? (verified["refusal"] ?? verified["outcome"]) : verified, criterionId: "VERIFY_ALL" });
    queued = criterionQueueIdentity(ready, verified, "live-proof-criterion-verify-all");
  } else {
    dispatched.push({
      criterionId: "VERIFY_ALL",
      integratedArtifact: artifact, verifyOffer: verifyOffer === null ? null : "PRESENT",
    });
    throw new Error(`criterion verification not offered: ${JSON.stringify(dispatched.at(-1))}`);
  }
  const settled = await tickUntilVerified(lane, scratch, workspace, queued);
  const coverage = await post(lane, "/documents/coverage/read", { goalRef });
  const rows = criteriaOf(settled).map((row) => ({
    approvalId: isRecord(row["approval"]) ? String(row["approval"]["approvalId"]) : null,
    criterionId: String(row["criterionId"]),
    status: isRecord(row["evidence"]) ? String(row["evidence"]["status"]) : null,
  }));
  const totals = isRecord(coverage) && isRecord(coverage["totals"])
    ? coverage["totals"] as Readonly<Record<string, number>> : null;
  return {
    criteria: rows, dispatched,
    integratedSha: isRecord(artifact) ? String(artifact["sha"]) : null,
    totals,
    // PASSED IS THE CRITERION RECEIPT'S OWN WORD, taken from the daemon rather than
    // renamed here; `/documents/coverage/read` then reports the same fact as `verified`.
    verified: rows.filter((row) => row.status === "PASSED").length,
  };
}
