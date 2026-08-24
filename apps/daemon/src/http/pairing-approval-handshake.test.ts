import { afterAll, expect, it } from "vitest";

import {
  createPairingApprovalHandshake,
  pairingApprovalStatusFor,
} from "./pairing-approval-handshake.js";
import {
  PAIRING_APPROVAL_REFUSAL_CODES,
  createPairingApprovalWindow,
} from "./pairing-approval-window.js";
import { OPERATOR_CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import type { SessionHandshakePort } from "../identity/session-handshake.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import {
  PROJECT_ID,
  closeStores,
  openStore,
} from "../identity/session-test-fixtures.js";

const encoder = new TextEncoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);

afterAll(() => { closeStores(); });

function created(
  handshake: ReturnType<typeof createPairingApprovalHandshake>,
): { readonly confirmationLabel: string; readonly requestId: string } {
  const result = handshake.request(bytes("{}"));
  if (!result.ok) throw new Error(`pairing request refused: ${result.code}`);
  return result;
}

it("releases an approved claim only for an explicit session-mint refusal", () => {
  const window = createPairingApprovalWindow();
  let attempts = 0;
  const pairing: SessionHandshakePort = {
    boundProjectId: "project-release",
    mint: () => {
      attempts += 1;
      return attempts === 1 ? { code: "SESSION_OPEN_REFUSED", ok: false } : {
        capabilities: ["project.admin"],
        credential: "credential-after-retry",
        expiresAt: "2026-08-25T00:00:00.000Z",
        ok: true,
      };
    },
  };
  const handshake = createPairingApprovalHandshake(window.requests, pairing);
  const request = created(handshake);
  expect(window.operator.approve(request.confirmationLabel).ok).toBe(true);
  const body = bytes(JSON.stringify({ requestId: request.requestId }));

  expect(handshake.claim(body)).toMatchObject({ code: "PAIRING_SESSION_MINT_FAILED", ok: false });
  expect(handshake.claim(body)).toMatchObject({
    ok: true,
    sessionCredential: "credential-after-retry",
  });
  expect(handshake.claim(body)).toMatchObject({
    code: "PAIRING_REQUEST_ALREADY_CLAIMED",
    ok: false,
  });
  expect(attempts).toBe(2);
});

it("burns an approved claim when a durable session mint throws after committing", () => {
  const store = openStore();
  const durable = createOperatorSessionHandshakePort({
    capabilities: OPERATOR_CAPABILITIES,
    clock: () => Date.parse("2026-08-24T00:00:00.000Z"),
    mintCredential: () => "credential-committed-before-throw",
    mintSessionId: () => "session-committed-before-throw",
    operatorPrincipalId: "operator-ambiguous-mint",
    projectId: PROJECT_ID,
    reservedPrincipalIds: ["operator-ambiguous-mint"],
    sessionTtlMs: 60_000,
    store,
  });
  let attempts = 0;
  const pairing: SessionHandshakePort = {
    boundProjectId: durable.boundProjectId,
    mint: () => {
      attempts += 1;
      const result = durable.mint();
      if (!result.ok) return result;
      throw new Error("transport failed after durable commit");
    },
  };
  const window = createPairingApprovalWindow();
  const handshake = createPairingApprovalHandshake(window.requests, pairing);
  const request = created(handshake);
  expect(window.operator.approve(request.confirmationLabel).ok).toBe(true);
  const body = bytes(JSON.stringify({ requestId: request.requestId }));

  expect(handshake.claim(body)).toMatchObject({
    code: "PAIRING_SESSION_MINT_OUTCOME_UNKNOWN",
    ok: false,
  });
  expect(readSessionLedger(store, PROJECT_ID).sessions.size).toBe(1);
  expect(handshake.claim(body)).toMatchObject({
    code: "PAIRING_REQUEST_ALREADY_CLAIMED",
    ok: false,
  });
  expect(readSessionLedger(store, PROJECT_ID).sessions.size).toBe(1);
  expect(attempts).toBe(1);
});

it.each([
  ["missing credential", {
    capabilities: ["project.admin"], expiresAt: "2026-08-25T00:00:00.000Z", ok: true,
  }],
  ["empty credential", {
    capabilities: ["project.admin"], credential: "", expiresAt: "2026-08-25T00:00:00.000Z", ok: true,
  }],
  ["empty capabilities", {
    capabilities: [], credential: "credential", expiresAt: "2026-08-25T00:00:00.000Z", ok: true,
  }],
  ["empty capability", {
    capabilities: [""], credential: "credential", expiresAt: "2026-08-25T00:00:00.000Z", ok: true,
  }],
  ["invalid expiry", {
    capabilities: ["project.admin"], credential: "credential", expiresAt: "not-an-instant", ok: true,
  }],
  ["extra field", {
    capabilities: ["project.admin"], credential: "credential",
    expiresAt: "2026-08-25T00:00:00.000Z", extra: true, ok: true,
  }],
  ["extra refusal field", { code: "SESSION_OPEN_REFUSED", extra: true, ok: false }],
  ["empty refusal code", { code: "", ok: false }],
] as const)("burns a claim after an ambiguous malformed mint result with %s", (_, malformed) => {
  const window = createPairingApprovalWindow();
  let attempts = 0;
  const pairing: SessionHandshakePort = {
    boundProjectId: "project-malformed",
    mint: (() => {
      attempts += 1;
      return attempts === 1 ? malformed : {
        capabilities: ["project.admin"],
        credential: "credential-after-malformed-result",
        expiresAt: "2026-08-25T00:00:00.000Z",
        ok: true,
      };
    }) as SessionHandshakePort["mint"],
  };
  const handshake = createPairingApprovalHandshake(window.requests, pairing);
  const request = created(handshake);
  expect(window.operator.approve(request.confirmationLabel).ok).toBe(true);
  const body = bytes(JSON.stringify({ requestId: request.requestId }));

  expect(handshake.claim(body)).toEqual({
    code: "PAIRING_SESSION_MINT_OUTCOME_UNKNOWN",
    layer: "CONTROL_ROOM_PAIRING_APPROVAL",
    ok: false,
  });
  expect(handshake.claim(body)).toMatchObject({
    code: "PAIRING_REQUEST_ALREADY_CLAIMED",
    ok: false,
  });
  expect(attempts).toBe(1);
});

it("rejects malformed UTF-8 and every non-exact body before touching authority", () => {
  let minted = 0;
  const pairing: SessionHandshakePort = {
    boundProjectId: "project-exact",
    mint: () => {
      minted += 1;
      return { code: "unused", ok: false };
    },
  };
  const window = createPairingApprovalWindow();
  const handshake = createPairingApprovalHandshake(window.requests, pairing);

  for (const body of [
    new Uint8Array([0xc3, 0x28]), bytes(""), bytes("[]"), bytes("null"), bytes('{"extra":1}'),
  ]) {
    expect(handshake.request(body)).toMatchObject({ code: "PAIRING_CREATE_REQUEST_INVALID", ok: false });
  }
  for (const body of [
    new Uint8Array([0xc3, 0x28]), bytes("{}"), bytes('{"requestId":"a"}'),
    bytes(`{"requestId":"${"a".repeat(64)}","extra":true}`),
  ]) {
    expect(handshake.claim(body)).toMatchObject({ code: "PAIRING_CLAIM_REQUEST_INVALID", ok: false });
  }
  expect(minted).toBe(0);
});

it("maps every closed refusal code to one explicit non-success HTTP status", () => {
  expect(PAIRING_APPROVAL_REFUSAL_CODES.length).toBeGreaterThan(0);
  for (const code of PAIRING_APPROVAL_REFUSAL_CODES) {
    const status = pairingApprovalStatusFor(code);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(600);
  }
  expect(pairingApprovalStatusFor("PAIRING_APPROVAL_REQUIRED")).toBe(409);
  expect(pairingApprovalStatusFor("PAIRING_REQUEST_ALREADY_CLAIMED")).toBe(410);
  expect(pairingApprovalStatusFor("PAIRING_APPROVAL_CAPACITY_EXHAUSTED")).toBe(429);
});
