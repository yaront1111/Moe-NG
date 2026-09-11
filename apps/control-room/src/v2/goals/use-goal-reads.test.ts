import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import { useGoalReads } from "./use-goal-reads.js";

function catalog(...goalIds: string[]): GoalCatalogFrame {
  return {
    connection: "CONNECTED", detail: "", outcome: "GOALS",
    goals: goalIds.map((goalId) => ({
      binding: null, brief: null, goalId, planningRunRef: `run-${goalId}`, truthClass: "DAEMON_VERIFIED",
    })),
  };
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

const POLL_MS = 100;
const GOALS = catalog("goal-a");

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("per-goal read polling", () => {
  it("keeps one batch in flight so a slow earlier poll cannot overwrite a newer answer", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useGoalReads(GOALS, read, POLL_MS));
    await act(async () => { vi.advanceTimersByTime(POLL_MS * 3); });
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.size).toBe(0);

    await act(async () => { first.resolve("first-observation"); });
    expect(result.current.get("goal-a")).toBe("first-observation");
    await act(async () => { vi.advanceTimersByTime(POLL_MS); });
    expect(read).toHaveBeenCalledTimes(2);
    // Keep the current scope's previous observation while its next read is pending.
    expect(result.current.get("goal-a")).toBe("first-observation");
    await act(async () => { second.resolve("newer-observation"); });
    expect(result.current.get("goal-a")).toBe("newer-observation");
  });

  it("waits for all goals in a batch while preserving per-goal failure isolation", async () => {
    const slow = deferred<string>();
    const read = vi.fn((goalId: string): Promise<string> => {
      if (goalId === "slow") return slow.promise;
      if (goalId === "broken") throw new Error("read failed");
      return Promise.resolve("healthy-observation");
    });
    const goals = catalog("healthy", "broken", "slow");
    const { result } = renderHook(() => useGoalReads(goals, read, POLL_MS));
    await act(async () => { vi.advanceTimersByTime(POLL_MS * 2); });
    expect(read).toHaveBeenCalledTimes(3);
    await act(async () => { slow.resolve("slow-observation"); });
    expect([...result.current]).toEqual([
      ["healthy", "healthy-observation"], ["slow", "slow-observation"],
    ]);
  });

  it("hides old session answers while the replacement reader is pending", async () => {
    const replacement = deferred<string>();
    const firstRead = vi.fn(async () => "previous-session");
    const nextRead = vi.fn(() => replacement.promise);
    const { result, rerender } = renderHook(({ read }) => useGoalReads(GOALS, read, POLL_MS), {
      initialProps: { read: firstRead as () => Promise<string> },
    });
    await act(async () => undefined);
    expect(result.current.get("goal-a")).toBe("previous-session");
    rerender({ read: nextRead });
    expect(result.current.size).toBe(0);
    await act(async () => { replacement.resolve("current-session"); });
    expect(result.current.get("goal-a")).toBe("current-session");
  });

  it("ignores a previous reader resolving after the current reader", async () => {
    const old = deferred<string>();
    const current = deferred<string>();
    const { result, rerender } = renderHook(({ read }) => useGoalReads(GOALS, read, POLL_MS), {
      initialProps: { read: () => old.promise },
    });
    rerender({ read: () => current.promise });
    await act(async () => { current.resolve("new-session-answer"); });
    expect(result.current.get("goal-a")).toBe("new-session-answer");
    await act(async () => { old.resolve("late-old-session-answer"); });
    expect(result.current.get("goal-a")).toBe("new-session-answer");
  });

  it("hides old goal answers when the catalog changes and when it returns to an earlier scope", async () => {
    const first = deferred<string>();
    const pending = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(({ goals }) => useGoalReads(goals, read, POLL_MS), {
      initialProps: { goals: GOALS },
    });
    await act(async () => { first.resolve("old-goal-a"); });
    expect(result.current.get("goal-a")).toBe("old-goal-a");
    rerender({ goals: catalog("goal-b") });
    expect(result.current.size).toBe(0);
    rerender({ goals: GOALS });
    expect(result.current.size).toBe(0);
    await act(async () => { pending.resolve("current-goal-a"); });
    expect([...result.current]).toEqual([["goal-a", "current-goal-a"]]);
  });

  it.each(["UNDELIVERED", "REFUSED", "UNREADABLE"] as const)(
    "clears answers when the catalog becomes %s", async (outcome) => {
      const read = vi.fn(async () => "prior-verified-answer");
      const { result, rerender } = renderHook(({ goals }) => useGoalReads(goals, read, POLL_MS), {
        initialProps: { goals: GOALS },
      });
      await act(async () => undefined);
      expect(result.current.size).toBe(1);
      rerender({ goals: { connection: "DISCONNECTED", detail: "unavailable", goals: [], outcome } });
      expect(result.current.size).toBe(0);
      await act(async () => { vi.advanceTimersByTime(POLL_MS * 2); });
      expect(read).toHaveBeenCalledTimes(1);
    },
  );

  it.each([null, catalog()])("clears answers when no goals are available (%j)", async (goals) => {
    const read = vi.fn(async () => "prior-answer");
    const { result, rerender } = renderHook(({ frame }) => useGoalReads(frame, read, POLL_MS), {
      initialProps: { frame: GOALS as GoalCatalogFrame | null },
    });
    await act(async () => undefined);
    expect(result.current.size).toBe(1);
    rerender({ frame: goals });
    expect(result.current.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears answers when the reader is removed", async () => {
    const read = vi.fn(async () => "prior-answer");
    const { result, rerender } = renderHook(({ reader }) => useGoalReads(GOALS, reader, POLL_MS), {
      initialProps: { reader: read as (() => Promise<string>) | undefined },
    });
    await act(async () => undefined);
    expect(result.current.size).toBe(1);
    rerender({ reader: undefined });
    expect(result.current.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not restart reads for an equivalent catalog object", async () => {
    const read = vi.fn(async () => "current-answer");
    const { result, rerender } = renderHook(({ goals }) => useGoalReads(goals, read, POLL_MS), {
      initialProps: { goals: GOALS },
    });
    await act(async () => undefined);
    const answers = result.current;
    rerender({ goals: catalog("goal-a") });
    expect(result.current).toBe(answers);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("ignores a pending answer after unmount and stops further reads", async () => {
    const pending = deferred<string>();
    const read = vi.fn(() => pending.promise);
    const { result, unmount } = renderHook(() => useGoalReads(GOALS, read, POLL_MS));
    const before = result.current;
    unmount();
    await act(async () => {
      pending.resolve("late-answer");
      vi.advanceTimersByTime(POLL_MS * 3);
    });
    expect(result.current).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
