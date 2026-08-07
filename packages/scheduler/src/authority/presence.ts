/**
 * Presence projection (design 12.3, lines 757-761).
 *
 * `presence.ping` is authenticated, server-timestamped, idempotent, coalesced
 * operational telemetry. It may update only a NON-authoritative projection: it
 * MUST NOT renew a lease, change an epoch/version/readiness/phase, or make a
 * stale action valid. A fenced `lease.renew` is the only lease liveness input.
 *
 * That separation is enforced structurally, not by convention: this module
 * imports no lease module and no lease module imports it, so no code path
 * exists from a ping to lease authority. `authority-kernel-invariants.test.ts`
 * asserts the ban in both directions by scanning the sources.
 *
 * The default 10-second client cadence and the at-most-one-second daemon batch
 * window are DAEMON behaviour and are deliberately not kernel constants here —
 * a coalescing window must never become something the kernel can be tuned by.
 */
import { hasOnlyOwnStringKeys, isPlainRecord, readOwnDataProperty } from "../runtime-shape.js";

export type PresenceErrorCode = "PRESENCE_MALFORMED_INPUT" | "PRESENCE_SESSION_MISMATCH";

/** Carries no epoch, version, token, or lifecycle: a ping cannot express authority. */
export interface PresenceProjection {
  readonly sessionRef: string;
  readonly lastSeen: number;
  readonly lastPingId: string | null;
}

export interface PresencePing {
  readonly sessionRef: string;
  readonly pingId: string;
  readonly clientObservation: string;
  readonly serverReceivedAt: number;
}

export type PresenceOutcome =
  | { readonly ok: true; readonly projection: PresenceProjection }
  | { readonly ok: false; readonly code: PresenceErrorCode; readonly message: string };

const PROJECTION_KEYS = ["sessionRef", "lastSeen", "lastPingId"] as const;
const PING_KEYS = ["sessionRef", "pingId", "clientObservation", "serverReceivedAt"] as const;

function isRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isInstant(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!isPlainRecord(value) || !hasOnlyOwnStringKeys(value, keys)) return null;
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const read = readOwnDataProperty(value, key);
    if (!read.ok || !read.present) return null;
    output[key] = read.value;
  }
  return output;
}
function refuse(code: PresenceErrorCode, message: string): PresenceOutcome {
  return Object.freeze({ ok: false as const, code, message });
}
function project(projection: PresenceProjection): PresenceOutcome {
  return Object.freeze({ ok: true as const, projection: Object.freeze(projection) });
}

function parseProjection(value: unknown): PresenceProjection | null {
  const parsed = exactRecord(value, PROJECTION_KEYS);
  if (parsed === null) return null;
  if (!isRef(parsed["sessionRef"]) || !isInstant(parsed["lastSeen"])) return null;
  if (parsed["lastPingId"] !== null && !isRef(parsed["lastPingId"])) return null;
  return parsed as unknown as PresenceProjection;
}

function parsePing(value: unknown): PresencePing | null {
  const parsed = exactRecord(value, PING_KEYS);
  if (parsed === null) return null;
  if (!isRef(parsed["sessionRef"]) || !isRef(parsed["pingId"])) return null;
  if (!isRef(parsed["clientObservation"]) || !isInstant(parsed["serverReceivedAt"])) return null;
  return parsed as unknown as PresencePing;
}

export function openPresence(sessionRef: unknown, observedAt: unknown): PresenceOutcome {
  if (!isRef(sessionRef) || !isInstant(observedAt)) {
    return refuse("PRESENCE_MALFORMED_INPUT", "presence requires a session reference and instant");
  }
  return project({ sessionRef, lastSeen: observedAt, lastPingId: null });
}

/**
 * An accepted ping sets `lastSeen = max(lastSeen, serverReceivedAt)` and nothing
 * else. A repeated ping id is coalesced to the existing projection, so a ping
 * storm converges to one value; a dropped ping promises nothing and is healed
 * by the next delivery.
 */
export function acceptPing(current: unknown, envelope: unknown): PresenceOutcome {
  const projection = parseProjection(current);
  const ping = parsePing(envelope);
  if (projection === null || ping === null) {
    return refuse("PRESENCE_MALFORMED_INPUT", "presence ping or projection is malformed");
  }
  if (projection.sessionRef !== ping.sessionRef) {
    return refuse("PRESENCE_SESSION_MISMATCH", "ping does not address this presence projection");
  }
  if (projection.lastPingId === ping.pingId) return project(projection);
  return project({
    sessionRef: projection.sessionRef,
    lastSeen: Math.max(projection.lastSeen, ping.serverReceivedAt),
    lastPingId: ping.pingId,
  });
}
