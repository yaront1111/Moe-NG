import { afterAll, describe, expect, it, vi } from "vitest";
import { RECOVERY_BINDING_CODEC_VERSION } from "@moe/store";
import { handlePairingSessionValidation } from "./pairing-session-validation.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { BEARER, NOW, PROJECT_ID, closeStores, validationFixture } from "./pairing-session-validation-test-fixtures.js";
import { SESSION_TTL_MS } from "../identity/session-authority-contracts.js";

afterAll(closeStores);
const invalid = { httpStatus: 401, body: { ok: false, code: "PAIRING_SESSION_INVALID", layer: "CONTROL_ROOM_PAIRING_SESSION" } };
const unavailable = { httpStatus: 503, body: { ok: false, code: "PAIRING_SESSION_UNAVAILABLE", layer: "CONTROL_ROOM_PAIRING_SESSION" } };
type Fixture = ReturnType<typeof validationFixture>;
function read(f: Fixture, binding: unknown = f.binding, credential: string | null = BEARER,
  dependencies: Partial<Parameters<typeof handlePairingSessionValidation>[0]> = {}) {
  return handlePairingSessionValidation({ authenticator: f.authenticator, pairingOpenSessions: f.authority,
    sessionChallengeOperands: f.operands, ...dependencies }, { credential, protocolVersion: WIRE_PROTOCOL_VERSION,
    body: new TextEncoder().encode(JSON.stringify(binding)) });
}

describe("completed project pairing validation", () => {
  it("validates a real signed open joined to its approved bearer without appending events", () => {
    const f = validationFixture(), opened = f.open();
    const before = f.store.readEvents(opened.receipt.aggregateId);
    expect(read(f)).toEqual({ httpStatus: 200, body: { ok: true, projectId: PROJECT_ID } });
    expect(read(f)).toEqual({ httpStatus: 200, body: { ok: true, projectId: PROJECT_ID } });
    expect(f.store.readEvents(opened.receipt.aggregateId)).toEqual(before);
  });

  it("refuses a claim-only bearer even though ordinary HTTP authentication accepts it", () => {
    const f = validationFixture();
    expect(f.authenticator.authenticate(BEARER).verdict).toBe("AUTHENTICATED");
    expect(read(f)).toEqual(invalid);
  });

  it.each(["sessionId", "credentialId", "clientKeyId", "generation"] as const)("refuses a foreign %s binding", field => {
    const f = validationFixture(); f.open();
    expect(read(f, { ...f.binding, [field]: field === "generation" ? 2 : field === "clientKeyId" ? "ab".repeat(32) : "foreign" })).toEqual(invalid);
  });

  it.each(["principal", "project"] as const)("refuses an authenticated foreign %s", field => {
    const f = validationFixture(); f.open();
    const principal = { principalId: f.claimed.principalId, projectId: PROJECT_ID, capabilities: ["goal.write"] };
    const authenticate = () => ({ verdict: "AUTHENTICATED" as const,
      principal: { ...principal, [field === "principal" ? "principalId" : "projectId"]: "foreign" } });
    expect(read(f, f.binding, BEARER, { authenticator: { authenticate } })).toEqual(invalid);
  });

  it("requires control-room transport in the signed session", () => {
    const f = validationFixture(); f.open("coordination.v1");
    expect(read(f)).toEqual(invalid);
  });

  it("refuses a genuinely closed signed session while the bearer remains valid", () => {
    const f = validationFixture(); f.open();
    expect(f.close()).toMatchObject({ ok: true, authority: { session: { status: "CLOSED" } } });
    expect(f.authenticator.authenticate(BEARER).verdict).toBe("AUTHENTICATED");
    expect(read(f)).toEqual(invalid);
  });

  it("refuses a revoked old credential after a real signed rotation", () => {
    const f = validationFixture(); f.open();
    expect(f.rotate()).toMatchObject({ ok: true, revokedCredential: { revoked: true } });
    expect(read(f)).toEqual(invalid);
  });

  it("refuses at the exact keyed expiry without extending the bearer lifetime", () => {
    const f = validationFixture(); f.open();
    f.setNow(NOW + SESSION_TTL_MS - 1);
    expect(read(f).httpStatus).toBe(200);
    f.setNow(NOW + SESSION_TTL_MS);
    expect(f.authenticator.authenticate(BEARER).verdict).toBe("AUTHENTICATED");
    expect(read(f)).toEqual(invalid);
  });

  it("preserves the existing recovery replay refusal before reading opened authority", () => {
    const f = validationFixture(); f.open();
    expect(f.store.installRecoveryBinding({ bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
      incarnationRef: "a1".repeat(32), keyEpochRef: "a2".repeat(32), installedAt: new Date(NOW).toISOString(),
      payload: new TextEncoder().encode("replacement"), slot: "ACTIVE" })).toMatchObject({ ok: true });
    const held = vi.fn(f.authority.readActiveSession);
    expect(read(f, f.binding, BEARER, { pairingOpenSessions: { ...f.authority, readActiveSession: held } }))
      .toMatchObject({ httpStatus: 401, body: { ok: false, outcome: "PORT_REFUSED",
      stage: "AUTHENTICATE", refusal: { code: "SESSION_REPLAYED", layer: "IDENTITY" } } });
    expect(held).not.toHaveBeenCalled();
  });

  it("checks current recovery operands even when an authenticated test port admits the bearer", () => {
    const f = validationFixture(); f.open();
    const current = f.operands.readOperands(f.claimed.principalId);
    if (current.outcome !== "OPERANDS") throw new Error("fixture operands absent");
    expect(read(f, f.binding, BEARER, { sessionChallengeOperands: { boundProjectId: PROJECT_ID,
      readOperands: () => ({ ...current, operands: { ...current.operands, keyEpochRef: "ff".repeat(32) } }) } })).toEqual(invalid);
  });

  it.each([null, "unknown-bearer"])("preserves authentication failure and stops downstream for %s", credential => {
    const f = validationFixture();
    const readActiveSession = vi.fn(() => { throw new Error("must not read"); });
    expect(read(f, f.binding, credential, { pairingOpenSessions: { ...f.authority, readActiveSession } }))
      .toMatchObject({ httpStatus: 401, body: { ok: false, outcome: "REFUSED", stage: "AUTHENTICATE",
        error: { code: "AUTHENTICATION_FAILED" } } });
    expect(readActiveSession).not.toHaveBeenCalled();
  });

  it.each([{}, null, { extra: true }, { sessionId: "s", credentialId: "c", clientKeyId: "aa".repeat(32), generation: 0 }])
  ("refuses malformed selectors without reading authority: %o", body => {
    const f = validationFixture();
    const readActiveSession = vi.fn(() => { throw new Error("must not read"); });
    expect(read(f, body, BEARER, { pairingOpenSessions: { ...f.authority, readActiveSession } })).toEqual({
      httpStatus: 400, body: { ok: false, code: "PAIRING_SESSION_REQUEST_INVALID", layer: "CONTROL_ROOM_PAIRING_SESSION" },
    });
    expect(readActiveSession).not.toHaveBeenCalled();
  });

  it("keeps unavailable authority distinct from a refused completed session", () => {
    const f = validationFixture();
    expect(read(f, f.binding, BEARER, { pairingOpenSessions: undefined })).toEqual(unavailable);
    expect(read(f, f.binding, BEARER, { sessionChallengeOperands: undefined })).toEqual(unavailable);
    expect(read(f, f.binding, BEARER, { pairingOpenSessions: { ...f.authority,
      readActiveSession: () => ({ status: "UNKNOWN", code: "SESSION_AUTHORITY_UNREADABLE" }) } })).toEqual(unavailable);
  });
});
