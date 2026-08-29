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
import { readPrincipalRecord } from "../identity/session-authority-store.js";
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
const HOSTILE_KIND_CASES = Object.freeze([
  Object.freeze({ kind: "HUMAN" }),
  Object.freeze({ principalKind: "HUMAN" }),
] as const);

afterAll(() => { closeStores(); });

function created(
  handshake: ReturnType<typeof createPairingApprovalHandshake>,
): { readonly confirmationLabel: string; readonly requestId: string } {
  const result = handshake.request(bytes("{}"));
  if (!result.ok) throw new Error(`pairing request refused: ${result.code}`);
  return result;
}

it("burns an approved claim for a mint refusal that declares no retry disposition", () => {
  // A refusal that does not say what it left behind is UNCERTAIN, and the pairing
  // seam fails closed on uncertainty: the approval is consumed, never released.
  const window = createPairingApprovalWindow();
  let attempts = 0;
  const pairing: SessionHandshakePort = {
    boundProjectId: "project-no-disposition",
    mint: () => {
      attempts += 1;
      return { code: "SESSION_OPEN_REFUSED", ok: false };
    },
  };
  const handshake = createPairingApprovalHandshake(window.requests, pairing);
  const request = created(handshake);
  expect(window.operator.approve(request.confirmationLabel).ok).toBe(true);
  const body = bytes(JSON.stringify({ requestId: request.requestId }));

  const refused = handshake.claim(body);
  expect(refused).toEqual({
    code: "PAIRING_SESSION_MINT_FAILED",
    layer: "CONTROL_ROOM_PAIRING_APPROVAL",
    ok: false,
  });
  expect(refused).not.toHaveProperty("cause");
  expect(handshake.claim(body)).toMatchObject({
    code: "PAIRING_REQUEST_ALREADY_CLAIMED",
    ok: false,
  });
  expect(attempts).toBe(1);
});

it("releases a layered mint refusal and preserves its exact cause", () => {
  const window = createPairingApprovalWindow();
  let attempts = 0;
  const pairing: SessionHandshakePort = {
    boundProjectId: "project-layered-refusal",
    mint: () => {
      attempts += 1;
      return attempts === 1 ? {
        code: "EXPECTED_VERSION_CONFLICT",
        disposition: "RELEASE" as const,
        layer: "DURABLE_STORE",
        ok: false,
      } : {
        capabilities: ["project.admin"],
        credential: "credential-after-layered-refusal",
        expiresAt: "2026-08-25T00:00:00.000Z",
        ok: true,
      };
    },
  };
  const handshake = createPairingApprovalHandshake(window.requests, pairing);
  const request = created(handshake);
  expect(window.operator.approve(request.confirmationLabel).ok).toBe(true);
  const body = bytes(JSON.stringify({ requestId: request.requestId }));

  const refused = handshake.claim(body);
  expect(refused).toEqual({
    cause: { code: "EXPECTED_VERSION_CONFLICT", layer: "DURABLE_STORE" },
    code: "PAIRING_SESSION_MINT_FAILED",
    layer: "CONTROL_ROOM_PAIRING_APPROVAL",
    ok: false,
  });
  // The cause is CONSTRUCTED from exactly two vetted fields: no `ok`, no
  // `disposition`, and no structural extra a hostile port could smuggle in.
  expect(Object.keys((refused as { readonly cause: object }).cause)).toEqual(["code", "layer"]);
  expect(handshake.claim(body)).toMatchObject({
    ok: true,
    sessionCredential: "credential-after-layered-refusal",
  });
  expect(attempts).toBe(2);
});

it("honours a RELEASE disposition on a refusal that carries no layer", () => {
  // `layer` is optional on the port type, so a double may declare its retry
  // disposition without one. There is then no cause to report, but the approval
  // is still explicitly retryable rather than uncertain.
  const window = createPairingApprovalWindow();
  let attempts = 0;
  const pairing: SessionHandshakePort = {
    boundProjectId: "project-unlayered-release",
    mint: () => {
      attempts += 1;
      return attempts === 1
        ? { code: "SESSION_STORE_UNAVAILABLE", disposition: "RELEASE" as const, ok: false }
        : {
          capabilities: ["project.admin"],
          credential: "credential-after-unlayered-release",
          expiresAt: "2026-08-25T00:00:00.000Z",
          ok: true,
        };
    },
  };
  const handshake = createPairingApprovalHandshake(window.requests, pairing);
  const request = created(handshake);
  expect(window.operator.approve(request.confirmationLabel).ok).toBe(true);
  const body = bytes(JSON.stringify({ requestId: request.requestId }));

  const refused = handshake.claim(body);
  expect(refused).toEqual({
    code: "PAIRING_SESSION_MINT_FAILED",
    layer: "CONTROL_ROOM_PAIRING_APPROVAL",
    ok: false,
  });
  expect(refused).not.toHaveProperty("cause");
  expect(handshake.claim(body)).toMatchObject({
    ok: true,
    sessionCredential: "credential-after-unlayered-release",
  });
  expect(attempts).toBe(2);
});

it("burns a layered mint refusal that declares BURN and still preserves its exact cause", () => {
  const window = createPairingApprovalWindow();
  let attempts = 0;
  const pairing: SessionHandshakePort = {
    boundProjectId: "project-burn-disposition",
    mint: () => {
      attempts += 1;
      return {
        code: "SESSION_RECOVERY_BINDING_UNAVAILABLE",
        disposition: "BURN" as const,
        layer: "DAEMON_PREREQUISITE",
        ok: false,
      };
    },
  };
  const handshake = createPairingApprovalHandshake(window.requests, pairing);
  const request = created(handshake);
  expect(window.operator.approve(request.confirmationLabel).ok).toBe(true);
  const body = bytes(JSON.stringify({ requestId: request.requestId }));

  expect(handshake.claim(body)).toEqual({
    cause: { code: "SESSION_RECOVERY_BINDING_UNAVAILABLE", layer: "DAEMON_PREREQUISITE" },
    code: "PAIRING_SESSION_MINT_FAILED",
    layer: "CONTROL_ROOM_PAIRING_APPROVAL",
    ok: false,
  });
  expect(handshake.claim(body)).toMatchObject({
    code: "PAIRING_REQUEST_ALREADY_CLAIMED",
    ok: false,
  });
  expect(attempts).toBe(1);
});

it("burns a mint refusal whose declared disposition is unrecognised", () => {
  const window = createPairingApprovalWindow();
  let attempts = 0;
  const pairing: SessionHandshakePort = {
    boundProjectId: "project-unknown-disposition",
    mint: (() => {
      attempts += 1;
      return { code: "SESSION_OPEN_REFUSED", disposition: "MAYBE", layer: "DURABLE_STORE", ok: false };
    }) as unknown as SessionHandshakePort["mint"],
  };
  const handshake = createPairingApprovalHandshake(window.requests, pairing);
  const request = created(handshake);
  expect(window.operator.approve(request.confirmationLabel).ok).toBe(true);
  const body = bytes(JSON.stringify({ requestId: request.requestId }));

  expect(handshake.claim(body)).toEqual({
    cause: { code: "SESSION_OPEN_REFUSED", layer: "DURABLE_STORE" },
    code: "PAIRING_SESSION_MINT_FAILED",
    layer: "CONTROL_ROOM_PAIRING_APPROVAL",
    ok: false,
  });
  expect(handshake.claim(body)).toMatchObject({
    code: "PAIRING_REQUEST_ALREADY_CLAIMED",
    ok: false,
  });
  expect(attempts).toBe(1);
});

it("ignores a prototype-carried refusal layer and burns the undisposed legacy shape", () => {
  const inherited = Object.create(Object.freeze({ layer: "DURABLE_STORE" })) as Record<string, unknown>;
  Object.assign(inherited, { code: "EXPECTED_VERSION_CONFLICT", ok: false });
  const window = createPairingApprovalWindow();
  let attempts = 0;
  const pairing: SessionHandshakePort = {
    boundProjectId: "project-prototype-refusal",
    mint: (() => {
      attempts += 1;
      return inherited;
    }) as unknown as SessionHandshakePort["mint"],
  };
  const handshake = createPairingApprovalHandshake(window.requests, pairing);
  const request = created(handshake);
  expect(window.operator.approve(request.confirmationLabel).ok).toBe(true);
  const body = bytes(JSON.stringify({ requestId: request.requestId }));

  // The inherited layer is invisible: only the two OWN keys are read, so this is
  // the legacy undisposed shape and the approval burns.
  expect(handshake.claim(body)).toEqual({
    code: "PAIRING_SESSION_MINT_FAILED",
    layer: "CONTROL_ROOM_PAIRING_APPROVAL",
    ok: false,
  });
  expect(handshake.claim(body)).toMatchObject({
    code: "PAIRING_REQUEST_ALREADY_CLAIMED",
    ok: false,
  });
  expect(attempts).toBe(1);
});

it("burns a refusal whose code hides behind a non-enumerable descriptor", () => {
  const refusal: Record<string, unknown> = { layer: "DURABLE_STORE", ok: false };
  Object.defineProperty(refusal, "code", {
    configurable: true, enumerable: false, value: "EXPECTED_VERSION_CONFLICT",
  });
  const window = createPairingApprovalWindow();
  const pairing: SessionHandshakePort = {
    boundProjectId: "project-hidden-code",
    mint: (() => refusal) as unknown as SessionHandshakePort["mint"],
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
});

it("burns an accessor-carried refusal code without invoking the getter", () => {
  let getterReads = 0;
  const refusal: Record<string, unknown> = { layer: "DURABLE_STORE", ok: false };
  Object.defineProperty(refusal, "code", {
    enumerable: true,
    get: () => {
      getterReads += 1;
      return "EXPECTED_VERSION_CONFLICT";
    },
  });
  const window = createPairingApprovalWindow();
  const pairing: SessionHandshakePort = {
    boundProjectId: "project-accessor-code",
    mint: (() => refusal) as unknown as SessionHandshakePort["mint"],
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
  expect(getterReads).toBe(0);
  expect(handshake.claim(body)).toMatchObject({
    code: "PAIRING_REQUEST_ALREADY_CLAIMED",
    ok: false,
  });
});

it("burns a Proxy-served refusal that declares no disposition, without one property get", () => {
  let getTraps = 0;
  const served: Record<string, unknown> = {
    code: "EXPECTED_VERSION_CONFLICT", layer: "DURABLE_STORE", ok: false,
  };
  const refusal = new Proxy({}, {
    get: (_target, key) => {
      getTraps += 1;
      return served[key as string];
    },
    getOwnPropertyDescriptor: (_target, key) => (
      typeof key === "string" && key in served
        ? { configurable: true, enumerable: true, value: served[key], writable: false }
        : undefined
    ),
    ownKeys: () => Object.keys(served),
  });
  const window = createPairingApprovalWindow();
  const pairing: SessionHandshakePort = {
    boundProjectId: "project-proxy-refusal",
    mint: (() => refusal) as unknown as SessionHandshakePort["mint"],
  };
  const handshake = createPairingApprovalHandshake(window.requests, pairing);
  const request = created(handshake);
  expect(window.operator.approve(request.confirmationLabel).ok).toBe(true);
  const body = bytes(JSON.stringify({ requestId: request.requestId }));

  // A Proxy may serve any descriptor it likes; what it CANNOT do is declare a
  // disposition it never had, so the undisposed refusal burns.
  expect(handshake.claim(body)).toEqual({
    cause: { code: "EXPECTED_VERSION_CONFLICT", layer: "DURABLE_STORE" },
    code: "PAIRING_SESSION_MINT_FAILED",
    layer: "CONTROL_ROOM_PAIRING_APPROVAL",
    ok: false,
  });
  expect(getTraps).toBe(0);
  expect(handshake.claim(body)).toMatchObject({
    code: "PAIRING_REQUEST_ALREADY_CLAIMED",
    ok: false,
  });
});

it("burns an accessor-carried refusal layer without invoking the getter", () => {
  let getterReads = 0;
  const refusal: Record<string, unknown> = { code: "EXPECTED_VERSION_CONFLICT", ok: false };
  Object.defineProperty(refusal, "layer", {
    enumerable: true,
    get: () => {
      getterReads += 1;
      return "DURABLE_STORE";
    },
  });
  const window = createPairingApprovalWindow();
  const pairing: SessionHandshakePort = {
    boundProjectId: "project-accessor-refusal",
    mint: (() => refusal) as unknown as SessionHandshakePort["mint"],
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
  expect(getterReads).toBe(0);
  expect(handshake.claim(body)).toMatchObject({
    code: "PAIRING_REQUEST_ALREADY_CLAIMED",
    ok: false,
  });
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
  ["empty refusal layer", { code: "X", layer: "", ok: false }],
  ["extra layered refusal field", { code: "X", extra: 1, layer: "L", ok: false }],
  ["symbol refusal field", { code: "X", layer: "L", ok: false, [Symbol("extra")]: 1 }],
  ["non-string disposition", { code: "X", disposition: 1, layer: "L", ok: false }],
  ["non-string disposition without a layer", { code: "X", disposition: 1, ok: false }],
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

it("rejects caller-supplied kind fields before minting any authority", () => {
  const store = openStore();
  const sessionId = "session-hostile-pairing-kind";
  const pairing = createOperatorSessionHandshakePort({
    capabilities: OPERATOR_CAPABILITIES,
    clock: () => Date.now(),
    mintSessionId: () => sessionId,
    operatorPrincipalId: "operator-hostile-pairing-kind",
    projectId: PROJECT_ID,
    reservedPrincipalIds: ["operator-hostile-pairing-kind"],
    sessionTtlMs: 60_000,
    store,
  });
  const window = createPairingApprovalWindow();
  const handshake = createPairingApprovalHandshake(window.requests, pairing);

  expect(handshake.request(bytes('{"kind":"HUMAN"}'))).toEqual({
    code: "PAIRING_CREATE_REQUEST_INVALID",
    layer: "CONTROL_ROOM_PAIRING_APPROVAL",
    ok: false,
  });
  const request = created(handshake);
  expect(window.operator.approve(request.confirmationLabel).ok).toBe(true);
  expect(HOSTILE_KIND_CASES).toHaveLength(2);
  for (const extra of HOSTILE_KIND_CASES) {
    expect(handshake.claim(bytes(JSON.stringify({ requestId: request.requestId, ...extra }))))
      .toEqual({
        code: "PAIRING_CLAIM_REQUEST_INVALID",
        layer: "CONTROL_ROOM_PAIRING_APPROVAL",
        ok: false,
      });
  }
  // The unit seam bypasses the listener's 96-byte body fence, so exact keys are
  // the only refuser here even for the longer principalKind body.
  expect(readSessionLedger(store, PROJECT_ID).sessions.size).toBe(0);
  expect(readPrincipalRecord(store, sessionId)).toEqual({ status: "ABSENT" });
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
