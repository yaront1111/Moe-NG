import type { BootstrapRefusedBy } from "../bootstrap/bootstrap-contracts.js";
import type { ControlledProfileRefusalCode } from "./controlled-profile/controlled-profile-generator.js";
import type { GitRunner, GitRunResult } from "./git-landing-port.js";

export { BOOTSTRAP_PROFILE_VERSION_UNKNOWN } from "./controlled-profile/controlled-profile-generator.js";
/** The wired command kind. Named ONCE here so the vocabulary, the bootstrap sequence and the
 *  async registry entry cannot drift apart on a hand-typed literal. */
export const REPOSITORY_BOOTSTRAP_COMMAND_KIND = "repository.bootstrap" as const;
export const BOOTSTRAP_DIR_NOT_EMPTY = "BOOTSTRAP_DIR_NOT_EMPTY" as const;
export const BOOTSTRAP_GIT_UNAVAILABLE = "BOOTSTRAP_GIT_UNAVAILABLE" as const;
export const BOOTSTRAP_GH_UNAVAILABLE = "BOOTSTRAP_GH_UNAVAILABLE" as const;
export const BOOTSTRAP_RECEIPT_VERSION = "moe-bootstrap-receipt/1" as const;

export type BootstrapCode = ControlledProfileRefusalCode
  | typeof BOOTSTRAP_DIR_NOT_EMPTY | typeof BOOTSTRAP_GIT_UNAVAILABLE | typeof BOOTSTRAP_GH_UNAVAILABLE
  | "BOOTSTRAP_DIR_INVALID" | "BOOTSTRAP_TREE_PATH_INVALID" | "BOOTSTRAP_TREE_WRITE_FAILED"
  | "BOOTSTRAP_PAYLOAD_INVALID" | "BOOTSTRAP_BIND_FAILED" | "BOOTSTRAP_CATALOG_FAILED";

// Closed diagnostics: never copy exception messages, stdout/stderr, URLs or request data.
export type BootstrapDetail = "PROFILE_UNKNOWN" | "PRODUCT_NAME_INVALID" | "DIRECTORY_NOT_EMPTY"
  | "DIRECTORY_INVALID" | "TREE_PATH_INVALID" | "TREE_WRITE_FAILED" | "GIT_EXECUTABLE_UNAVAILABLE"
  | "GIT_COMMAND_FAILED" | "GIT_SHA_INVALID" | "GH_EXECUTABLE_ABSENT" | "GITHUB_REFUSED"
  | "GH_EXECUTION_FAILED" | "REMOTE_URL_REJECTED" | "GITHUB_REQUEST_INVALID"
  | "BIND_FAILED_LOCAL_REPOSITORY_RETAINED" | "CATALOG_FAILED_LOCAL_REPOSITORY_RETAINED";

export interface BootstrapRefusal {
  readonly code: BootstrapCode;
  readonly detail: BootstrapDetail;
  readonly refusedBy: BootstrapRefusedBy;
}

interface BootstrapReceiptBase {
  readonly decidedAt: string;
  readonly dir: string;
  readonly version: typeof BOOTSTRAP_RECEIPT_VERSION;
  /** Optional GitHub failure is independent of the local outcome/null-pair. */
  readonly githubRefusal: BootstrapRefusal | null;
}

export type BootstrapReceiptV1 = BootstrapReceiptBase & (
  | { readonly outcome: "BOOTSTRAPPED"; readonly sha: string; readonly remoteUrl: string | null;
      readonly refusal: null }
  | { readonly outcome: "REFUSED"; readonly sha: null; readonly remoteUrl: null;
      readonly refusal: BootstrapRefusal }
);

export interface BootstrapGithubRequest {
  readonly owner: string;
  readonly name: string;
  readonly visibility: "private" | "public" | "internal";
}

export function isBootstrapGithubRequest(request: unknown): request is BootstrapGithubRequest {
  if (typeof request !== "object" || request === null || Array.isArray(request)) return false;
  const fields = request as Record<string, unknown>;
  return typeof fields["owner"] === "string" && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(fields["owner"])
    && typeof fields["name"] === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(fields["name"])
    && typeof fields["visibility"] === "string" && ["private", "public", "internal"].includes(fields["visibility"]);
}

export interface BootstrapRequest {
  readonly projectId: string;
  readonly productName: string;
  readonly profileVersion: string;
  readonly dir: string;
  readonly github?: BootstrapGithubRequest;
}

export type BootstrapPortResult<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly refusal: BootstrapRefusal };

/** Same argv/stdin seam as GitRunner; absence is explicit, never inferred from stderr. */
export type GhRunner = (...args: Parameters<GitRunner>) =>
  Promise<GitRunResult & { readonly executableAbsent: boolean }>;

export interface TreeWriterPort {
  prepare(dir: string): Promise<BootstrapPortResult<{ readonly dir: string }>>;
  write(dir: string, files: ReadonlyMap<string, string>): Promise<BootstrapPortResult<object>>;
}

export interface BootstrapGitPort {
  commit(dir: string): Promise<BootstrapPortResult<{ readonly sha: string }>>;
}

export interface BootstrapGhPort {
  create(dir: string, request: BootstrapGithubRequest):
    Promise<BootstrapPortResult<{ readonly remoteUrl: string }>>;
}

export interface BootstrapRepository {
  readonly projectId: string;
  readonly productName: string;
  readonly dir: string;
  readonly sha: string;
  /** Only canonical HTTPS github.com owner/name URLs are admitted by the service. */
  readonly remoteUrl: string | null;
}

/** Parent composes existing bindRepository after durable project.register, never a second reducer.
 * Implementations must throw on refusal, not resolve a discarded refusal result. */
export type RepositoryBoundPort = (repository: BootstrapRepository) => Promise<void>;
export type CatalogRegistrationPort = (repository: BootstrapRepository) => Promise<void>;

export interface BootstrapPorts {
  readonly tree: TreeWriterPort;
  readonly git: BootstrapGitPort;
  readonly gh: BootstrapGhPort;
  readonly bindRepository: RepositoryBoundPort;
  readonly registerCatalog: CatalogRegistrationPort;
  readonly now: () => string;
}

export function bootstrapRefusal(code: BootstrapCode, detail: BootstrapDetail): BootstrapRefusal {
  return { code, detail, refusedBy: "DAEMON_INGRESS" };
}
