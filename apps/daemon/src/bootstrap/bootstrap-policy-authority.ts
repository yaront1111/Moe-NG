/**
 * The policy-validation AUTHORITY: what the server sources itself, how it digests what it
 * verified, and how a durable row is read back strictly.
 *
 * Split out of `bootstrap-policy-services.ts` so the handler stays under the per-file line rail
 * while this file holds the part an attacker would probe - the refused caller keys, the digest
 * preimage and the strict reader - with nothing else in it.
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
const SERVER_SOURCED_KEYS: readonly string[] = Object.freeze(["sliceChain", "waivers"]);

/** Domain-separated so this digest can never collide with another preimage's. */
const DECISION_DIGEST_DOMAIN = "moe.policy.validate.decision.v1";

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
  const hash = createHash("sha256").update(DECISION_DIGEST_DOMAIN, "utf8");
  for (const part of parts) {
    const bytes = encoder.encode(part);
    hash.update(`${String(bytes.byteLength)}:`, "ascii").update(bytes);
  }
  return hash.digest("hex");
}

/** The three facts the widened row must carry, each with the code its absence answers. */
const POLICY_AUTHORITY_FACTS: readonly (readonly [string, string])[] = Object.freeze([
  Object.freeze(["principalId", "POLICY_AUTHORITY_PRINCIPAL_UNKNOWN"] as const),
  Object.freeze(["sliceRef", "POLICY_AUTHORITY_SLICE_UNKNOWN"] as const),
  Object.freeze(["decisionDigest", "POLICY_AUTHORITY_DIGEST_UNKNOWN"] as const),
]);

export interface PolicyEvaluationAuthority {
  readonly decision: string;
  readonly decisionDigest: string;
  readonly ok: true;
  readonly policyRef: string;
  readonly principalId: string;
  readonly sliceRef: string;
}

export interface PolicyEvaluationAuthorityRefused {
  readonly code: string;
  readonly layer: "DAEMON_POLICY_AUTHORITY";
  readonly ok: false;
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
 * The digest of what the SERVER verified, never what the caller proposed.
 *
 * The preimage is the installed slice BYTES, the authenticated principal, the ref the server
 * selected by, the action and the decision core reached over those bytes. `input.decisionDigest`
 * is deliberately absent from it: core hands that value straight back
 * (`policy-evaluation.ts:190`) and its own modules document it as caller passthrough, so folding
 * it in would let the caller move the server's digest.
 */
export function decisionDigestFor(
  action: string, decision: string, policyRef: string, principalId: string, slice: JsonValue,
): string {
  return framedDigest([action, decision, policyRef, principalId, canonicalJson(slice)]);
}

/**
 * Answers a policy verdict from the DURABLE row, and refuses rather than infers.
 *
 * A row written before this binding landed carries only `{decision, policyRef}`. It must read
 * UNKNOWN with the code naming WHICH fact is missing - never be back-filled with a default,
 * because a defaulted principal is indistinguishable from a verified one at every call site
 * downstream. That is the whole reason the row was widened rather than the reader relaxed.
 */
export function readPolicyEvaluationAuthority(
  payload: JsonValue | null,
): PolicyEvaluationAuthority | PolicyEvaluationAuthorityRefused {
  const refused = (code: string): PolicyEvaluationAuthorityRefused =>
    Object.freeze({ code, layer: "DAEMON_POLICY_AUTHORITY" as const, ok: false as const });
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return refused("POLICY_AUTHORITY_ROW_UNREADABLE");
  }
  const record = payload as Record<string, unknown>;
  for (const [key, code] of POLICY_AUTHORITY_FACTS) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) return refused(code);
  }
  const decision = record["decision"], policyRef = record["policyRef"];
  if (typeof decision !== "string" || typeof policyRef !== "string") {
    return refused("POLICY_AUTHORITY_ROW_UNREADABLE");
  }
  return Object.freeze({
    decision,
    decisionDigest: record["decisionDigest"] as string,
    ok: true as const,
    policyRef,
    principalId: record["principalId"] as string,
    sliceRef: record["sliceRef"] as string,
  });
}
