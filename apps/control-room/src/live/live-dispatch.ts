import type { ControlRoomClientSurface, ControlRoomTransport } from "@moe/control-room-client";
import type { JsonObject } from "@moe/contracts";

import { recordDispatchEffort } from "./live-effort-edge.js";

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

// THE DEV-SUBJECT CONVENTION, spelled by hand because this package cannot
// import the daemon: these three literals MUST agree with DEFAULT_RUN_SUBJECT /
// DEFAULT_GOAL_SUBJECT / DEFAULT_SESSION_SUBJECT in apps/daemon/src/http/
// affordance-read.ts (and the demo seed binds to the same exports). A drifted
// copy here is exactly how the provider-probe chain silently broke once.
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
    // The PROFILE is what the probe registers; an observation without one
    // refuses PROVIDER_PROFILE_INPUT_INVALID at the codec, which silently
    // bricked the whole board-driven chain (project.activate names the probe
    // as its prerequisite). Mirrors the daemon's CLAUDE_PROFILE fixture; the
    // ref MUST agree with project.activate's witness below.
    observation: {
      profile: {
        capabilitySchemaDigest: hex64("ca9ab111"),
        concurrencyCeiling: 4,
        limits: { stderrBytes: 65_536, stdoutBytes: 131_072, tailBytes: 4_096, timeoutMs: 900_000 },
        modelSnapshotEvidence: "claude --version reported a dated snapshot",
        modelSnapshotKind: "DATED_SNAPSHOT",
        profileRevisionId: "profile-revision-1",
        provider: "claude",
        providerMinimumProfileRef: "provider-profile-1",
        reasoningEffort: "high",
        selectedModelId: "claude-opus-5",
        selection: {
          modelRef: "model-ref-1", profileRef: "profile-ref-1", providerRef: "provider-ref-1",
          reasoningEffortRef: "reasoning-effort-ref-1", runtimeRef: "runtime-ref-1",
          snapshotRef: "snapshot-ref-1", structuredOutputSchemaRef: "structured-output-schema-ref-1",
        },
      },
      providerMinimumProfileRef: "provider-profile-1", truthClass: "DAEMON_VERIFIED",
    },
  },
  "session.open": {
    capabilities: ["goal.write"], credentialSha256: "a".repeat(64),
    expiresAt: "2027-01-01T00:00:00.000Z", sessionId: "sess-ui-1",
  },
});

/** The seven evidence-bindable package items buildReviewPackage demands. */
const REVIEW_PACKAGE_ITEMS: readonly JsonObject[] = [
  { digest: hex64("c1"), kind: "CRITERION", locator: "criterion-1" },
  { digest: hex64("d1"), kind: "DAEMON_RECEIPT", locator: "receipt-1" },
  { digest: hex64("6a"), kind: "GRAPH_HASH", locator: "graph-1" },
  { digest: hex64("f1"), kind: "INTEGRATED_TREE", locator: "tree-1" },
  { digest: hex64("b1"), kind: "PLAN_HASH", locator: "plan-1" },
  { digest: hex64("2b"), kind: "RUBRIC", locator: "rubric-1" },
  { digest: hex64("5b"), kind: "SUBMITTED_BYTES", locator: "submitted-1" },
];

/** Review-family payloads are per-subject: the target aggregate IS the node. */
function reviewPayloadFor(kind: string, subjectRef: string): JsonObject | null {
  if (kind === "review.submit") {
    return {
      findings: [], packageItems: REVIEW_PACKAGE_ITEMS, round: 1, subjectRef,
    };
  }
  if (kind === "integration.accept_output") {
    // Exactly the seam's allow-list — PAYLOAD_KEYS admits ["receiptId",
    // "subjectRef"] and nothing else; the previous richer shape was refused
    // whole at PAYLOAD_SHAPE before any gate could even read it.
    return { receiptId: `receipt-${subjectRef}`, subjectRef };
  }
  return null;
}

/** The one session the board may operate: its own dev subject, never an agent's. */
const DEV_SESSION_ID = "sess-ui-1";

/** session.close / session.renew derive their payload from the step's aggregate. */
export function payloadFor(kind: string, aggregateId: string | null): JsonObject | null {
  if (kind === "session.close" || kind === "session.renew") {
    const sessionId = aggregateId?.startsWith("session/") === true
      ? aggregateId.slice("session/".length)
      : null;
    // ONLY the dev session. The surface offers close/renew for EVERY open
    // session, including the ones the wrapper minted for live agents — a
    // one-click close there kills an agent's session mid-work, and a renew
    // silently rewrites its expiry. The board authors neither.
    if (sessionId !== DEV_SESSION_ID) return null;
    return kind === "session.close"
      ? { sessionId }
      : { expiresAt: "2027-06-01T00:00:00.000Z", sessionId };
  }
  if ((kind === "review.submit" || kind === "integration.accept_output")
    && aggregateId !== null) {
    return reviewPayloadFor(kind, aggregateId);
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
  // A side record of what the surface demanded of the operator, taken before anything
  // can refuse: the human already decided by handing the card back, whatever the daemon
  // then answers. It returns void and cannot throw, so every line below is unchanged.
  recordDispatchEffort({
    affordance: input.affordance, aggregateId: input.aggregateId, commandKind: input.kind,
  });
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
