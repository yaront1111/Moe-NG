import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { RunNodeView } from "../../live/live-runs.js";
import { BOARD_COLUMNS, columnOf } from "../board/board-columns.js";
import { NeedsYou } from "./needs-you.js";
import type { NeedsYouData, NeedsYouItem } from "./needs-you-model.js";
import type { PreviewFacts } from "./needs-you-preview.js";
import { createPreviewPort } from "./preview-port.js";
import type { PreviewWire } from "./preview-port.js";

/**
 * DoD 3, AS RULED: a rejection renders its findings against the NAMED NODE, and NOTHING MOVES.
 *
 * The two invariance arms are the durable half of the ruling. Asserting "the column did not
 * change" is only worth writing if it could fail, so each arm is built to catch the change a
 * future row would actually make:
 *  - a seventh BOARD_COLUMNS entry, or a REWORK spelling anywhere in the control room, reddens
 *    the roster arm AND the source sweep;
 *  - a node transition asked for from the browser reddens the payload arm, because the payload
 *    the port puts on the wire is asserted with EXACT arity - a `status`, `column` or
 *    `transition` member added to it has nowhere to hide.
 * Reading a column before and after a rejection cannot fail on its own, because the browser
 * holds the runs frame; the arms below are what make the invariance measurable rather than
 * merely observed.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const NODE: RunNodeView = {
  accepted: null,
  claim: null,
  criterionIds: [],
  dependsOn: [],
  landing: null,
  lastActivityAt: null,
  nodeKey: "ui",
  nodeRef: "node-ui",
  objective: "Render the orders page",
  receipt: null,
  review: {
    escalated: false, findings: [], latestRoute: null, rounds: 1, unreadable: false,
    unsuccessfulRounds: 0, version: 1,
  },
  sharedKey: false,
  status: "DELIVERED",
};

const FACTS: PreviewFacts = {
  affordance: {
    commandEnvelopeVersion: "moe-runtime-command/1",
    commandId: "cmd-preview-1",
    commandKind: "preview.decide",
    expectedVersion: 2,
    inputSchemaVersion: "moe-preview-command/1",
    targetAggregateId: "preview:goal-1",
  },
  captures: [],
  nodes: [{ nodeKey: NODE.nodeKey, nodeRef: NODE.nodeRef, objective: NODE.objective }],
  receiptId: "preview-receipt/abc",
  url: "http://127.0.0.1:4173/",
};

const ITEM: NeedsYouItem = {
  actionLabel: "Open the goal",
  detail: "Your product is running at http://127.0.0.1:4173/.",
  goalId: "goal-1",
  headline: "Your product is running and needs your verdict",
  kind: "PREVIEW",
  planningRunRef: "run-1",
  preview: FACTS,
  title: "Alpha",
};

const dataWith = (item: NeedsYouItem): NeedsYouData =>
  ({ countLabel: "1 decision needs you", items: [item], note: null });

describe("BOARD_COLUMNS stays its six entries (DoD 3)", () => {
  it("is exactly the six pipeline words, in order, with no REWORK", () => {
    expect([...BOARD_COLUMNS]).toEqual([
      "PLANNED", "WORKING", "REVIEW", "VERIFIED", "LANDED", "PUBLISHED",
    ]);
    expect(BOARD_COLUMNS).toHaveLength(6);
    expect([...BOARD_COLUMNS]).not.toContain("REWORK");
  });

  it("has no REWORK spelling anywhere in the control room's source", () => {
    // Same derivation as goals-home.test.tsx:371 - a URL pathname is a POSIX path and
    // resolves to `D:\src` on Windows, which is a directory that does not exist.
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { walk(path); continue; }
        if (!/\.tsx?$/u.test(entry.name)) continue;
        // This file names the word in order to forbid it; nothing else may.
        if (entry.name === "preview-rejection-invariants.test.tsx") continue;
        if (readFileSync(path, "utf8").includes("REWORK")) offenders.push(entry.name);
      }
    };
    walk(root);
    expect(offenders, "a REWORK column is a design regression, not a feature").toEqual([]);
  });
});

describe("a rejection moves nothing (DoD 3)", () => {
  it("puts NO node transition on the wire: the payload is exactly the daemon's arity", async () => {
    const built: { affordance: unknown; input: Record<string, unknown> }[] = [];
    const wire = {
      client: { commands: { "preview.decide":
        (affordance: unknown, input: Record<string, unknown>) => {
          built.push({ affordance, input });
          return { envelope: { commandId: "cmd-preview-1", payload: input["payload"] }, ok: true };
        } } },
      sessionCredential: "cred-preview-1",
      transport: { sendCommand: vi.fn(async () => ({
        delivered: true as const, response: { ok: true }, status: 200,
      })) },
    } as unknown as PreviewWire;

    await createPreviewPort(wire).submit(FACTS.affordance, "REJECT", [
      { detail: "The total is wrong.", nodeRef: NODE.nodeRef },
    ]);

    // EXACT ARITY over the WHOLE payload. A `status`, `column` or `transition` member added
    // here later has nowhere to hide, which is what makes the invariance durable.
    expect(built[0]?.input["payload"]).toEqual({
      decision: "REJECT",
      findings: [{ detail: "The total is wrong.", nodeRef: NODE.nodeRef }],
      previewRef: "preview:goal-1",
    });
    const finding = (built[0]?.input["payload"] as { findings: readonly object[] }).findings[0];
    expect(Object.keys(finding ?? {}).sort()).toEqual(["detail", "nodeRef"]);
  });

  it("reads the SAME column for the named node before and after the rejection", async () => {
    const user = userEvent.setup();
    const before = columnOf(NODE);
    const { rerender } = render(
      <NeedsYou data={dataWith(ITEM)} onDecide={vi.fn()} onOpenBoard={vi.fn()}
        onPreviewDecide={vi.fn()} />,
    );

    await user.type(screen.getByTestId("cr.needsyou.preview.detail"), "The total is wrong.");
    await user.click(screen.getByTestId("cr.needsyou.preview.reject"));
    rerender(
      <NeedsYou
        data={dataWith(ITEM)}
        decisionResults={new Map([["goal-1", { busy: false, outcome: { commandId: "c", ok: true } }]])}
        onDecide={vi.fn()} onOpenBoard={vi.fn()} onPreviewDecide={vi.fn()}
      />,
    );

    // The node the finding NAMES is the node whose column must not have moved.
    expect(columnOf(NODE)).toBe(before);
    expect(before).toBe("REVIEW");
    expect(screen.getByTestId(`cr.needsyou.preview.finding.${NODE.nodeRef}`).textContent)
      .toContain("The total is wrong.");
  });

  it("shows the EXISTING path back to work, and says nothing moved", async () => {
    const user = userEvent.setup();
    const onOpenBoard = vi.fn();
    const { rerender } = render(
      <NeedsYou data={dataWith(ITEM)} onDecide={vi.fn()} onOpenBoard={onOpenBoard}
        onPreviewDecide={vi.fn()} />,
    );
    await user.type(screen.getByTestId("cr.needsyou.preview.detail"), "The total is wrong.");
    await user.click(screen.getByTestId("cr.needsyou.preview.reject"));
    rerender(
      <NeedsYou
        data={dataWith(ITEM)}
        decisionResults={new Map([["goal-1", { busy: false, outcome: { commandId: "c", ok: true } }]])}
        onDecide={vi.fn()} onOpenBoard={onOpenBoard} onPreviewDecide={vi.fn()}
      />,
    );

    expect(screen.getByTestId("cr.needsyou.preview.sent").textContent)
      .toContain("nothing moved on the board");
    // The path back to work is the goal's own affordance, not a synthetic column.
    await user.click(screen.getByTestId("cr.needsyou.open.preview.goal-1"));
    expect(onOpenBoard).toHaveBeenCalledWith("goal-1", "run-1", "Alpha");
  });
});
