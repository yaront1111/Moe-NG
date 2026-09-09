import type { GitCommitReceipt } from "./git-landing-port.js";
import type { LandingCommit } from "./landing-receipt-contracts.js";
import type { RepositoryExecutionHandle } from "./repository-execution-contracts.js";
import type { VerifiedWorkspaceBinding } from "./verified-workspace-contracts.js";

export interface RepositoryLandingIntent {
  readonly version: "moe-repository-landing-intent/1";
  readonly intentId: string;
  readonly ownerDigest: string;
  readonly projectId: string;
  readonly nodeRef: string;
  readonly baselineId: string;
  readonly sessionId: string;
  readonly gitDirectory: string;
  readonly verifierReceiptId: string;
  readonly binding: VerifiedWorkspaceBinding;
  readonly paths: readonly string[];
  readonly message: string;
}
export interface RepositoryLandingIntentInput {
  readonly handle: RepositoryExecutionHandle;
  readonly verifierReceiptId: string;
  readonly binding: VerifiedWorkspaceBinding;
  readonly paths: readonly string[];
  readonly message: string;
}
export interface RepositoryLandingCompletion {
  readonly version: "moe-repository-landing-completion/1";
  readonly intentId: string;
  readonly commit: LandingCommit;
}
export interface RepositoryLandingCompletionInput {
  readonly intent: RepositoryLandingIntent;
  /** Supplied only after the exact Git port returned success and closed its owned locks. */
  readonly commit: GitCommitReceipt;
}
