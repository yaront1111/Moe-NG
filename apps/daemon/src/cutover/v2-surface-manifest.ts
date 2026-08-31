import { createHash } from "node:crypto";

import {
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_COMMAND_KINDS,
  RUNTIME_ERROR_REGISTRY_VERSION,
  RUNTIME_QUERY_ENVELOPE_VERSION,
  decodeBoundedJsonBytes,
} from "@moe/contracts";
import type { RuntimeCommandKind } from "@moe/contracts";

import {
  PLANNING_SUBMIT_DECOMPOSITION_COMMAND_KIND,
  PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND,
  PRODUCT_CONTRACT_ASK_CLARIFICATION_COMMAND_KIND,
  PRODUCT_CONTRACT_PROPOSE_REVISION_COMMAND_KIND,
} from "../product-contract/product-contract-command-contracts.js";
import { PRODUCT_CONTRACT_GATE_1_COMMAND_KIND } from
  "../product-contract/product-contract-gate-1-contract.js";

export const V2_SURFACE_MANIFEST_SCHEMA_VERSION = "moe-v2-surface-manifest/1" as const;
export const V2_SURFACE_MANIFEST_LAYER = "DAEMON_V2_SURFACE_MANIFEST" as const;
export const MAX_V2_MUTATION_COMMAND_KINDS = 32 as const;

export const V2_SURFACE_MANIFEST_CODES = Object.freeze([
  "V2_SURFACE_MANIFEST_INVALID",
  "V2_SURFACE_MANIFEST_NONCANONICAL",
  "V2_SURFACE_MANIFEST_ROSTER_INVALID",
] as const);
export type V2SurfaceManifestCode = (typeof V2_SURFACE_MANIFEST_CODES)[number];

/**
 * The commands that belong to the new Product Contract/compiler authority plane. This is not
 * the global runtime vocabulary: legacy commands stay available to forensic/read compatibility
 * paths and do not become v2-authoritative merely because they exist in a shared tuple.
 */
export const V2_MUTATION_COMMAND_KINDS = Object.freeze([
  PLANNING_SUBMIT_DECOMPOSITION_COMMAND_KIND,
  PRODUCT_CONTRACT_ANSWER_CLARIFICATION_COMMAND_KIND,
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
  PRODUCT_CONTRACT_ASK_CLARIFICATION_COMMAND_KIND,
  PRODUCT_CONTRACT_PROPOSE_REVISION_COMMAND_KIND,
] as const satisfies readonly RuntimeCommandKind[]);

export type V2MutationCommandKind = (typeof V2_MUTATION_COMMAND_KINDS)[number];

export const V2_SURFACE_MANIFEST_KEYS = Object.freeze([
  "commandEnvelopeVersion",
  "errorRegistryVersion",
  "mutationCommandKinds",
  "queryEnvelopeVersion",
  "schemaVersion",
] as const);

export interface V2SurfaceManifest {
  readonly commandEnvelopeVersion: typeof RUNTIME_COMMAND_ENVELOPE_VERSION;
  readonly errorRegistryVersion: typeof RUNTIME_ERROR_REGISTRY_VERSION;
  readonly mutationCommandKinds: readonly V2MutationCommandKind[];
  readonly queryEnvelopeVersion: typeof RUNTIME_QUERY_ENVELOPE_VERSION;
  readonly schemaVersion: typeof V2_SURFACE_MANIFEST_SCHEMA_VERSION;
}

export interface V2SurfaceManifestRefused {
  readonly code: V2SurfaceManifestCode;
  readonly layer: typeof V2_SURFACE_MANIFEST_LAYER;
  readonly ok: false;
}

export type V2SurfaceManifestResult =
  | { readonly manifest: V2SurfaceManifest; readonly ok: true }
  | V2SurfaceManifestRefused;

function refuse(code: V2SurfaceManifestCode): V2SurfaceManifestRefused {
  return Object.freeze({ code, layer: V2_SURFACE_MANIFEST_LAYER, ok: false as const });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

const GLOBAL_COMMANDS: ReadonlySet<string> = new Set(RUNTIME_COMMAND_KINDS);

function exactV2Roster(value: unknown): value is readonly V2MutationCommandKind[] {
  if (!Array.isArray(value) || value.length === 0
    || value.length > MAX_V2_MUTATION_COMMAND_KINDS) return false;
  if (!value.every((kind) => typeof kind === "string" && GLOBAL_COMMANDS.has(kind))) return false;
  if (new Set(value).size !== value.length || value.length !== V2_MUTATION_COMMAND_KINDS.length) {
    return false;
  }
  return V2_MUTATION_COMMAND_KINDS.every((kind, index) => value[index] === kind);
}

export const V2_SURFACE_MANIFEST: V2SurfaceManifest = Object.freeze({
  commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
  errorRegistryVersion: RUNTIME_ERROR_REGISTRY_VERSION,
  mutationCommandKinds: V2_MUTATION_COMMAND_KINDS,
  queryEnvelopeVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
  schemaVersion: V2_SURFACE_MANIFEST_SCHEMA_VERSION,
});

/** Fixed field and roster order: these bytes are a release pin, not display JSON. */
export function encodeV2SurfaceManifest(manifest: V2SurfaceManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    commandEnvelopeVersion: manifest.commandEnvelopeVersion,
    errorRegistryVersion: manifest.errorRegistryVersion,
    mutationCommandKinds: [...manifest.mutationCommandKinds],
    queryEnvelopeVersion: manifest.queryEnvelopeVersion,
    schemaVersion: manifest.schemaVersion,
  }));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function decodeV2SurfaceManifest(bytes: unknown): V2SurfaceManifestResult {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok || !exactKeys(decoded.value, V2_SURFACE_MANIFEST_KEYS)) {
    return refuse("V2_SURFACE_MANIFEST_INVALID");
  }
  const value = decoded.value;
  if (!exactV2Roster(value["mutationCommandKinds"])) {
    return refuse("V2_SURFACE_MANIFEST_ROSTER_INVALID");
  }
  if (value["commandEnvelopeVersion"] !== RUNTIME_COMMAND_ENVELOPE_VERSION
    || value["errorRegistryVersion"] !== RUNTIME_ERROR_REGISTRY_VERSION
    || value["queryEnvelopeVersion"] !== RUNTIME_QUERY_ENVELOPE_VERSION
    || value["schemaVersion"] !== V2_SURFACE_MANIFEST_SCHEMA_VERSION) {
    return refuse("V2_SURFACE_MANIFEST_INVALID");
  }
  const manifest: V2SurfaceManifest = Object.freeze({
    commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    errorRegistryVersion: RUNTIME_ERROR_REGISTRY_VERSION,
    mutationCommandKinds: V2_MUTATION_COMMAND_KINDS,
    queryEnvelopeVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
    schemaVersion: V2_SURFACE_MANIFEST_SCHEMA_VERSION,
  });
  if (!(bytes instanceof Uint8Array) || !sameBytes(bytes, encodeV2SurfaceManifest(manifest))) {
    return refuse("V2_SURFACE_MANIFEST_NONCANONICAL");
  }
  return Object.freeze({ manifest, ok: true as const });
}

export const V2_SURFACE_MANIFEST_SHA256 = createHash("sha256")
  .update(encodeV2SurfaceManifest(V2_SURFACE_MANIFEST))
  .digest("hex");
