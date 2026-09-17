import { createHash, randomUUID } from "node:crypto";
import { expect } from "vitest";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { createDaemonCommandPorts, OPERATOR_CAPABILITIES } from "../daemon-command-registry.js";
import { handleAsyncCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { createSessionAuthenticator } from "../identity/session-authenticator.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { runSessionCommand } from "../identity/session-services.js";
import { SESSION_SCHEMA_VERSION } from "../identity/session-contracts.js";
import { runWorkClaimCommand } from "../work/work-claim-services.js";
import { WORK_CLAIM_SCHEMA_VERSION } from "../work/work-claim-contracts.js";
import { createAgentSessionFence } from "../orchestrator/agent-session-fence.js";
import { recordSeatExit } from "../orchestrator/provider-pause-ledger.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { runReviewCommand } from "../review/review-services.js";
import { GOVERNANCE_PRINCIPAL_ID } from "../review/governance-policy-settings.js";
import { createReviewResumeWorld } from "./repository-review-resume-test-fixtures.js";
import type { ReviewResumeWorldOptions } from "./repository-review-resume-test-fixtures.js";

type ReviewResumeWorld = Awaited<ReturnType<typeof createReviewResumeWorld>>;

export interface ReplanRecoveryWorldOptions extends ReviewResumeWorldOptions {
  /** An agent's `qualification.replan` committed right after this round, at the node's version. */
  readonly deltaAfterRound?: 1 | 3;
  /** Runs after round 3 (and any delta after it), immediately before the REPLAN is decided. */
  readonly beforeReplan?: (w: ReviewResumeWorld) => void;
}

export async function createReplanRecoveryWorld(
  options: ReplanRecoveryWorldOptions = {},
  replanAs: "human" | "governance" = "human",
) {
  const w = await createReviewResumeWorld(options);
  const sessionId = w.blocked.reservation.sessionId!;
  const workItemId = `node.deliver@${w.owner.nodeRef}`;
  const stamp = w.request.decidedAt;
  const future = new Date(Date.parse(w.options.clock()) + 60_000).toISOString();
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const command = (kind: string, payload: unknown, expectedVersion: number, principalId: string, schemaVersion: string) => ({
    kind, payload, expectedVersion, principalId, schemaVersion, projectId: PROJECT_ID,
    commandId: randomUUID(), correlationId: "replan-recovery-fixture", decidedAt: stamp,
  });
  expect(runSessionCommand(w.store, bytes(command("session.open", { sessionId, capabilities: ["work.write", "review.write"],
    expiresAt: future, credentialSha256: "c".repeat(64) }, 0, "operator", SESSION_SCHEMA_VERSION))).ok).toBe(true);
  expect(runWorkClaimCommand(w.store, bytes(command("work.claim", { workItemId,
    expiresAt: future }, 0, sessionId, WORK_CLAIM_SCHEMA_VERSION))).ok).toBe(true);
  const fence = createAgentSessionFence({ store: w.store, projectId: PROJECT_ID, isProcessAlive: () => false });
  expect(fence.recordLiveChild({ sessionId, workItemId, childPid: w.blocked.reservation.pid!, claimAggregateVersion: 0 })).toEqual([]);
  // Each round names a distinct gap: three unsuccessful rounds exhaust the cap. Repeating one
  // finding on the same prepared input would be a stall that asks for the decision at round 2.
  const findings = (round: number) => (w.request.payload.findings as readonly Record<string, unknown>[])
    .map((finding) => ({ ...finding, ruleId: `${String(finding["ruleId"])}-${String(round)}` }));
  // Every command binds the node's CURRENT version, so an agent's re-plan between rounds shifts the
  // later versions without changing the defaults (rounds at 1-3, REPLAN at 3).
  const version = () => readReviewLedger(w.store, PROJECT_ID, w.owner.nodeRef).version;
  const deltaAfter = (round: number) => {
    if (options.deltaAfterRound !== round) return;
    expect(runReviewCommand(w.store, bytes({ ...w.request, commandId: randomUUID(), kind: "qualification.replan",
      expectedVersion: version(), payload: { nodes: [{ nodeRef: w.owner.nodeRef }], subjectRef: w.owner.nodeRef,
        successorPlanRef: "agent-successor-plan" } }))).toMatchObject({ ok: true });
  };
  deltaAfter(1);
  for (const round of [2, 3]) {
    expect(runReviewCommand(w.store, bytes({ ...w.request, commandId: randomUUID(), expectedVersion: version(),
      payload: { ...w.request.payload, findings: findings(round), round } }), undefined, w.prepared).ok).toBe(true);
    deltaAfter(round);
  }
  options.beforeReplan?.(w);
  const now = Date.parse(w.options.clock());
  const human = createOperatorSessionHandshakePort({ store: w.store, projectId: PROJECT_ID,
    operatorPrincipalId: "operator", capabilities: OPERATOR_CAPABILITIES, clock: () => now,
    sessionTtlMs: 60_000 }).mint();
  if (!human.ok) throw new Error(human.code);
  const authenticator = createSessionAuthenticator(w.store, { clock: () => now, operatorCapabilities: OPERATOR_CAPABILITIES,
    operatorCredential: "private-replan-operator", operatorPrincipalId: "operator", projectId: PROJECT_ID });
  const ports = createDaemonCommandPorts({ store: w.store, projectId: PROJECT_ID,
    operatorPrincipalId: "operator", clock: w.options.clock });
  const replan = async () => {
    const decidedVersion = version();
    const payload = { decision: "REPLAN", escalationRef: `ui-escalation-${w.owner.nodeRef}-v${String(decidedVersion)}`, subjectRef: w.owner.nodeRef };
    return handleAsyncCommandRequest({ ...ports, authenticator }, {
      body: bytes({ commandId: randomUUID(), commandKind: "escalation.decide", expectedVersion: decidedVersion,
        correlationId: "replan-recovery-fixture", targetAggregateId: w.owner.nodeRef, payload,
        requestDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: human.credential }),
      credential: human.credential, protocolVersion: WIRE_PROTOCOL_VERSION,
    }, "HTTP_LISTENER");
  };
  /**
   * The same REPLAN, committed by the reserved governance seat instead of the human — the shape
   * governance actually produced on UnAI 2026-09-16, straight through `runReviewCommand` as
   * `governance-escalation-decider.ts` did. It retires the node identically, and the release
   * gate then refuses it for ever, which is what left two checkouts unfreeable by any command.
   */
  const replanAsGovernance = () => runReviewCommand(w.store, bytes({
    commandId: randomUUID(), correlationId: "replan-recovery-fixture", decidedAt: stamp,
    expectedVersion: version(), kind: "escalation.decide",
    payload: { decision: "REPLAN", escalationRef: `gov-escalation-${w.owner.nodeRef}-v${String(version())}`, subjectRef: w.owner.nodeRef },
    principalId: GOVERNANCE_PRINCIPAL_ID, projectId: PROJECT_ID, schemaVersion: w.request.schemaVersion,
  }));
  if (replanAs === "governance") expect(replanAsGovernance()).toMatchObject({ ok: true });
  else expect(await replan()).toMatchObject({ ok: true });
  const closeAuthority = () => {
    expect(runWorkClaimCommand(w.store, bytes(command("work.release", { workItemId }, 1, sessionId, WORK_CLAIM_SCHEMA_VERSION))).ok).toBe(true);
    expect(runSessionCommand(w.store, bytes(command("session.close", { sessionId }, 1, "operator", SESSION_SCHEMA_VERSION))).ok).toBe(true);
    expect(recordSeatExit(w.store, { projectId: PROJECT_ID, sessionId, workItemId,
      decidedAt: w.options.clock(), exitCode: 0, kind: "COMPLETED", lastLine: null,
      outputSeen: true, provider: "private-test", resetAt: null, terminatedByWrapper: false }).ok).toBe(true);
    expect(fence.retireLiveChild(workItemId)).toEqual([]);
  };
  closeAuthority();
  w.git("add", "--", "app.txt");
  w.git("-c", "user.name=Human", "-c", "user.email=human@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "preserve reviewed work");
  const review = readReviewLedger(w.store, PROJECT_ID, w.owner.nodeRef);
  const input = { ...w.input, commandId: "release-replanned-one", payload: { ...w.input.payload,
    action: "RELEASE_REPLANNED", expectedReviewVersion: review.version,
    expectedReviewDigest: review.rounds.at(-1)!.resultSha256, reason: "Preserve the reviewed human commit and release the retired node" } };
  return { ...w, input, human, fence };
}
