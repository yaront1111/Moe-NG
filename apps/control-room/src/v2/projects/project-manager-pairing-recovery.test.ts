import { describe, expect, it, vi } from "vitest";

import { connectProjectManager, PROJECT_MANAGER_SCHEMA_VERSION } from "./project-manager-client.js";
import type { ProjectManagerFetch } from "./project-manager-client.js";

const LAYER = "CONTROL_ROOM_PAIRING_APPROVAL";
const FALLBACK = { code: "PROJECT_MANAGER_PAIRING_REFUSED", layer: "CONTROL_ROOM_PROJECT_MANAGER", ok: false };
function json(value: unknown, status = 200): Response {
  return { json: async () => value, ok: status >= 200 && status < 300, status } as Response;
}
async function claim(value: unknown, status: number) {
  const fetchImpl = vi.fn<ProjectManagerFetch>(async (path) => {
    if (path === "/manager/bootstrap") return json({
      authenticated: false, csrfToken: "test-csrf", schemaVersion: PROJECT_MANAGER_SCHEMA_VERSION,
    });
    if (path === "/manager/session/pair/request") return json({
      confirmationLabel: "abcd-ef01-2345", ok: true, requestId: "ab".repeat(32),
    });
    if (path === "/manager/session/pair/claim") return json(value, status);
    throw new Error("unexpected downstream read");
  });
  const pending = await connectProjectManager({ fetchImpl });
  if (!("status" in pending)) throw new Error("expected pairing");
  return { fetchImpl, pending, result: await pending.claim() };
}

describe("manager pairing recovery details", () => {
  it.each([
    ["PAIRING_REQUEST_EXPIRED", 410],
    ["PAIRING_REQUEST_ALREADY_CLAIMED", 410],
    ["PAIRING_REQUEST_UNKNOWN", 404],
  ])("preserves exact %s refusal and stops before loading projects", async (code, status) => {
    const refusal = { code, layer: LAYER, ok: false };
    const { fetchImpl, result } = await claim(refusal, status as number);
    expect(result).toEqual(refusal);
    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual([
      "/manager/bootstrap", "/manager/session/pair/request", "/manager/session/pair/claim",
    ]);
  });

  it.each([
    ["wrong layer", { code: "PAIRING_REQUEST_EXPIRED", layer: "FOREIGN_LAYER", ok: false }, 410],
    ["extra fields", { code: "PAIRING_REQUEST_EXPIRED", layer: LAYER, ok: false, detail: "untrusted" }, 410],
    ["success flag", { code: "PAIRING_REQUEST_EXPIRED", layer: LAYER, ok: true }, 410],
    ["wrong status", { code: "PAIRING_REQUEST_EXPIRED", layer: LAYER, ok: false }, 403],
    ["success status", { code: "PAIRING_REQUEST_EXPIRED", layer: LAYER, ok: false }, 200],
    ["unknown refusal", { code: "PAIRING_NEW_REFUSAL", layer: LAYER, ok: false }, 410],
    ["pending wrong layer", { code: "PAIRING_APPROVAL_REQUIRED", layer: "FOREIGN_LAYER", ok: false }, 409],
    ["pending success flag", { code: "PAIRING_REQUEST_BUSY", layer: LAYER, ok: true }, 409],
    ["pending extra fields", { code: "PAIRING_APPROVAL_REQUIRED", layer: LAYER, ok: false, extra: true }, 409],
  ])("uses generic recovery for %s", async (_name, value, status) => {
    expect((await claim(value, status as number)).result).toEqual(FALLBACK);
  });

  it.each(["PAIRING_APPROVAL_REQUIRED", "PAIRING_REQUEST_BUSY"])("keeps exact %s retryable", async (code) => {
    const { pending, result } = await claim({ code, layer: LAYER, ok: false }, 409);
    expect(result).toBe(pending);
  });
});
