import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { useWorkspaceSurface } from "./use-workspace-surface.js";

const feeds = vi.hoisted(() => [] as { onFrame: (frame: SurfaceFrame) => void; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[]);
vi.mock("../../live/live-board-feed.js", () => ({ createBoardFeed: (options: { onFrame: (frame: SurfaceFrame) => void }) => {
  const feed = { ...options, start: vi.fn(), stop: vi.fn() }; feeds.push(feed); return feed;
} }));
afterEach(() => { cleanup(); feeds.length = 0; });
const frame: SurfaceFrame = { connection: "CONNECTED", detail: "", offers: [{ commandId: "exact-grant" }], outcome: "SURFACE", steps: [] };
describe("workspace surface lifetime", () => {
  it("polls without mounting a technical screen and preserves exact offers", () => {
    const headers = {}; const report = vi.fn();
    const hook = renderHook(() => useWorkspaceSurface(headers, "a", report));
    expect(feeds[0]?.start).toHaveBeenCalledOnce();
    act(() => feeds[0]!.onFrame(frame));
    expect(hook.result.current).toBe(frame);
    expect(report).toHaveBeenCalledWith("CONNECTED");
    hook.unmount(); expect(feeds[0]?.stop).toHaveBeenCalledOnce();
  });
  it("cuts off old subject and session frames immediately", () => {
    const oldHeaders = {}; const newHeaders = {};
    const hook = renderHook(({ headers, subject }) => useWorkspaceSurface(headers, subject), {
      initialProps: { headers: oldHeaders, subject: "a" },
    });
    act(() => feeds[0]!.onFrame(frame));
    hook.rerender({ headers: newHeaders, subject: "b" });
    expect(hook.result.current).toBeNull();
    act(() => feeds[0]!.onFrame(frame));
    expect(hook.result.current).toBeNull();
    expect(feeds[0]?.stop).toHaveBeenCalledOnce();
  });
});
