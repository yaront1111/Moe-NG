import { createHash } from "node:crypto";

/**
 * The closed vocabulary and the hostile-input fences for the daemon-startup
 * repository/scope catalog. Shape and rules only: nothing here reads a store, a
 * filesystem or a clock, and nothing here decides.
 *
 * TWO LAYERS, NEVER SHARING A CODE. `DAEMON_REPOSITORY_SCOPE_CATALOG` answers
 * for operator configuration; `DAEMON_REPOSITORY_SCOPE_RESOLUTION` answers for
 * durable-state facts. A caller has to be able to tell "your catalog is wrong"
 * from "this project is not bound the way you asked", and one layer would make
 * the `layer` field a constant instead of an answer.
 */

export const FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION =
  "moe-foundation-repository-scope-catalog/1" as const;
export const FOUNDATION_REPOSITORY_SCOPE_DIGEST_DOMAIN =
  "moe-foundation-repository-scope-catalog-digest/1" as const;

export const FOUNDATION_REPOSITORY_SCOPE_LAYERS = Object.freeze([
  "DAEMON_REPOSITORY_SCOPE_CATALOG", "DAEMON_REPOSITORY_SCOPE_RESOLUTION",
] as const);
export type FoundationRepositoryScopeLayer = (typeof FOUNDATION_REPOSITORY_SCOPE_LAYERS)[number];

/**
 * Closed. Every family the design distinguishes gets its own member: an absent
 * fact, an unreadable one and a mismatched one are three different operator
 * actions, and a shared code would make them one.
 */
export const FOUNDATION_REPOSITORY_SCOPE_CODES = Object.freeze([
  "FOUNDATION_REPOSITORY_SCOPE_CATALOG_MALFORMED",
  "FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION_UNSUPPORTED",
  "FOUNDATION_REPOSITORY_SCOPE_CATALOG_ACCESSOR",
  "FOUNDATION_REPOSITORY_SCOPE_ENTRY_MALFORMED",
  "FOUNDATION_REPOSITORY_SCOPE_ENTRY_DUPLICATE",
  "FOUNDATION_REPOSITORY_SCOPE_LIMIT_EXCEEDED",
  "FOUNDATION_REPOSITORY_SCOPE_PATH_NONCANONICAL",
  "FOUNDATION_REPOSITORY_SCOPE_PATH_CASE_COLLISION",
  "FOUNDATION_REPOSITORY_SCOPE_HOST_ROOT_INVALID",
  "FOUNDATION_REPOSITORY_SCOPE_REQUEST_MALFORMED",
  "FOUNDATION_REPOSITORY_SCOPE_CATALOG_DIGEST_MISMATCH",
  "FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_ABSENT",
  "FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_UNREADABLE",
  "FOUNDATION_REPOSITORY_SCOPE_PROJECT_STATE_INVALID",
  "FOUNDATION_REPOSITORY_SCOPE_OBSERVATION_ABSENT",
  "FOUNDATION_REPOSITORY_SCOPE_PROJECT_MISMATCH",
  "FOUNDATION_REPOSITORY_SCOPE_REPOSITORY_MISMATCH",
  "FOUNDATION_REPOSITORY_SCOPE_SCOPE_MISMATCH",
  "FOUNDATION_REPOSITORY_SCOPE_BASE_REVISION_MISMATCH",
  "FOUNDATION_REPOSITORY_SCOPE_ENTRY_ABSENT",
] as const);
export type FoundationRepositoryScopeCode = (typeof FOUNDATION_REPOSITORY_SCOPE_CODES)[number];

/** Published so a consumer bounds itself by THESE numbers rather than a copy. */
export const FOUNDATION_REPOSITORY_SCOPE_LIMITS = Object.freeze({
  declaredPaths: 256, entries: 64, hostRootChars: 260, pathChars: 400, refChars: 256,
});

export interface FoundationRepositoryScopeRefused {
  readonly code: FoundationRepositoryScopeCode;
  readonly layer: FoundationRepositoryScopeLayer;
  readonly ok: false;
}

export interface FoundationRepositoryScopeCatalogEntry {
  readonly declaredPaths: readonly string[];
  readonly projectId: string;
  readonly repositoryRef: string;
  readonly scopeRef: string;
  readonly sourceRepositoryRoot: string;
  readonly worktreeParent: string;
}

export interface FoundationRepositoryScopeCatalog {
  readonly catalogVersion: typeof FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION;
  readonly digest: string;
  readonly entries: readonly FoundationRepositoryScopeCatalogEntry[];
}

export type FoundationRepositoryScopeCatalogResult =
  | { readonly catalog: FoundationRepositoryScopeCatalog; readonly ok: true }
  | FoundationRepositoryScopeRefused;

/**
 * Durable identity only, and that is the point: a cwd, a worktree root, a launch
 * template or a Git changed-path list is UNREPRESENTABLE here rather than merely
 * rejected. Physical facts come from the catalog, never from a caller.
 */
export interface FoundationRepositoryScopeRequest {
  readonly baseRevisionHash: string;
  readonly projectId: string;
  readonly repositoryRef: string;
  readonly scopeRef: string;
}

export interface FoundationRepositoryScopeAuthority {
  readonly baseRevisionHash: string;
  readonly catalogDigest: string;
  readonly declaredPaths: readonly string[];
  readonly projectId: string;
  readonly repositoryRef: string;
  readonly scopeRef: string;
  readonly sourceRepositoryRoot: string;
  readonly worktreeParent: string;
}

export type FoundationRepositoryScopeResult =
  | { readonly authority: FoundationRepositoryScopeAuthority; readonly ok: true }
  | FoundationRepositoryScopeRefused;

export const CATALOG_KEYS = Object.freeze(["catalogVersion", "entries"] as const);
export const ENTRY_KEYS = Object.freeze([
  "declaredPaths", "projectId", "repositoryRef", "scopeRef", "sourceRepositoryRoot",
  "worktreeParent",
] as const);
export const REQUEST_KEYS = Object.freeze([
  "baseRevisionHash", "projectId", "repositoryRef", "scopeRef",
] as const);

export const refuseCatalog = (
  code: FoundationRepositoryScopeCode,
): FoundationRepositoryScopeRefused =>
  Object.freeze({ code, layer: "DAEMON_REPOSITORY_SCOPE_CATALOG" as const, ok: false as const });
export const refuseResolution = (
  code: FoundationRepositoryScopeCode,
): FoundationRepositoryScopeRefused =>
  Object.freeze({ code, layer: "DAEMON_REPOSITORY_SCOPE_RESOLUTION" as const, ok: false as const });

/** Reflection refused, or reflection that threw. Never a value. */
export const UNREADABLE = Symbol("unreadable");

/**
 * Reads the exact key set ONCE, from own data descriptors only. An accessor is
 * refused rather than invoked: a getter that answers one value to validation and
 * another to use is the whole reason a catalog is snapshotted before it is read.
 */
export function ownValues(
  value: unknown, keys: readonly string[],
): Record<string, unknown> | typeof UNREADABLE | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const names = Object.keys(value);
    if (names.length !== keys.length || !keys.every((key) => names.includes(key))) return null;
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return UNREADABLE;
      out[key] = descriptor.value;
    }
    return out;
  } catch { return UNREADABLE; }
}

const isNormalizedText = (value: string): boolean =>
  value.isWellFormed() && value === value.normalize("NFC");

export const isRef = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max
  && isNormalizedText(value);

const RESERVED_DEVICE_STEMS: ReadonlySet<string> = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/**
 * The segment rules a filesystem could reinterpret, transcribed from the
 * runner's canonical fence rather than deep-imported: this package must own the
 * rule it enforces, and a deep relative import across the workspace fails TS6059.
 */
const segmentsInvalid = (segments: readonly string[]): boolean =>
  segments.some((segment) =>
    segment.length === 0 || segment === "." || segment === ".."
    || segment.endsWith(".") || segment.endsWith(" ")
    || RESERVED_DEVICE_STEMS.has((segment.split(".")[0] ?? "").toLowerCase()));

/** Repository-relative, forward-slashed, and never reinterpretable as a root. */
export function isDeclaredPath(value: unknown): value is string {
  if (!isRef(value, FOUNDATION_REPOSITORY_SCOPE_LIMITS.pathChars)) return false;
  if (value.includes("\\") || value.includes(":") || value.startsWith("/")) return false;
  return !segmentsInvalid(value.split("/"));
}

const WINDOWS_ROOT = /^[A-Za-z]:\\/u;

/**
 * One of exactly two spellings — drive-absolute with backslashes, or rooted
 * POSIX with forward slashes. Everything else is refused WITHOUT normalizing:
 * `\\?\`, `\\.\`, UNC, drive-relative `C:x` and mixed separators each resolve to
 * a different object than they read as, and repairing one here would hand this
 * module the very authority it exists to keep in the catalog.
 */
export function isHostRoot(value: unknown): value is string {
  if (!isRef(value, FOUNDATION_REPOSITORY_SCOPE_LIMITS.hostRootChars)) return false;
  if (WINDOWS_ROOT.test(value)) {
    return !value.includes("/") && value.length > 3 && !segmentsInvalid(value.slice(3).split("\\"));
  }
  if (!value.startsWith("/") || value.includes("\\") || value.includes(":")) return false;
  return value.length > 1 && !segmentsInvalid(value.slice(1).split("/"));
}

export const entryKey = (entry: FoundationRepositoryScopeCatalogEntry): string =>
  JSON.stringify([entry.projectId, entry.repositoryRef, entry.scopeRef]);

/**
 * Over EVERY admitted field, under a domain tag, in a fixed field order. The
 * version is folded in from the catalog itself rather than from the constant, so
 * a tampered version moves the digest instead of surviving it.
 */
export function digestOf(catalog: {
  readonly catalogVersion: string;
  readonly entries: readonly FoundationRepositoryScopeCatalogEntry[];
}): string {
  const preimage = JSON.stringify([
    FOUNDATION_REPOSITORY_SCOPE_DIGEST_DOMAIN, catalog.catalogVersion,
    catalog.entries.map((entry) => [
      entry.projectId, entry.repositoryRef, entry.scopeRef, entry.sourceRepositoryRoot,
      entry.worktreeParent, [...entry.declaredPaths],
    ]),
  ]);
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}
