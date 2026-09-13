import { describe, expect, it, vi } from "vitest";

import { connectProjectManager, PROJECT_MANAGER_SCHEMA_VERSION } from "./project-manager-client.js";
import type { ProjectManagerFetch } from "./project-manager-client.js";

const UNAVAILABLE = {
  code: "OPERATOR_CHANNEL_UNAVAILABLE", layer: "PROJECT_MANAGER_HTTP", ok: false,
} as const;
const PAIRING = { confirmationLabel: "abcd-ef01-2345", ok: true, requestId: "ab".repeat(32) };

function json(value: unknown, status = 200): Response {
  return { json: async () => value, ok: status >= 200 && status < 300, status } as Response;
}

async function connect(stage: "request" | "claim", response: Response) {
  const fetchImpl = vi.fn<ProjectManagerFetch>(async (path) => {
    if (path === "/manager/bootstrap") return json({
      authenticated: false, csrfToken: "manager-csrf", schemaVersion: PROJECT_MANAGER_SCHEMA_VERSION,
    });
    if (path === "/manager/session/pair/request") return stage === "request" ? response : json(PAIRING);
    if (path === "/manager/session/pair/claim") return response;
    throw new Error("unexpected downstream request");
  });
  const initial = await connectProjectManager({ fetchImpl });
  if (stage === "request") return { fetchImpl, result: initial };
  if (!("status" in initial)) throw new Error("expected initial pairing request");
  return { fetchImpl, result: await initial.claim() };
}

describe.each(["request", "claim"] as const)("manager operator channel at %s", (stage) => {
  it("preserves the exact HTTP refusal without exposing pairing controls or reading projects", async () => {
    const { fetchImpl, result } = await connect(stage, json(UNAVAILABLE, 403));
    expect(result).toEqual(UNAVAILABLE);
    expect(result).not.toHaveProperty("claim");
    expect(result).not.toHaveProperty("confirmationLabel");
    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual([
      "/manager/bootstrap", "/manager/session/pair/request",
      ...(stage === "claim" ? ["/manager/session/pair/claim"] : []),
    ]);
  });

  it.each([
    ["wrong layer", { ...UNAVAILABLE, layer: "CONTROL_ROOM_PAIRING_APPROVAL" }, 403],
    ["success flag", { ...UNAVAILABLE, ok: true }, 403],
    ["extra fields", { ...UNAVAILABLE, confirmationLabel: PAIRING.confirmationLabel }, 403],
    ["success status", UNAVAILABLE, 200],
  ])("does not infer channel failure from %s", async (_name, value, status) => {
    const { result } = await connect(stage, json(value, status as number));
    expect(result).toEqual({
      code: "PROJECT_MANAGER_PAIRING_REFUSED", layer: "CONTROL_ROOM_PROJECT_MANAGER", ok: false,
    });
  });
});
