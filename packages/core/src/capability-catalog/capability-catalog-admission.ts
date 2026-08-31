import {
  deepFreeze,
  exact,
  snapshotDataBounded,
  validHex64,
} from "../planning/planning-snapshot.js";
import {
  CAPABILITY_CATALOG_LIMITS,
  CAPABILITY_CATALOG_VERSION,
  capabilityCatalogRefusal,
  type CapabilityCatalogRefusal,
  type CapabilityCatalogRevisionAdmission,
  type CapabilityCatalogRevisionDraft,
  type CapabilityCatalogRevisionDraftAdmission,
} from "./capability-catalog-contract.js";
import { readCapabilityCatalogEntries } from "./capability-catalog-entry-admission.js";
import {
  readCapabilityCatalogLineage,
  readCapabilityCatalogText,
} from "./capability-catalog-value-readers.js";

type ParseResult =
  | Readonly<{
    body: CapabilityCatalogRevisionDraft;
    ok: true;
    revisionDigest?: string;
  }>
  | CapabilityCatalogRefusal;

const DRAFT_KEYS = Object.freeze([
  "catalogId", "entries", "lineage", "revisionId", "sourceCommitSha256",
]);
const FULL_KEYS = Object.freeze([...DRAFT_KEYS, "revisionDigest", "version"]);
const malformed = () => capabilityCatalogRefusal(
  "CAPABILITY_CATALOG_MALFORMED", "CAPABILITY_CATALOG_ADMISSION",
);
const referenceInvalid = () => capabilityCatalogRefusal(
  "CAPABILITY_CATALOG_REFERENCE_INVALID", "CAPABILITY_CATALOG_REFERENCES",
);
const limitExceeded = () => capabilityCatalogRefusal(
  "CAPABILITY_CATALOG_LIMIT_EXCEEDED", "CAPABILITY_CATALOG_LIMITS",
);

function parseRevision(value: unknown, full: boolean): ParseResult {
  const snapshot = snapshotDataBounded(value, {
    maxArrayLength: CAPABILITY_CATALOG_LIMITS.maxEntries,
    maxDepth: CAPABILITY_CATALOG_LIMITS.maxSnapshotDepth,
    maxNodes: CAPABILITY_CATALOG_LIMITS.maxSnapshotNodes,
  });
  if (!snapshot.ok) return snapshot.limitExceeded ? limitExceeded() : malformed();
  if (!exact(snapshot.value, full ? FULL_KEYS : DRAFT_KEYS)) return malformed();
  const record = snapshot.value;
  if (full && record["version"] !== CAPABILITY_CATALOG_VERSION) {
    return capabilityCatalogRefusal(
      "CAPABILITY_CATALOG_VERSION_UNSUPPORTED", "CAPABILITY_CATALOG_VERSION",
    );
  }
  const catalogId = readCapabilityCatalogText(
    record["catalogId"], "CAPABILITY_CATALOG_ADMISSION",
  );
  const revisionId = readCapabilityCatalogText(
    record["revisionId"], "CAPABILITY_CATALOG_ADMISSION",
  );
  if (!catalogId.ok) return catalogId;
  if (!revisionId.ok) return revisionId;
  const lineage = readCapabilityCatalogLineage(record["lineage"], revisionId.value);
  const entries = readCapabilityCatalogEntries(record["entries"]);
  if (!lineage.ok) return lineage;
  if (!entries.ok) return entries;
  if (!validHex64(record["sourceCommitSha256"])) return referenceInvalid();
  const body = Object.freeze({
    catalogId: catalogId.value,
    entries: entries.value,
    lineage: lineage.value,
    revisionId: revisionId.value,
    sourceCommitSha256: record["sourceCommitSha256"],
  });
  if (!full) return Object.freeze({ body, ok: true as const });
  return validHex64(record["revisionDigest"])
    ? Object.freeze({ body, ok: true as const, revisionDigest: record["revisionDigest"] })
    : referenceInvalid();
}

export function admitCapabilityCatalogRevisionDraft(
  value: unknown,
): CapabilityCatalogRevisionDraftAdmission {
  const parsed = parseRevision(value, false);
  return parsed.ok
    ? Object.freeze({ draft: deepFreeze({ ...parsed.body }), ok: true as const })
    : parsed;
}

export function admitCapabilityCatalogRevision(
  value: unknown,
): CapabilityCatalogRevisionAdmission {
  const parsed = parseRevision(value, true);
  if (!parsed.ok) return parsed;
  return Object.freeze({
    ok: true as const,
    revision: deepFreeze({
      ...parsed.body,
      revisionDigest: parsed.revisionDigest!,
      version: CAPABILITY_CATALOG_VERSION,
    }),
  });
}
