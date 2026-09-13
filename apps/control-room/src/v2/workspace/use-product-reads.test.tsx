import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSetup } from "../../live/live-config.js";
import { readPendingContract } from "../goals/gate1-approval.js";
import { readPendingContractV1 } from "../goals/gate1-v1-approval.js";
import type { Gate1ReadOutcomeV1 } from "../goals/gate1-v1-approval.js";
import { useProductReads } from "./use-product-reads.js";

vi.mock("../goals/gate1-approval.js", () => ({ readPendingContract: vi.fn() }));
vi.mock("../goals/gate1-v1-approval.js", () => ({ readPendingContractV1: vi.fn() }));
const pending = { status: "PENDING", contractId: "contract-a", revisionId: "revision-a", revisionDigest: "a".repeat(64),
  approval: null, clarifications: [], requirements: [], criteria: [] } as const;
const setupFor = (commandAuthorityPlane: "V1" | "V2", projectId: string | null = "project-a") =>
  ({ commandAuthorityPlane, projectId, headers: { "x-session": "test-session" } }) as unknown as LiveSetup;
beforeEach(() => {
  vi.mocked(readPendingContractV1).mockResolvedValue(pending);
  vi.mocked(readPendingContract).mockResolvedValue({ status: "NONE" });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "UNAVAILABLE", layer: "TEST" }), { status: 503 })));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("uncompiled product definition read", () => {
  it("makes a pending V1 definition selectable before a planning run exists", async () => {
    const setup = setupFor("V1");
    const hook = renderHook(() => useProductReads(setup, "goal-a", ""));
    await waitFor(() => expect(hook.result.current.definitionRef).toEqual({ plane: "V1", contractId: pending.contractId,
      revisionId: pending.revisionId, revisionDigest: pending.revisionDigest }));
    expect(readPendingContractV1).toHaveBeenCalledWith(setup.headers, "goal-a");
    expect(readPendingContract).not.toHaveBeenCalled();
  });
  it("uses only the bootstrap plane and preserves an absent definition", async () => {
    const setup = setupFor("V2");
    const hook = renderHook(() => useProductReads(setup, "goal-a", ""));
    await waitFor(() => expect(hook.result.current.definition).toEqual({ status: "NONE" }));
    expect(hook.result.current.definitionRef).toBeNull();
    expect(readPendingContract).toHaveBeenCalledWith(setup.headers, "goal-a", "project-a");
    expect(readPendingContractV1).not.toHaveBeenCalled();
  });
  it("cuts off a late pending revision from a previously opened goal", async () => {
    let settle!: (value: Gate1ReadOutcomeV1) => void;
    vi.mocked(readPendingContractV1).mockImplementation((_headers, goal) => goal === "goal-a"
      ? new Promise(resolve => { settle = resolve; }) : Promise.resolve({ status: "NONE" }));
    const setup = setupFor("V1");
    const hook = renderHook(({ goal }) => useProductReads(setup, goal, ""), { initialProps: { goal: "goal-a" } });
    await waitFor(() => expect(readPendingContractV1).toHaveBeenCalledOnce());
    hook.rerender({ goal: "goal-b" });
    await waitFor(() => expect(hook.result.current.definition).toEqual({ status: "NONE" }));
    await act(async () => { settle(pending); });
    expect(hook.result.current.definitionRef).toBeNull();
    expect(hook.result.current.definition).toEqual({ status: "NONE" });
  });
  it("does not ask the V2 reader to resolve an unbound project", async () => {
    const setup = setupFor("V2", null);
    const hook = renderHook(() => useProductReads(setup, "goal-a", ""));
    await waitFor(() => expect(hook.result.current.definition).toEqual({ status: "ERROR",
      code: "PROJECT_BINDING_ABSENT", layer: "CONTROL_ROOM_PRODUCT" }));
    expect(readPendingContract).not.toHaveBeenCalled();
  });
});
