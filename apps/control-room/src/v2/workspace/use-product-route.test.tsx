import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveSetup } from "../../live/live-config.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import { FIXTURE_GOALS_DATA } from "../goals/goals-fixtures.js";
import { useProductRoute } from "./use-product-route.js";
const read = vi.hoisted(() => vi.fn());
vi.mock("../../live/live-goal-catalog.js", () => ({ readGoalCatalog: read }));
const setup = (name: string) => ({ headers: { "x-test": name }, projectId: name } as unknown as LiveSetup);
const catalog = (goals: readonly string[]): GoalCatalogFrame => ({ connection: "CONNECTED", detail: "", outcome: "GOALS",
  goals: goals.map((goalId) => ({ goalId, planningRunRef: `run-${goalId}`, brief: { title: `Product ${goalId}`, instructions: "Build it" }, binding: null, truthClass: "DAEMON_VERIFIED" })) });
afterEach(() => { cleanup(); read.mockReset(); window.history.replaceState(null, "", "/"); });

describe("authenticated product links", () => {
  it("resolves the requested product instead of taking the first catalog entry", async () => {
    const attached = setup("project"); read.mockResolvedValue(catalog(["first", "chosen"]));
    const hook = renderHook(() => useProductRoute(attached, "?product=chosen&inspect=requirements&artifact=version-a"));
    expect(hook.result.current.open).toBeNull();
    await waitFor(() => expect(hook.result.current.open?.goalId).toBe("chosen"));
    expect(hook.result.current.open?.planningRunRef).toBe("run-chosen");
    expect(hook.result.current.query).toEqual({ goalId: "chosen", inspector: "requirements", artifactId: "version-a" });
    expect(read).toHaveBeenCalledWith({ headers: attached.headers });
  });
  it("refuses a missing or duplicated catalog identity without opening another product", async () => {
    const attached = setup("project"); read.mockResolvedValue(catalog(["other"]));
    const hook = renderHook(() => useProductRoute(attached, "?product=unknown"));
    await waitFor(() => expect(hook.result.current.error).toContain("not in the connected project's catalog"));
    expect(hook.result.current.open).toBeNull();
  });
  it("rejects a late answer from the previous authenticated project", async () => {
    let finishOld!: (value: GoalCatalogFrame) => void;
    read.mockImplementationOnce(() => new Promise<GoalCatalogFrame>((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce(catalog(["other"]));
    const hook = renderHook(({ attached }) => useProductRoute(attached, "?product=chosen"), { initialProps: { attached: setup("a") } });
    hook.rerender({ attached: setup("b") });
    await waitFor(() => expect(hook.result.current.error).not.toBeNull());
    await act(async () => { finishOld(catalog(["chosen"])); });
    expect(hook.result.current.open).toBeNull();
  });
  it("restores product and inspector on browser Back without treating selection as authority", async () => {
    const attached = setup("project"); read.mockResolvedValue(catalog(["chosen"]));
    const hook = renderHook(() => useProductRoute(attached, ""));
    act(() => {
      window.history.replaceState(null, "", "/?product=chosen&artifact=old&inspect=readiness");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(hook.result.current.open?.goalId).toBe("chosen"));
    expect(hook.result.current.query?.artifactId).toBe("old");
    expect(hook.result.current.query?.inspector).toBe("readiness");
    act(() => hook.result.current.back());
    expect(hook.result.current.open).toBeNull();
    expect(window.location.search).toBe("");
  });
  it("restores a fixture link without contacting a daemon", async () => {
    const goal = FIXTURE_GOALS_DATA.goals[0]!;
    const hook = renderHook(() => useProductRoute(null, `?fixtures=1&product=${encodeURIComponent(goal.goalId)}`, FIXTURE_GOALS_DATA));
    await waitFor(() => expect(hook.result.current.open?.title).toBe(goal.title));
    expect(read).not.toHaveBeenCalled();
  });
  it("refuses malformed URL state without a catalog read", () => {
    const hook = renderHook(() => useProductRoute(setup("a"), "?product=a&product=b"));
    expect(hook.result.current.error).toBe("This product link is invalid.");
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["/?product=chosen&artifact=user&inspect=record", "/?product=missing", "/?product=a&product=b", "/"])(
    "does not let a deferred initial pin replace restored navigation %s", async location => {
      const attached = setup("project"); read.mockResolvedValue(catalog(["chosen"]));
      const hook = renderHook(() => useProductRoute(attached, "?product=chosen"));
      await waitFor(() => expect(hook.result.current.open?.goalId).toBe("chosen"));
      const update = hook.result.current.update;
      act(() => {
        window.history.replaceState(null, "", location);
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      const restored = window.location.search;
      const replace = vi.spyOn(window.history, "replaceState");
      act(() => update(current => current?.goalId === "chosen" && current.artifactId === null
        ? { ...current, artifactId: "automatic" } : current, true));
      expect(window.location.search).toBe(restored);
      expect(replace).not.toHaveBeenCalled();
      if (location.includes("product=a&product=b")) expect(hook.result.current.error).toContain("invalid");
      replace.mockRestore();
    });
  it("rejects a deferred initial pin from the previous authenticated setup", async () => {
    read.mockResolvedValue(catalog(["chosen"]));
    const hook = renderHook(({ attached }) => useProductRoute(attached, "?product=chosen"), { initialProps: { attached: setup("first") } });
    await waitFor(() => expect(hook.result.current.open?.goalId).toBe("chosen"));
    const oldUpdate = hook.result.current.update;
    hook.rerender({ attached: setup("second") });
    await waitFor(() => expect(hook.result.current.open?.goalId).toBe("chosen"));
    act(() => oldUpdate(current => current?.goalId === "chosen" && current.artifactId === null
      ? { ...current, artifactId: "previous-session-artifact" } : current, true));
    expect(hook.result.current.query?.artifactId).toBeNull();
  });
});
