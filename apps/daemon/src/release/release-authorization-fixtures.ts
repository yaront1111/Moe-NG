/**
 * TEST-TIER HARNESS for `release.decide` authorization, built from PRODUCTION seams only.
 *
 * The browser identity under test is minted the way a real browser mints it: POST
 * `/session/pair/request` on the real listener, `approvePairing` on the operator channel,
 * POST `/session/pair/claim` for the bearer. No `AuthenticatedPrincipal` is hand-written and
 * the configured operator's credential is never substituted for the paired one -- doing
 * either would prove the fixture rather than the fence.
 *
 * Commands go out over the same socket the control room uses, so `authenticateHttpRequest`,
 * the capability gate and the async dispatch all run in their production order.
 */
import { request as httpRequest } from "node:http";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import type { ReleaseDecideSeams } from "../daemon-command-async-entries.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { CREDENTIAL_HEADER, PROTOCOL_VERSION_HEADER } from "../http/http-listener-guards.js";
import type { ControlRoomListener } from "../http/http-listener.js";
import { startControlRoomListener } from "../http/http-listener.js";
import { ensureGenesisRecoveryBinding } from "../identity/genesis-recovery-binding.js";
import { createSessionAuthenticator } from "../identity/session-authenticator.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { releaseDossierAggregateId } from "./release-dossier-contracts.js";
import { GOAL_ID, HEAD_SHA, ancestryOf, dossierInput } from "./release-dossier-fixtures.js";

export const PROJECT = "project-release-authorization";
export const OPERATOR = "release-authorization-operator";
export const OPERATOR_CREDENTIAL = "release-authorization-operator-credential";
export const SESSION_TTL_MS = 60_000;
export const START_MS = Date.parse("2026-09-07T12:00:00.000Z");
export { GOAL_ID, HEAD_SHA };
const CSRF = "release-authorization-csrf";

export interface Reply {
  readonly body: Readonly<Record<string, unknown>>;
  readonly status: number;
}

/** Every port the release service could reach, counted so a refusal can prove it reached none. */
export interface ReleaseEffectCounts {
  dossier: number;
  pr: number;
  publish: number;
}

export interface PairedIdentity {
  readonly capabilities: readonly string[];
  readonly credential: string;
  /** The durable HUMAN principal the mint created, under the id the session authenticates as. */
  readonly principalId: string;
}

export interface ReleaseAuthorizationHarness {
  /** Advances the millisecond clock the handshake port, authenticator and ports all read. */
  readonly advanceMs: (delta: number) => void;
  readonly close: () => Promise<void>;
  readonly command: (
    kind: string, credential: string | null, payload: JsonObject,
    overrides?: Readonly<Record<string, unknown>>,
  ) => Promise<Reply>;
  readonly counts: ReleaseEffectCounts;
  readonly listener: ControlRoomListener;
  readonly pair: (sessionId?: string) => Promise<PairedIdentity>;
  readonly projectId: string;
  /** One `release.decide` over `/command`, on a fresh release aggregate at version 0. */
  readonly send: (
    credential: string | null, overrides?: Readonly<Record<string, unknown>>,
  ) => Promise<Reply>;
  readonly store: SqliteEventStore;
}

export interface HarnessOptions {
  /** Capabilities every session this listener pairs authenticates with. */
  readonly capabilities?: readonly string[];
  /** `false` leaves the daemon release-unconfigured, so the fail-closed stub answers. */
  readonly composed?: boolean;
  readonly projectId?: string;
}

async function post(
  listener: ControlRoomListener, path: string, body: string, credential: string | null,
): Promise<Reply> {
  const headers: Record<string, string> = {
    "content-length": String(Buffer.byteLength(body)),
    "content-type": "application/json",
    host: `127.0.0.1:${listener.port}`,
    origin: listener.origin,
    "x-moe-csrf": CSRF,
    [PROTOCOL_VERSION_HEADER]: WIRE_PROTOCOL_VERSION,
  };
  if (credential !== null) headers[CREDENTIAL_HEADER] = credential;
  return await new Promise((resolve, reject) => {
    // Bounded: a hung socket must fail its arm, never wedge the file.
    const call = httpRequest(
      listener.origin + path, { headers, method: "POST", timeout: 15_000 },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            body: (text.length === 0 ? {} : JSON.parse(text)) as Readonly<Record<string, unknown>>,
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    call.on("timeout", () => { call.destroy(new Error("RELEASE_AUTHORIZATION_HTTP_TIMEOUT")); });
    call.on("error", reject);
    call.end(body);
  });
}

/** The counted release seams. The remote stays UNBOUND, so an AUTHORIZED caller stops at
 *  RELEASE_REMOTE_MISSING -- the first check past the fence, and therefore the oracle. */
function seamsOf(counts: ReleaseEffectCounts, projectId: string): ReleaseDecideSeams {
  return {
    dossierFacts: () => {
      counts.dossier += 1;
      return { ancestry: ancestryOf().predicate, input: dossierInput({ projectId }) };
    },
    prPort: {
      async open() {
        counts.pr += 1;
        return { ok: false, spawnErrorCode: null, stderrLastLine: "unreachable in this harness" };
      },
    },
    publisher: { async publishOnce() { counts.publish += 1; return []; } },
    workspace: "/tmp/release-authorization-workspace",
  };
}

export async function startReleaseAuthorizationHarness(
  options: HarnessOptions = {},
): Promise<ReleaseAuthorizationHarness> {
  const projectId = options.projectId ?? PROJECT;
  const store = SqliteEventStore.openEphemeralForProjectTest(projectId);
  const counts: ReleaseEffectCounts = { dossier: 0, pr: 0, publish: 0 };
  let nowMs = START_MS;
  let minted = 0;
  let nextSessionId: string | null = null;
  let listener: ControlRoomListener | null = null;
  const closeAll = async (): Promise<void> => {
    if (listener !== null) await listener.close();
    store.close();
  };
  try {
    const isoClock = (): string => new Date(nowMs).toISOString();
    ensureGenesisRecoveryBinding(store, { clock: isoClock, projectId });
    const composed = options.composed !== false;
    const deps = {
      authenticator: createSessionAuthenticator(store, {
        clock: () => nowMs, operatorCapabilities: [CAPABILITIES.ADMIN, CAPABILITIES.GOAL],
        operatorCredential: OPERATOR_CREDENTIAL, operatorPrincipalId: OPERATOR, projectId,
      }),
      ...createDaemonCommandPorts({
        clock: isoClock, operatorPrincipalId: OPERATOR, projectId, store,
        ...(composed ? { releaseDecide: seamsOf(counts, projectId) } : {}),
      }),
    };
    const started = await startControlRoomListener({
      csrfToken: CSRF,
      deps,
      log: () => undefined,
      pairing: createOperatorSessionHandshakePort({
        capabilities: options.capabilities ?? [CAPABILITIES.ADMIN, CAPABILITIES.GOAL],
        clock: () => nowMs,
        mintSessionId: () => {
          minted += 1;
          const chosen = nextSessionId ?? `session-release-${String(minted)}`;
          nextSessionId = null;
          return chosen;
        },
        operatorPrincipalId: OPERATOR, projectId, reservedPrincipalIds: [OPERATOR],
        sessionTtlMs: SESSION_TTL_MS, store,
      }),
      pairingMonotonicNow: () => nowMs,
    });
    if (!started.ok) throw new Error(`LISTENER_REFUSED:${started.code}`);
    listener = started;
    const live = started;
    const command = async (
      kind: string, credential: string | null, payload: JsonObject,
      overrides: Readonly<Record<string, unknown>> = {},
    ): Promise<Reply> => await post(live, "/command", JSON.stringify({
      commandId: `cmd-${kind}-${String(minted)}-${String(nowMs)}`, commandKind: kind,
      correlationId: "release-authorization", expectedVersion: 0, payload,
      requestDigest: "a".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: credential ?? "", targetAggregateId: projectId, ...overrides,
    }), credential);
    return {
      advanceMs: (delta) => { nowMs += delta; },
      close: closeAll,
      command,
      counts,
      listener: live,
      pair: async (sessionId?: string) => {
        nextSessionId = sessionId ?? null;
        return await claimPairing(live);
      },
      projectId,
      send: async (credential, overrides = {}) => await command(
        "release.decide", credential,
        { base: "main", decision: "APPROVE", goalId: GOAL_ID, sha: HEAD_SHA },
        { targetAggregateId: releaseDossierAggregateId(GOAL_ID), ...overrides },
      ),
      store,
    };
  } catch (error) {
    await closeAll();
    throw error;
  }
}

/** The browser's own three-call pairing dance, over the real socket. */
async function claimPairing(listener: ControlRoomListener): Promise<PairedIdentity> {
  const requested = await post(listener, "/session/pair/request", "{}", null);
  const confirmationLabel = requested.body["confirmationLabel"];
  const requestId = requested.body["requestId"];
  if (requested.status !== 200 || typeof confirmationLabel !== "string"
    || typeof requestId !== "string") {
    throw new Error(`PAIRING_REQUEST_FAILED:${String(requested.status)}`);
  }
  const approved = listener.approvePairing(confirmationLabel);
  if (approved.ok !== true) throw new Error(`PAIRING_APPROVAL_FAILED:${JSON.stringify(approved)}`);
  const claimed = await post(listener, "/session/pair/claim", JSON.stringify({ requestId }), null);
  const credential = claimed.body["sessionCredential"];
  const principalId = claimed.body["principalId"];
  const capabilities = claimed.body["capabilities"];
  if (claimed.status !== 200 || typeof credential !== "string" || credential.length === 0
    || typeof principalId !== "string" || principalId.length === 0
    || !Array.isArray(capabilities)) {
    throw new Error(`PAIRING_CLAIM_FAILED:${String(claimed.status)}`);
  }
  return { capabilities: capabilities as readonly string[], credential, principalId };
}
