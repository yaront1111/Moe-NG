/**
 * The policy-validation AUTHORITY: what the server sources itself, how it digests what it
 * verified. The strict durable reader lives beside it in
 * `bootstrap-policy-authority-reader.ts`.
 *
 * Split out of `bootstrap-policy-services.ts` so the handler stays under the per-file line rail
 * while this file holds the part an attacker would probe - the refused caller keys, the digest
 * preimage, with nothing else in it.
 *
 * Nothing here reads a request or a store. The handler passes in what it has already
 * authenticated and selected; these functions only decide and derive.
 */

import { createHash } from "node:crypto";

import type { JsonObject, JsonValue } from "@moe/contracts";

/**
 * The keys a caller may name but may not SUPPLY, because the server sources both.
 *
 * Named once so the refusal and the composition below cannot drift apart.
 */
const SERVER_SOURCED_KEYS: readonly string[] = Object.freeze([
  "sliceChain",
  "waivers",
  "facts",
  "evaluatedAtEpochMs",
  "evaluatorVersion",
]);

/**
 * Durable digest vocabulary. A reader must know this exact preimage contract before treating a
 * row as authority; a non-empty version string is not enough.
 */
export const POLICY_DECISION_DIGEST_VERSION = "moe.policy.validate.decision.v2";
export const POLICY_EVALUATOR_VERSION = "moe-policy-evaluator/1";
export const POLICY_EVALUATION_TIME_SOURCE = "DAEMON_COMMAND_CLOCK";
export const POLICY_EVALUATOR_VERSION_SOURCE = "DAEMON_BUILD";

const encoder = new TextEncoder();

/**
 * Canonical because key ORDER must not move the digest: the slice arrives parsed out of the
 * ledger, and two writers constructing the same slice differently would otherwise disagree
 * about what the server verified.
 *
 * NOT imported: `canonicalSha256` exists at `packages/context/src/canonical-digest.ts` but that
 * module is absent from the package index (five `export *` lines, none of them this one), so it
 * is package-private and publishing it would widen another package's surface from this row.
 * Recorded in the task comment as a consolidation candidate rather than done here.
 */
function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as JsonObject;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] as JsonValue)}`)
    .join(",")}}`;
}

/**
 * LENGTH-FRAMED, so no field boundary can be forged by moving bytes between fields - the same
 * discipline `documents/document-source-identifiers.ts` uses. Framing removes the need for a
 * separator byte entirely, which is why no control character appears in this preimage.
 */
function framedDigest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of [POLICY_DECISION_DIGEST_VERSION, ...parts]) {
    const bytes = encoder.encode(part);
    hash.update(`${String(bytes.byteLength)}:`, "ascii").update(bytes);
  }
  return hash.digest("hex");
}

/** The sealed bytes persisted beside their digest so a reader can independently recompute it. */
export interface PolicyDecisionMaterial extends JsonObject {
  readonly projectId: string;
  readonly serverSources: JsonObject;
  readonly verifiedInput: JsonObject;
  readonly verifiedOutcome: JsonObject;
}

/**
 * OWN-property presence over a named list, never `in`.
 *
 * `in` and `Reflect.has` walk the prototype chain, so a hostile prototype would answer for an
 * honest request and a caller could be refused for a key it never sent. The same idiom guards
 * the release seam at `attempt-release-terminal.ts:100-103`, and for the same reason.
 */
export function callerSuppliedKey(input: object): string | null {
  return SERVER_SOURCED_KEYS.find(
    (key) => Object.prototype.hasOwnProperty.call(input, key)) ?? null;
}

/**
 * The digest of the COMPLETE decision material the SERVER verified, never a caller proposal.
 *
 * `material` contains project identity, the normalized server-assembled evaluation input and
 * the complete evaluated outcome. The handler deliberately removes `input.decisionDigest`
 * before constructing it: core hands that value straight back (`policy-evaluation.ts:190`) and
 * documents it as caller passthrough, so folding it in would let the caller move server evidence.
 * One canonical JSON frame makes additions unambiguous while retaining order inside arrays,
 * where order is semantic for policy slice composition.
 */
export function decisionDigestFor(material: JsonValue): string {
  return framedDigest([canonicalJson(material)]);
}
