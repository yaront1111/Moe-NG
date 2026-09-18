import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import type { RunNodeFindingView, RunNodeView, RunsOutcome } from "../../live/live-runs.js";
import { blockingFindingsOf, escalationItems } from "./needs-you-escalation.js";
import { NeedsYou, resultKeyOf } from "./needs-you.js";

afterEach(cleanup);
const FINDING: RunNodeFindingView = { detail: "Which session expiry policy should be implemented?", round: 4,
  ruleId: "authentication-undecided", severity: "MAJOR", subject: "CRITERION CRT-AUTH" };
const CATALOG: GoalCatalogFrame = { connection: "CONNECTED", detail: "", goals: [], outcome: "GOALS" };
const offer = (version = 5) => ({ commandEnvelopeVersion: "moe-runtime-command/1", commandId: `offer-${version}`,
  commandKind: "escalation.decide", expectedVersion: version, inputSchemaVersion: "moe-review-command/1", targetAggregateId: "execution-own" });
function surface(version = 5): SurfaceFrame {
  return { connection: "CONNECTED", detail: "", offers: [offer(version)], outcome: "SURFACE", planningGoalRefs: {}, steps: [] };
}
function node(version = 5, nodeRef = "execution-own", unreadable = false, findings: readonly RunNodeFindingView[] = [FINDING]): RunNodeView {
  return { accepted: null, claim: null, criterionIds: ["CRT-AUTH"], declaredMigrations: null, dependsOn: [], lastActivityAt: null,
    nodeKey: "api", nodeRef, objective: "Implement sign in", landing: null, receipt: null,
    review: { escalated: false, findings, latestRoute: "ESCALATE", rounds: 4, unreadable, unsuccessfulRounds: 4, version },
    sharedKey: false, status: "ESCALATION_REQUIRED" };
}
function runs(nodes: readonly RunNodeView[] = [node()]): RunsOutcome {
  return { status: "RUNS", goals: [{ goalId: "goal-own", lifecycle: "EXECUTION_ENABLED", nodes, publish: null,
    run: { approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: "run-own" }, title: "Own" }],
    totals: { ACCEPTED: 0, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: nodes.length, IN_PROGRESS: 0,
      READY: 0, REPLANNED: 0, UNATTRIBUTABLE: 0, goals: 1, nodes: nodes.length } };
}
function items(read: RunsOutcome | null = runs(), version = 5) { return escalationItems(surface(version), read, CATALOG); }
function guidedItems(version = 5, nodeRef = "execution-own") {
  return escalationItems({ ...surface(version), offers: [{ ...offer(version), targetAggregateId: nodeRef,
    inputSchemaVersion: "moe-review-escalation-guidance/1" }] }, runs([node(version, nodeRef)]), CATALOG);
}

it("adds guidance to the explicit retry while keeping REPLAN and empty retry independent", async () => {
  const decide = vi.fn(); const selected = guidedItems();
  render(<NeedsYou data={{ countLabel: "1", items: selected, note: null }} onDecide={decide} onOpenBoard={vi.fn()} />);
  const field = screen.getByRole("textbox", { name: "Answers or instructions for the next attempt (optional)" }) as HTMLTextAreaElement;
  expect(field.maxLength).toBe(4000);
  const guidance = "Use session cookies. Keep all approved checks.";
  fireEvent.change(field, { target: { value: guidance } });
  await userEvent.click(screen.getByRole("button", { name: "Retry with guidance on api" }));
  expect(decide).toHaveBeenLastCalledWith(selected[0], undefined, guidance);
  await userEvent.click(screen.getByRole("button", { name: "Replan api from its findings" }));
  expect(decide).toHaveBeenLastCalledWith(selected[0], "REPLAN");
  fireEvent.change(field, { target: { value: "" } });
  await userEvent.click(screen.getByRole("button", { name: "Allow one more attempt on api" }));
  expect(decide).toHaveBeenLastCalledWith(selected[0]);
});

it("keeps invalid or unsupported guidance from silently becoming a plain retry", async () => {
  const decide = vi.fn(); const selected = guidedItems();
  const { rerender } = render(<NeedsYou data={{ countLabel: "1", items: selected, note: null }} onDecide={decide} onOpenBoard={vi.fn()} />);
  const field = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: "x".repeat(4001) } });
  expect((screen.getByTestId("cr.needsyou.escalate.execution-own") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTestId("cr.needsyou.replan.execution-own") as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(field, { target: { value: "\ud800" } });
  expect((screen.getByTestId("cr.needsyou.escalate.execution-own") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(field, { target: { value: "Retain this guidance" } });
  rerender(<NeedsYou data={{ countLabel: "1", items: items(), note: null }} onDecide={decide} onOpenBoard={vi.fn()} />);
  expect(screen.getByText("This daemon does not support retry guidance. Refresh after updating Moe." )).toBeTruthy();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Retain this guidance");
  const retry = screen.getByTestId("cr.needsyou.escalate.execution-own") as HTMLButtonElement;
  expect(retry.disabled).toBe(true); await userEvent.click(retry); expect(decide).not.toHaveBeenCalled();
});

it("offers no guidance entry for a legacy daemon", () => {
  render(<NeedsYou data={{ countLabel: "1", items: items(), note: null }} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect((screen.getByRole("button", { name: "Allow one more attempt on api" }) as HTMLButtonElement).disabled).toBe(false);
});

it("preserves a refused draft but resets it for another review, node, or unmount", () => {
  const decide = vi.fn(); const selected = guidedItems(); const item = selected[0]!;
  const { rerender } = render(<NeedsYou data={{ countLabel: "1", items: selected, note: null }} onDecide={decide} onOpenBoard={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Human's exact answer" } });
  const refused = new Map([[resultKeyOf(item), { busy: false, outcome: { ok: false as const, code: "VERSION_STALE", layer: "DAEMON" } }]]);
  rerender(<NeedsYou data={{ countLabel: "1", items: selected, note: null }} decisionResults={refused} onDecide={decide} onOpenBoard={vi.fn()} />);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Human's exact answer");
  expect((screen.getByRole("button", { name: "Retry with guidance on api" }) as HTMLButtonElement).disabled).toBe(false);
  for (const next of [guidedItems(7), guidedItems(7, "execution-other")]) {
    rerender(<NeedsYou data={{ countLabel: "1", items: next, note: null }} onDecide={decide} onOpenBoard={vi.fn()} />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Discard on identity change" } });
  }
  rerender(<NeedsYou data={{ countLabel: "0", items: [], note: null }} onDecide={decide} onOpenBoard={vi.fn()} />);
  rerender(<NeedsYou data={{ countLabel: "1", items: selected, note: null }} onDecide={decide} onOpenBoard={vi.fn()} />);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
});

it("joins reported findings to the exact offered node and review version", () => {
  const [item] = items(runs([node(5, "execution-other", false, [{ ...FINDING, detail: "FOREIGN" }]), node()]));
  expect(item?.escalation).toMatchObject({ findingsState: "CURRENT", findings: [FINDING], affordance: offer() });
  expect(blockingFindingsOf(item!.escalation!.findings)).toBe(1);
  expect(JSON.stringify(item)).not.toContain("FOREIGN");
});

// UnAI 2026-09-17/18: the owner clicked "Allow one more attempt" repeatedly without knowing what
// it rescued, while every round carried only MINOR findings — which never block a round, never
// count toward the escalation limit and never enter repeat detection (@moe/review 42bf88b3).
const MINOR_A: RunNodeFindingView = { detail: "Suite needs a freshly provisioned database.", round: 4,
  ruleId: "suite-requires-freshly-provisioned-database", severity: "MINOR", subject: "CRITERION CRT-DB" };
const MINOR_B: RunNodeFindingView = { detail: "Applied migration digest changed.", round: 4,
  ruleId: "applied-migration-digest-changed", severity: "MINOR", subject: "CRITERION CRT-MIG" };
const ALL_MINOR_LINE = "All 2 findings are MINOR: they never block a round; one more attempt is accepted unless a CRITICAL or MAJOR finding appears.";
const OPTIONS = {
  allow: "Allow one more attempt funds one more review round. That round is accepted if it carries no CRITICAL or MAJOR finding; MINOR notes are recorded but never block it.",
  guidance: "Guidance is optional. Whatever you write below reaches the worker word for word with that one attempt; approved requirements and checks still apply.",
  replan: "Replan from the findings retires this node and hands its findings to a successor goal for the planning agent. No further round runs here.",
};

it("says in one line that an all-MINOR list blocks nothing, beside each finding's severity", () => {
  const selected = items(runs([node(5, "execution-own", false, [MINOR_A, MINOR_B])]));
  expect(blockingFindingsOf(selected[0]!.escalation!.findings)).toBe(0);
  render(<NeedsYou data={{ countLabel: "1", items: selected, note: null }} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  expect(screen.getByTestId("cr.needsyou.findings.nonblocking").textContent).toBe(ALL_MINOR_LINE);
  expect(screen.queryByTestId("cr.needsyou.findings.blocking")).toBeNull();
  const rows = screen.getAllByRole("listitem").filter((row) => row.dataset["severity"] !== undefined);
  expect(rows.map((row) => [row.dataset["severity"], row.dataset["blocking"]])).toEqual([["MINOR", "false"], ["MINOR", "false"]]);
  expect(screen.getByText("MINOR · suite-requires-freshly-provisioned-database")).toBeTruthy();
  expect(screen.getByText("MINOR · applied-migration-digest-changed")).toBeTruthy();
  const allow = screen.getByRole("button", { name: "Allow one more attempt on api" }) as HTMLButtonElement;
  expect(allow.disabled).toBe(false); expect(allow.dataset["variant"]).toBe("primary");
});

it("uses singular words for one MINOR finding", () => {
  render(<NeedsYou data={{ countLabel: "1", items: items(runs([node(5, "execution-own", false, [MINOR_A])])), note: null }} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  expect(screen.getByTestId("cr.needsyou.findings.nonblocking").textContent)
    .toBe("All 1 finding is MINOR: they never block a round; one more attempt is accepted unless a CRITICAL or MAJOR finding appears.");
});

it("prints no all-MINOR line for a mixed list, and counts what blocks instead", () => {
  const selected = items(runs([node(5, "execution-own", false, [MINOR_A, FINDING])]));
  expect(blockingFindingsOf(selected[0]!.escalation!.findings)).toBe(1);
  render(<NeedsYou data={{ countLabel: "1", items: selected, note: null }} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  expect(screen.queryByTestId("cr.needsyou.findings.nonblocking")).toBeNull();
  expect(screen.getByTestId("cr.needsyou.findings.blocking").textContent)
    .toBe("1 of 2 findings blocks acceptance (CRITICAL or MAJOR): the next round is accepted only if no CRITICAL or MAJOR finding remains.");
  const rows = screen.getAllByRole("listitem").filter((row) => row.dataset["severity"] !== undefined);
  expect(rows.map((row) => [row.dataset["severity"], row.dataset["blocking"]])).toEqual([["MINOR", "false"], ["MAJOR", "true"]]);
  expect(screen.queryByText(/All \d+ findings are MINOR/)).toBeNull();
});

it("treats a MAJOR finding owned by another node as non-blocking beside this node's MINOR note", () => {
  const foreign: RunNodeFindingView = { ...FINDING, attributedTo: { criterionIds: ["CRT-REG-01-A"], nodeKey: "registry" } };
  const selected = items(runs([node(5, "execution-own", false, [foreign, MINOR_A])]));
  expect(blockingFindingsOf(selected[0]!.escalation!.findings)).toBe(0);
  render(<NeedsYou data={{ countLabel: "1", items: selected, note: null }} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  expect(screen.getByTestId("cr.needsyou.findings.nonblocking").textContent)
    .toBe("None of these 2 findings blocks this node: MINOR notes never block a round and the rest are owned by other nodes; one more attempt is accepted unless a CRITICAL or MAJOR finding appears.");
  expect(screen.queryByTestId("cr.needsyou.findings.blocking")).toBeNull();
});

it("prints neither severity line for an empty current summary", () => {
  render(<NeedsYou data={{ countLabel: "1", items: items(runs([node(5, "execution-own", false, [])])), note: null }} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  expect(screen.queryByTestId("cr.needsyou.findings.nonblocking")).toBeNull();
  expect(screen.queryByTestId("cr.needsyou.findings.blocking")).toBeNull();
});

it("states what each answer does, and that guidance is optional and reaches the seat verbatim", () => {
  const { rerender } = render(<NeedsYou data={{ countLabel: "1", items: guidedItems(), note: null }} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  const options = screen.getByTestId("cr.needsyou.options");
  expect(options.getAttribute("aria-label")).toBe("What each answer does");
  expect([...options.querySelectorAll("li")].map((row) => row.textContent)).toEqual([OPTIONS.allow, OPTIONS.replan, OPTIONS.guidance]);
  const field = screen.getByRole("textbox", { name: "Answers or instructions for the next attempt (optional)" });
  expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent)
    .toBe("Optional. Saved with your approval of one more attempt and sent to the worker word for word; leave it empty to retry as is. Approved requirements and checks still apply.");
  // A legacy daemon takes no guidance, so the card does not promise to carry any.
  rerender(<NeedsYou data={{ countLabel: "1", items: items(), note: null }} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  expect([...screen.getByTestId("cr.needsyou.options").querySelectorAll("li")].map((row) => row.textContent)).toEqual([OPTIONS.allow, OPTIONS.replan]);
  expect(screen.queryByText(OPTIONS.guidance)).toBeNull();
});

it("keeps the plain retry primary when the stalled rounds repeated only MINOR notes", () => {
  // The kernel accepts the next MINOR-only round, so "another attempt would repeat them" was false.
  const base = node(5, "execution-own", false, [MINOR_A, MINOR_B]);
  const selected = escalationItems(guidedOffer(), runs([{ ...base, review: { ...base.review, stalledRounds: [11, 13] } }]), CATALOG);
  expect(selected[0]?.detail).toBe("Implement sign in failed review 4 times (last: review escalated). Rounds 11, 13 repeated the same MINOR notes on an unchanged workspace."
    + " MINOR notes never block, so one more attempt is accepted unless a CRITICAL or MAJOR finding appears. Allow one more attempt, or replan the work into a successor goal.");
  expect(selected[0]?.detail).not.toContain("would repeat them");
  render(<NeedsYou data={{ countLabel: "1", items: selected, note: null }} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  const allow = screen.getByRole("button", { name: "Allow one more attempt on api" }) as HTMLButtonElement;
  expect(allow.disabled).toBe(false); expect(allow.dataset["variant"]).toBe("primary");
  expect((screen.getByRole("button", { name: "Replan api from its findings" }) as HTMLButtonElement).dataset["variant"]).toBe("secondary");
  expect(screen.queryByTestId("cr.needsyou.stall-guidance.execution-own")).toBeNull();
  expect(screen.getByTestId("cr.needsyou.stall").textContent).toContain("Rounds 11, 13");
  expect(screen.getByTestId("cr.needsyou.findings.nonblocking").textContent).toBe(ALL_MINOR_LINE);
});

it("blocks on a MAJOR own finding in the live daemon shape, attributedTo: null", async () => {
  // runs-read.ts maps an absent attribution to null, never undefined; the fixtures above omit the key.
  const liveOwn: RunNodeFindingView = { ...FINDING, attributedTo: null };
  expect(blockingFindingsOf([liveOwn])).toBe(1);
  const base = node(5, "execution-own", false, [MINOR_A, liveOwn]);
  const selected = escalationItems(guidedOffer(), runs([{ ...base, review: { ...base.review, stalledRounds: [3, 4] } }]), CATALOG);
  expect(selected[0]?.detail).toContain("would repeat them");
  const decide = vi.fn();
  render(<NeedsYou data={{ countLabel: "1", items: selected, note: null }} onDecide={decide} onOpenBoard={vi.fn()} />);
  expect(screen.queryByTestId("cr.needsyou.findings.nonblocking")).toBeNull();
  expect(screen.queryByTestId("cr.needsyou.findings.capped")).toBeNull();
  expect(screen.getByTestId("cr.needsyou.findings.blocking").textContent)
    .toBe("1 of 2 findings blocks acceptance (CRITICAL or MAJOR): the next round is accepted only if no CRITICAL or MAJOR finding remains.");
  const rows = screen.getAllByRole("listitem").filter((row) => row.dataset["severity"] !== undefined);
  expect(rows.map((row) => [row.dataset["severity"], row.dataset["blocking"]])).toEqual([["MINOR", "false"], ["MAJOR", "true"]]);
  expect(screen.queryByTestId("cr.needsyou.finding.owner")).toBeNull();
  const allow = screen.getByRole("button", { name: "Allow one more attempt on api" }) as HTMLButtonElement;
  expect(allow.disabled).toBe(true); expect(allow.dataset["variant"]).toBe("secondary");
  expect((screen.getByRole("button", { name: "Replan api from its findings" }) as HTMLButtonElement).dataset["variant"]).toBe("primary");
  expect(screen.getByTestId("cr.needsyou.stall-guidance.execution-own")).toBeTruthy();
  await userEvent.click(allow); expect(decide).not.toHaveBeenCalled();
});

// The daemon lists at most 8 findings of the latest round (runs-read.ts MAX_FINDINGS) and carries
// no total, so a list at the cap may hide a blocking finding past it: the card must not claim
// "All 8 findings are MINOR", and a stall on such a list keeps its guidance gate.
const EIGHT_MINOR: readonly RunNodeFindingView[] = Array.from({ length: 8 }, (_, index) =>
  ({ ...MINOR_A, ruleId: `minor-note-${String(index + 1)}` }));
const CAPPED_ALL_MINOR_LINE = "All 8 listed findings are MINOR (the daemon lists at most 8, so a CRITICAL or MAJOR finding may be unlisted): MINOR notes never block a round; one more attempt is accepted unless a CRITICAL or MAJOR finding appears.";

it("says a capped all-MINOR list is only the listed 8, and keeps the stall gate on it", async () => {
  expect(blockingFindingsOf(EIGHT_MINOR)).toBe(0);
  const seven = items(runs([node(5, "execution-own", false, EIGHT_MINOR.slice(0, 7))]));
  expect(seven[0]?.escalation?.findings.length).toBe(7);
  const { rerender } = render(<NeedsYou data={{ countLabel: "1", items: seven, note: null }} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  expect(screen.getByTestId("cr.needsyou.findings.nonblocking").textContent).toContain("All 7 findings are MINOR");
  expect(screen.queryByTestId("cr.needsyou.findings.capped")).toBeNull();
  const eight = items(runs([node(5, "execution-own", false, EIGHT_MINOR)]));
  expect(eight[0]?.detail).toContain("Allow one more attempt, or replan the work into a successor goal that carries these findings.");
  rerender(<NeedsYou data={{ countLabel: "1", items: eight, note: null }} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  expect(screen.getByTestId("cr.needsyou.findings.capped").textContent).toBe(CAPPED_ALL_MINOR_LINE);
  expect(screen.queryByTestId("cr.needsyou.findings.nonblocking")).toBeNull();
  expect(screen.queryByText(/All 8 findings are MINOR/)).toBeNull();
  expect(screen.getByText("Review summary: up to 8 findings.")).toBeTruthy();
  // Not stalled: the plain retry stays primary; the card only refuses to overclaim the list.
  const allow = screen.getByRole("button", { name: "Allow one more attempt on api" }) as HTMLButtonElement;
  expect(allow.disabled).toBe(false); expect(allow.dataset["variant"]).toBe("primary");
  // Stalled on a capped list: the unlisted finding may be the one that repeats, so guidance is required.
  const base = node(5, "execution-own", false, EIGHT_MINOR);
  const decide = vi.fn();
  const stalledCapped = escalationItems(guidedOffer(), runs([{ ...base, review: { ...base.review, stalledRounds: [11, 13] } }]), CATALOG);
  expect(stalledCapped[0]?.detail).toContain("Rounds 11, 13 repeated the same findings on an unchanged workspace, so another attempt without new instructions would repeat them.");
  expect(stalledCapped[0]?.detail).not.toContain("MINOR notes never block");
  rerender(<NeedsYou data={{ countLabel: "1", items: stalledCapped, note: null }} onDecide={decide} onOpenBoard={vi.fn()} />);
  expect(screen.getByTestId("cr.needsyou.findings.capped").textContent).toBe(CAPPED_ALL_MINOR_LINE);
  const gated = screen.getByRole("button", { name: "Allow one more attempt on api" }) as HTMLButtonElement;
  expect(gated.disabled).toBe(true); expect(gated.dataset["variant"]).toBe("secondary");
  expect((screen.getByRole("button", { name: "Replan api from its findings" }) as HTMLButtonElement).dataset["variant"]).toBe("primary");
  expect(screen.getByTestId("cr.needsyou.stall-guidance.execution-own")).toBeTruthy();
  await userEvent.click(gated); expect(decide).not.toHaveBeenCalled();
});

it("names the cap for a capped list whose listed findings are MINOR or owned elsewhere", () => {
  const foreign: RunNodeFindingView = { ...FINDING, attributedTo: { criterionIds: ["CRT-REG-01-A"], nodeKey: "registry" } };
  const selected = items(runs([node(5, "execution-own", false, [foreign, ...EIGHT_MINOR.slice(0, 7)])]));
  expect(blockingFindingsOf(selected[0]!.escalation!.findings)).toBe(0);
  render(<NeedsYou data={{ countLabel: "1", items: selected, note: null }} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  expect(screen.getByTestId("cr.needsyou.findings.capped").textContent)
    .toBe("None of the 8 listed findings blocks this node (the daemon lists at most 8, so a CRITICAL or MAJOR finding may be unlisted): MINOR notes never block a round; one more attempt is accepted unless a CRITICAL or MAJOR finding appears.");
  expect(screen.queryByTestId("cr.needsyou.findings.nonblocking")).toBeNull();
  expect(screen.queryByTestId("cr.needsyou.findings.blocking")).toBeNull();
});

it("does not promise a guidance textbox on a read-only card", () => {
  // Without a decision port there is no textbox, so "whatever you write below" would point at nothing.
  render(<NeedsYou data={{ countLabel: "1", items: guidedItems(), note: null }} onOpenBoard={vi.fn()} />);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Allow one more attempt on / })).toBeNull();
  expect([...screen.getByTestId("cr.needsyou.options").querySelectorAll("li")].map((row) => row.textContent)).toEqual([OPTIONS.allow, OPTIONS.replan]);
  expect(screen.queryByText(OPTIONS.guidance)).toBeNull();
});

it.each([
  ["missing", null, "MISSING"],
  ["unrelated", runs([node(5, "execution-other")]), "MISSING"],
  ["stale", runs([node(3)]), "STALE"],
  ["ahead", runs([node(7)]), "STALE"],
  ["unreadable", runs([node(5, "execution-own", true)]), "UNREADABLE"],
  ["refused", { code: "RUNS_READ_UNREADABLE", layer: "RUNS_READ", status: "ERROR" }, "UNREADABLE"],
] as const)("does not show %s findings as the offered review", (_label, read, expected) => {
  expect(items(read)[0]?.escalation).toMatchObject({ findingsState: expected, findings: [] });
});

it("renders literal reported issues before the attempt decision", () => {
  const hostile = '<img src=x onerror="window.secret()">';
  const data = { countLabel: "1", items: items(runs([node(5, "execution-own", false, [{ ...FINDING, detail: hostile }])])), note: null };
  const { container } = render(<NeedsYou data={data} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  const detail = screen.getByText(hostile);
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText(/^MAJOR · /).textContent).toContain("authentication-undecided");
  expect(screen.getByText("CRITERION CRT-AUTH")).toBeTruthy();
  expect(screen.getByText("Review summary: up to 8 findings.")).toBeTruthy();
  expect(screen.getByText("Another attempt does not answer unresolved product questions.")).toBeTruthy();
  const button = screen.getByRole("button", { name: "Allow one more attempt on api" });
  expect(detail.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect((button as HTMLButtonElement).disabled).toBe(false);
});

it.each([
  [null, "Latest review details have not arrived yet."],
  [runs([node(3)]), "Latest review details are refreshing to match this decision."],
  [runs([node(5, "execution-own", true)]), "Latest review details could not be read."],
] as const)("keeps a decision read-only until its reported issues are current", async (read, message) => {
  const decide = vi.fn();
  render(<NeedsYou data={{ countLabel: "1", items: items(read), note: null }} onDecide={decide} onOpenBoard={vi.fn()} />);
  expect(screen.getByText(message)).toBeTruthy();
  expect(screen.queryByText(FINDING.detail)).toBeNull();
  const buttons = [screen.getByRole("button", { name: /^Allow one more attempt on / }), screen.getByRole("button", { name: /^Replan .+ from its findings$/ })];
  for (const button of buttons) { expect((button as HTMLButtonElement).disabled).toBe(true); await userEvent.click(button); }
  expect(decide).not.toHaveBeenCalled();
});

it("distinguishes an empty current summary from missing evidence", () => {
  render(<NeedsYou data={{ countLabel: "1", items: items(runs([node(5, "execution-own", false, [])])), note: null }} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  expect(screen.getByText("No findings were included in the latest review summary.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Allow one more attempt on api" }) as HTMLButtonElement).disabled).toBe(false);
});

it("does not reuse an earlier successful decision for a later review", () => {
  const oldItem = items()[0]!;
  const nextItem = items(runs([node(7)]), 7)[0]!;
  expect(resultKeyOf(nextItem)).not.toBe(resultKeyOf(oldItem));
  const results = new Map([[resultKeyOf(oldItem), { busy: false, outcome: { ok: true as const, commandId: "old-allow" } }]]);
  const { rerender } = render(<NeedsYou data={{ countLabel: "1", items: [oldItem], note: null }} decisionResults={results} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Allow one more attempt on api" }).textContent).toBe("Allowed");
  rerender(<NeedsYou data={{ countLabel: "1", items: [nextItem], note: null }} decisionResults={results} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  const button = screen.getByRole("button", { name: "Allow one more attempt on api" }) as HTMLButtonElement;
  expect(button.textContent).toBe("Allow one more attempt"); expect(button.disabled).toBe(false);
  expect(screen.queryByText("Allowed. One more review attempt is approved for this node.")).toBeNull();
});

function stalledNode(findings: readonly RunNodeFindingView[] = [FINDING]): RunNodeView {
  const base = node(5, "execution-own", false, findings);
  return { ...base, review: { ...base.review, stalledRounds: [3, 4] } };
}
const guidedOffer = () => ({ ...surface(), offers: [{ ...offer(), inputSchemaVersion: "moe-review-escalation-guidance/1" }] });

it("says a stalled review cannot change without new instructions and makes replan the primary answer", async () => {
  // UnAI 2026-09-15: "Allow one more attempt" was the primary button while rounds 5, 7, 9 and 11
  // repeated one finding on an unchanged workspace; each click bought one more identical round.
  const decide = vi.fn(); const selected = escalationItems(guidedOffer(), runs([stalledNode()]), CATALOG);
  expect(selected[0]?.detail).toContain("Rounds 3, 4 repeated the same findings on an unchanged workspace");
  expect(selected[0]?.escalation?.stalledRounds).toEqual([3, 4]);
  render(<NeedsYou data={{ countLabel: "1", items: selected, note: null }} onDecide={decide} onOpenBoard={vi.fn()} />);
  const allow = screen.getByRole("button", { name: "Allow one more attempt on api" }) as HTMLButtonElement;
  expect(allow.disabled).toBe(true);
  expect(allow.dataset["variant"]).toBe("secondary");
  expect((screen.getByRole("button", { name: "Replan api from its findings" }) as HTMLButtonElement).dataset["variant"]).toBe("primary");
  expect(screen.getByTestId("cr.needsyou.stall").textContent).toContain("Rounds 3, 4");
  fireEvent.change(screen.getByRole("textbox", { name: "Answers or instructions for the next attempt (optional)" }),
    { target: { value: "Use the approved server-session design." } });
  await userEvent.click(screen.getByRole("button", { name: "Retry with guidance on api" }));
  expect(decide).toHaveBeenLastCalledWith(selected[0], undefined, "Use the approved server-session design.");
});

it("keeps the plain retry for a stalled review that cannot take instructions", () => {
  const selected = escalationItems(surface(), runs([stalledNode()]), CATALOG);
  render(<NeedsYou data={{ countLabel: "1", items: selected, note: null }} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  expect((screen.getByRole("button", { name: "Allow one more attempt on api" }) as HTMLButtonElement).disabled).toBe(false);
});

it("names the owning node of an attributed finding", () => {
  const owned: RunNodeFindingView = { ...FINDING, attributedTo: { criterionIds: ["CRT-REG-01-A"], nodeKey: "registry" } };
  const selected = items(runs([node(5, "execution-own", false, [owned])]));
  render(<NeedsYou data={{ countLabel: "1", items: selected, note: null }} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  expect(screen.getByTestId("cr.needsyou.finding.owner").textContent)
    .toContain("Owned by node registry (criteria CRT-REG-01-A); it does not count against this node.");
});
