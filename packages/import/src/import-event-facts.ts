import { byCodeUnit, canonicalJson, isPlainRecord } from "./canonical-bytes.js";
import { IMPORT_RECORD_VERSION } from "./import-contract.js";
import type {
  ImportProvenance,
  ImportRefusalLayer,
  ImportedClaim,
  LegacyLink,
} from "./import-contract.js";
import { SHADOW_PROJECTION_VERSION } from "./shadow-contract.js";

/**
 * The versioned wire form of a committed legacy import event, and how it is WRITTEN.
 *
 * WHY IT EXISTS. `applyImport` used to write only `canonicalPayload(record)` into the event
 * payload, and the event id is a digest. So the derived claim id, principal, status, source
 * path and link endpoints — everything `projectLegacyImport` reads — were computed, handed
 * back in the report, and then lost the moment the process exited. No later reader could
 * recover them from any committed byte. This is the durable half: the SAME derived facts,
 * canonically encoded, in the same commit.
 *
 * NOTHING HERE ACTIVATES ANYTHING, and that is a property of the FIELD SET rather than a
 * comment. `status` is the `ImportedClaimStatus` union, which has no ACTIVE arm;
 * `evidenceOnly` is the literal `true`; there is no command, script, path or handler field
 * to carry an executable or activation affordance.
 *
 * WHY ITS OWN REFUSAL CODES. `refuseImport` is typed to `ImportRefusalCode`, whose four
 * DECODE codes name facts about SOURCE bytes. Pointing those at EVENT bytes would give one
 * code two subjects and leave an operator unable to tell a corrupt legacy file from a
 * corrupt committed event. The LAYER vocabulary IS shared — these refusals carry `DECODE`
 * from `ImportRefusalLayer`, never a retyped string literal.
 *
 * Split from `import-event-codec.ts` when that module passed the 250-line target, the same
 * way `shadow-contract.ts` was split from `shadow-projection.ts`: the vocabulary, the
 * canonical body and the admission primitives live here; reading hostile bytes back lives
 * there. Split the file, never the task.
 */

/** Bumped when the encoded fact set changes. Declared IN the bytes, never inferred. */
export const IMPORT_EVENT_FACTS_VERSION = "moe-import-event-facts/1" as const;

/** Every code has a planned emitter; an unreachable code is a claim no test can pin. */
export const IMPORT_EVENT_REFUSAL_CODES = Object.freeze([
  "IMPORT_EVENT_BYTES_MALFORMED",
  "IMPORT_EVENT_BYTES_NONCANONICAL",
  "IMPORT_EVENT_FACTS_INCOMPLETE",
  "IMPORT_EVENT_FACTS_UNKNOWN_FIELD",
  "IMPORT_EVENT_IDENTITY_CONFLICT",
  "IMPORT_EVENT_SCHEMA_CONFLICT",
  "IMPORT_EVENT_SCHEMA_UNSUPPORTED",
] as const);

export type ImportEventRefusalCode = (typeof IMPORT_EVENT_REFUSAL_CODES)[number];

export interface ImportEventRefused {
  readonly code: ImportEventRefusalCode;
  readonly detail: string;
  readonly layer: ImportRefusalLayer;
  readonly outcome: "REFUSED";
}

export function refuseImportEvent(
  code: ImportEventRefusalCode,
  layer: ImportRefusalLayer,
  detail: string,
): ImportEventRefused {
  return Object.freeze({ code, detail, layer, outcome: "REFUSED" as const });
}

/** The derived facts one import event carries, plus the canonical source payload. */
export interface ImportEventFacts {
  readonly claim: ImportedClaim;
  readonly links: readonly LegacyLink[];
  readonly payload: Record<string, unknown>;
  readonly recordVersion: typeof IMPORT_RECORD_VERSION;
  readonly schemaVersion: typeof IMPORT_EVENT_FACTS_VERSION;
  readonly shadowVersion: typeof SHADOW_PROJECTION_VERSION;
}

export interface ImportEventFactsInput {
  readonly claim: ImportedClaim;
  readonly links: readonly LegacyLink[];
  readonly payload: Record<string, unknown>;
}

/**
 * The declared key set of every encoded record, single-sourced: the encoder projects
 * through these and the decoder validates against them, so the two halves cannot drift
 * into disagreeing about which fields exist.
 */
export const FACTS_KEYS: readonly string[] = Object.freeze([
  "claim", "links", "payload", "recordVersion", "schemaVersion", "shadowVersion",
]);
export const CLAIM_KEYS: readonly string[] =
  Object.freeze(["claimId", "principal", "provenance", "status"]);
export const LINK_KEYS: readonly string[] =
  Object.freeze(["evidenceOnly", "from", "kind", "provenance", "to"]);
/** `timeBasis` is a closed vocabulary rather than free text, so it is listed last. */
export const PROVENANCE_TEXT_KEYS: readonly string[] =
  Object.freeze(["manifestDigest", "sourceDigest", "sourcePath", "sourceTime"]);
export const PROVENANCE_KEYS: readonly string[] =
  Object.freeze([...PROVENANCE_TEXT_KEYS, "timeBasis"]);

/**
 * A TOTAL order over the three fields that identify a link, so two callers holding the
 * same links in different orders encode byte-identical bytes.
 */
export function compareLinks(left: LegacyLink, right: LegacyLink): number {
  const byKind = byCodeUnit(left.kind, right.kind);
  if (byKind !== 0) return byKind;
  const byFrom = byCodeUnit(left.from, right.from);
  return byFrom === 0 ? byCodeUnit(left.to, right.to) : byFrom;
}

/** Projects the declared keys only, so an extra field on the input cannot ride along. */
function pick(value: object, keys: readonly string[]): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  return Object.fromEntries(keys.map((key) => [key, source[key]]));
}

/** The canonical body: the exact object the bytes are `canonicalJson` of. */
export function factsBody(input: ImportEventFactsInput): Record<string, unknown> {
  return {
    claim: {
      ...pick(input.claim, CLAIM_KEYS),
      provenance: pick(input.claim.provenance, PROVENANCE_KEYS),
    },
    links: [...input.links].sort(compareLinks).map((link) => ({
      ...pick(link, LINK_KEYS),
      provenance: pick(link.provenance, PROVENANCE_KEYS),
    })),
    payload: input.payload,
    recordVersion: IMPORT_RECORD_VERSION,
    schemaVersion: IMPORT_EVENT_FACTS_VERSION,
    shadowVersion: SHADOW_PROJECTION_VERSION,
  };
}

/**
 * The canonical bytes for one event.
 *
 * `canonicalJson` is this package's existing encoder — sorted keys, safe integers only,
 * throw rather than serialise to `undefined`. A second encoder here would drift from the
 * digests every other derived identity in the importer is taken over.
 */
export function encodeImportEventFacts(
  input: ImportEventFactsInput,
): Uint8Array | ImportEventRefused {
  try {
    return new TextEncoder().encode(canonicalJson(factsBody(input)));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return refuseImportEvent(
      "IMPORT_EVENT_BYTES_MALFORMED",
      "DECODE",
      `facts are not canonicalisable: ${detail}`,
    );
  }
}

/** Every refusal this codec raises about BYTES is a DECODE-layer refusal. */
export function refuseDecode(code: ImportEventRefusalCode, detail: string): ImportEventRefused {
  return refuseImportEvent(code, "DECODE", detail);
}

/**
 * Descriptor-safe canonical-data check, applied before any value is read.
 *
 * Reading a field with `value[key]` runs an accessor, and an accessor that answers
 * differently on its second call would let validated facts differ from decoded ones. Every
 * own property must therefore be a plain DATA property, checked through its descriptor,
 * which never invokes it.
 */
export function checkData(value: unknown, where: string): ImportEventRefused | null {
  if (value === null || typeof value === "boolean" || typeof value === "string") return null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value)
      ? null
      : refuseDecode("IMPORT_EVENT_BYTES_MALFORMED", `${where} is not a safe integer`);
  }
  if (Array.isArray(value)) {
    for (const [at, entry] of value.entries()) {
      const broken = checkData(entry, `${where}[${String(at)}]`);
      if (broken !== null) return broken;
    }
    return null;
  }
  if (!isPlainRecord(value)) {
    return refuseDecode("IMPORT_EVENT_BYTES_MALFORMED", `${where} is not canonical data`);
  }
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return refuseDecode(
        "IMPORT_EVENT_BYTES_MALFORMED",
        `${where}.${key} is not a plain data property`,
      );
    }
    const broken = checkData(descriptor.value, `${where}.${key}`);
    if (broken !== null) return broken;
  }
  return null;
}

export function checkText(
  holder: Record<string, unknown>,
  keys: readonly string[],
  where: string,
): ImportEventRefused | null {
  for (const key of keys) {
    if (typeof holder[key] !== "string") {
      return refuseDecode("IMPORT_EVENT_BYTES_MALFORMED", `${where}.${key} is not text`);
    }
  }
  return null;
}

/** A closed-vocabulary field. `code` differs for the version arms, which are not shape. */
export function checkMember(
  holder: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  where: string,
  code: ImportEventRefusalCode = "IMPORT_EVENT_BYTES_MALFORMED",
): ImportEventRefused | null {
  const value = holder[key];
  return typeof value === "string" && allowed.includes(value)
    ? null
    : refuseDecode(code, `${where}.${key} is not one of ${allowed.join("|")}`);
}

/** Rebuilt from the declared provenance keys, so a decoded value carries nothing else. */
export function frozenProvenance(value: Record<string, unknown>): ImportProvenance {
  return Object.freeze(pick(value, PROVENANCE_KEYS)) as unknown as ImportProvenance;
}

/**
 * `evidenceOnly` is re-asserted as the LITERAL `true` rather than copied, so a decoded link
 * cannot widen to `boolean` and become representable as something stronger than evidence.
 */
export function frozenLink(value: Record<string, unknown>): LegacyLink {
  return Object.freeze({
    ...pick(value, LINK_KEYS),
    evidenceOnly: true as const,
    provenance: frozenProvenance(value["provenance"] as Record<string, unknown>),
  }) as unknown as LegacyLink;
}

export function frozenClaim(value: Record<string, unknown>): ImportedClaim {
  return Object.freeze({
    ...pick(value, CLAIM_KEYS),
    provenance: frozenProvenance(value["provenance"] as Record<string, unknown>),
  }) as unknown as ImportedClaim;
}
