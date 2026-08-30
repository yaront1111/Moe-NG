/**
 * The pairing CLAIM body, minted by the real daemon seam and spread exactly as the
 * route ships it, must be admitted by the shipped browser client. This is the only
 * place the two sides of `/session/pair/claim` meet: the daemon's own suite pins its
 * response shape and the client's suite pins its roster against fixtures, so each
 * side can drift green on its own — commit ee44b773 added `principalId` to the wire
 * and every real pairing refused as LIVE_PAIRING_REFUSED while both suites stayed
 * green. No single edit can move both sides of this test.
 */
import { afterAll, expect, it } from "vitest";

import { createPairingApprovalHandshake } from "../../../apps/daemon/src/http/pairing-approval-handshake.js";
import type { PairingClaimed } from "../../../apps/daemon/src/http/pairing-approval-handshake.js";
import { WIRE_PROTOCOL_VERSION } from "../../../apps/daemon/src/http/http-contract.js";
import { createPairingApprovalWindow } from "../../../apps/daemon/src/http/pairing-approval-window.js";
import {
  createSessionChallengeOperandsReadPort,
} from "../../../apps/daemon/src/http/session-challenge-operands-read.js";
import { OPERATOR_CAPABILITIES } from "../../../apps/daemon/src/daemon-command-vocabulary.js";
import {
  createOperatorSessionHandshakePort,
} from "../../../apps/daemon/src/identity/session-handshake.js";
import {
  PROJECT_ID,
  closeStores,
  openStore,
} from "../../../apps/daemon/src/identity/session-test-fixtures.js";
import { resolveLiveSetupFromHandshake } from "../../../apps/control-room/src/live/live-handshake.js";

afterAll(() => { closeStores(); });

const encoder = new TextEncoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);
const NOW = Date.parse("2026-08-30T06:00:00.000Z");
/** 44-byte Ed25519 SPKI as hex — the shape the keyed claim admits. */
const SPKI_HEX = "a".repeat(88);

function realSeam(): {
  readonly claim: (body: Record<string, unknown>) => PairingClaimed;
  readonly request: () => { confirmationLabel: string; requestId: string };
  readonly approve: (label: string) => void;
} {
  // Same project id as the store binding, or every mint refuses on the recovery binding.
  const store = openStore();
  const window = createPairingApprovalWindow();
  const pairing = createOperatorSessionHandshakePort({
    capabilities: OPERATOR_CAPABILITIES,
    clock: () => NOW,
    operatorPrincipalId: "principal-operator-parity",
    projectId: PROJECT_ID,
    sessionTtlMs: 60_000,
    store,
  });
  const operands = createSessionChallengeOperandsReadPort({ projectId: PROJECT_ID, store });
  const handshake = createPairingApprovalHandshake(window.requests, pairing, operands);
  return {
    approve: (label) => {
      const approved = window.operator.approve(label);
      if (!approved.ok) throw new Error("operator approval refused in fixture");
    },
    claim: (body) => {
      const outcome = handshake.claim(bytes(JSON.stringify(body)));
      if (!outcome.ok) throw new Error(`daemon refused the claim: ${outcome.code}`);
      return outcome;
    },
    request: () => {
      const created = handshake.request(bytes("{}"));
      if (!created.ok) throw new Error(`pairing request refused: ${created.code}`);
      return created;
    },
  };
}

/**
 * Serve the daemon-minted bodies to the real client. The bootstrap and request
 * responses mirror the shipped routes; the CLAIM response is the load-bearing one:
 * `{ ...outcome, protocolVersion }` is byte-for-byte the spread the listener ships
 * at http-listener-pairing-routes.ts:126.
 */
async function driveClientAgainst(claimed: PairingClaimed): Promise<unknown> {
  const claimWire = { ...claimed, protocolVersion: WIRE_PROTOCOL_VERSION };
  const seamRequest = { confirmationLabel: "abcd-ef01-2345", ok: true, requestId: "ab".repeat(32) };
  const respond = (path: string): Response => {
    if (path === "/bootstrap") {
      return json({ csrfToken: "csrf-parity", projectId: PROJECT_ID, protocolVersion: WIRE_PROTOCOL_VERSION });
    }
    if (path === "/session/pair/request") {
      return json(seamRequest, { "x-moe-operator-channel": "true" });
    }
    if (path === "/session/pair/claim") return json(claimWire);
    return json({}, undefined, 404);
  };
  const result = await resolveLiveSetupFromHandshake({
    fetchImpl: async (path: string) => respond(path),
  });
  if (!("status" in result) || result.status !== "AWAITING_OPERATOR") {
    throw new Error("expected pending pairing before the claim");
  }
  return result.claim();
}

function json(body: unknown, headers?: HeadersInit, status = 200): Response {
  return {
    headers: new Headers(headers),
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

it("client admits the daemon-minted BEARER claim body, route-spread and all", async () => {
  const seam = realSeam();
  const request = seam.request();
  seam.approve(request.confirmationLabel);
  const claimed = seam.claim({ requestId: request.requestId });

  // Positive control: the daemon really minted, with the principal on the body.
  expect(claimed.ok).toBe(true);
  expect(typeof claimed.principalId).toBe("string");

  const outcome = await driveClientAgainst(claimed);
  expect(outcome).toMatchObject({ ok: true, sessionCredential: claimed.sessionCredential });
});

it("client admits the daemon-minted KEYED claim body carrying the challenge", async () => {
  const seam = realSeam();
  const request = seam.request();
  seam.approve(request.confirmationLabel);
  const claimed = seam.claim({ publicKeySpkiHex: SPKI_HEX, requestId: request.requestId });

  // Positive control: the keyed arm really disclosed the challenge operands.
  expect(claimed.challenge).toBeDefined();

  const outcome = await driveClientAgainst(claimed);
  expect(outcome).toMatchObject({ ok: true, sessionCredential: claimed.sessionCredential });
});
