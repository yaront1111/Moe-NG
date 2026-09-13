import { useEffect, useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { ReleaseEvidenceView } from "../../live/live-release.js";
import type { OfferOutcome } from "../approvals/offer-wire.js";
import { GoalRelease } from "../goals/goal-release.js";
import type { ProductInspector } from "./product-query.js";
import { ProductWorkspace } from "./product-workspace.js";
import { createFixtureProductModel } from "./fixtures/fixture-product-data.js";

afterEach(cleanup);
const evidence: ReleaseEvidenceView = { ancestryMeasured: true, criteria: [], goalId: "goal", goalTitle: "Product",
  preview: null, receipt: null, reviewRounds: [], sha: "candidate" };
const frame: SurfaceFrame = { connection: "CONNECTED", detail: "", outcome: "SURFACE", steps: [],
  offers: [{ commandId: "release-command", commandKind: "release.decide", targetAggregateId: "release:goal" }] };
const model = createFixtureProductModel("goal", "example:source");
function Panel({ name, mounted }: { name: string; mounted: (name: string) => void }) {
  useEffect(() => { mounted(name); }, [mounted, name]);
  return <p>{name} contents</p>;
}
function Workspace({ release, mounted, scope = "initial", blocked = false }: { release: React.ReactNode; mounted: (name: string) => void; scope?: string; blocked?: boolean }) {
  const [inspector, inspect] = useState<ProductInspector | null>(null);
  return <ProductWorkspace title="Product" model={model} recordScopeKey={scope} recordBlocked={blocked ? <p>Current work unavailable</p> : null} inspector={inspector} onInspect={inspect} onSelect={vi.fn()} onRefresh={vi.fn()}
    renderArtifact={() => <p>PRD canvas</p>} records={{ Definition: <Panel name="Definition" mounted={mounted} />,
      "Build plan": <Panel name="Build plan" mounted={mounted} />, Checks: <Panel name="Checks" mounted={mounted} />,
      Delivery: release, "Technical detail": <Panel name="Technical detail" mounted={mounted} /> }} />;
}

describe("product record lifetime", () => {
  it("does not mount an unvisited action panel while current evidence is unavailable", async () => {
    const user = userEvent.setup(); const mounted = vi.fn();
    const release = <Panel name="Delivery" mounted={mounted} />;
    const view = render(<Workspace blocked mounted={mounted} release={release} />);
    await user.click(screen.getByRole("button", { name: "Production record" }));
    await user.click(screen.getByRole("button", { name: "Delivery" }));
    expect(mounted).not.toHaveBeenCalled();
    expect(screen.getByText("Current work unavailable")).toBeTruthy();
    view.rerender(<Workspace mounted={mounted} release={release} />);
    expect(mounted.mock.calls).toEqual([["Delivery"]]);
  });
  it("mounts only visited action records and keeps inactive records inert", async () => {
    const user = userEvent.setup(); const mounted = vi.fn();
    render(<Workspace mounted={mounted} release={<Panel name="Delivery" mounted={mounted} />} />);
    expect(mounted).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Production record" }));
    expect(mounted.mock.calls).toEqual([["Build plan"]]);
    await user.click(screen.getByRole("button", { name: "Delivery" }));
    await user.click(screen.getByRole("button", { name: "Checks" }));
    const retained = screen.getByText("Delivery contents");
    expect(retained.closest("[hidden][inert]")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Delivery" }));
    expect(mounted.mock.calls).toEqual([["Build plan"], ["Delivery"], ["Checks"]]);
    expect(screen.queryByText("Technical detail contents")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close product inspector" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(retained.closest("[hidden][inert]")).not.toBeNull();
  });
  it("preserves one pending release and its typed base through tabs and inspector closure", async () => {
    const user = userEvent.setup(); let finish!: (outcome: OfferOutcome) => void;
    const submit = vi.fn(() => new Promise<OfferOutcome>((resolve) => { finish = resolve; }));
    render(<Workspace mounted={vi.fn()} release={<GoalRelease evidence={evidence} frame={frame} goalId="goal" port={{ submit }} />} />);
    await user.click(screen.getByRole("button", { name: "Production record" }));
    await user.click(screen.getByRole("button", { name: "Delivery" }));
    await user.clear(screen.getByTestId("cr.release.base"));
    await user.type(screen.getByTestId("cr.release.base"), "release-train");
    await user.click(screen.getByTestId("cr.release.button"));
    await user.click(screen.getByTestId("cr.release.button"));
    expect(submit).toHaveBeenCalledOnce();
    const button = screen.getByTestId("cr.release.button");
    await user.click(screen.getByRole("button", { name: "Checks" }));
    await user.click(screen.getByRole("button", { name: "Delivery" }));
    expect(screen.getByTestId("cr.release.button")).toBe(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("cr.release.base") as HTMLInputElement).value).toBe("release-train");
    await user.click(screen.getByRole("button", { name: "Close product inspector" }));
    await user.click(screen.getByRole("button", { name: "Production record" }));
    expect(screen.getByTestId("cr.release.button")).toBe(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish({ ok: false, code: "EXACT_RELEASE_REFUSAL", layer: "RELEASE_AUTHORITY" }); });
    expect(screen.getByTestId("cr.release.answer").textContent).toContain("EXACT_RELEASE_REFUSAL");
    expect(screen.getByTestId("cr.release.answer").textContent).toContain("RELEASE_AUTHORITY");
    expect(submit).toHaveBeenCalledOnce();
  });
  it("clears visited panels on an authority scope change without mounting hidden replacement actions", async () => {
    const user = userEvent.setup(); const mounted = vi.fn();
    const release = <Panel name="Delivery" mounted={mounted} />;
    const view = render(<Workspace scope="old" mounted={mounted} release={release} />);
    await user.click(screen.getByRole("button", { name: "Production record" }));
    await user.click(screen.getByRole("button", { name: "Delivery" }));
    await user.click(screen.getByRole("button", { name: "Close product inspector" }));
    view.rerender(<Workspace scope="new" mounted={mounted} release={release} />);
    expect(screen.queryByText("Delivery contents")).toBeNull();
    expect(mounted.mock.calls).toEqual([["Build plan"], ["Delivery"]]);
    await user.click(screen.getByRole("button", { name: "Production record" }));
    expect(mounted.mock.calls).toEqual([["Build plan"], ["Delivery"], ["Delivery"]]);
  });
});
