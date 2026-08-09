import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { UNSTATED } from "../data/data-contract.js";
import { UNKNOWN_FACT_VALUE } from "../nodes/node-authority.js";
import { PROVENANCE_SHORTCUT_KEY } from "../shell/provenance-panel.js";
import { TIMELINE_TRUNCATION_CODE } from "./timeline-contract.js";
import type {
  TimelineCursorState,
  TimelineEventRow,
  TimelineProvenance,
  TimelineRejectedRow,
  TimelineRestartGapRow,
  TimelineRow,
  TimelineSourcePage,
} from "./timeline-contract.js";
import type { TimelinePageSource } from "./timeline-page.js";
import { TimelineList } from "./timeline-list.js";
import type { TimelineListProps } from "./timeline-list.js";

/**
 * The timeline surface renders daemon truth and nothing else.
 *
 * It never sorts, ranks, or upgrades a row, and it never closes a gap. A rejected command
 * and a restart marker are FIRST-CLASS ROWS: neither may be a toast, a badge, or a thing
 * that scrolls past unrendered, because both are exactly the facts an operator is looking
 * for when they open this surface.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

function provenanceOf(over: Partial<TimelineProvenance> = {}): TimelineProvenance {
  return {
    actor: "w-3",
    aggregateId: "api-endpnt",
    commandId: "cmd-4819",
    effectId: "eff-4819",
    eventId: "evt-4819",
    leaseEpoch: 7,
    sessionId: "session-w-3",
    timestamp: "2026-08-09T09:41:02.000Z",
    typedLink: { kind: "receipt", label: "Runner receipt", ref: "receipt/rcpt-4819" },
    ...over,
  };
}

function eventRow(sequence: number, over: Partial<TimelineProvenance> = {}): TimelineEventRow {
  return {
    eventType: "step.finish",
    kind: "EVENT",
    provenance: provenanceOf({ eventId: `evt-${String(sequence)}`, ...over }),
    sequence,
    summary: `step.finish (w-3, epoch 7)`,
    truthClass: "DAEMON_VERIFIED",
  };
}

const REJECTED_TEXT =
  "REJECTED: step.finish from w-2 (epoch 6; current epoch 7, held by w-3 since 09:39:12). "
  + "No state was changed.";

function rejectedRow(sequence: number): TimelineRejectedRow {
  return {
    eventType: "step.finish",
    explain: "The rejected session should re-fetch context before any further command.",
    kind: "REJECTED",
    provenance: provenanceOf({ actor: "w-2", eventId: `evt-${String(sequence)}`, leaseEpoch: 6 }),
    reasonCode: "LEASE_EPOCH_STALE",
    sequence,
    summary: REJECTED_TEXT,
    truthClass: "OBSERVED",
  };
}

function gapRow(sequence: number): TimelineRestartGapRow {
  return {
    eventType: null,
    gapOutcome: "CURSOR_GAP",
    kind: "RESTART_GAP",
    lastGoodSequence: sequence - 1,
    provenance: provenanceOf({
      actor: null, commandId: null, effectId: null, leaseEpoch: null, typedLink: null,
    }),
    sequence,
    statedCause: "daemon restarted; subscription reseated",
    summary: null,
    truthClass: "OBSERVED",
  };
}

function sourceOf(rows: readonly TimelineRow[], pageSize = 50): TimelinePageSource {
  return (cursor: number | null): TimelineSourcePage => {
    const from = cursor === null ? 0 : rows.findIndex((row) => row.sequence > cursor);
    const start = from < 0 ? rows.length : from;
    const served = rows.slice(start, start + pageSize);
    const last = served.at(-1);
    return {
      hasMore: start + served.length < rows.length,
      nextCursor: last === undefined ? null : last.sequence,
      rows: served,
    };
  };
}

const LIVE_CURSOR: TimelineCursorState = {
  appliedSequence: 4819, latestSequence: 4819, live: true,
};

function listProps(rows: readonly TimelineRow[], over: Partial<TimelineListProps> = {}): TimelineListProps {
  return {
    cursorState: LIVE_CURSOR,
    filterOptions: { actor: ["w-2", "w-3"], node: ["api-endpnt", "payments"], type: ["step.finish"] },
    maxRows: 100,
    source: sourceOf(rows),
    startCursor: null,
    ...over,
  };
}

const idsUnder = (container: HTMLElement, prefix: string): string[] =>
  [...container.querySelectorAll(`[data-testid^='${prefix}']`)]
    .map((node) => node.getAttribute("data-testid") ?? "");

describe("the surface exposes exactly the spec §2.4 component ids", () => {
  it("renders the list, one addressable row per event, and the restart row", () => {
    const rows = [eventRow(4817), rejectedRow(4818), gapRow(4819)];
    const { container } = render(<TimelineList {...listProps(rows)} />);
    expect(screen.getByTestId("cr.timeline.list")).toBeDefined();
    // The row prefix names rows and nothing inside them, so it counts rows exactly.
    expect(idsUnder(container, "cr.timeline.row.")).toEqual([
      "cr.timeline.row.4817", "cr.timeline.row.4818", "cr.timeline.row.restart",
    ]);
    expect(screen.getByTestId("cr.timeline.cursor")).toBeDefined();
  });

  it("renders all three filter controls and the jump affordance", () => {
    const { container } = render(<TimelineList {...listProps([eventRow(1)])} />);
    for (const field of ["node", "actor", "type"]) {
      expect(screen.getByTestId(`cr.timeline.filter.${field}`).tagName).toBe("SELECT");
    }
    expect(idsUnder(container, "cr.timeline.filter.").length).toBe(3);
    expect(screen.getAllByTestId("cr.timeline.jump").length).toBe(1);
  });

  it("omits the jump link for a row whose event id the daemon did not state", () => {
    render(<TimelineList {...listProps([eventRow(1), eventRow(2, { eventId: null })])} />);
    // A link to an unresolvable target would present unreachable evidence as reachable.
    expect(screen.getAllByTestId("cr.timeline.jump").length).toBe(1);
  });
});

describe("rejected commands and restart gaps are first-class rows", () => {
  it("renders a rejected row with its daemon reason code and an explain affordance", () => {
    render(<TimelineList {...listProps([eventRow(4817), rejectedRow(4818)])} />);
    const row = screen.getByTestId("cr.timeline.row.4818");
    expect(row.textContent).toContain("REJECTED");
    expect(within(row).getByTestId("cr.timeline.reason.4818").textContent).toBe("LEASE_EPOCH_STALE");
    const explain = within(row).getByTestId("cr.timeline.explain.4818");
    expect(explain.tagName).toBe("DETAILS");
    expect(explain.textContent).toContain("re-fetch context");
  });

  it("renders the restart gap visibly and states what the daemon said about it", () => {
    render(<TimelineList {...listProps([eventRow(4818), gapRow(4819)])} />);
    const row = screen.getByTestId("cr.timeline.row.restart");
    expect(row.textContent).toContain("RESTART GAP");
    expect(row.textContent).toContain("CURSOR_GAP");
    expect(row.textContent).toContain("daemon restarted; subscription reseated");
  });

  it("conveys every row kind as text, never by colour or icon alone", () => {
    const rows = [eventRow(1), rejectedRow(2), gapRow(3)];
    render(<TimelineList {...listProps(rows)} />);
    const kinds = screen.getAllByTestId(/^cr\.timeline\.kind\./u).map((n) => n.textContent);
    expect(kinds).toEqual(["EVENT", "REJECTED", "RESTART GAP"]);
  });
});

describe("absent provenance stays UNKNOWN and borrows nothing", () => {
  it("renders UNKNOWN for each absent field of a row whose neighbour supplied it", () => {
    const rows = [eventRow(1), eventRow(2, { actor: null, effectId: null, sessionId: null })];
    render(<TimelineList {...listProps(rows)} />);
    expect(screen.getByTestId("cr.timeline.provenance.1.actor").textContent).toBe("w-3");
    for (const field of ["actor", "effect", "session"]) {
      const cell = screen.getByTestId(`cr.timeline.provenance.2.${field}`);
      expect(cell.textContent).toBe(UNSTATED);
      expect(cell.getAttribute("data-provenance")).toBe("ABSENT");
    }
    expect(screen.getByTestId("cr.timeline.provenance.2.aggregate").getAttribute("data-provenance"))
      .toBe("DAEMON_STATED");
  });

  it("treats a blank supplied string as absent instead of labelling it stated", () => {
    // A blank cell beside a DAEMON_STATED marker is a confident label attached to
    // nothing — the same failure node-authority.readValue already refuses.
    render(<TimelineList {...listProps([eventRow(1, { actor: "   ", eventId: "" })])} />);
    const actor = screen.getByTestId("cr.timeline.provenance.1.actor");
    expect(actor.textContent).toBe(UNSTATED);
    expect(actor.getAttribute("data-provenance")).toBe("ABSENT");
    // A blank event id is not a name, so it buys no link to `#timeline/`.
    expect(screen.queryAllByTestId("cr.timeline.jump").length).toBe(0);
  });

  it("renders a row whose summary the daemon omitted as UNKNOWN rather than blank", () => {
    render(<TimelineList {...listProps([gapRow(9)])} />);
    const value = within(screen.getByTestId("cr.fact.timeline.9.summary")).getByTestId("cr.value");
    expect(value.textContent).toBe(UNKNOWN_FACT_VALUE);
  });
});

describe("the cursor line states applied-of-latest and liveness", () => {
  it("renders the §4.5 wording when the daemon stated both positions", () => {
    render(<TimelineList {...listProps([eventRow(4819)])} />);
    expect(screen.getByTestId("cr.timeline.cursor").textContent)
      .toBe("applied #4819 of #4819 · live");
  });

  it("renders UNKNOWN positions and a not-live stream honestly", () => {
    const cursorState: TimelineCursorState = {
      appliedSequence: null, latestSequence: 4819, live: false,
    };
    render(<TimelineList {...listProps([eventRow(4819)], { cursorState })} />);
    expect(screen.getByTestId("cr.timeline.cursor").textContent)
      .toBe(`applied #${UNSTATED} of #4819 · not live`);
  });

  it("reports a truncated walk beside the cursor instead of ending the list quietly", () => {
    const rows = [eventRow(1), eventRow(2), eventRow(3)];
    render(<TimelineList {...listProps(rows, { maxRows: 2 })} />);
    expect(screen.getAllByTestId(/^cr\.timeline\.row\./u).length).toBe(2);
    const notice = screen.getByTestId("cr.timeline.truncation");
    expect(notice.textContent).toContain(TIMELINE_TRUNCATION_CODE);
    expect(notice.textContent).toContain("#3");
  });
});

describe("a refused walk is shown, never rendered as an empty timeline", () => {
  it("names the refusal code and the layer that refused", () => {
    const scrambled = [eventRow(1), eventRow(3), eventRow(2)];
    const { container } = render(<TimelineList {...listProps(scrambled)} />);
    expect(idsUnder(container, "cr.timeline.row.")).toEqual([]);
    const refusal = screen.getByTestId("cr.timeline.refusal");
    expect(refusal.textContent).toContain("TIMELINE_SEQUENCE_OUT_OF_ORDER");
    expect(refusal.textContent).toContain("PAGING");
  });

  it("refuses to render a row kind outside the vocabulary and names the RENDER layer", () => {
    const alien = { ...eventRow(5), kind: "SUMMARISED" } as unknown as TimelineRow;
    render(<TimelineList {...listProps([alien])} />);
    const row = screen.getByTestId("cr.timeline.row.5");
    expect(row.textContent).toContain("TIMELINE_ROW_KIND_UNSUPPORTED");
    expect(row.textContent).toContain("RENDER");
  });
});

describe("filters route through the page walker, not through the renderer", () => {
  it("narrows the rows and keeps the continuation honest", () => {
    const rows = [eventRow(1), eventRow(2, { actor: "w-2" }), eventRow(3)];
    render(<TimelineList {...listProps(rows)} />);
    expect(screen.getAllByTestId(/^cr\.timeline\.row\./u).length).toBe(3);
    fireEvent.change(screen.getByTestId("cr.timeline.filter.actor"), { target: { value: "w-2" } });
    expect(screen.getAllByTestId(/^cr\.timeline\.row\./u).length).toBe(1);
    expect(screen.getByTestId("cr.timeline.row.2")).toBeDefined();
  });

  it("cannot hide a restart gap behind a node filter", () => {
    const rows = [eventRow(1), gapRow(2), eventRow(3, { aggregateId: "payments" })];
    render(<TimelineList {...listProps(rows)} />);
    fireEvent.change(screen.getByTestId("cr.timeline.filter.node"), { target: { value: "payments" } });
    const shown = screen.getAllByTestId(/^cr\.timeline\.row\./u)
      .map((node) => node.getAttribute("data-testid"));
    expect(shown).toEqual(["cr.timeline.row.restart", "cr.timeline.row.3"]);
  });
});

describe("every row is keyboard reachable and drills to its provenance", () => {
  it("gives each row a tab stop and one truth chip", () => {
    const rows = [eventRow(1), rejectedRow(2), gapRow(3)];
    const { container } = render(<TimelineList {...listProps(rows)} />);
    const listed = screen.getAllByTestId(/^cr\.timeline\.row\./u);
    expect(listed.length).toBe(3);
    for (const row of listed) {
      expect(row.getAttribute("tabindex")).toBe("0");
    }
    // One chip per fact claim, per the §12 audit; inflation would break that count.
    expect(container.querySelectorAll("[data-testid^='cr.fact.']").length).toBe(3);
    expect(container.querySelectorAll("[data-testid^='cr.chip.']").length).toBe(3);
  });

  it("opens the row's provenance from the focused chip with the shell shortcut", () => {
    render(<TimelineList {...listProps([eventRow(1)])} />);
    const drill = screen.getByTestId("cr.timeline.provenance.1");
    expect(drill.hasAttribute("open")).toBe(false);
    const chip = within(screen.getByTestId("cr.timeline.row.1")).getByTestId(/^cr\.chip\./u);
    fireEvent.keyDown(chip, { key: PROVENANCE_SHORTCUT_KEY });
    expect(screen.getByTestId("cr.timeline.provenance.1").hasAttribute("open")).toBe(true);
  });

  it("ignores the shortcut when focus is not on a chip", () => {
    render(<TimelineList {...listProps([eventRow(1)])} />);
    const row = screen.getByTestId("cr.timeline.row.1");
    fireEvent.keyDown(row, { key: PROVENANCE_SHORTCUT_KEY });
    expect(screen.getByTestId("cr.timeline.provenance.1").hasAttribute("open")).toBe(false);
  });
});
