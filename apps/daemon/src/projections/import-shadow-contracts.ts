import type { ImportEventRefusalCode, ImportRefusalLayer, ShadowComparison, ShadowProjection } from "@moe/import";
import type { StoredEvent } from "@moe/store";

/**
 * The vocabulary the daemon's import-shadow read answers in.
 *
 * Split out of `import-shadow-reader.ts` for the per-file line rail alone; it is one seam
 * with the reader and the mapper, published together through the daemon root.
 *
 * TWO LAYERS CAN REFUSE HERE, and which one answered is itself information. A refusal that
 * `@moe/import`'s decoder raised keeps its OWN `IMPORT_EVENT_*` code and its OWN
 * `ImportRefusalLayer` verbatim; only a fact the DAEMON itself could not establish carries
 * an `IMPORT_SHADOW_*` code at {@link IMPORT_SHADOW_READ_LAYER}. Restamping an upstream code
 * into a local one would make malformed bytes indistinguishable from an unsupported schema
 * and leave two vocabularies to drift apart.
 *
 * NOTHING HERE CAN WRITE. {@link ImportShadowStorePort} declares two readers and no commit,
 * no apply and no outbox, so "this adapter never mutates or activates anything" is a
 * property of the type rather than a rule to remember. Every result carries
 * `advisoryOnly: true` and `authority: "NONE"` on BOTH arms.
 */

/** The daemon is not an `ImportRefusalLayer`; naming its own layer keeps the two distinct. */
export const IMPORT_SHADOW_READ_LAYER = "DAEMON_IMPORT_SHADOW" as const;

export type ImportShadowReadLayer = typeof IMPORT_SHADOW_READ_LAYER;

/** Every code has a planned emitter; an unreachable code is a claim no test can pin. */
export const IMPORT_SHADOW_REFUSAL_CODES = Object.freeze([
  "IMPORT_SHADOW_ABSENT",
  "IMPORT_SHADOW_BINDING_MISMATCH",
  "IMPORT_SHADOW_EVENT_UNSUPPORTED",
  "IMPORT_SHADOW_EVIDENCE_MALFORMED",
  "IMPORT_SHADOW_HORIZON_DRIFT",
  "IMPORT_SHADOW_INPUT_INVALID",
  "IMPORT_SHADOW_LEGACY_UNREADABLE",
  "IMPORT_SHADOW_SCHEMA_UNSUPPORTED",
  "IMPORT_SHADOW_STORE_UNREADABLE",
] as const);

export type ImportShadowRefusalCode = (typeof IMPORT_SHADOW_REFUSAL_CODES)[number];

/**
 * The read-only seam. Declared structurally rather than as `SqliteEventStore` so the
 * adapter cannot reach a writer even by accident, and so a caller may pass any bounded
 * durable reader.
 */
export interface ImportShadowStorePort {
  readEventHorizon(): bigint;
  readEvents(aggregateId: string): readonly StoredEvent[];
}

export interface ImportShadowRequest {
  /** Locates WHICH import. It is never a fact; every fact comes from the durable bytes. */
  readonly manifestDigest: string;
}

/**
 * A refusal carries no `projection` and no `entities` field at all. A partial projection is
 * therefore unrepresentable rather than merely unproduced.
 */
export interface ImportShadowRefused {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
  readonly code: ImportEventRefusalCode | ImportShadowRefusalCode;
  readonly detail: string;
  readonly layer: ImportRefusalLayer | ImportShadowReadLayer;
  readonly ok: false;
}

export interface ImportShadowAccepted {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
  readonly ok: true;
  readonly projection: ShadowProjection;
}

export type ImportShadowRead = ImportShadowAccepted | ImportShadowRefused;

export interface ImportShadowCompared {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
  readonly comparison: ShadowComparison;
  readonly current: ShadowProjection;
  readonly legacy: ShadowProjection;
  readonly ok: true;
}

export type ImportShadowComparison = ImportShadowCompared | ImportShadowRefused;

/** The daemon's own refusal. Upstream refusals are forwarded by {@link forwardRefusal}. */
export function refuseImportShadow(
  code: ImportShadowRefusalCode,
  detail: string,
): ImportShadowRefused {
  return Object.freeze({
    advisoryOnly: true as const,
    authority: "NONE" as const,
    code,
    detail,
    layer: IMPORT_SHADOW_READ_LAYER,
    ok: false as const,
  });
}

/**
 * Wraps an `@moe/import` refusal WITHOUT touching its code or its layer.
 *
 * The advisory envelope is the daemon's; the diagnosis stays the decoder's, so a caller can
 * always tell which layer answered.
 */
export function forwardRefusal(
  refused: Readonly<{ code: ImportEventRefusalCode; detail: string; layer: ImportRefusalLayer }>,
): ImportShadowRefused {
  return Object.freeze({
    advisoryOnly: true as const,
    authority: "NONE" as const,
    code: refused.code,
    detail: refused.detail,
    layer: refused.layer,
    ok: false as const,
  });
}
