import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { NeedsYou } from "./needs-you.js";
import type { NeedsYouData, NeedsYouItem } from "./needs-you-model.js";
import type { PreviewFacts } from "./needs-you-preview.js";
import type { PreviewDecision, PreviewFinding } from "./preview-port.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const FACTS: PreviewFacts = {
  affordance: { commandKind: "preview.decide", targetAggregateId: "preview:goal-1" },
  captures: [{ alt: "Screenshot of Read orders", url: "/preview/capture/goal-1/abc/orders.png" }],
  nodes: [
    { nodeKey: "api", nodeRef: "node-api", objective: "Serve the orders route" },
    { nodeKey: "ui", nodeRef: "node-ui", objective: "Render the orders page" },
  ],
  receiptId: "preview-receipt/abc",
  url: "http://127.0.0.1:4173/",
};

const previewItem = (preview?: PreviewFacts): NeedsYouItem => ({
  actionLabel: "Open the goal",
  detail: "Your product is running at http://127.0.0.1:4173/.",
  goalId: "goal-1",
  headline: "Your product is running and needs your verdict",
  kind: "PREVIEW",
  planningRunRef: "run-1",
  ...(preview === undefined ? {} : { preview }),
  title: "Alpha",
});

const dataWith = (item: NeedsYouItem): NeedsYouData =>
  ({ countLabel: "1 decision needs you", items: [item], note: null });

type PreviewDecideMock = ReturnType<typeof vi.fn<
  (item: NeedsYouItem, decision: PreviewDecision, findings: readonly PreviewFinding[]) => void
>>;

const renderCard = (
  over: {
    readonly item?: NeedsYouItem;
    readonly onPreviewDecide?: PreviewDecideMock | undefined;
    readonly results?: ReadonlyMap<string, { busy: boolean; outcome: unknown }>;
  } = {},
): PreviewDecideMock => {
  const onPreviewDecide: PreviewDecideMock = over.onPreviewDecide ?? vi.fn();
  render(
    <NeedsYou
      data={dataWith(over.item ?? previewItem(FACTS))}
      decisionResults={over.results as never}
      onDecide={vi.fn()}
      onOpenBoard={vi.fn()}
      onPreviewDecide={onPreviewDecide}
    />,
  );
  return onPreviewDecide;
};

describe("the Gate 2 preview card (DoD 1)", () => {
  it("shows the loopback url as a link that opens in a NEW TAB, and the captures inline", () => {
    renderCard();

    const link = screen.getByTestId("cr.needsyou.preview.link");
    expect(link.getAttribute("href")).toBe("http://127.0.0.1:4173/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");

    const shot = screen.getByAltText("Screenshot of Read orders");
    expect(shot.getAttribute("src")).toBe("/preview/capture/goal-1/abc/orders.png");
  });

  it("offers BOTH answers: approve, and send back with a finding", () => {
    renderCard();

    expect(screen.getByTestId("cr.needsyou.preview.approve").textContent).toBe("Approve it");
    expect(screen.getByTestId("cr.needsyou.preview.reject")).not.toBeNull();
  });

  it("IS ABSENT when the item carries no preview facts - not a dead control", () => {
    renderCard({ item: previewItem(undefined) });

    expect(screen.queryByTestId("cr.needsyou.preview.root")).toBeNull();
    expect(screen.queryByTestId("cr.needsyou.preview.approve")).toBeNull();
    // The rest of the card is still there: only the preview half is absent.
    expect(screen.getByText("Your product is running and needs your verdict")).not.toBeNull();
  });

  it("spends the daemon offer with APPROVE and no findings", async () => {
    const user = userEvent.setup();
    const onPreviewDecide = renderCard();

    await user.click(screen.getByTestId("cr.needsyou.preview.approve"));

    expect(onPreviewDecide).toHaveBeenCalledTimes(1);
    const call = onPreviewDecide.mock.calls[0]!;
    expect(call[1]).toBe("APPROVE");
    expect(call[2]).toStrictEqual([]);
  });
});

describe("sending the preview back with findings (DoD 3)", () => {
  it("refuses to send an empty finding, and sends one NAMED AGAINST A NODE once written", async () => {
    const user = userEvent.setup();
    const onPreviewDecide = renderCard();

    const reject = screen.getByTestId("cr.needsyou.preview.reject") as HTMLButtonElement;
    expect(reject.disabled, "no detail written yet").toBe(true);

    await user.selectOptions(screen.getByTestId("cr.needsyou.preview.node"), "node-ui");
    await user.type(screen.getByTestId("cr.needsyou.preview.detail"), "  The total is wrong.  ");
    expect(reject.disabled).toBe(false);
    await user.click(reject);

    expect(onPreviewDecide).toHaveBeenCalledTimes(1);
    const call = onPreviewDecide.mock.calls[0]!;
    expect(call[1]).toBe("REJECT");
    expect(call[2]).toStrictEqual([{ detail: "The total is wrong.", nodeRef: "node-ui" }]);
  });

  it("renders the finding AGAINST THE NAMED NODE once the daemon accepted it", async () => {
    const user = userEvent.setup();
    const onPreviewDecide: PreviewDecideMock = vi.fn();
    const { rerender } = render(
      <NeedsYou
        data={dataWith(previewItem(FACTS))}
        onDecide={vi.fn()}
        onOpenBoard={vi.fn()}
        onPreviewDecide={onPreviewDecide}
      />,
    );
    await user.type(screen.getByTestId("cr.needsyou.preview.detail"), "The total is wrong.");
    await user.click(screen.getByTestId("cr.needsyou.preview.reject"));

    rerender(
      <NeedsYou
        data={dataWith(previewItem(FACTS))}
        decisionResults={new Map([["goal-1", {
          busy: false, outcome: { commandId: "preview-1", ok: true },
        }]])}
        onDecide={vi.fn()}
        onOpenBoard={vi.fn()}
        onPreviewDecide={onPreviewDecide}
      />,
    );

    const finding = screen.getByTestId("cr.needsyou.preview.finding.node-api");
    expect(finding.textContent).toContain("node-api");
    expect(finding.textContent).toContain("The total is wrong.");
    // The path back to work is the goal itself; no board column was invented for it.
    expect(screen.getByTestId("cr.needsyou.preview.sent").textContent)
      .toContain("nothing moved on the board");
  });

  it("cannot write a finding when the daemon has named no nodes, and says so", () => {
    renderCard({ item: previewItem({ ...FACTS, nodes: [] }) });

    expect((screen.getByTestId("cr.needsyou.preview.node") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByTestId("cr.needsyou.preview.reject") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("cr.needsyou.preview.nonodes").textContent)
      .toContain("has not named this goal nodes yet");
  });

  it("disables both answers while the decision is in flight", () => {
    renderCard({ results: new Map([["goal-1", { busy: true, outcome: null }]]) });

    expect((screen.getByTestId("cr.needsyou.preview.approve") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("cr.needsyou.preview.reject") as HTMLButtonElement).disabled).toBe(true);
  });

  it("announces the outcome ONCE, and keeps the findings list outside the live region", async () => {
    const user = userEvent.setup();
    const onPreviewDecide: PreviewDecideMock = vi.fn();
    const { rerender } = render(
      <NeedsYou data={dataWith(previewItem(FACTS))} onDecide={vi.fn()} onOpenBoard={vi.fn()}
        onPreviewDecide={onPreviewDecide} />,
    );
    await user.type(screen.getByTestId("cr.needsyou.preview.detail"), "Wrong total.");
    await user.click(screen.getByTestId("cr.needsyou.preview.reject"));
    rerender(
      <NeedsYou
        data={dataWith(previewItem(FACTS))}
        decisionResults={new Map([["goal-1", { busy: false, outcome: { commandId: "c", ok: true } }]])}
        onDecide={vi.fn()} onOpenBoard={vi.fn()} onPreviewDecide={onPreviewDecide}
      />,
    );

    // EXACTLY ONE live region on the card, carrying ONE sentence. A poll re-renders the
    // queue but does not change that text, so it is announced once and not again.
    const live = document.querySelectorAll("[aria-live]");
    expect(live).toHaveLength(1);
    expect(live[0]!.getAttribute("data-testid")).toBe("cr.needsyou.preview.said");
    expect(live[0]!.textContent).toBe("Sent back. The daemon recorded your findings.");
    // The findings themselves are OUTSIDE it: a reader hears the sentence, not the list.
    expect(screen.getByTestId("cr.needsyou.preview.sent").closest("[aria-live]")).toBeNull();
    expect(screen.getByTestId("cr.needsyou.preview.shots").closest("[aria-live]")).toBeNull();
  });
});
