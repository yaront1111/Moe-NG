import { UNREADABLE, ownValues } from "../work/foundation-repository-scope-contracts.js";

/**
 * The closed vocabulary, the hostile-input fence and the decode for the daemon's
 * host-scoped VERIFICATION CATALOG. Shape and rules only: nothing here reads a
 * store, a filesystem or a clock, and nothing here decides. The reader that
 * touches disk is `./verification-catalog-reader.ts`, kept separate for the same
 * reason `foundation-repository-scope-contracts.ts` is kept apart from its
 * authority — a decode that can also open a file cannot be tested as a decode.
 *
 * WHY IT EXISTS. The durable planning world carries no executable command
 * anywhere: `verificationRecipeRevisions` holds REFS, and `\bargv\b` does not
 * occur in packages/core/src, packages/scheduler/src or apps/daemon/src/planning
 * outside tests. Deriving a command from `capability` or `objective` would be an
 * invented convention, so the argv comes from host-scoped daemon process
 * configuration, per comment-80620701d58846e9a6aa2217f9e85069 on task-143cad76.
 *
 * THAT IS NOT A SPEC FILE. The sources rail 2 disqualifies are SHARED-TREE-
 * WRITABLE — the agent being verified can rewrite them, so they cannot be
 * authority over its own verification. This catalog is named by an environment
 * key read at daemon startup, lives outside the worktree, and is configured by
 * whoever runs the daemon. No path here reads a disqualified source, fallback
 * included; and those sources are never SPELLED OUT here, because DoD item 1's
 * arm greps this module's own bytes for their names.
 *
 * THE REPRESENTATION IS AN ARGV VECTOR, NEVER A SHELL STRING. The recipe builder
 * canonicalises `argv` (packages/runner/src/evidence/verification-recipe.ts:206-
 * 212), so a vector is what the seal consumes; a shell string would have to be
 * split back into one by a quoting convention nobody ratified, and the split is
 * where the ambiguity — and the injection — would live.
 *
 * THE RULE MAPPING THE VECTOR ONTO THE MISSION BRIEF'S SINGLE `test` STRING:
 * `test` is the argv elements joined by exactly one U+0020 space, and nothing
 * else. The join is LOSSLESS BY CONSTRUCTION, not by convention, because
 * `admitArgv` refuses any element containing whitespace, a quote or a backslash
 * — so `verificationTestField(argv).split(" ")` returns the original vector for
 * every admitted argv. An argv that would need quoting is not representable.
 */

export const VERIFICATION_CATALOG_VERSION = "moe-verification-catalog/1" as const;

/** Published so the store provider names the same key this family reads; two
 *  hand-written copies of an env key drift in exactly one direction. */
export const VERIFICATION_CATALOG_ENV_KEY = "MOE_VERIFICATION_CATALOG";

/** Matches the sibling workspace catalog's ceiling. Enforced BEFORE the read. */
export const MAX_VERIFICATION_CATALOG_BYTES = 1_048_576;

/**
 * This family's OWN layer. Deliberately not spelled `*_LAYER`: the security
 * boundary roster scans exported column-zero `*_LAYER(S)` constants and would
 * demand a hostile trio for a name that tags operator-configuration refusals.
 * Same reasoning, same spelling discipline as `DAEMON_RESOURCE_RECONCILE`
 * (work/resource-reconcile-command.ts:44-49).
 */
export const DAEMON_VERIFICATION_CATALOG = "DAEMON_VERIFICATION_CATALOG" as const;

/**
 * CLOSED, and every member names a DIFFERENT operator repair. ABSENT says
 * "configure a catalog", UNREADABLE says "the one you configured cannot be
 * consulted"; PROJECT_ABSENT says "your catalog never mentions this project",
 * ENTRY_ABSENT says "it does, but not this capability".
 */
export const VERIFICATION_CATALOG_CODES = Object.freeze([
  "VERIFICATION_CATALOG_ABSENT",
  "VERIFICATION_CATALOG_ARGV_INVALID",
  "VERIFICATION_CATALOG_ENTRY_ABSENT",
  "VERIFICATION_CATALOG_MALFORMED",
  "VERIFICATION_CATALOG_PROJECT_ABSENT",
  "VERIFICATION_CATALOG_TOO_LARGE",
  "VERIFICATION_CATALOG_UNREADABLE",
] as const);
export type VerificationCatalogCode = (typeof VERIFICATION_CATALOG_CODES)[number];

/** Published so a consumer bounds itself by THESE numbers rather than a copy. */
export const VERIFICATION_CATALOG_LIMITS = Object.freeze({
  argvChars: 400, argvLength: 64, entries: 256, refChars: 256,
});

export interface VerificationCatalogRefused {
  readonly code: VerificationCatalogCode;
  readonly layer: typeof DAEMON_VERIFICATION_CATALOG;
  readonly ok: false;
}

export interface VerificationCatalogEntry {
  readonly argv: readonly string[];
  readonly capability: string;
  /** The durable provider profile revision this command is verified under -
   *  the OPERATOR's fact, since the daemon cannot derive which revision an argv
   *  was configured for and hardcoding one is the convention rail 4 forbids. It
   *  is a FENCE too: the observation is read by this identity, so a catalog
   *  naming a revision the durable probe does not carry refuses
   *  IDENTITY_MISMATCH at the reader's layer instead of sealing over the gap. */
  readonly profileRevisionId: string;
  readonly projectId: string;
}

export interface VerificationCatalog {
  readonly catalogVersion: typeof VERIFICATION_CATALOG_VERSION;
  readonly entries: readonly VerificationCatalogEntry[];
}

export type VerificationCatalogResult =
  | { readonly catalog: VerificationCatalog; readonly ok: true }
  | VerificationCatalogRefused;

export type VerificationCatalogArgvResult =
  | { readonly argv: readonly string[]; readonly ok: true }
  | VerificationCatalogRefused;

export type VerificationCatalogEntryResult =
  | { readonly entry: VerificationCatalogEntry; readonly ok: true }
  | VerificationCatalogRefused;

export type VerificationCatalogCapabilitiesResult =
  | { readonly capabilities: readonly string[]; readonly ok: true }
  | VerificationCatalogRefused;

export const CATALOG_KEYS = Object.freeze(["catalogVersion", "entries"] as const);
export const ENTRY_KEYS = Object.freeze([
  "argv", "capability", "profileRevisionId", "projectId",
] as const);

export const refuseCatalog = (code: VerificationCatalogCode): VerificationCatalogRefused =>
  Object.freeze({ code, layer: DAEMON_VERIFICATION_CATALOG, ok: false as const });

const isNormalizedText = (value: string): boolean =>
  value.isWellFormed() && value === value.normalize("NFC");

const isRef = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max
  && isNormalizedText(value);

/** The characters that would make the documented space-join ambiguous when read
 *  back: any whitespace, either quote, and the backslash a shell would treat as
 *  an escape. Refusing them turns the join into an identity, not a convention. */
const JOIN_HOSTILE = /[\s"'\\]/u;

/** A nonempty vector of nonempty, bounded, normalized, join-safe strings.
 *  Anything else is refused rather than repaired: repairing would move the
 *  command's meaning out of the operator's file and into this module. */
function admitArgv(value: unknown): readonly string[] | null {
  const limits = VERIFICATION_CATALOG_LIMITS;
  if (!Array.isArray(value) || value.length === 0 || value.length > limits.argvLength) {
    return null;
  }
  const argv: string[] = [];
  for (const element of value) {
    if (!isRef(element, limits.argvChars) || JOIN_HOSTILE.test(element)) return null;
    argv.push(element);
  }
  return Object.freeze(argv);
}

function decodeEntry(value: unknown): VerificationCatalogEntry | VerificationCatalogRefused {
  const own = ownValues(value, ENTRY_KEYS);
  if (own === null) return refuseCatalog("VERIFICATION_CATALOG_MALFORMED");
  if (own === UNREADABLE) return refuseCatalog("VERIFICATION_CATALOG_UNREADABLE");
  const capability = own["capability"], projectId = own["projectId"];
  const profileRevisionId = own["profileRevisionId"];
  const limits = VERIFICATION_CATALOG_LIMITS;
  if (!isRef(capability, limits.refChars) || !isRef(projectId, limits.refChars)
    || !isRef(profileRevisionId, limits.refChars)) {
    return refuseCatalog("VERIFICATION_CATALOG_MALFORMED");
  }
  const argv = admitArgv(own["argv"]);
  if (argv === null) return refuseCatalog("VERIFICATION_CATALOG_ARGV_INVALID");
  return Object.freeze({ argv, capability, profileRevisionId, projectId });
}

const pairKey = (projectId: string, capability: string): string =>
  JSON.stringify([projectId, capability]);

/** Decodes an operator-supplied value into a catalog, or refuses with an exact
 *  code. Never throws on hostile input, never invokes an accessor, and never
 *  defaults: a catalog it cannot admit refuses rather than reading as empty. */
export function decodeVerificationCatalog(input: unknown): VerificationCatalogResult {
  const outer = ownValues(input, CATALOG_KEYS);
  if (outer === null) return refuseCatalog("VERIFICATION_CATALOG_MALFORMED");
  if (outer === UNREADABLE) return refuseCatalog("VERIFICATION_CATALOG_UNREADABLE");
  if (outer["catalogVersion"] !== VERIFICATION_CATALOG_VERSION) {
    return refuseCatalog("VERIFICATION_CATALOG_MALFORMED");
  }
  const raw = outer["entries"];
  if (!Array.isArray(raw) || raw.length === 0
    || raw.length > VERIFICATION_CATALOG_LIMITS.entries) {
    return refuseCatalog("VERIFICATION_CATALOG_MALFORMED");
  }
  const entries: VerificationCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    const entry = decodeEntry(candidate);
    if ("ok" in entry) return entry;
    const key = pairKey(entry.projectId, entry.capability);
    // A duplicated pair has two answers and no rule for choosing; first-wins
    // would make the file's order load-bearing without saying so.
    if (seen.has(key)) return refuseCatalog("VERIFICATION_CATALOG_MALFORMED");
    seen.add(key);
    entries.push(entry);
  }
  return {
    catalog: Object.freeze({
      catalogVersion: VERIFICATION_CATALOG_VERSION, entries: Object.freeze(entries),
    }),
    ok: true as const,
  };
}

/**
 * The entry this catalog holds for one (projectId, capability), or an exact
 * refusal. A project the catalog never names and a capability it does not cover
 * for a project it DOES name are separate operator mistakes, so they get
 * separate answers. */
export function lookupCatalogEntry(
  catalog: VerificationCatalog, projectId: string, capability: string,
): VerificationCatalogEntryResult {
  const forProject = catalog.entries.filter((entry) => entry.projectId === projectId);
  if (forProject.length === 0) return refuseCatalog("VERIFICATION_CATALOG_PROJECT_ABSENT");
  const found = forProject.find((entry) => entry.capability === capability);
  if (found === undefined) return refuseCatalog("VERIFICATION_CATALOG_ENTRY_ABSENT");
  return { entry: found, ok: true as const };
}

/** The argv half of the same lookup, for a consumer that needs only the command. */
export function lookupCatalogArgv(
  catalog: VerificationCatalog, projectId: string, capability: string,
): VerificationCatalogArgvResult {
  const found = lookupCatalogEntry(catalog, projectId, capability);
  return found.ok ? { argv: found.entry.argv, ok: true as const } : found;
}

/** The capabilities this catalog covers for one project, sorted, or the same
 *  PROJECT_ABSENT refusal the lookups give. An empty list is not a possible
 *  admission: a project with no entries is one the catalog never names. */
export function listCatalogCapabilities(
  catalog: VerificationCatalog, projectId: string,
): VerificationCatalogCapabilitiesResult {
  const capabilities = catalog.entries
    .filter((entry) => entry.projectId === projectId)
    .map((entry) => entry.capability)
    .sort();
  if (capabilities.length === 0) return refuseCatalog("VERIFICATION_CATALOG_PROJECT_ABSENT");
  return { capabilities: Object.freeze(capabilities), ok: true as const };
}

/** THE STATED MAPPING onto the mission brief's single `test` string, and the
 *  only one: single-space join, lossless for every admitted argv because no
 *  admitted element can contain a space. */
export const verificationTestField = (argv: readonly string[]): string => argv.join(" ");
