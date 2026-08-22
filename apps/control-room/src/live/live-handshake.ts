import { admitByWireProtocol, createControlRoomTransport } from "@moe/control-room-client";
import type { FetchLike } from "@moe/control-room-client";

import {
  LIVE_PROJECTION,
  LIVE_SUBSCRIBER,
} from "./live-config.js";
import type { LiveConfigRefusalCode, LiveRefused, LiveSetupResult } from "./live-config.js";

/**
 * Resolves the live attachment from the daemon's RUNTIME credential handshake.
 *
 * This replaces the build-time secret path in `live-config.ts`
 * (`resolveLiveSetup`): a loopback process could read a baked
 * VITE_MOE_LIVE_CREDENTIAL, so no secret is ever baked here. The operator
 * credential is fetched live from the daemon and lives ONLY in the returned
 * setup that the caller holds in memory.
 *
 * Everything crosses `input.fetchImpl` and `input.locationHref`; the resolver
 * touches no `window`, `history`, ambient `fetch`, `localStorage`,
 * `sessionStorage`, or cookies. That keeps it a PURE function of its inputs
 * (so it is fully unit-testable) and, more importantly, means the credential and
 * the one-time pairing token are never persisted anywhere this module controls.
 *
 * Security invariants held here and asserted by the tests:
 * - the pairing token is read from the URL FRAGMENT only, never the query;
 * - the token and the credential travel in a header or the request body only,
 *   never in a URL, path, or query string;
 * - the module persists nothing - the caller owns the returned setup's lifetime.
 */
export interface HandshakeInput {
  readonly fetchImpl: FetchLike;
  readonly locationHref: string;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** One shared shape for every refusal: a stable code and a secret-free detail. */
function refused(code: LiveConfigRefusalCode, detail: string): LiveRefused {
  return Object.freeze({ code, detail, ok: false } as const);
}

/**
 * Reads the one-time pairing token from the URL FRAGMENT only.
 *
 * The fragment never leaves the browser - it is not sent to any server and not
 * written to server logs - which is exactly why the pairing link from `moe up`
 * carries the token there. Reading it from the query string instead would leak
 * the token into request lines and history, so the query is deliberately ignored.
 * A leading "#" (and a hash-router "#/" prefix) is stripped before the remainder
 * is parsed as URL-encoded pairs.
 */
function readPairingToken(locationHref: string): string | undefined {
  let hash: string;
  try {
    hash = new URL(locationHref).hash;
  } catch {
    return undefined;
  }
  let raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw.startsWith("/")) raw = raw.slice(1);
  const token = new URLSearchParams(raw).get("pair");
  return isNonEmptyString(token) ? token : undefined;
}

export async function resolveLiveSetupFromHandshake(
  input: HandshakeInput,
): Promise<LiveSetupResult> {
  // 1. GET /bootstrap. Same-origin; the browser sets Host. Any fault - a thrown
  //    request, a non-200, an unreadable body, or a body missing a non-empty
  //    csrfToken/projectId/protocolVersion - fails closed to one code. The status
  //    is included when known; no field of the body is ever echoed (never a secret).
  let bootstrapRes: Response;
  try {
    bootstrapRes = await input.fetchImpl("/bootstrap", { method: "GET" });
  } catch {
    return refused("LIVE_BOOTSTRAP_UNAVAILABLE", "daemon bootstrap unavailable");
  }
  if (!bootstrapRes.ok) {
    return refused(
      "LIVE_BOOTSTRAP_UNAVAILABLE",
      `daemon bootstrap unavailable (status ${bootstrapRes.status})`,
    );
  }
  let bootstrapBody: unknown;
  try {
    bootstrapBody = await bootstrapRes.json();
  } catch {
    return refused(
      "LIVE_BOOTSTRAP_UNAVAILABLE",
      `daemon bootstrap unavailable (status ${bootstrapRes.status})`,
    );
  }
  if (
    !isPlainObject(bootstrapBody)
    || !isNonEmptyString(bootstrapBody["csrfToken"])
    || !isNonEmptyString(bootstrapBody["projectId"])
    || !isNonEmptyString(bootstrapBody["protocolVersion"])
  ) {
    return refused(
      "LIVE_BOOTSTRAP_UNAVAILABLE",
      `daemon bootstrap unavailable (status ${bootstrapRes.status})`,
    );
  }
  const csrfToken = bootstrapBody["csrfToken"];
  const protocolVersion = bootstrapBody["protocolVersion"];

  // 2. Compat, at runtime: /bootstrap serves only the wire protocol string, which
  //    pins all three envelope versions at once. The protocol string is not a
  //    secret, so naming it in the refusal detail is safe and helps diagnosis.
  const gate = admitByWireProtocol(protocolVersion);
  if (!gate.ok) {
    return refused(
      "LIVE_COMPAT_REFUSED",
      `compat gate refused for daemon protocol ${protocolVersion}`,
    );
  }

  // 3. Pairing token, from the FRAGMENT only. Absent is the honest common state on
  //    a plain load: no in-memory credential and no token to redeem this time.
  const pairingToken = readPairingToken(input.locationHref);
  if (pairingToken === undefined) {
    return refused("LIVE_CONFIG_MISSING", "open the pairing link from `moe up` to attach");
  }

  // 4. POST /session/pair. The token and the CSRF/protocol pins travel in the body
  //    and headers, never a URL. The daemon returns one code for a wrong, reused,
  //    or expired token, so we do not try to distinguish - every fault is one code.
  let pairRes: Response;
  try {
    pairRes = await input.fetchImpl("/session/pair", {
      body: JSON.stringify({ pairingToken }),
      headers: {
        "content-type": "application/json",
        "x-moe-csrf": csrfToken,
        "x-moe-protocol-version": protocolVersion,
      },
      method: "POST",
    });
  } catch {
    return refused("LIVE_PAIRING_REFUSED", "session pairing refused");
  }
  if (!pairRes.ok) {
    return refused("LIVE_PAIRING_REFUSED", `session pairing refused (status ${pairRes.status})`);
  }
  let pairBody: unknown;
  try {
    pairBody = await pairRes.json();
  } catch {
    return refused("LIVE_PAIRING_REFUSED", "session pairing refused");
  }
  if (!isPlainObject(pairBody) || !isNonEmptyString(pairBody["sessionCredential"])) {
    return refused("LIVE_PAIRING_REFUSED", "session pairing refused");
  }
  const sessionCredential = pairBody["sessionCredential"];

  // 5. Success. Origin is empty on purpose: requests stay same-origin and the
  //    dev/prod host serves the daemon routes. The credential is carried in a
  //    header by the transport and echoed in `headers` for the one route the
  //    transport does not own, exactly as the build-time path did.
  const transport = createControlRoomTransport({
    csrfToken,
    fetch: input.fetchImpl,
    origin: "",
    sessionCredential,
    wireProtocolVersion: protocolVersion,
  });
  return Object.freeze({
    client: gate.client,
    headers: Object.freeze({
      "content-type": "application/json",
      "x-moe-csrf": csrfToken,
      "x-moe-protocol-version": protocolVersion,
      "x-moe-session-credential": sessionCredential,
    }),
    ok: true,
    projection: LIVE_PROJECTION,
    sessionCredential,
    subscriberId: LIVE_SUBSCRIBER,
    transport,
  } as const);
}
