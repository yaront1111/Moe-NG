/**
 * The signed continuation cursor for the durable goal catalog.
 *
 * A cursor is the one thing a paginated read takes from the caller, so it decides nothing on
 * its own: the daemon pins the project and the store horizon at page one, signs them, and this
 * module refuses anything that was forged, rebound to another project, or pinned ahead of the
 * store it is being replayed against. Nothing here reads the clock, the store or the
 * environment — the secret and the current horizon are supplied by the caller.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";

const CURSOR_SCHEMA = "goal-catalog-cursor/1";
const CURSOR_KEYS = Object.freeze(["after", "horizon", "projectId", "schema"]);
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/u;

export const MAX_GOAL_CATALOG_CURSOR_CHARS = 512 as const;

export const GOAL_CATALOG_CURSOR_CODES = Object.freeze([
  "GOAL_CATALOG_CURSOR_MALFORMED",
  "GOAL_CATALOG_CURSOR_OVERSIZED",
  "GOAL_CATALOG_CURSOR_PROJECT_MISMATCH",
  "GOAL_CATALOG_CURSOR_STALE",
] as const);

export type GoalCatalogCursorCode = (typeof GOAL_CATALOG_CURSOR_CODES)[number];

export interface GoalCatalogCursorClaims {
  /** The last global position already emitted; the next page starts strictly after it. */
  readonly after: bigint;
  /** The store horizon pinned at page one, so later appends cannot enter this enumeration. */
  readonly horizon: bigint;
  readonly projectId: string;
}

export interface GoalCatalogCursorBinding {
  readonly currentHorizon: bigint;
  readonly projectId: string;
}

export type GoalCatalogCursorResult =
  | { readonly after: bigint; readonly horizon: bigint; readonly ok: true }
  | { readonly code: GoalCatalogCursorCode; readonly ok: false };

function refused(code: GoalCatalogCursorCode): GoalCatalogCursorResult {
  return Object.freeze({ code, ok: false as const });
}

function signature(secret: Buffer, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

export function encodeGoalCatalogCursor(secret: Buffer, claims: GoalCatalogCursorClaims): string {
  const payload = Buffer.from(JSON.stringify({
    after: claims.after.toString(10),
    horizon: claims.horizon.toString(10),
    projectId: claims.projectId,
    schema: CURSOR_SCHEMA,
  }), "utf8").toString("base64url");
  return `${payload}.${signature(secret, payload)}`;
}

function decodedClaims(payload: string): GoalCatalogCursorClaims | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (keys.length !== CURSOR_KEYS.length || !CURSOR_KEYS.every((key) => key in record)) return null;
  if (record["schema"] !== CURSOR_SCHEMA || typeof record["projectId"] !== "string"
    || record["projectId"].length === 0) return null;
  const after = record["after"];
  const horizon = record["horizon"];
  if (typeof after !== "string" || !DECIMAL.test(after)) return null;
  if (typeof horizon !== "string" || !DECIMAL.test(horizon)) return null;
  return Object.freeze({
    after: BigInt(after), horizon: BigInt(horizon), projectId: record["projectId"],
  });
}

/** Constant-time over the WHOLE digest: a compare that stopped early would admit a near-miss. */
function signatureMatches(secret: Buffer, payload: string, presented: string): boolean {
  const expected = Buffer.from(signature(secret, payload), "utf8");
  const supplied = Buffer.from(presented, "utf8");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

/**
 * Refusal order is deliberate: the size bound answers before anything is decoded, and the
 * signature answers before the claims are believed — a cursor that fails its MAC is MALFORMED,
 * never PROJECT_MISMATCH or STALE, because its claims are not evidence of anything.
 */
export function decodeGoalCatalogCursor(
  secret: Buffer, binding: GoalCatalogCursorBinding, value: unknown,
): GoalCatalogCursorResult {
  if (typeof value !== "string") return refused("GOAL_CATALOG_CURSOR_MALFORMED");
  if (value.length > MAX_GOAL_CATALOG_CURSOR_CHARS) {
    return refused("GOAL_CATALOG_CURSOR_OVERSIZED");
  }
  const separator = value.lastIndexOf(".");
  if (separator <= 0 || separator === value.length - 1) {
    return refused("GOAL_CATALOG_CURSOR_MALFORMED");
  }
  const payload = value.slice(0, separator);
  const presented = value.slice(separator + 1);
  if (!BASE64URL.test(payload) || !BASE64URL.test(presented)) {
    return refused("GOAL_CATALOG_CURSOR_MALFORMED");
  }
  if (!signatureMatches(secret, payload, presented)) {
    return refused("GOAL_CATALOG_CURSOR_MALFORMED");
  }
  const claims = decodedClaims(payload);
  if (claims === null) return refused("GOAL_CATALOG_CURSOR_MALFORMED");
  if (claims.projectId !== binding.projectId) {
    return refused("GOAL_CATALOG_CURSOR_PROJECT_MISMATCH");
  }
  if (claims.horizon > binding.currentHorizon) return refused("GOAL_CATALOG_CURSOR_STALE");
  return Object.freeze({ after: claims.after, horizon: claims.horizon, ok: true as const });
}

/**
 * The REQUEST shape that carries a cursor: exactly `{}` (page one) or exactly
 * `{ cursor: <string> }`. Anything else is a request-shape refusal at the listener, before a row
 * is read — a non-string cursor or an extra key never reaches the decoder above, so its four
 * codes only ever describe a real cursor. The SIZE rule stays with the decoder, so an over-long
 * cursor still reaches the code that names it.
 */
export function requestedCursor(
  body: unknown,
): { readonly cursor?: string; readonly ok: boolean } {
  const decoded = decodeBoundedJsonBytes(body);
  if (!decoded.ok) return { ok: false };
  const record = decoded.value;
  if (typeof record !== "object" || record === null || Array.isArray(record)) return { ok: false };
  const keys = Object.keys(record as Readonly<Record<string, unknown>>);
  if (keys.length === 0) return { ok: true };
  if (keys.length !== 1 || keys[0] !== "cursor") return { ok: false };
  const continuation = (record as Readonly<Record<string, unknown>>)["cursor"];
  if (typeof continuation !== "string" || continuation.length === 0) return { ok: false };
  return { cursor: continuation, ok: true };
}
