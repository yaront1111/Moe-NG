export const RUNNER_SOURCE_SNAPSHOT_GIT_LAYER = "RUNNER_SOURCE_SNAPSHOT_GIT" as const;

export const RUNNER_SOURCE_SNAPSHOT_GIT_CODES = Object.freeze([
  "RUNNER_SOURCE_SNAPSHOT_ROOT_UNRESOLVABLE",
  "RUNNER_SOURCE_SNAPSHOT_REPOSITORY_OWNERSHIP_MISMATCH",
  "RUNNER_SOURCE_SNAPSHOT_EXPECTED_REVISION_INVALID",
  "RUNNER_SOURCE_SNAPSHOT_HEAD_MISMATCH",
  "RUNNER_SOURCE_SNAPSHOT_TREE_UNREADABLE",
  "RUNNER_SOURCE_SNAPSHOT_OUTPUT_MALFORMED",
  "RUNNER_SOURCE_SNAPSHOT_OBSERVATION_FAILED",
  "RUNNER_SOURCE_SNAPSHOT_OBSERVATION_OVERFLOW",
] as const);

export const MAX_SOURCE_SNAPSHOT_GIT_OUTPUT_BYTES = 4 * 1024;
export const SOURCE_SNAPSHOT_GIT_TIMEOUT_MS = 30_000;

export type SourceSnapshotGitCode = (typeof RUNNER_SOURCE_SNAPSHOT_GIT_CODES)[number];
export type SourceSnapshotGitLayer = typeof RUNNER_SOURCE_SNAPSHOT_GIT_LAYER;

export interface SourceSnapshotGitObservation {
  readonly baseRevisionHash: string;
  readonly realRepositoryRoot: string;
  readonly repositoryBaseTree: string;
}

export interface SourceSnapshotGitObserved {
  readonly observation: SourceSnapshotGitObservation;
  readonly ok: true;
}

export interface SourceSnapshotGitRefusal {
  readonly code: SourceSnapshotGitCode;
  readonly layer: SourceSnapshotGitLayer;
  readonly ok: false;
}

export type SourceSnapshotGitResult = SourceSnapshotGitObserved | SourceSnapshotGitRefusal;

export interface SourceSnapshotGitObserver {
  observe(expectedBaseRevision: string): SourceSnapshotGitResult;
}
