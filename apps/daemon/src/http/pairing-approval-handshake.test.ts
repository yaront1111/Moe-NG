import { afterAll, expect, it } from "vitest";

import {
  PAIRING_APPROVAL_MAX_BODY_BYTES,
  PAIRING_CLAIM_MAX_BODY_BYTES,
  createPairingApprovalHandshake,
  pairingApprovalStatusFor,
} from "./pairing-approval-handshake.js";
import type { PairingClaimed } from "./pairing-approval-handshake.js";
import type { PairingApprovalRefusal } from "./pairing-approval-contract.js";
import {
  createSessionChallengeOperandsReadPort,
} from "./session-challenge-operands-read.js";
import type { SessionChallengeOperandsReadPort } from "./session-challenge-operands-read.js";
import {
  PAIRING_APPROVAL_REFUSAL_CODES,
  createPairingApprovalWindow,
} from "./pairing-approval-window.js";
import { OPERATOR_CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createSessionAuthority } from "../identity/session-authority.js";
import { readPrincipalRecord } from "../identity/session-authority-store.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import type { SessionHandshakePort } from "../identity/session-handshake.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import {
  PROJECT_ID,
  TEST_RECOVERY_INCARNATION_REF,
  TEST_RECOVERY_KEY_EPOCH_REF,
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
        principalId: "principal-after-layered-refusal",
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
          principalId: "principal-after-unlayered-release",
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

/**
 * task-2f554e29 DoD 2 — the claim ingress admits a browser-presented public key.
 *
 * A canonical Ed25519 SPKI is 44 DER bytes, so `publicKeySpkiHex` is 88 hex characters
 * and a claim carrying one cannot fit the 96-byte body bound the bearer claim uses.
 * The cap is therefore RAISED FOR THE CLAIM ROUTE ONLY, via its own constant —
 * `PAIRING_APPROVAL_MAX_BODY_BYTES` is also read by `project-manager-http-routing.ts`
 * at two sites on a separate origin and cookie authority, and widening it there is a
 * blast radius this row has no business taking.
 */
const SPKI_HEX = "a".repeat(88);

/** Records what the seam handed the mint, which is the only way to see the fence admit. */
function recordingPort(boundProjectId: string): {
  readonly port: SessionHandshakePort;
  readonly seen: { value: unknown };
} {
  const seen: { value: unknown } = { value: "NEVER_CALLED" };
  const port = {
    boundProjectId,
    mint: (input?: unknown) => {
      seen.value = input;
      return { code: "SESSION_OPEN_REFUSED", disposition: "BURN", ok: false } as const;
    },
  } as unknown as SessionHandshakePort;
  return { port, seen };
}

it("keeps the bearer claim unchanged: {requestId} alone still reaches the mint with no key", () => {
  // DoD 2 requires the no-key path to be UNCHANGED. This arm is what catches a
  // publicKeySpkiHex that was made REQUIRED rather than optional.
  const window = createPairingApprovalWindow();
  const { port, seen } = recordingPort("project-bearer-unchanged");
  const handshake = createPairingApprovalHandshake(window.requests, port);
  const request = created(handshake);
  expect(window.operator.approve(request.confirmationLabel).ok).toBe(true);

  handshake.claim(bytes(JSON.stringify({ requestId: request.requestId })));
  expect(seen.value).not.toBe("NEVER_CALLED");
  expect((seen.value as { publicKeySpkiHex?: unknown } | undefined)?.publicKeySpkiHex)
    .toBeUndefined();
});

it("admits {requestId, publicKeySpkiHex} through the fence and hands the key to the mint", () => {
  const window = createPairingApprovalWindow();
  const { port, seen } = recordingPort("project-key-admitted");
  // An operand source is wired because a key-bearing claim now fails closed ABOVE the
  // mint without one; this arm grades the BODY ROSTER, so it must get past that fence.
  const handshake = createPairingApprovalHandshake(
    window.requests, port, createSessionChallengeOperandsReadPort({
      projectId: PROJECT_ID, store: openStore(),
    }),
  );
  const request = created(handshake);
  expect(window.operator.approve(request.confirmationLabel).ok).toBe(true);

  handshake.claim(bytes(JSON.stringify({
    publicKeySpkiHex: SPKI_HEX, requestId: request.requestId,
  })));
  // Reaching the mint AT ALL is the property: a roster that refused would leave
  // "NEVER_CALLED" and the arm could not tell that apart from a mint that ignored it.
  expect((seen.value as { publicKeySpkiHex?: unknown }).publicKeySpkiHex).toBe(SPKI_HEX);
});

it("keeps the body roster EXACT: a third key is refused by code, not silently dropped", () => {
  const window = createPairingApprovalWindow();
  const { port, seen } = recordingPort("project-roster-exact");
  const handshake = createPairingApprovalHandshake(window.requests, port);
  const request = created(handshake);
  expect(window.operator.approve(request.confirmationLabel).ok).toBe(true);

  expect(handshake.claim(bytes(JSON.stringify({
    extra: "x", publicKeySpkiHex: SPKI_HEX, requestId: request.requestId,
  })))).toMatchObject({ code: "PAIRING_CLAIM_REQUEST_INVALID", ok: false });
  // A dropped-extra-key implementation would still reach the mint; this is the tell.
  expect(seen.value).toBe("NEVER_CALLED");
});

it("refuses a misspelled key name rather than treating it as absent", () => {
  const window = createPairingApprovalWindow();
  const { port } = recordingPort("project-misspelled-key");
  const handshake = createPairingApprovalHandshake(window.requests, port);
  const request = created(handshake);
  expect(window.operator.approve(request.confirmationLabel).ok).toBe(true);

  expect(handshake.claim(bytes(JSON.stringify({
    publicKeySpkiHEX: SPKI_HEX, requestId: request.requestId,
  })))).toMatchObject({ code: "PAIRING_CLAIM_REQUEST_INVALID", ok: false });
});

it("leaves the MANAGER body bound at 96 — the shared constant is not this route's cap", () => {
  // PAIRING_APPROVAL_MAX_BODY_BYTES is read by project-manager-http-routing.ts at two
  // sites on a separate origin and cookie authority. Raising it to fit a public key
  // would widen that surface silently. This guard lives beside the change that would
  // break it, and the step-7 drill raises the constant to prove the guard fires.
  expect(PAIRING_APPROVAL_MAX_BODY_BYTES).toBe(96);
  // The claim route gets its own, strictly larger, bound.
  expect(PAIRING_CLAIM_MAX_BODY_BYTES).toBeGreaterThan(PAIRING_APPROVAL_MAX_BODY_BYTES);
  // RE-SPEC'D by ruling comment-1b17ab9b, which selected arm (A): the claim carries a
  // possession PROOF, not just {requestId, publicKeySpkiHex}. That body is ~600 bytes
  // serialized (88+64+64 hex fields plus a 128-hex signature), so the original < 512 would
  // have rejected the very shape the ruling mandates. Still bounded, and no larger than it
  // needs to be: a cap that admits an arbitrary body is not a cap.
  expect(PAIRING_CLAIM_MAX_BODY_BYTES).toBeLessThanOrEqual(1024);
});

/**
 * CHALLENGE ISSUANCE AT THE APPROVED CLAIM (ruling `comment-d3a24ac8`, steps 2-3).
 *
 * The whole seam over ONE real store: the production operator mint, the production
 * operand reader `task-c338dd23` landed, and a real approval window. Nothing is
 * doubled, so an arm that passes here passes against the code the listener wires.
 */
const CHALLENGE_NOW = Date.parse("2026-08-30T06:00:00.000Z");

function realSeam(): {
  readonly handshake: ReturnType<typeof createPairingApprovalHandshake>;
  readonly operands: SessionChallengeOperandsReadPort;
  readonly store: ReturnType<typeof openStore>;
  readonly window: ReturnType<typeof createPairingApprovalWindow>;
} {
  // `openStore` binds the store to PROJECT_ID and installs the recovery binding, so the
  // seam must be built on the SAME project id or every mint refuses on the binding.
  const store = openStore();
  const window = createPairingApprovalWindow();
  const pairing = createOperatorSessionHandshakePort({
    capabilities: OPERATOR_CAPABILITIES,
    clock: () => CHALLENGE_NOW,
    operatorPrincipalId: "principal-operator-challenge",
    projectId: PROJECT_ID,
    sessionTtlMs: 60_000,
    store,
  });
  const operands = createSessionChallengeOperandsReadPort({ projectId: PROJECT_ID, store });
  return {
    handshake: createPairingApprovalHandshake(window.requests, pairing, operands),
    operands,
    store,
    window,
  };
}

/** Drives one approved claim to its response; `key` decides bearer vs key-bearing. */
function approvedClaim(
  seam: ReturnType<typeof realSeam>, key: string | null,
): PairingClaimed | PairingApprovalRefusal {
  const request = created(seam.handshake);
  expect(seam.window.operator.approve(request.confirmationLabel).ok).toBe(true);
  return seam.handshake.claim(bytes(JSON.stringify(
    key === null ? { requestId: request.requestId } : {
      publicKeySpkiHex: key, requestId: request.requestId,
    },
  )));
}

function mintedOrThrow(result: PairingClaimed | PairingApprovalRefusal): PairingClaimed {
  if (!result.ok) throw new Error(`claim refused: ${result.code}`);
  return result;
}

it("issues the claim-bound challenge to an approved KEY-BEARING claim, from the store", () => {
  const seam = realSeam();
  const claimed = mintedOrThrow(approvedClaim(seam, SPKI_HEX));

  // The response names the principal the mint actually committed, so a browser can
  // fold it into the digest openSession recomputes.
  expect(readPrincipalRecord(seam.store, claimed.principalId).status).toBe("FOUND");
  // EVERY scalar is compared against an INDEPENDENT read through the production
  // operand port, never a literal: a challenge assembled from constants, or from the
  // wrong principal, cannot satisfy this.
  const read = seam.operands.readOperands(claimed.principalId);
  if (read.outcome !== "OPERANDS") throw new Error(`operands unreadable: ${read.code}`);
  expect(claimed.challenge).toEqual({
    keyEpochRef: read.operands.keyEpochRef,
    profileRevisionId: read.operands.profileRevisionId,
    recoveryIncarnationRef: read.operands.recoveryIncarnationRef,
  });
  // The roster is EXACT: a fourth scalar smuggled into the response fails here.
  expect(Object.keys(claimed.challenge ?? {}).sort())
    .toEqual(["keyEpochRef", "profileRevisionId", "recoveryIncarnationRef"]);
  // And the values are the ones the recovery binding actually holds, spelled
  // independently of the production reader so both sides cannot move together.
  expect(claimed.challenge?.recoveryIncarnationRef).toBe(TEST_RECOVERY_INCARNATION_REF);
  expect(claimed.challenge?.keyEpochRef).toBe(TEST_RECOVERY_KEY_EPOCH_REF);
});

it("mints NO session authority at the approved claim: the challenge is not a durable binding", () => {
  // The amended DoD 2 property. The claim commits a HUMAN principal and issues the
  // challenge; the key-bound authority record must not exist until the open
  // completion verifies possession.
  const seam = realSeam();
  const claimed = mintedOrThrow(approvedClaim(seam, SPKI_HEX));

  const authority = createSessionAuthority(seam.store, {
    clock: () => CHALLENGE_NOW, projectId: PROJECT_ID,
  });
  expect(authority.readSessionAuthority(claimed.principalId)).toEqual({ status: "ABSENT" });
});

it("keeps the BEARER response byte-identical: no challenge, no key, same key set", () => {
  const seam = realSeam();
  const claimed = mintedOrThrow(approvedClaim(seam, null));

  // Key-ABSENCE on the response shape, not merely an undefined lookup: a spread of
  // `{challenge: undefined}` would pass the latter and fail this.
  expect(Object.keys(claimed).sort()).toEqual([
    "capabilities", "expiresAt", "ok", "principalId", "projectId", "sessionCredential",
  ]);
  expect(Object.hasOwn(claimed, "challenge")).toBe(false);
});

it("DISCLOSURE FENCE: no refusal path carries any challenge scalar", () => {
  // Four genuinely different refusals - shape, unknown request, unapproved request,
  // and an already-claimed one - all asserted on the RESPONSE SHAPE. A leak that
  // assembled the challenge before the approval check would surface here whatever
  // status code it chose.
  const seam = realSeam();
  const unapproved = created(seam.handshake);
  const consumed = created(seam.handshake);
  expect(seam.window.operator.approve(consumed.confirmationLabel).ok).toBe(true);
  const consumedBody = bytes(JSON.stringify({
    publicKeySpkiHex: SPKI_HEX, requestId: consumed.requestId,
  }));
  expect(seam.handshake.claim(consumedBody).ok).toBe(true);

  const refusals = [
    seam.handshake.claim(bytes(JSON.stringify({ publicKeySpkiHex: SPKI_HEX }))),
    seam.handshake.claim(bytes(JSON.stringify({
      publicKeySpkiHex: SPKI_HEX, requestId: "f".repeat(64),
    }))),
    seam.handshake.claim(bytes(JSON.stringify({
      publicKeySpkiHex: SPKI_HEX, requestId: unapproved.requestId,
    }))),
    seam.handshake.claim(consumedBody),
  ];
  expect(refusals.map((refusal) => refusal.ok)).toEqual([false, false, false, false]);
  for (const refusal of refusals) {
    const keys = Object.keys(refusal);
    expect(keys).not.toContain("challenge");
    for (const scalar of ["keyEpochRef", "profileRevisionId", "recoveryIncarnationRef"]) {
      expect(keys).not.toContain(scalar);
    }
    // The serialized body is the wire: a scalar nested anywhere in it is a leak.
    const wire = JSON.stringify(refusal);
    expect(wire).not.toContain(TEST_RECOVERY_INCARNATION_REF);
    expect(wire).not.toContain(TEST_RECOVERY_KEY_EPOCH_REF);
  }
});

it("refuses a key-bearing claim when no operand source is wired, WITHOUT burning the approval", () => {
  // Fail closed and fail EARLY: a daemon that cannot assemble a challenge must not
  // consume the operator's approval, or a misconfiguration costs a human interaction.
  const window = createPairingApprovalWindow();
  const { port, seen } = recordingPort("project-challenge-unwired");
  const handshake = createPairingApprovalHandshake(window.requests, port);
  const request = created(handshake);
  expect(window.operator.approve(request.confirmationLabel).ok).toBe(true);

  expect(handshake.claim(bytes(JSON.stringify({
    publicKeySpkiHex: SPKI_HEX, requestId: request.requestId,
  })))).toEqual({
    code: "PAIRING_CLAIM_CHALLENGE_UNAVAILABLE",
    layer: "CONTROL_ROOM_PAIRING_APPROVAL",
    ok: false,
  });
  // Never reached the mint, so nothing durable was written.
  expect(seen.value).toBe("NEVER_CALLED");
  // AND THE APPROVAL SURVIVED. This double's mint always refuses, so "the retry
  // succeeded" is unavailable as a witness; REACHING the mint is the property, and it
  // is exactly what a consumed approval would prevent.
  handshake.claim(bytes(JSON.stringify({ requestId: request.requestId })));
  expect(seen.value).not.toBe("NEVER_CALLED");
});
