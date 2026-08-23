/** Pure contract and validation seam for a future human-installed authority record. */

const AUTHORITY_LAYER = "CONFIRMATORY_FREEZE_AUTHORITY" as const;
const AUTHORITY_SCOPE = "CONFIRMATORY_BENCHMARK_CORPUS" as const;
const MAX_RECORD_BYTES = 65_536;

export const CONFIRMATORY_FREEZE_AUTHORITY_CODES = Object.freeze([
  "CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED",
  "CONFIRMATORY_FREEZE_AUTHORITY_MALFORMED",
  "CONFIRMATORY_FREEZE_AUTHORITY_UNREADABLE",
  "CONFIRMATORY_FREEZE_AUTHORITY_STALE",
  "CONFIRMATORY_FREEZE_AUTHORITY_EXPIRED",
  "CONFIRMATORY_FREEZE_AUTHORITY_REVOKED",
  "CONFIRMATORY_FREEZE_AUTHORITY_FOREIGN_SCOPE",
  "CONFIRMATORY_FREEZE_AUTHORITY_CONFLICTING_DUPLICATE",
] as const);

export type ConfirmatoryFreezeAuthorityCode =
  (typeof CONFIRMATORY_FREEZE_AUTHORITY_CODES)[number];

export interface ConfirmatoryFreezeAuthorityRecord {
  readonly schemaVersion: 1;
  readonly scope: string;
  readonly scopeReference: string;
  readonly independentAuthor: string;
  readonly custodian: string;
  readonly allowedViewers: readonly string[];
  readonly restrictedArtifactBoundary: string;
  readonly separationFromImplementers: string;
  readonly signatureAlgorithm: string;
  readonly signatureEncoding: string;
  readonly signerKeyId: string;
  readonly trustedPublicKeyDistribution: string;
  readonly keyRotation: string;
  readonly canonicalBytesCovered: string;
  readonly issuedAt: string;
  readonly timestampSemantics: string;
  readonly publicRegistryReference: string;
  readonly registrySemantics: string;
  readonly redactionRules: string;
  readonly staleAfter: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface ConfirmatoryFreezeAuthorityGrant {
  readonly authority: typeof AUTHORITY_LAYER;
  readonly ok: true;
  readonly record: ConfirmatoryFreezeAuthorityRecord;
}

export interface ConfirmatoryFreezeAuthorityValidationRefusal {
  readonly authority: "NONE";
  readonly code: ConfirmatoryFreezeAuthorityCode;
  readonly layer: typeof AUTHORITY_LAYER;
  readonly ok: false;
}

export type ConfirmatoryFreezeAuthorityValidation =
  | ConfirmatoryFreezeAuthorityGrant
  | ConfirmatoryFreezeAuthorityValidationRefusal;

export type ConfirmatoryFreezeAuthorityRecordSource =
  | Uint8Array
  | readonly Uint8Array[];

const RECORD_KEYS = Object.freeze([
  "allowedViewers", "canonicalBytesCovered", "custodian", "expiresAt", "independentAuthor",
  "issuedAt", "keyRotation", "publicRegistryReference", "redactionRules", "registrySemantics",
  "restrictedArtifactBoundary", "revokedAt", "schemaVersion", "scope", "scopeReference",
  "separationFromImplementers", "signatureAlgorithm", "signatureEncoding", "signerKeyId",
  "staleAfter", "timestampSemantics", "trustedPublicKeyDistribution",
] as const);

const TEXT_KEYS = Object.freeze([
  "canonicalBytesCovered", "custodian", "expiresAt", "independentAuthor", "issuedAt",
  "keyRotation", "publicRegistryReference", "redactionRules", "registrySemantics",
  "restrictedArtifactBoundary", "scope", "scopeReference", "separationFromImplementers",
  "signatureAlgorithm", "signatureEncoding", "signerKeyId", "staleAfter",
  "timestampSemantics", "trustedPublicKeyDistribution",
] as const);

type TextKey = (typeof TEXT_KEYS)[number];
type ParsedRecord = Record<string, unknown> & Record<TextKey, string> & {
  readonly allowedViewers: string[];
  readonly revokedAt: string | null;
  readonly schemaVersion: 1;
};

function refusal(
  code: ConfirmatoryFreezeAuthorityCode,
): ConfirmatoryFreezeAuthorityValidationRefusal {
  return Object.freeze({ authority: "NONE", code, layer: AUTHORITY_LAYER, ok: false });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isByteSourceList(value: unknown): value is readonly Uint8Array[] {
  return Array.isArray(value) && value.every((entry) => entry instanceof Uint8Array);
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === RECORD_KEYS.length
    && actual.every((key, index) => key === RECORD_KEYS[index]);
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1_024;
}

function isIsoTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function hasRecordForm(value: Record<string, unknown>): value is ParsedRecord {
  if (!hasExactKeys(value) || value["schemaVersion"] !== 1) return false;
  if (!TEXT_KEYS.every((key) => isBoundedText(value[key]))) return false;
  const viewers = value["allowedViewers"];
  if (!Array.isArray(viewers) || viewers.length === 0 || !viewers.every(isBoundedText)) return false;
  if (new Set(viewers).size !== viewers.length) return false;
  const revokedAt = value["revokedAt"];
  if (revokedAt !== null && !isBoundedText(revokedAt)) return false;
  return [value["issuedAt"], value["staleAfter"], value["expiresAt"], revokedAt]
    .filter((entry): entry is string => entry !== null)
    .every(isIsoTimestamp);
}

function normalizeRecord(value: ParsedRecord): ConfirmatoryFreezeAuthorityRecord {
  return Object.freeze({
    schemaVersion: 1,
    scope: value.scope,
    scopeReference: value.scopeReference,
    independentAuthor: value.independentAuthor,
    custodian: value.custodian,
    allowedViewers: Object.freeze([...value.allowedViewers]),
    restrictedArtifactBoundary: value.restrictedArtifactBoundary,
    separationFromImplementers: value.separationFromImplementers,
    signatureAlgorithm: value.signatureAlgorithm,
    signatureEncoding: value.signatureEncoding,
    signerKeyId: value.signerKeyId,
    trustedPublicKeyDistribution: value.trustedPublicKeyDistribution,
    keyRotation: value.keyRotation,
    canonicalBytesCovered: value.canonicalBytesCovered,
    issuedAt: value.issuedAt,
    timestampSemantics: value.timestampSemantics,
    publicRegistryReference: value.publicRegistryReference,
    registrySemantics: value.registrySemantics,
    redactionRules: value.redactionRules,
    staleAfter: value.staleAfter,
    expiresAt: value.expiresAt,
    revokedAt: value.revokedAt,
  });
}

function decodeRecord(bytes: Uint8Array): ConfirmatoryFreezeAuthorityRecord
  | ConfirmatoryFreezeAuthorityValidationRefusal {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return refusal("CONFIRMATORY_FREEZE_AUTHORITY_MALFORMED");
  }
  if (!isObject(decoded)) return refusal("CONFIRMATORY_FREEZE_AUTHORITY_MALFORMED");
  if (decoded["schemaVersion"] !== 1) {
    return refusal("CONFIRMATORY_FREEZE_AUTHORITY_UNREADABLE");
  }
  if (!hasRecordForm(decoded)) return refusal("CONFIRMATORY_FREEZE_AUTHORITY_MALFORMED");
  const issued = Date.parse(decoded.issuedAt);
  const stale = Date.parse(decoded.staleAfter);
  const expires = Date.parse(decoded.expiresAt);
  if (!(issued < stale && stale < expires)) {
    return refusal("CONFIRMATORY_FREEZE_AUTHORITY_MALFORMED");
  }
  return normalizeRecord(decoded);
}

function semanticResult(
  record: ConfirmatoryFreezeAuthorityRecord,
): ConfirmatoryFreezeAuthorityValidation {
  if (record.scope !== AUTHORITY_SCOPE) {
    return refusal("CONFIRMATORY_FREEZE_AUTHORITY_FOREIGN_SCOPE");
  }
  if (record.revokedAt !== null) return refusal("CONFIRMATORY_FREEZE_AUTHORITY_REVOKED");
  const now = Date.now();
  if (now >= Date.parse(record.expiresAt)) {
    return refusal("CONFIRMATORY_FREEZE_AUTHORITY_EXPIRED");
  }
  if (now >= Date.parse(record.staleAfter)) {
    return refusal("CONFIRMATORY_FREEZE_AUTHORITY_STALE");
  }
  return Object.freeze({ authority: AUTHORITY_LAYER, ok: true, record });
}

function isRefusal(
  value: ConfirmatoryFreezeAuthorityRecord | ConfirmatoryFreezeAuthorityValidationRefusal,
): value is ConfirmatoryFreezeAuthorityValidationRefusal {
  return "ok" in value && value.ok === false;
}

export function validateConfirmatoryFreezeAuthorityRecord(
  source: ConfirmatoryFreezeAuthorityRecordSource,
): ConfirmatoryFreezeAuthorityValidation {
  if (!(source instanceof Uint8Array) && !isByteSourceList(source)) {
    return refusal("CONFIRMATORY_FREEZE_AUTHORITY_MALFORMED");
  }
  const sources: readonly Uint8Array[] = source instanceof Uint8Array ? [source] : source;
  if (sources.length === 0 || sources.some((bytes) => bytes.byteLength === 0)) {
    return refusal("CONFIRMATORY_FREEZE_AUTHORITY_UNASSIGNED");
  }
  if (sources.some((bytes) => bytes.byteLength > MAX_RECORD_BYTES)) {
    return refusal("CONFIRMATORY_FREEZE_AUTHORITY_MALFORMED");
  }
  const records: ConfirmatoryFreezeAuthorityRecord[] = [];
  for (const bytes of sources) {
    const decoded = decodeRecord(bytes);
    if (isRefusal(decoded)) return decoded;
    records.push(decoded);
  }
  const scopes = records.map((record) => record.scope);
  if (new Set(scopes).size !== scopes.length) {
    return refusal("CONFIRMATORY_FREEZE_AUTHORITY_CONFLICTING_DUPLICATE");
  }
  if (records.length !== 1) return refusal("CONFIRMATORY_FREEZE_AUTHORITY_FOREIGN_SCOPE");
  return semanticResult(records[0]!);
}
