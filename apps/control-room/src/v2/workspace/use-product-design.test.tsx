import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveSetup } from "../../live/live-config.js";
import { LiveDesignVersionNote } from "../goals/design-version-note.js";
import { createProductWorkspaceModel } from "./product-model-adapter.js";
import { reconcileProductArtifactHistory, selectProductArtifactHistory } from "./product-artifact-history.js";
import { useProductReads } from "./use-product-reads.js";

const setup = { headers: {}, projectId: "project", commandAuthorityPlane: "V1" } as LiveSetup;
function design(version: number) {
  return { ok: true, versions: Array.from({ length: version }, (_, index) => index + 1), record: {
    contractRef: { contractId: "contract", revisionId: "revision", revisionDigest: "a".repeat(64) },
    goalRef: "goal", projectId: "project", profile: "typescript-web-app/react-node-postgresql",
    schemaVersion: "moe-design-revision/1", submittedAt: "2026-09-13T00:00:00.000Z", version,
    revision: { apiSurface: [], componentList: [`Component${version}`], dataModel: [], openDecisions: [], screens: [],
      nonFunctional: { accessibility: "Keyboard", auth: "Session", performance: "Fast" } },
  } };
}
function serve(latest: number, pinned: number | null | "unreadable") {
  const requests: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/design/read") {
      const body = JSON.parse(String(init?.body)) as { goalRef: string; planningRunRef?: string };
      requests.push(body);
      const response = body.planningRunRef === undefined ? design(latest) : typeof pinned === "number" ? design(pinned)
        : { outcome: "REFUSED", code: pinned === null ? "DESIGN_REVISION_ABSENT" : "DESIGN_RECORD_MALFORMED", layer: "LEDGER" };
      return new Response(JSON.stringify(response), { status: 200 });
    }
    return new Response(JSON.stringify({ code: "UNAVAILABLE", layer: "TEST" }), { status: 503 });
  }));
  return requests;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("authored design observation and compiled design identity", () => {
  it("shows an authored design before the existing draft run is compiled", async () => {
    const requests = serve(1, "unreadable");
    const hook = renderHook(() => useProductReads(setup, "goal", "draft-run"));
    await waitFor(() => expect(hook.result.current.design).toMatchObject({ status: "DESIGN", record: { version: 1 } }));
    const model = createProductWorkspaceModel({ ...hook.result.current,
      scope: { connectionId: "session", projectId: "project", goalId: "goal", plane: "V1" },
      goalRef: "goal", planningRunRef: "draft-run" });
    expect(model.artifacts.find(artifact => artifact.kind === "DESIGN")).toMatchObject({ availability: "PRESENT", planningRunRef: null });
    expect(requests).toEqual([{ goalRef: "goal" }]);
  });

  it.each([1, null, "unreadable"] as const)("keeps the plan's own design selection separate from authored version 2: %s", async pinned => {
    const requests = serve(2, pinned);
    const hook = renderHook(() => useProductReads(setup, "goal", "compiled-run"));
    render(<LiveDesignVersionNote goalRef="goal" planningRunRef="compiled-run" headers={setup.headers} />);
    await waitFor(() => expect(hook.result.current.design).toMatchObject({ status: "DESIGN", record: { version: 2 } }));
    const expected = pinned === 1 ? "Design version 1" : pinned === null ? "compiled with no design" : "DESIGN_RECORD_MALFORMED";
    await waitFor(() => expect(screen.getByTestId("cr.approve.design-version").textContent).toContain(expected));
    expect(screen.getByTestId("cr.approve.design-version").textContent).not.toContain("Design version 2");
    expect(requests).toContainEqual({ goalRef: "goal" });
    expect(requests).toContainEqual({ goalRef: "goal", planningRunRef: "compiled-run" });
  });

  it("keeps the selected earlier design when the authored read advances", async () => {
    serve(1, 1);
    const hook = renderHook(() => useProductReads(setup, "goal", "compiled-run"));
    await waitFor(() => expect(hook.result.current.design).toMatchObject({ status: "DESIGN", record: { version: 1 } }));
    const subject = { scope: { connectionId: "session", projectId: "project", goalId: "goal", plane: "V1" as const },
      goalRef: "goal", planningRunRef: "compiled-run" };
    const first = { ...hook.result.current, ...subject };
    const selectedArtifactId = createProductWorkspaceModel(first).artifacts.find(artifact => artifact.kind === "DESIGN")!.id;
    const history = reconcileProductArtifactHistory(null, { ...first, selectedArtifactId }, "2026-09-13T00:00:00.000Z");
    serve(2, 1);
    await act(async () => { hook.result.current.refresh(); });
    await waitFor(() => expect(hook.result.current.design).toMatchObject({ status: "DESIGN", record: { version: 2 } }));
    const next = { ...hook.result.current, ...subject, selectedArtifactId };
    const shown = selectProductArtifactHistory(reconcileProductArtifactHistory(history, next, "2026-09-13T00:01:00.000Z"), next);
    expect(shown.historical).toBe(true);
    expect(shown.reads.design).toMatchObject({ status: "DESIGN", record: { version: 1 } });
    expect(shown.model.selection.artifact).toMatchObject({ id: selectedArtifactId, planningRunRef: null });
  });
});
