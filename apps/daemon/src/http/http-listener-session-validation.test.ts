import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { resolveOptionalDaemonPorts } from "../daemon-entry-port-resolution.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { startControlRoomListener } from "./http-listener.js";
import type { ControlRoomListener } from "./http-listener.js";
import { BEARER, NOW, PROJECT_ID, closeStores, validationFixture } from "./pairing-session-validation-test-fixtures.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { decisionPort } from "./http-test-fixtures.js";

afterAll(closeStores);
const CSRF = "validation-fixture-csrf";
async function request(listener: ControlRoomListener, binding: unknown,
  overrides: { method?: string; origin?: string; csrf?: string; credential?: string; protocol?: string } = {}) {
  const method = overrides.method ?? "POST";
  const response = await fetch(`${listener.origin}/session/validate`, { method,
    headers: { origin: overrides.origin ?? listener.origin, "content-type": "application/json",
      "x-moe-csrf": overrides.csrf ?? CSRF, "x-moe-protocol-version": overrides.protocol ?? WIRE_PROTOCOL_VERSION,
      "x-moe-session-credential": overrides.credential ?? BEARER },
    ...(method === "POST" ? { body: JSON.stringify(binding) } : {}), signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
}

describe("project pairing validation HTTP", () => {
  it("forwards actual production authority through optional port resolution and survives listener restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-pairing-validation-"));
    const storePath = join(directory, "store.sqlite");
    const provider = createStoreDependencies({ clock: () => new Date(NOW).toISOString(),
      credential: "fixture-operator", principalId: "operator-validation", projectId: PROJECT_ID, storePath });
    const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
    let listener: ControlRoomListener | undefined;
    try {
      installTestRecoveryBinding(store);
      const f = validationFixture(store);
      const realAuthority = provider.pairingOpenSessions!();
      const resolved = resolveOptionalDaemonPorts({ pairingOpenSessions: () => realAuthority,
        sessionChallengeOperands: provider.sessionChallengeOperands! });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error("port resolution refused");
      expect(resolved.ports.pairingOpenSessions).toBe(realAuthority);
      expect(typeof resolved.ports.pairingOpenSessions?.readActiveSession).toBe("function");
      const options = { csrfToken: CSRF, deps: provider.provide(), host: "127.0.0.1", port: 0, ...resolved.ports };
      const first = await startControlRoomListener(options);
      if (!first.ok) throw new Error(first.code);
      listener = first;
      expect(await request(listener, f.binding)).toMatchObject({ status: 401,
        body: { ok: false, code: "PAIRING_SESSION_INVALID", layer: "CONTROL_ROOM_PAIRING_SESSION" } });
      const opened = f.open();
      const before = store.readEvents(opened.receipt.aggregateId);
      expect(await request(listener, f.binding)).toEqual({ status: 200, cache: "no-store",
        body: { ok: true, projectId: PROJECT_ID } });
      await listener.close(); listener = undefined;
      const second = await startControlRoomListener(options);
      if (!second.ok) throw new Error(second.code);
      listener = second;
      expect(await request(listener, f.binding)).toMatchObject({ status: 200, body: { ok: true, projectId: PROJECT_ID } });
      expect(store.readEvents(opened.receipt.aggregateId)).toEqual(before);
    } finally {
      await listener?.close(); store.close(); provider.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("applies actual origin, CSRF, method, bearer and protocol guards", async () => {
    const f = validationFixture(); f.open();
    const started = await startControlRoomListener({ csrfToken: CSRF, host: "127.0.0.1", port: 0,
      deps: { authenticator: f.authenticator, registry: new Map(), decisions: decisionPort() },
      pairingOpenSessions: f.authority, sessionChallengeOperands: f.operands });
    if (!started.ok) throw new Error(started.code);
    try {
      expect(await request(started, f.binding, { origin: "http://foreign.invalid" })).toMatchObject({ status: 403,
        body: { code: "LISTENER_ORIGIN_INVALID", layer: "CONTROL_ROOM_LISTENER" } });
      expect(await request(started, f.binding, { csrf: "wrong" })).toMatchObject({ status: 403,
        body: { code: "LISTENER_CSRF_INVALID", layer: "CONTROL_ROOM_LISTENER" } });
      expect(await request(started, f.binding, { method: "GET" })).toMatchObject({ status: 405,
        body: { ok: false, code: "PAIRING_SESSION_REQUEST_INVALID", layer: "CONTROL_ROOM_PAIRING_SESSION" } });
      expect(await request(started, f.binding, { credential: "wrong" })).toMatchObject({ status: 401,
        body: { ok: false, stage: "AUTHENTICATE", error: { code: "AUTHENTICATION_FAILED" } } });
      expect(await request(started, f.binding, { protocol: "wrong" })).toMatchObject({ status: 422,
        body: { ok: false, stage: "COMPATIBILITY", error: { code: "DISTRIBUTION_MISMATCH" } } });
    } finally { await started.close(); }
  });
});
