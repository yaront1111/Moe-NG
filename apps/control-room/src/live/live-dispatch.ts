import type { ControlRoomClientSurface, ControlRoomTransport } from "@moe/control-room-client";
import type { JsonObject } from "@moe/contracts";

/**
 * Dispatch = the daemon's affordance handed back through the generated builder.
 *
 * The builder validates the affordance and mints the envelope; this module adds
 * only the caller half (payload, correlation, digest, credential) and reports
 * the daemon's answer verbatim. The UI never moves a card on the strength of a
 * dispatch — the next surface poll does, because only the ledger moves cards.
 *
 * DEVELOPMENT payload defaults: dev-fixture payloads matching the daemon's
 * default-subject convention. The daemon may still refuse any of them; that
 * refusal renders verbatim, which is correct behavior rather than a failure.
 */

// Shapes mirror the daemon's committed J1 fixtures (bootstrap-test-fixtures.ts)
// on the live default subjects the affordance surface derives versions for.
const hex64 = (seed: string): string =>
  (seed.replace(/[^0-9a-f]/gu, "0") + "0".repeat(64)).slice(0, 64);

const GOAL_ID = "goal-live-1";
const RUN_ID = "run-live-1";
const POLICY_REF = hex64("a1b2c3");
const SUBMISSION_HASH = hex64("dec0de");

const PLANNING_CHAIN: readonly JsonObject[] = [
  {
    commandId: "chain-create", expectedVersion: 0, goalRef: GOAL_ID,
    kind: "planning.create_draft", runId: RUN_ID, runKind: "INITIAL",
  },
  {
    commandId: "chain-ready", expectedVersion: 1, kind: "planning.ready",
    witness: {
      acceptanceCriteriaRef: "criteria-1", intentBaseRef: "intent-1",
      planningBudgetRef: "budget-1", truthClass: "DAEMON_VERIFIED",
    },
  },
  {
    commandId: "chain-claim", expectedVersion: 2, kind: "planning.claim",
    witness: {
      attemptRef: "attempt-1", contextRef: "context-1", leaseRef: "lease-1",
      providerSlotRef: "slot-1", truthClass: "DAEMON_VERIFIED",
    },
  },
  {
    commandId: "chain-propose",
    effectTerminalProof: {
      effectTerminalRef: "effect-terminal-1", resourcesTerminalRef: "resources-terminal-1",
      truthClass: "DAEMON_VERIFIED",
    },
    expectedVersion: 3, kind: "plan.propose", proposalKind: "INITIAL",
    submissionHash: SUBMISSION_HASH,
    witness: {
      attemptRef: "attempt-1", submissionRef: "submission-1", truthClass: "DAEMON_VERIFIED",
    },
  },
];

export const DEV_PAYLOADS: Readonly<Record<string, JsonObject>> = Object.freeze({
  "approval.decide": {
    activation: {
      activationRef: "activation-1", budgetHash: hex64("b0"), expectedGoalVersion: 1,
      goalDraftNoActiveRevision: true, graphHash: hex64("6a"), policyHash: hex64("b1"),
      qualityHash: hex64("dd"), truthClass: "HUMAN_APPROVED",
    },
    command: {
      decision: "APPROVE", decisionReason: "reason-1", kind: "approval.decide",
      stepUpAuthRef: "stepup-1",
    },
    graphRevisionRef: "graph-revision-1",
    record: {
      actor: "human-1", actorKind: "HUMAN", applicablePolicyRef: hex64("aa"),
      approvalRef: "approval-1", approvedNodeScope: ["node-1"], budgetRef: hex64("bb"),
      criteriaRef: hex64("cc"), decision: null, decisionReason: null,
      dependencyChanges: { additions: [], challenges: [], removals: [] },
      exactRevisionHash: SUBMISSION_HASH, lifecycle: "PENDING",
      planQualityAssessmentRef: hex64("dd"), policyDecisionRef: null, riskTier: "R2",
      stepUpAuthRef: "stepup-1", truthClass: "HUMAN_APPROVED", validity: "CURRENT",
    },
    runId: RUN_ID,
  },
  "goal.close": {
    closureWitness: {
      acceptanceClosureRef: "acceptance-1", completionNodeAcceptedRef: "completion-node-1",
      noCurrentPreparationGeneration: true, noPendingDraftOrSupersession: true,
      obligationsHoldRef: "obligations-1", truthClass: "HUMAN_APPROVED",
    },
    goalId: GOAL_ID,
    zeroAuthorityWitness: {
      truthClass: "DAEMON_VERIFIED", zeroAuthorityProofRef: "zero-authority-1",
    },
  },
  "goal.create": {
    budgetAccountRef: "budget-account-1", goalId: GOAL_ID, planningRunRef: RUN_ID,
    witness: { projectReadyRef: "ready-1", truthClass: "DAEMON_VERIFIED" },
  },
  "plan.propose": { commands: PLANNING_CHAIN, runId: RUN_ID },
  "policy.install": {
    slice: { autoApprovalOptIns: [], rules: [], sliceRef: POLICY_REF },
  },
  "policy.validate": {
    input: {
      action: "plan.approve", actor: "principal-1", callerRiskHint: null,
      decisionDigest: hex64("d1"), evaluatedAtEpochMs: 1_760_000_000_000,
      evaluatorVersion: "evaluator-1", facts: [], graphNodeRevisionRefs: [],
      policyRevisionRef: POLICY_REF, requiredFactIds: [], scope: [],
      sliceChain: [{ autoApprovalOptIns: [], rules: [], sliceRef: POLICY_REF }],
      waivers: [],
    },
  },
  "project.activate": {
    witness: {
      artifactPathRef: "artifact-1", backupPathRef: "backup-1", credentialRef: "credential-1",
      distributionManifestHash: hex64("cafe"), policyRevisionHash: hex64("face"),
      providerMinimumProfileRef: "provider-profile-1", signingKeyRef: "signing-1",
      storeDriverRef: "store-driver-1", truthClass: "DAEMON_VERIFIED",
    },
  },
  "project.bind_repository": {
    observation: {
      baseRevisionHash: hex64("beef"), repositoryRef: "repo-1", scopeRef: "scope-1",
      truthClass: "DAEMON_VERIFIED",
    },
  },
  "project.register": { owner: "operator-local" },
  "provider.probe": {
    observation: {
      providerMinimumProfileRef: "provider-profile-1", truthClass: "DAEMON_VERIFIED",
    },
  },
  "session.open": {
    capabilities: ["goal.write"], credentialSha256: "a".repeat(64),
    expiresAt: "2027-01-01T00:00:00.000Z", sessionId: "sess-ui-1",
  },
});

/** session.close / session.renew derive their payload from the step's aggregate. */
export function payloadFor(kind: string, aggregateId: string | null): JsonObject | null {
  if (kind === "session.close" || kind === "session.renew") {
    const sessionId = aggregateId?.startsWith("session/") === true
      ? aggregateId.slice("session/".length)
      : null;
    if (sessionId === null) return null;
    return kind === "session.close"
      ? { sessionId }
      : { expiresAt: "2027-06-01T00:00:00.000Z", sessionId };
  }
  return DEV_PAYLOADS[kind] ?? null;
}

export interface DispatchReport {
  /** The daemon's own answer text: resultCode, refusal code, or transport code. */
  readonly detail: string;
  readonly ok: boolean;
  readonly stage: "ANSWERED" | "BUILD_REFUSED" | "UNDELIVERED";
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function answerText(response: unknown): { detail: string; ok: boolean } {
  if (!isRecord(response)) return { detail: "unreadable answer", ok: false };
  if (response["ok"] === true) {
    const decision = response["decision"];
    const resultCode = isRecord(decision) ? String(decision["resultCode"] ?? "") : "";
    const disposition = isRecord(decision) ? String(decision["disposition"] ?? "") : "";
    return { detail: `${disposition} ${resultCode}`.trim(), ok: true };
  }
  const refusal = response["refusal"];
  if (isRecord(refusal)) return { detail: String(refusal["code"] ?? "REFUSED"), ok: false };
  const error = response["error"];
  if (isRecord(error)) return { detail: String(error["code"] ?? "REFUSED"), ok: false };
  return { detail: "REFUSED", ok: false };
}

export interface DispatchInput {
  readonly affordance: Record<string, unknown>;
  readonly aggregateId: string | null;
  readonly client: ControlRoomClientSurface;
  readonly kind: string;
  readonly sessionCredential: string;
  readonly transport: Pick<ControlRoomTransport, "sendCommand">;
}

export async function dispatchAffordance(input: DispatchInput): Promise<DispatchReport> {
  const payload = payloadFor(input.kind, input.aggregateId);
  if (payload === null) {
    return { detail: "no development payload for this kind", ok: false, stage: "BUILD_REFUSED" };
  }
  const builders = input.client.commands as unknown as Readonly<Record<
    string,
    (affordance: unknown, caller: unknown) => { envelope?: unknown; error?: { code?: string }; ok: boolean }
  >>;
  const builder = builders[input.kind];
  if (builder === undefined) {
    return { detail: "no generated builder for this kind", ok: false, stage: "BUILD_REFUSED" };
  }
  const built = builder(input.affordance, {
    correlationId: `ui-${String(Date.now())}`,
    payload,
    requestDigest: await sha256Hex(JSON.stringify(payload)),
    sessionCredential: input.sessionCredential,
  });
  if (!built.ok || built.envelope === undefined) {
    return { detail: built.error?.code ?? "INPUT_INVALID", ok: false, stage: "BUILD_REFUSED" };
  }
  const sent = await input.transport.sendCommand(
    built.envelope as Parameters<ControlRoomTransport["sendCommand"]>[0],
  );
  if (!sent.delivered) return { detail: sent.code, ok: false, stage: "UNDELIVERED" };
  const answer = answerText(sent.response);
  return { detail: answer.detail, ok: answer.ok, stage: "ANSWERED" };
}
