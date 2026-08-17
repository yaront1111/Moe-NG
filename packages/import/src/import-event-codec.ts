import { byCodeUnit, canonicalJson, isPlainRecord } from "./canonical-bytes.js";
import {
  IMPORTED_CLAIM_STATUSES,
  IMPORT_RECORD_VERSION,
  LEGACY_LINK_KINDS,
  TIME_BASES,
} from "./import-contract.js";
import {
  CLAIM_KEYS,
  FACTS_KEYS,
  IMPORT_EVENT_FACTS_VERSION,
  LINK_KEYS,
  PROVENANCE_KEYS,
  PROVENANCE_TEXT_KEYS,
  checkData,
  checkMember,
  checkText,
  compareLinks,
  factsBody,
  frozenClaim,
  frozenLink,
  refuseDecode,
} from "./import-event-facts.js";
import type { ImportEventFacts, ImportEventRefused } from "./import-event-facts.js";
import { SHADOW_PROJECTION_VERSION } from "./shadow-contract.js";

/**
 * Reading committed import-event bytes back, fail-closed.
 *
 * The vocabulary these facts are written against — the version, the refusal codes, the
 * declared key sets and the canonical body — lives in `import-event-facts.ts`; this module
 * is the hostile-input half. Both are published through this specifier, so a consumer has
 * ONE codec seam to import even though the file rail put them in two files.
 *
 * Nothing here reads a clock or a random source, and every refusal names its own code and
 * the `DECODE` layer, so a caller never has to infer which layer answered.
 */

export {
  IMPORT_EVENT_FACTS_VERSION,
  IMPORT_EVENT_REFUSAL_CODES,
  encodeImportEventFacts,
  refuseImportEvent,
} from "./import-event-facts.js";
export type {
  ImportEventFacts,
  ImportEventFactsInput,
  ImportEventRefusalCode,
  ImportEventRefused,
} from "./import-event-facts.js";

/** A bound, so a hostile or corrupt row cannot make the decoder allocate without limit. */
export const IMPORT_EVENT_MAX_BYTES = 1_048_576;

const refuse = refuseDecode;

/** Exactly the declared keys: descriptor safety first, then undeclared, then missing. */
function checkRecord(
  value: unknown,
  declared: readonly string[],
  where: string,
): ImportEventRefused | null {
  const data = checkData(value, where);
  if (data !== null) return data;
  if (!isPlainRecord(value)) {
    return refuse("IMPORT_EVENT_BYTES_MALFORMED", `${where} is not a record`);
  }
  for (const key of Object.keys(value)) {
    if (!declared.includes(key)) {
      return refuse("IMPORT_EVENT_FACTS_UNKNOWN_FIELD", `${where} carries undeclared field ${key}`);
    }
  }
  for (const key of declared) {
    if (!Object.hasOwn(value, key)) {
      return refuse("IMPORT_EVENT_FACTS_INCOMPLETE", `${where} is missing ${key}`);
    }
  }
  return null;
}

function checkProvenance(value: unknown, where: string): ImportEventRefused | null {
  const shape = checkRecord(value, PROVENANCE_KEYS, where);
  if (shape !== null) return shape;
  const provenance = value as Record<string, unknown>;
  const text = checkText(provenance, PROVENANCE_TEXT_KEYS, where);
  return text ?? checkMember(provenance, "timeBasis", TIME_BASES, where);
}

function checkClaim(value: unknown): ImportEventRefused | null {
  const shape = checkRecord(value, CLAIM_KEYS, "claim");
  if (shape !== null) return shape;
  const claim = value as Record<string, unknown>;
  const text = checkText(claim, ["claimId", "principal"], "claim");
  if (text !== null) return text;
  const status = checkMember(claim, "status", IMPORTED_CLAIM_STATUSES, "claim");
  return status ?? checkProvenance(claim["provenance"], "claim.provenance");
}

function checkLink(value: unknown, at: number): ImportEventRefused | null {
  const where = `links[${String(at)}]`;
  const shape = checkRecord(value, LINK_KEYS, where);
  if (shape !== null) return shape;
  const link = value as Record<string, unknown>;
  if (link["evidenceOnly"] !== true) {
    return refuse("IMPORT_EVENT_BYTES_MALFORMED", `${where}.evidenceOnly is not the literal true`);
  }
  const text = checkText(link, ["from", "to"], where);
  if (text !== null) return text;
  const kind = checkMember(link, "kind", LEGACY_LINK_KINDS, where);
  return kind ?? checkProvenance(link["provenance"], `${where}.provenance`);
}

/**
 * The declared schema binds the two vocabularies these facts speak. A payload naming a
 * different one is a CONFLICT rather than an unsupported envelope: the envelope IS one this
 * decoder serves, and what disagrees is the content accompanying it.
 */
function checkVersions(facts: Record<string, unknown>): ImportEventRefused | null {
  const schema = checkMember(
    facts, "schemaVersion", [IMPORT_EVENT_FACTS_VERSION], "facts",
    "IMPORT_EVENT_SCHEMA_UNSUPPORTED",
  );
  if (schema !== null) return schema;
  const bound: readonly (readonly [string, string])[] = [
    ["recordVersion", IMPORT_RECORD_VERSION],
    ["shadowVersion", SHADOW_PROJECTION_VERSION],
  ];
  for (const [key, value] of bound) {
    const conflict = checkMember(facts, key, [value], "facts", "IMPORT_EVENT_SCHEMA_CONFLICT");
    if (conflict !== null) return conflict;
  }
  return null;
}

function checkFacts(value: unknown): ImportEventRefused | null {
  const shape = checkRecord(value, FACTS_KEYS, "facts");
  if (shape !== null) return shape;
  const facts = value as Record<string, unknown>;
  const versions = checkVersions(facts);
  if (versions !== null) return versions;
  const claim = checkClaim(facts["claim"]);
  if (claim !== null) return claim;
  const links: unknown = facts["links"];
  if (!Array.isArray(links)) {
    return refuse("IMPORT_EVENT_BYTES_MALFORMED", "facts.links is not a list");
  }
  for (const [at, link] of (links as readonly unknown[]).entries()) {
    const broken = checkLink(link, at);
    if (broken !== null) return broken;
  }
  return isPlainRecord(facts["payload"])
    ? null
    : refuse("IMPORT_EVENT_BYTES_MALFORMED", "facts.payload is not a record");
}

/**
 * Copies rather than freezes in place: freezing a caller's object is a side effect, and
 * `Object.fromEntries` defines own data properties, so a `__proto__` key inside a legacy
 * payload cannot reach `Object.prototype` through an assignment.
 */
function frozenData(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => frozenData(entry)));
  if (!isPlainRecord(value)) return value;
  return Object.freeze(Object.fromEntries(
    Object.keys(value).sort(byCodeUnit).map((key) => [key, frozenData(value[key])]),
  ));
}

/**
 * The structural admission the byte decoder composes, and the surface a reader that already
 * holds a parsed JSON value calls. It does NOT judge canonicality — only bytes have a
 * spelling — so a caller holding bytes must use `decodeImportEventFacts`.
 */
export function admitImportEventFacts(value: unknown): ImportEventFacts | ImportEventRefused {
  // The walks below recurse, and `JSON.parse` is iterative in V8 — so bytes it accepts can
  // still overflow the stack here. A crash is not a refusal, so the whole admission fails
  // closed onto a code rather than escaping as a throw.
  try {
    const broken = checkFacts(value);
    if (broken !== null) return broken;
    const facts = value as Record<string, unknown>;
    return Object.freeze({
      claim: frozenClaim(facts["claim"] as Record<string, unknown>),
      links: Object.freeze((facts["links"] as readonly Record<string, unknown>[])
        .map((link) => frozenLink(link))
        .sort(compareLinks)),
      payload: frozenData(facts["payload"]) as Record<string, unknown>,
      recordVersion: IMPORT_RECORD_VERSION,
      schemaVersion: IMPORT_EVENT_FACTS_VERSION,
      shadowVersion: SHADOW_PROJECTION_VERSION,
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return refuse("IMPORT_EVENT_BYTES_MALFORMED", `facts could not be admitted: ${detail}`);
  }
}

/**
 * Bytes to facts, fail-closed.
 *
 * The re-encode compare is LAST and is load-bearing: a duplicate key, reordered keys or
 * inserted whitespace all parse to a value indistinguishable from the honest one, so only
 * comparing the canonical form back against the input bytes sees the second spelling.
 */
export function decodeImportEventFacts(bytes: unknown): ImportEventFacts | ImportEventRefused {
  if (!(bytes instanceof Uint8Array)) {
    return refuse("IMPORT_EVENT_BYTES_MALFORMED", "event payload is not a byte array");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > IMPORT_EVENT_MAX_BYTES) {
    return refuse(
      "IMPORT_EVENT_BYTES_MALFORMED",
      `event payload of ${String(bytes.byteLength)} bytes is outside the declared bound`,
    );
  }
  let text = "";
  let parsed: unknown;
  try {
    // Copied first: the caller's view is read exactly once, so nothing it does afterwards
    // can make the validated bytes differ from the decoded ones.
    text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    parsed = JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return refuse("IMPORT_EVENT_BYTES_MALFORMED", `event payload is not JSON text: ${detail}`);
  }
  const facts = admitImportEventFacts(parsed);
  if ("outcome" in facts) return facts;
  try {
    return canonicalJson(factsBody(facts)) === text
      ? facts
      : refuse("IMPORT_EVENT_BYTES_NONCANONICAL", "event payload is not its own canonical form");
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return refuse("IMPORT_EVENT_BYTES_MALFORMED", `facts do not re-encode: ${detail}`);
  }
}
