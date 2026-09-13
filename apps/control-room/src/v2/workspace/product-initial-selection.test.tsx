import { useLayoutEffect, useRef } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveSetup } from "../../live/live-config.js";
import { LiveProductWorkspace } from "./live-product-workspace.js";
import { useProductRoute } from "./use-product-route.js";

vi.mock("./use-workspace-surface.js", () => ({ useWorkspaceSurface: () => null }));
vi.mock("../../live/live-goal-catalog.js", () => ({ readGoalCatalog: async () => ({ outcome: "GOALS", goals: [
  { goalId: "goal", planningRunRef: "", brief: { title: "Product" } },
] }) }));
vi.mock("./use-product-reads.js", () => ({ useProductReads: () => ({
  source: { status: "GOAL_SOURCE", text: "PRD", contentSha256: "source", sourceRef: "source", displayPath: "PRD.md" },
  design: { status: "REFUSED", code: "DESIGN_REVISION_ABSENT", layer: "LEDGER" },
  coverage: null, criteria: { status: "ERROR", code: "UNAVAILABLE", layer: "TEST" },
  preview: { status: "ERROR", code: "UNAVAILABLE", layer: "TEST" },
  release: { status: "ERROR", code: "UNAVAILABLE", layer: "TEST" },
  definition: { status: "NONE" }, definitionRef: null, refresh: vi.fn(),
}) }));
const setup = { headers: {}, projectId: "project", commandAuthorityPlane: "V1" } as LiveSetup;
type Navigation = ReturnType<typeof useProductRoute>;
type Action = "inspector" | "artifact" | "other-goal" | "back";

function NewerNavigation({ navigation, action }: { navigation: Navigation; action: Action }) {
  const changed = useRef(false);
  useLayoutEffect(() => {
    if (changed.current) return;
    changed.current = true;
    if (action === "back") navigation.back();
    else if (action === "other-goal") navigation.openProduct("other-goal", "other-run", "Other product");
    else if (navigation.query !== null) navigation.update({ ...navigation.query,
      ...(action === "inspector" ? { inspector: "record" as const } : { artifactId: "user-selected" }) });
  }, [navigation, action]);
  return null;
}
function Race({ action }: { action: Action }) {
  const navigation = useProductRoute(setup, "");
  return <><output data-testid="query">{JSON.stringify(navigation.query)}</output>
    {navigation.open?.goalId !== "goal" || navigation.query === null ? null : <>
      <LiveProductWorkspace setup={setup} route={navigation.open} query={navigation.query} update={navigation.update}
        onBack={navigation.back} onNeedsYou={vi.fn()} onConnection={vi.fn()} />
      <NewerNavigation navigation={navigation} action={action} />
    </>}
  </>;
}
beforeEach(() => { window.history.replaceState(null, "", "/?product=goal"); });
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

it.each(["inspector", "artifact", "other-goal", "back"] as const)("initial artifact pin preserves newer %s navigation in the same commit", async action => {
  render(<Race action={action} />);
  await waitFor(() => {
    const query = JSON.parse(screen.getByTestId("query").textContent ?? "null");
    if (action === "inspector") expect(query).toEqual({ goalId: "goal", artifactId: "source:source", inspector: "record" });
    else if (action === "artifact") expect(query).toEqual({ goalId: "goal", artifactId: "user-selected", inspector: null });
    else if (action === "other-goal") expect(query?.goalId).toBe("other-goal");
    else expect(query).toBeNull();
  });
  if (action === "inspector") expect(screen.getByRole("complementary", { name: "Production record" })).toBeTruthy();
});
