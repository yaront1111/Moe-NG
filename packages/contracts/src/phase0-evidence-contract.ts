export const CANONICAL_JSON_VERSION = "moe-canonical-json/1" as const;
export const EVIDENCE_IDENTITY_VERSION = "moe-evidence-identity/1" as const;
export const PHASE0_EVIDENCE_MANIFEST_VERSION = "moe-phase0-evidence-manifest/1" as const;

export const PHASE0_SOURCE_REPOSITORY = "D:\\projexts\\moes" as const;
export const PHASE0_TARGET_REPOSITORY = "D:\\projexts\\moe-next" as const;
export const PHASE0_GIT_STATUS_COMMAND =
  "git status --porcelain=v2 -z --untracked-files=all" as const;

const roleMetadata = [
  {
    role: "rebuild-design",
    owner: "codex",
    relativePath: "docs/plans/2026-08-05-moe-rebuild-design.md",
  },
  {
    role: "rebuild-charter",
    owner: "codex",
    relativePath: "docs/plans/2026-08-05-moe-rebuild-charter.md",
  },
  {
    role: "fable-review",
    owner: "fable",
    relativePath: "docs/plans/2026-08-05-moe-rebuild-fable-review.md",
  },
  {
    role: "control-room-spec",
    owner: "fable",
    relativePath: "docs/plans/2026-08-05-moe-v1-control-room-spec.md",
  },
  {
    role: "benchmark-spec",
    owner: "fable",
    relativePath: "docs/plans/2026-08-05-moe-best-tool-benchmark-spec.md",
  },
  {
    role: "moe-review",
    owner: "moe-reviewer",
    relativePath: "docs/plans/2026-08-05-moe-rebuild-moe-review.md",
  },
] as const;

export const PHASE0_ROLE_METADATA = Object.freeze(
  roleMetadata.map((metadata) => Object.freeze({ ...metadata })),
);

export type Phase0RoleMetadata = (typeof PHASE0_ROLE_METADATA)[number];
export type Phase0EvidenceRole = Phase0RoleMetadata["role"];
export type Phase0EvidenceOwner = Phase0RoleMetadata["owner"];
export type GitObjectFormat = "sha1" | "sha256";

export interface Phase0RepositoryObservation {
  readonly head: string;
  readonly statusObjectPath: string;
  readonly statusSha256: string;
}

export type Phase0SourceState =
  | {
      readonly blobOid: null;
      readonly state: "ABSENT_AT_HEAD";
    }
  | {
      readonly blobOid: string;
      readonly state: "IDENTICAL_TO_HEAD";
      readonly verifiedAtHead: true;
    };

export interface Phase0EvidenceEntry {
  readonly byteLength: number;
  readonly lineCount: number;
  readonly objectPath: string;
  readonly owner: Phase0EvidenceOwner;
  readonly relativePath: string;
  readonly role: Phase0EvidenceRole;
  readonly sha256: string;
  readonly sourceState: Phase0SourceState;
}

export interface Phase0EvidenceManifest {
  readonly canonicalizerVersion: typeof CANONICAL_JSON_VERSION;
  readonly captureStatus: "VERIFIED";
  readonly capturedAt: string;
  readonly entries: readonly Phase0EvidenceEntry[];
  readonly evidenceIdentityVersion: typeof EVIDENCE_IDENTITY_VERSION;
  readonly gitObjectFormat: GitObjectFormat;
  readonly schemaVersion: typeof PHASE0_EVIDENCE_MANIFEST_VERSION;
  readonly sourceAfter: Phase0RepositoryObservation;
  readonly sourceBefore: Phase0RepositoryObservation;
  readonly sourceRepository: typeof PHASE0_SOURCE_REPOSITORY;
  readonly statusCommand: typeof PHASE0_GIT_STATUS_COMMAND;
  readonly targetRepository: typeof PHASE0_TARGET_REPOSITORY;
}
