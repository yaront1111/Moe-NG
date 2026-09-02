import { createCompatGate, createControlRoomTransport } from "@moe/control-room-client";
import type { ControlRoomClientSurface, ControlRoomTransport } from "@moe/control-room-client";

/**
 * Resolves the DEVELOPMENT-ONLY live attachment from build-time configuration.
 *
 * Fail closed, visibly: a missing credential, a missing dev compat report, or a
 * pin mismatch each resolve to a refusal with its own stable code — never to a
 * transport pointed at a guessed endpoint. Secrets travel through Vite env only
 * (headers at runtime, never URLs); the compat report is injected by the dev
 * server from the generated pins and still validated by the real gate, which
 * remains the only authority on admission.
 */

export const LIVE_PROJECTION = "moe.board" as const;
export const LIVE_SUBSCRIBER = "control-room-1" as const;

export const LIVE_CONFIG_REFUSAL_CODES = Object.freeze([
  "LIVE_CONFIG_MISSING",
  "LIVE_COMPAT_REFUSED",
  "LIVE_BOOTSTRAP_UNAVAILABLE",
  "LIVE_PAIRING_REFUSED",
] as const);

export type LiveConfigRefusalCode = (typeof LIVE_CONFIG_REFUSAL_CODES)[number];

export interface LiveSetup {
  /** The gated surface: generated builders + wire protocol; the gate admitted it. */
  readonly client: ControlRoomClientSurface;
  /** Header values for the one route the transport does not carry (/affordances/read). */
  readonly headers: Readonly<Record<string, string>>;
  readonly ok: true;
  /** Runtime bootstrap authority; null only on the legacy build-time dev path. */
  readonly projectId: string | null;
  readonly projection: typeof LIVE_PROJECTION;
  readonly sessionCredential: string;
  readonly subscriberId: typeof LIVE_SUBSCRIBER;
  readonly transport: ControlRoomTransport;
}

export interface LiveRefused {
  readonly code: LiveConfigRefusalCode;
  readonly detail: string;
  readonly ok: false;
}

export type LiveSetupResult = LiveRefused | LiveSetup;

export interface LiveEnv {
  readonly VITE_MOE_LIVE_CREDENTIAL?: string | undefined;
  readonly VITE_MOE_LIVE_CSRF?: string | undefined;
}

export function resolveLiveSetup(env: LiveEnv, compatReport: unknown): LiveSetupResult {
  const credential = env.VITE_MOE_LIVE_CREDENTIAL ?? "";
  const csrf = env.VITE_MOE_LIVE_CSRF ?? "";
  if (credential === "" || csrf === "") {
    return Object.freeze({
      code: "LIVE_CONFIG_MISSING",
      detail: "set VITE_MOE_LIVE_CREDENTIAL and VITE_MOE_LIVE_CSRF to attach the daemon",
      ok: false,
    } as const);
  }
  const gate = createCompatGate(compatReport);
  if (!gate.ok) {
    return Object.freeze({
      code: "LIVE_COMPAT_REFUSED",
      detail: `compat gate refused: ${gate.error.code}`,
      ok: false,
    } as const);
  }
  // Origin is empty on purpose: requests stay same-origin and the dev server
  // proxies /command, /events/read, /events/ack and /affordances/read to the daemon.
  // V1 is STATED, not inferred: this build-time attachment never reads `/bootstrap`,
  // so it cannot learn a cutover plane and must not pretend to. The shipped path is
  // the handshake in live-handshake.ts, which routes by what the daemon states.
  const transport = createControlRoomTransport({
    commandAuthorityPlane: "V1",
    csrfToken: csrf,
    origin: "",
    sessionCredential: credential,
    wireProtocolVersion: gate.client.wireProtocolVersion,
  });
  return Object.freeze({
    client: gate.client,
    headers: Object.freeze({
      "content-type": "application/json",
      "x-moe-csrf": csrf,
      "x-moe-protocol-version": gate.client.wireProtocolVersion,
      "x-moe-session-credential": credential,
    }),
    ok: true,
    projectId: null,
    projection: LIVE_PROJECTION,
    sessionCredential: credential,
    subscriberId: LIVE_SUBSCRIBER,
    transport,
  } as const);
}
