import { readFileSync } from "node:fs";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { DesignOutcome } from "../../live/live-design.js";
import { DesignCard, LiveDesign } from "./design-card.js";

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const DESIGN: Extract<DesignOutcome, { status: "DESIGN" }> = {
  status: "DESIGN", versions: [1, 2],
  record: {
    contractRef: { contractId: "contract-1", revisionDigest: "a".repeat(64), revisionId: "rev-1" },
    goalRef: "goal-1", projectId: "project-1", profile: "typescript-web-app/react-node-postgresql",
    schemaVersion: "moe-design-revision/1", submittedAt: "2026-09-05T09:00:00.000Z", version: 2,
    revision: {
      apiSurface: [{ route: "GET /orders", payload: "{ orders }" }], componentList: ["OrderList"],
      dataModel: [{ entity: "Order", fields: ["id"], relations: ["Customer.id"] }],
      nonFunctional: { auth: "Session cookie", accessibility: "Keyboard support", performance: "p95 200ms" },
      openDecisions: ["Allow exports?"],
      screens: [{ journey: "Read orders", screens: [{ screen: "Orders", states: ["LOADED"] }] }],
    },
  },
};

describe("DesignCard", () => {
  it("is mounted on the opened goal with the attached session", () => {
    const source = readFileSync("src/v2/cordum-app.tsx", "utf8");
    expect(source).toContain('import { LiveDesign } from "./goals/design-card.js";');
    expect(source).toContain('<LiveDesign goalRef={open.goalId} headers={attached.headers} />');
  });

  it("shows all five sections, open decisions and the stored version", () => {
    render(<DesignCard outcome={DESIGN} />);
    expect(screen.getByTestId("cr.design.version").textContent).toContain("Version 2");
    for (const heading of ["Screens and journeys", "Data model", "API surface", "Components", "Non-functional decisions", "Open decisions"]) {
      expect(screen.getByRole("heading", { name: heading }).textContent).toBe(heading);
    }
    const body = screen.getByTestId("cr.design.body").textContent;
    for (const text of ["Order", "Customer.id", "GET /orders", "OrderList", "Session cookie", "LOADED", "Allow exports?"]) {
      expect(body).toContain(text);
    }
  });

  it("renders no design and a declared skip in words", () => {
    const { rerender } = render(<DesignCard outcome={{ code: "DESIGN_REVISION_ABSENT", layer: "LEDGER", status: "REFUSED" }} />);
    expect(screen.getByTestId("cr.design.none").textContent).toBe("This goal has no design yet.");
    rerender(<DesignCard outcome={{ ...DESIGN, record: { ...DESIGN.record, revision: { skipped: true, reason: "Internal CLI tool" } } }} />);
    expect(screen.getByTestId("cr.design.none").textContent).toBe("The design step was skipped. Internal CLI tool");
    expect(screen.getByTestId("cr.design.version").textContent).toContain("Version 2");
  });

  it("names loading and preserves the exact refusal code and layer", () => {
    const { rerender } = render(<DesignCard outcome={null} />);
    expect(screen.getByTestId("cr.design.loading").textContent).toBe("Reading the design...");
    for (const status of ["REFUSED", "ERROR"] as const) {
      rerender(<DesignCard outcome={{ code: "DESIGN_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_DESIGN", status }} />);
      expect(screen.getByTestId("cr.design.refusal").textContent).toContain("DESIGN_RESPONSE_INVALID @ CONTROL_ROOM_LIVE_DESIGN");
      expect(screen.queryByTestId("cr.design.body")).toBeNull();
    }
  });

  it("keeps empty design sections explicit and treats stored text as text", () => {
    render(<DesignCard outcome={{ ...DESIGN, record: { ...DESIGN.record, revision: {
      apiSurface: [], componentList: [], dataModel: [], screens: [], openDecisions: [],
      nonFunctional: { auth: "<script>text only</script>", accessibility: "Keyboard", performance: "200ms" },
    } } }} />);
    expect(screen.getAllByText("None recorded.")).toHaveLength(5);
    expect(screen.getByTestId("cr.design.body").textContent).toContain("<script>text only</script>");
    expect(document.querySelector("script")).toBeNull();
  });
});

describe("LiveDesign", () => {
  it("reads once per goal and ignores a late answer for the previous goal", async () => {
    let settle: (outcome: DesignOutcome) => void = () => { throw new Error("not started"); };
    const read = vi.fn((goal: string): Promise<DesignOutcome> => goal === "old"
      ? new Promise((resolve) => { settle = resolve; }) : Promise.resolve(DESIGN));
    const headers = {};
    const { rerender } = render(<LiveDesign goalRef="old" headers={headers} read={read} />);
    expect(screen.getByTestId("cr.design.loading").textContent).toBe("Reading the design...");
    rerender(<LiveDesign goalRef="goal-1" headers={headers} read={read} />);
    await screen.findByTestId("cr.design.body");
    await act(async () => settle({ status: "REFUSED", code: "DESIGN_REVISION_ABSENT", layer: "LEDGER" }));
    expect(screen.getByTestId("cr.design.body").textContent).toContain("Order");
    expect(read.mock.calls).toStrictEqual([["old"], ["goal-1"]]);
  });

  it("makes thrown reads visible and uses current headers for its default reader", async () => {
    const { unmount } = render(<LiveDesign goalRef="goal-1" headers={{}} read={async () => { throw new Error("offline"); }} />);
    expect((await screen.findByTestId("cr.design.refusal")).textContent).toContain("DESIGN_READ_FAILED @ CONTROL_ROOM_GOALS");
    unmount();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: "DESIGN_REVISION_ABSENT", layer: "LEDGER" })));
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(<LiveDesign goalRef="goal-1" headers={{ "x-session": "first" }} />);
    await screen.findByTestId("cr.design.none");
    rerender(<LiveDesign goalRef="goal-2" headers={{ "x-session": "second" }} />);
    await screen.findByTestId("cr.design.none");
    expect(fetcher).toHaveBeenLastCalledWith("/design/read", expect.objectContaining({
      body: JSON.stringify({ goalRef: "goal-2" }), headers: { "x-session": "second" },
    }));
  });
});
