export const FREEZE_MANIFEST_SCHEMA_VERSION = "moe-confirmatory-freeze-manifest/1";
export const CONFIRMATORY_FREEZE_MANIFEST_MAX_BYTES = 64 * 1024;

export const CONFIRMATORY_FREEZE_BINDING_KINDS = Object.freeze([
  "DESIGN", "BENCHMARK", "FROZEN_CONSTANTS", "GATE_INVENTORY",
  "COMPARATOR_MODEL_MATCH_MATRIX", "HARDWARE_RUNTIME_IDENTITY", "CORPUS",
  "CONFIGURATION", "ANALYSIS", "PROMPTS", "SCRIPTS", "COHORT",
] as const);

export type ConfirmatoryFreezeBindingKind =
  (typeof CONFIRMATORY_FREEZE_BINDING_KINDS)[number];

export type ConfirmatoryFreezeBinding = {
  readonly kind: ConfirmatoryFreezeBindingKind;
  readonly sha256: string;
};

export type ConfirmatoryFreezeAttestation = {
  readonly status: "UNATTESTED";
  readonly signerKeyId: null;
  readonly publicRegistryReference: null;
};

export type ConfirmatoryFreezeManifest = {
  readonly schemaVersion: typeof FREEZE_MANIFEST_SCHEMA_VERSION;
  readonly projectId: string;
  readonly campaignLabel: string;
  readonly campaignId: string;
  readonly implementationSha: string;
  readonly implementationFrozenAt: string;
  readonly sealedAt: string;
  readonly manifestRegistryRef: string;
  readonly attestation: ConfirmatoryFreezeAttestation;
  readonly bindings: readonly ConfirmatoryFreezeBinding[];
};

export type ConfirmatoryFreezeManifestContractCode =
  | "CONFIRMATORY_FREEZE_MANIFEST_MISSING"
  | "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED"
  | "CONFIRMATORY_FREEZE_MANIFEST_STALE"
  | "CONFIRMATORY_FREEZE_MANIFEST_CONFLICTING";

export type ConfirmatoryFreezeManifestContractRefusal = {
  readonly ok: false;
  readonly code: ConfirmatoryFreezeManifestContractCode;
  readonly layer: "CONFIRMATORY_FREEZE_MANIFEST_CONTRACT";
  readonly message: string;
};

export type ConfirmatoryFreezeManifestDecode =
  | { readonly ok: true; readonly manifest: ConfirmatoryFreezeManifest }
  | ConfirmatoryFreezeManifestContractRefusal;

const TOP_KEYS = Object.freeze([
  "schemaVersion", "projectId", "campaignLabel", "campaignId", "implementationSha",
  "implementationFrozenAt", "sealedAt", "manifestRegistryRef", "attestation", "bindings",
] as const);
const ATTESTATION_KEYS = Object.freeze([
  "status", "signerKeyId", "publicRegistryReference",
] as const);
const BINDING_KEYS = Object.freeze(["kind", "sha256"] as const);
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const REGISTRY_REF = /^sha256:[a-f0-9]{64}$/;

const refusal = (
  code: ConfirmatoryFreezeManifestContractCode,
  message: string,
): ConfirmatoryFreezeManifestContractRefusal => Object.freeze({
  ok: false, code, layer: "CONFIRMATORY_FREEZE_MANIFEST_CONTRACT", message,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isBoundedText = (value: unknown, max = 128): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max &&
  value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

const isCanonicalTime = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const instant = new Date(value);
  return Number.isFinite(instant.valueOf()) && instant.toISOString() === value;
};

const readBindings = (
  value: unknown,
): readonly ConfirmatoryFreezeBinding[] | ConfirmatoryFreezeManifestContractRefusal => {
  if (!Array.isArray(value) || value.length !== CONFIRMATORY_FREEZE_BINDING_KINDS.length) {
    return refusal("CONFIRMATORY_FREEZE_MANIFEST_MALFORMED", "binding roster is incomplete");
  }
  const seen = new Map<string, string>();
  for (const entry of value) {
    if (!isRecord(entry) || !hasExactKeys(entry, BINDING_KEYS) ||
        typeof entry.kind !== "string" || typeof entry.sha256 !== "string" ||
        !SHA256.test(entry.sha256)) {
      return refusal("CONFIRMATORY_FREEZE_MANIFEST_MALFORMED", "binding entry is malformed");
    }
    const prior = seen.get(entry.kind);
    if (prior !== undefined) {
      const code = prior === entry.sha256
        ? "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED"
        : "CONFIRMATORY_FREEZE_MANIFEST_CONFLICTING";
      return refusal(code, "binding kind is duplicated");
    }
    seen.set(entry.kind, entry.sha256);
  }
  const ordered = value.every((entry, index) =>
    (entry as Record<string, unknown>).kind === CONFIRMATORY_FREEZE_BINDING_KINDS[index]);
  if (!ordered) return refusal("CONFIRMATORY_FREEZE_MANIFEST_MALFORMED", "binding roster differs");
  return Object.freeze(value.map((entry) => Object.freeze({
    kind: (entry as Record<string, unknown>).kind as ConfirmatoryFreezeBindingKind,
    sha256: (entry as Record<string, unknown>).sha256 as string,
  })));
};

const readAttestation = (
  value: unknown,
): ConfirmatoryFreezeAttestation | ConfirmatoryFreezeManifestContractRefusal => {
  if (!isRecord(value) || !hasExactKeys(value, ATTESTATION_KEYS) ||
      value.status !== "UNATTESTED" || value.signerKeyId !== null ||
      value.publicRegistryReference !== null) {
    return refusal("CONFIRMATORY_FREEZE_MANIFEST_MALFORMED", "attestation must be UNATTESTED");
  }
  return Object.freeze({ status: "UNATTESTED", signerKeyId: null, publicRegistryReference: null });
};

const rebuildManifest = (
  value: Record<string, unknown>,
): ConfirmatoryFreezeManifest | ConfirmatoryFreezeManifestContractRefusal => {
  if (value.schemaVersion !== FREEZE_MANIFEST_SCHEMA_VERSION) {
    return refusal("CONFIRMATORY_FREEZE_MANIFEST_STALE", "manifest version is not admitted");
  }
  const textOk = isBoundedText(value.projectId) && isBoundedText(value.campaignLabel);
  const hashesOk = typeof value.campaignId === "string" && SHA256.test(value.campaignId) &&
    typeof value.implementationSha === "string" && COMMIT_SHA.test(value.implementationSha) &&
    typeof value.manifestRegistryRef === "string" && REGISTRY_REF.test(value.manifestRegistryRef);
  const timesOk = isCanonicalTime(value.implementationFrozenAt) && isCanonicalTime(value.sealedAt) &&
    Date.parse(value.sealedAt as string) > Date.parse(value.implementationFrozenAt as string);
  if (!textOk || !hashesOk || !timesOk) {
    return refusal("CONFIRMATORY_FREEZE_MANIFEST_MALFORMED", "manifest scalar is malformed");
  }
  const attestation = readAttestation(value.attestation);
  if ("code" in attestation) return attestation;
  const bindings = readBindings(value.bindings);
  if ("code" in bindings) return bindings;
  return Object.freeze({
    schemaVersion: FREEZE_MANIFEST_SCHEMA_VERSION,
    projectId: value.projectId as string,
    campaignLabel: value.campaignLabel as string,
    campaignId: value.campaignId as string,
    implementationSha: value.implementationSha as string,
    implementationFrozenAt: value.implementationFrozenAt as string,
    sealedAt: value.sealedAt as string,
    manifestRegistryRef: value.manifestRegistryRef as string,
    attestation,
    bindings,
  });
};

export const canonicalizeConfirmatoryFreezeManifest = (
  manifest: ConfirmatoryFreezeManifest,
): string => JSON.stringify({
  schemaVersion: manifest.schemaVersion,
  projectId: manifest.projectId,
  campaignLabel: manifest.campaignLabel,
  campaignId: manifest.campaignId,
  implementationSha: manifest.implementationSha,
  implementationFrozenAt: manifest.implementationFrozenAt,
  sealedAt: manifest.sealedAt,
  manifestRegistryRef: manifest.manifestRegistryRef,
  attestation: manifest.attestation,
  bindings: manifest.bindings,
});

export const decodeConfirmatoryFreezeManifest = (
  input: unknown,
): ConfirmatoryFreezeManifestDecode => {
  if (input === undefined || input === null ||
      (input instanceof Uint8Array && input.byteLength === 0)) {
    return refusal("CONFIRMATORY_FREEZE_MANIFEST_MISSING", "manifest bytes are absent");
  }
  if (!(input instanceof Uint8Array) || input.byteLength > CONFIRMATORY_FREEZE_MANIFEST_MAX_BYTES) {
    return refusal("CONFIRMATORY_FREEZE_MANIFEST_MALFORMED", "manifest bytes are malformed");
  }
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    value = JSON.parse(text) as unknown;
  } catch {
    return refusal("CONFIRMATORY_FREEZE_MANIFEST_MALFORMED", "manifest encoding is malformed");
  }
  if (!isRecord(value) || !hasExactKeys(value, TOP_KEYS)) {
    return refusal("CONFIRMATORY_FREEZE_MANIFEST_MALFORMED", "manifest keys are malformed");
  }
  const manifest = rebuildManifest(value);
  if ("code" in manifest) return manifest;
  if (text !== canonicalizeConfirmatoryFreezeManifest(manifest)) {
    return refusal("CONFIRMATORY_FREEZE_MANIFEST_MALFORMED", "manifest is not canonical JSON");
  }
  return Object.freeze({ ok: true, manifest });
};
