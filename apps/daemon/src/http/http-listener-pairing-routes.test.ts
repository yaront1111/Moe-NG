import type { IncomingMessage, ServerResponse } from "node:http";

import { expect, it, vi } from "vitest";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import type { SessionHandshakePort } from "../identity/session-handshake.js";
import type {
  AuthenticatedPrincipal,
  AuthenticationResult,
  Authenticator,
} from "./http-contract.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import {
  PAIRING_APPROVE_PATH,
  handlePairingApproveRequest,
  servePairingApproveRoute,
} from "./http-listener-pairing-routes.js";
import { createPairingApprovalWindow } from "./pairing-approval-window.js";

const CREDENTIAL = "operator-session";
const PROJECT_ID = "project-pairing-routes";

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

const MALFORMED_APPROVAL_BODY = bytes(Object.freeze({
  confirmationLabel: "label-possession-is-not-authority",
  injectedAuthority: CAPABILITIES.ADMIN,
}));

function principal(
  capabilities: readonly string[],
  projectId: string = PROJECT_ID,
): AuthenticatedPrincipal {
  return Object.freeze({ capabilities, principalId: "operator-1", projectId });
}

function authenticatorFor(answer: AuthenticationResult): Authenticator {
  return Object.freeze({
    authenticate: (credential: string | null): AuthenticationResult =>
      credential === CREDENTIAL ? answer : Object.freeze({ verdict: "UNAUTHENTICATED" as const }),
  });
}

function pairing(projectId: string = PROJECT_ID): SessionHandshakePort {
  return Object.freeze({
    boundProjectId: projectId,
    mint: vi.fn(() => {
      throw new Error("approval route must not mint a session");
    }),
  });
}

function pendingLabel(): {
  readonly confirmationLabel: string;
  readonly window: ReturnType<typeof createPairingApprovalWindow>;
} {
  const window = createPairingApprovalWindow();
  const created = window.requests.create();
  if (!created.ok) throw new Error(`pairing request refused: ${created.code}`);
  return { confirmationLabel: created.confirmationLabel, window };
}

const HOSTILE_APPROVAL_CASES = Object.freeze([
  "unauthenticated malformed body",
  "authenticator port refusal",
  "authenticated malformed body",
  "label possession without project.admin",
  "foreign-project project.admin",
] as const);

it("pins the hostile approval roster exact, nonzero, and unique", () => {
  expect(HOSTILE_APPROVAL_CASES).toHaveLength(5);
  expect(HOSTILE_APPROVAL_CASES.length).toBeGreaterThan(0);
  expect(new Set(HOSTILE_APPROVAL_CASES).size).toBe(HOSTILE_APPROVAL_CASES.length);
});

it(HOSTILE_APPROVAL_CASES[0], () => {
  const { window } = pendingLabel();
  const result = handlePairingApproveRequest(
    { approvalWindow: window, authenticator: authenticatorFor({
      principal: principal([CAPABILITIES.ADMIN]), verdict: "AUTHENTICATED",
    }), pairing: pairing() },
    { body: MALFORMED_APPROVAL_BODY, credential: "invalid", protocolVersion: WIRE_PROTOCOL_VERSION },
  );

  expect(result).toMatchObject({
    body: { error: { code: "AUTHENTICATION_FAILED" }, outcome: "REFUSED", stage: "AUTHENTICATE" },
    httpStatus: 401,
    kind: "REPLY",
  });
});

it("authenticates before consuming approval body bytes", async () => {
  const pending = pendingLabel();
  let authenticated = false;
  let readBeforeAuthentication = false;
  const request = {
    headers: {
      host: "127.0.0.1:4317",
      origin: "http://127.0.0.1:4317",
      "x-moe-csrf": "csrf-pairing-routes",
      "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
      "x-moe-session-credential": CREDENTIAL,
    },
    method: "POST",
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      readBeforeAuthentication = !authenticated;
      yield bytes({ confirmationLabel: pending.confirmationLabel });
    },
  } as unknown as IncomingMessage;
  const response = {
    end: vi.fn(),
    writeHead: vi.fn(),
  } as unknown as ServerResponse;
  const authenticator: Authenticator = Object.freeze({
    authenticate: (): AuthenticationResult => {
      authenticated = true;
      return Object.freeze({
        principal: principal([CAPABILITIES.ADMIN]), verdict: "AUTHENTICATED" as const,
      });
    },
  });

  await servePairingApproveRoute(response, request, {
    approvalWindow: pending.window,
    authenticator,
    authority: "127.0.0.1:4317",
    csrfToken: "csrf-pairing-routes",
    exactPath: true,
    origin: "http://127.0.0.1:4317",
    pairing: pairing(),
  });

  expect(readBeforeAuthentication).toBe(false);
});

it(HOSTILE_APPROVAL_CASES[1], () => {
  const { window } = pendingLabel();
  const refusal = Object.freeze({
    code: "OPERATOR_SESSION_REVOKED",
    detail: CREDENTIAL,
    httpStatus: 418,
    layer: "SESSION_AUTHORITY",
  });
  const result = handlePairingApproveRequest(
    { approvalWindow: window, authenticator: authenticatorFor({ refusal, verdict: "REFUSED" }), pairing: pairing() },
    { body: new Uint8Array([0xc3, 0x28]), credential: CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION },
  );

  expect(result).toEqual({
    body: {
      httpStatus: 418,
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: { ...refusal, detail: "authentication refused" },
      stage: "AUTHENTICATE",
    },
    httpStatus: 418,
    kind: "REPLY",
  });
  expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
});

it(HOSTILE_APPROVAL_CASES[2], () => {
  const { window } = pendingLabel();
  const result = handlePairingApproveRequest(
    { approvalWindow: window, authenticator: authenticatorFor({
      principal: principal([CAPABILITIES.ADMIN]), verdict: "AUTHENTICATED",
    }), pairing: pairing() },
    {
      body: MALFORMED_APPROVAL_BODY,
      credential: CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    },
  );

  expect(result).toEqual({
    body: { code: "PAIRING_CONFIRMATION_INVALID", layer: "CONTROL_ROOM_PAIRING_APPROVAL" },
    httpStatus: 400,
    kind: "REPLY",
  });
});

it(HOSTILE_APPROVAL_CASES[3], () => {
  const pending = pendingLabel();
  const denied = handlePairingApproveRequest(
    { approvalWindow: pending.window, authenticator: authenticatorFor({
      principal: principal([]), verdict: "AUTHENTICATED",
    }), pairing: pairing() },
    { body: bytes({ confirmationLabel: pending.confirmationLabel }), credential: CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION },
  );
  expect(denied).toMatchObject({
    body: { error: { code: "CAPABILITY_DENIED" }, stage: "AUTHORIZE" },
    httpStatus: 403,
  });

  const approved = handlePairingApproveRequest(
    { approvalWindow: pending.window, authenticator: authenticatorFor({
      principal: principal([CAPABILITIES.ADMIN]), verdict: "AUTHENTICATED",
    }), pairing: pairing() },
    { body: bytes({ confirmationLabel: pending.confirmationLabel }), credential: CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION },
  );
  expect(approved).toEqual({ body: { ok: true, state: "APPROVED" }, httpStatus: 200, kind: "REPLY" });
});

it(HOSTILE_APPROVAL_CASES[4], () => {
  const pending = pendingLabel();
  const result = handlePairingApproveRequest(
    { approvalWindow: pending.window, authenticator: authenticatorFor({
      principal: principal([CAPABILITIES.ADMIN], "project-foreign"), verdict: "AUTHENTICATED",
    }), pairing: pairing() },
    { body: bytes({ confirmationLabel: pending.confirmationLabel }), credential: CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION },
  );

  expect(result).toMatchObject({
    body: { error: { code: "CAPABILITY_DENIED" }, stage: "AUTHORIZE" },
    httpStatus: 403,
  });
});

it("checks project binding before consulting project.admin", () => {
  const pending = pendingLabel();
  const capabilities = new Proxy(Object.freeze([CAPABILITIES.ADMIN]), {
    get: (target, property, receiver): unknown => {
      if (property === "includes") throw new Error("capability check ran before project binding");
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const result = handlePairingApproveRequest(
    { approvalWindow: pending.window, authenticator: authenticatorFor({
      principal: principal(capabilities, "project-foreign"), verdict: "AUTHENTICATED",
    }), pairing: pairing() },
    { body: bytes({ confirmationLabel: pending.confirmationLabel }), credential: CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION },
  );

  expect(result).toMatchObject({
    body: { error: { code: "CAPABILITY_DENIED" }, stage: "AUTHORIZE" },
    httpStatus: 403,
  });
});

it("refuses unavailable approval state without a token fallback", () => {
  const { confirmationLabel, window } = pendingLabel();
  const result = handlePairingApproveRequest(
    { approvalWindow: window, authenticator: authenticatorFor({
      principal: principal([CAPABILITIES.ADMIN]), verdict: "AUTHENTICATED",
    }) },
    { body: bytes({ confirmationLabel }), credential: CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION },
  );

  expect(PAIRING_APPROVE_PATH).toBe("/session/pair/approve");
  expect(result).toEqual({
    body: { code: "PAIRING_APPROVAL_UNAVAILABLE", layer: "CONTROL_ROOM_PAIRING_APPROVAL" },
    httpStatus: 503,
    kind: "REPLY",
  });
});
