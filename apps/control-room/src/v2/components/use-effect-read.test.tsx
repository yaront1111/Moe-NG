import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useEffectRead } from "./use-effect-read.js";
afterEach(cleanup);
it("withholds an old scope while a changed reader is pending and ignores its late answer", async () => {
  let finish!: (value: string) => void;
  const old = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
  const current = vi.fn(async () => "current");
  const view = renderHook(({ read }) => useEffectRead(read, "failed", 60_000), { initialProps: { read: old as () => Promise<string> } });
  view.rerender({ read: current });
  expect(view.result.current.outcome).toBeNull();
  await waitFor(() => expect(view.result.current.outcome).toBe("current"));
  await act(async () => { finish("old"); });
  expect(view.result.current.outcome).toBe("current");
});
it("queues a refresh that arrives during a read", async () => {
  let finish!: (value: string) => void;
  const read = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; })).mockResolvedValue("fresh");
  const view = renderHook(() => useEffectRead<string>(read, "failed", 60_000));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  act(() => view.result.current.refresh());
  await act(async () => { finish("before-command"); });
  await waitFor(() => expect(view.result.current.outcome).toBe("fresh"));
  expect(read).toHaveBeenCalledTimes(2);
});
