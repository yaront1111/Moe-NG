import type { SqliteEventStore } from "@moe/store";
import { DomainRefusal, decisionOf } from "../daemon-command-dispatch.js";
import { foundationSyncHandler } from "../daemon-foundation-command.js";
import type { Authenticator, CommandHandlerInput, CommandRegistryEntry } from "../http/http-contract.js";
import { createVerifiedWorkspacePort } from "../repository/git-verified-workspace-port.js";
import type { VerifiedWorkspacePort } from "../repository/verified-workspace-contracts.js";
import { readWorkClaimLedger } from "../work/work-claim-read-model.js";
import { decodeReviewRequestBytes, REVIEW_SCHEMA_VERSION } from "./review-contracts.js";
import { readReviewLedger, replayOf } from "./review-ledger.js";
import { runReviewCommand } from "./review-services.js";
import { prepareReviewSubmissionPackage } from "./review-submission-package.js";
import { readReviewSubmissionSource } from "./review-submission-source.js";

const REVIEW_SUBMISSION_LAYER = "REVIEW_SUBMISSION";

export interface ReviewSubmissionWiring {
  /** The SAME authenticator as ingress, so operator and session revocation rules cannot drift. */
  readonly authenticate: Authenticator["authenticate"];
  readonly workspace: string;
  readonly capture?: VerifiedWorkspacePort["capture"];
}

/** Empty items explicitly request preparation; explicit legacy packages retain their old path. */
export function createReviewSubmissionCommandEntry(options: {
  readonly store: SqliteEventStore; readonly projectId: string; readonly clock: () => string;
  readonly assertAuthority: () => void;
  readonly wiring: ReviewSubmissionWiring;
}): CommandRegistryEntry {
  const { store, projectId, clock, wiring } = options;
  const capture = wiring.capture ?? createVerifiedWorkspacePort().capture;
  const refuse = (code: string): never => { throw new DomainRefusal(code, REVIEW_SUBMISSION_LAYER, code); };
  const sourceFor = (input: CommandHandlerInput) => {
    const { envelope, principal } = input;
    const authenticated = wiring.authenticate(envelope.sessionCredential);
    if (authenticated.verdict !== "AUTHENTICATED"
      || authenticated.principal.principalId !== principal.principalId
      || authenticated.principal.projectId !== projectId
      || !authenticated.principal.capabilities.includes("review.write")) {
      return refuse("REVIEW_SUBMISSION_AUTHENTICATION_CHANGED");
    }
    const source = readReviewSubmissionSource(store, projectId, envelope.targetAggregateId);
    if (source === null) return refuse("REVIEW_SUBMISSION_NODE_UNAVAILABLE");
    const claims = readWorkClaimLedger(store, projectId);
    const claim = claims.claims.get(`node.deliver@${envelope.targetAggregateId}`);
    if (claims.unreadable || claim === undefined || claim.status !== "OPEN"
      || claim.claimedBy !== principal.principalId || !(Date.parse(claim.expiresAt) > Date.parse(clock()))) {
      return refuse("REVIEW_SUBMISSION_CLAIM_REQUIRED");
    }
    const review = readReviewLedger(store, projectId, envelope.targetAggregateId);
    if (review.unreadable || review.accepted !== undefined || review.replanned
      || review.version !== envelope.expectedVersion) return refuse("REVIEW_SUBMISSION_VERSION_CHANGED");
    return { source, claim };
  };
  return Object.freeze({ kind: "review.submit", requiredCapability: "review.write",
    payloadKeys: ["findings", "packageItems", "round", "subjectRef"], handler: foundationSyncHandler,
    asyncHandler: async (input: CommandHandlerInput) => {
      options.assertAuthority();
      const { envelope, principal } = input;
      if (principal.projectId !== projectId) return refuse("REVIEW_SUBMISSION_PROJECT_MISMATCH");
      const bytes = new TextEncoder().encode(JSON.stringify({ kind: "review.submit", projectId,
        commandId: envelope.commandId, correlationId: envelope.correlationId, decidedAt: clock(),
        expectedVersion: envelope.expectedVersion, payload: envelope.payload,
        principalId: principal.principalId, schemaVersion: REVIEW_SCHEMA_VERSION }));
      const decoded = decodeReviewRequestBytes(bytes);
      if (!decoded.ok) return decisionOf(runReviewCommand(store, bytes));
      // Preserve ORIGINAL command bytes for replay; a repeated submit never recaptures new work.
      const replay = replayOf(store, decoded.request);
      if (replay !== null) return decisionOf(replay);
      const items = envelope.payload["packageItems"];
      if (!Array.isArray(items) || items.length !== 0) return decisionOf(runReviewCommand(store, bytes));
      // With no items the existing parser can only refuse, so use its exact finding/round/shape
      // admission before touching Git. Only the expected missing-package refusal opens capture.
      const admission = runReviewCommand(store, bytes);
      if (admission.ok || admission.code !== "PACKAGE_BINDING_INCOMPLETE") return decisionOf(admission);
      if (envelope.payload["subjectRef"] !== envelope.targetAggregateId) return refuse("REVIEW_SUBMISSION_SUBJECT_MISMATCH");
      const before = sourceFor(input);
      const observed = await capture(wiring.workspace);
      options.assertAuthority();
      if (!observed.ok) return refuse(observed.code);
      // No await follows these checks. Approval, claim (including version), and review version
      // must still be exactly the facts that authorized capture before any durable round exists.
      const after = sourceFor(input);
      if (JSON.stringify(before) !== JSON.stringify(after)) return refuse("REVIEW_SUBMISSION_AUTHORITY_CHANGED");
      const prepared = prepareReviewSubmissionPackage({ source: after.source, binding: observed.binding,
        projectId, subjectRef: envelope.targetAggregateId });
      return decisionOf(runReviewCommand(store, bytes, undefined, prepared));
    },
  });
}
