import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  APPROVAL_FIXTURE_RECORDS,
  AUTO_APPROVED_RECORD,
  FIXTURE_REVISION_HASH,
  approvalAffordance,
  withRecord,
} from "./approval-fixtures.js";
import { ApprovalInbox, DecisionControl } from "./approval-inbox.js";
import type { ApprovalControl } from "./approval-gating.js";
import type { ApprovalInboxProps, ApprovalInboxItem } from "./approval-inbox.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const verified = (value: string) => ({ truthClass: "DAEMON_VERIFIED", value });

function planItem(overrides: Partial<ApprovalInboxItem> = {}): ApprovalInboxItem {
  return {
    affordances: [],
    age: verified("age 4m"),
    decisionId: "d-plan-1",
    kind: "PLAN",
    preconditions: verified("recipe valid · scope src/api/**"),
    record: withRecord(APPROVAL_FIXTURE_RECORDS.PLAN, {
      exactRevisionHash: FIXTURE_REVISION_HASH,
    }),
    subject: "api-endpnt",
    title: "Approve plan · api-endpnt",
    ...overrides,
  };
}

function renderInbox(props: Partial<ApprovalInboxProps> = {}): void {
  render(<ApprovalInbox items={[planItem()]} {...props} />);
}

describe("approvals inbox list", () => {
  it("shows the calmest empty screen and no pending list", () => {
    renderInbox({ items: [] });
    expect(screen.getByText("Nothing needs you.")).toBeDefined();
    expect(screen.queryByTestId("cr.approvals.pending")).toBeNull();
  });

  it("renders risk, age, and preconditions as chip-bearing facts with [Open]", async () => {
    const onOpen = vi.fn();
    renderInbox({ onOpen });
    const item = screen.getByTestId("cr.approvals.item.d-plan-1");
    expect(within(item).getByText("Approve plan · api-endpnt")).toBeDefined();
    expect(within(item).getByTestId("cr.fact.approval.risk")).toBeDefined();
    expect(within(item).getByTestId("cr.fact.approval.age")).toBeDefined();
    expect(within(item).getByTestId("cr.fact.approval.preconditions")).toBeDefined();
    expect(within(item).getByText("R2")).toBeDefined();
    await userEvent.click(within(item).getByRole("button", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledWith("d-plan-1");
  });

  it("gives every fact claim on an item exactly one truth chip", () => {
    renderInbox();
    const item = screen.getByTestId("cr.approvals.item.d-plan-1");
    const facts = item.querySelectorAll("[data-testid^='cr.fact.']");
    const chips = item.querySelectorAll("[data-testid^='cr.chip.']");
    expect(facts.length).toBeGreaterThan(0);
    expect(chips.length).toBe(facts.length);
    for (const fact of facts) {
      expect(fact.querySelector("[data-testid^='cr.chip.']")).not.toBeNull();
    }
  });

  it("carries the spec 8.10 idle-consequence line for the decision's kind", () => {
    renderInbox();
    const item = screen.getByTestId("cr.approvals.item.d-plan-1");
    expect(
      within(item).getByText("if idle: node waits in PLAN_REVIEW; its lease may lapse to SUSPECT."),
    ).toBeDefined();
  });

  it("flags items as possibly stale only while the view is degraded", () => {
    renderInbox({ degraded: true });
    expect(
      within(screen.getByTestId("cr.approvals.item.d-plan-1")).getByText("may be stale"),
    ).toBeDefined();
    cleanup();
    renderInbox();
    expect(screen.queryByText("may be stale")).toBeNull();
  });

  it("announces the pending count politely", () => {
    renderInbox();
    const badge = screen.getByTestId("cr.approvals.badge");
    expect(badge.getAttribute("aria-live")).toBe("polite");
    expect(badge.textContent).toBe("Approvals (1 pending)");
  });
});

describe("escalation and reconciliation items", () => {
  const escalation = planItem({
    affordances: [
      approvalAffordance("escalation.decide", { targetAggregateId: "d-escalation" }),
      approvalAffordance("planning.cancel", {
        commandId: "cmd-fx-replan", targetAggregateId: "d-escalation",
      }),
    ],
    decisionId: "d-escalation",
    kind: "ESCALATION",
    record: withRecord(APPROVAL_FIXTURE_RECORDS.ESCALATION, {
      exactRevisionHash: FIXTURE_REVISION_HASH,
    }),
    title: "Escalation: api-endpnt rejected 3 times",
  });

  it("lands escalation as an inbox item under its declared test id", () => {
    renderInbox({ items: [escalation] });
    const item = screen.getByTestId("cr.approvals.item.escalation");
    expect(within(item).getByText("Escalation: api-endpnt rejected 3 times")).toBeDefined();
    expect(within(item).getByText("if idle: node stays parked in PLANNING.")).toBeDefined();
    expect(within(item).queryByRole("button", { name: "Open" })).toBeNull();
  });

  it("renders one choice per returned command and never invents a choice", () => {
    renderInbox({ items: [escalation] });
    const item = screen.getByTestId("cr.approvals.item.escalation");
    expect(within(item).getByTestId("cr.action.escalation-decide")).toBeDefined();
    expect(within(item).getByTestId("cr.action.planning-cancel")).toBeDefined();
    expect(item.querySelectorAll("[data-testid^='cr.action.']").length).toBe(2);
  });

  it("offers no choice at all when the daemon returned none", () => {
    renderInbox({ items: [{ ...escalation, affordances: [] }] });
    const item = screen.getByTestId("cr.approvals.item.escalation");
    expect(item.querySelectorAll("[data-testid^='cr.action.']").length).toBe(0);
  });

  it("refuses a stale escalation choice with its guard's reason code", () => {
    renderInbox({
      items: [{
        ...escalation,
        record: withRecord(escalation.record, { validity: "INVALIDATED" }),
      }],
    });
    const choice = screen.getByTestId("cr.action.escalation-decide");
    expect(choice.hasAttribute("disabled")).toBe(true);
    expect(choice.getAttribute("data-reason-code"))
      .toBe("APPROVAL_AUTHORITY_BINDING_MISMATCH");
    expect(choice.getAttribute("data-refusing-layer")).toBe("HUMAN_AUTHORITY_GATE");
    expect(choice.getAttribute("data-refused-by")).toBe("RECORD_VALIDITY");
    // Both returned choices are refused by the same stable code and canonical layer.
    expect(screen.getAllByText(
      /^Unavailable: .+ \(APPROVAL_AUTHORITY_BINDING_MISMATCH @ HUMAN_AUTHORITY_GATE\)\.$/,
    )).toHaveLength(2);
  });

  it("carries the reconciliation idle line verbatim", () => {
    renderInbox({
      items: [planItem({
        decisionId: "d-reconcile",
        kind: "RECONCILIATION",
        record: APPROVAL_FIXTURE_RECORDS.RECONCILIATION,
        title: "Reconciliation: import-42",
      })],
    });
    expect(
      screen.getByText("if idle: the record stays quarantined and unschedulable."),
    ).toBeDefined();
  });
});

describe("policy-decided group", () => {
  const autoGroup = {
    policyRevision: "q-3",
    records: [
      { approvalRef: "approval-fx-auto", record: AUTO_APPROVED_RECORD, rule: "auto-r1-isolated-writes" },
      { approvalRef: "approval-fx-auto-2", record: AUTO_APPROVED_RECORD, rule: "auto-r0-readonly" },
    ],
  };

  it("shows nothing at all for a manual-default project", () => {
    renderInbox();
    expect(screen.queryByTestId("cr.approvals.auto")).toBeNull();
  });

  it("collapses the opted-in group behind the spec header", async () => {
    renderInbox({ autoGroup });
    const group = screen.getByTestId("cr.approvals.auto");
    expect(
      within(group).getByText("Decided by policy (2) — auto-approved under rev q-3 (project opted in)"),
    ).toBeDefined();
    expect(within(group).queryByText(/decided by policy q-3, rule auto-r1/)).toBeNull();
    await userEvent.click(within(group).getByRole("button"));
    expect(
      within(group).getByText("decided by policy q-3, rule auto-r1-isolated-writes"),
    ).toBeDefined();
  });

  it("marks automation with the POL chip while its truth stays daemon-verified", async () => {
    renderInbox({ autoGroup });
    const group = screen.getByTestId("cr.approvals.auto");
    await userEvent.click(within(group).getByRole("button"));
    const row = within(group).getByTestId("cr.approvals.auto.row.approval-fx-auto");
    expect(within(row).getAllByTestId("cr.chip.daemon_verified").length).toBe(1);
    expect(within(row).queryByTestId("cr.chip.human_approved")).toBeNull();
    const pol = within(row).getByTestId("cr.chip.policy-approved");
    expect(pol.textContent).toContain("POL");
    // The POL badge marks the actor, not a fact's truth class, so it must never sit
    // inside a fact wrapper where the "one chip per fact" audit would count it.
    expect(pol.closest("[data-testid^='cr.fact.']")).toBeNull();
  });
});

describe("DecisionControl command identity", () => {
  const enabled = Object.freeze({
    commandId: "cmd-fx-approval-decide",
    commandKind: "approval.decide",
    destructive: false,
    disabledText: null,
    label: "Approve",
    reasonCode: null,
    refusedBy: null,
    state: "ENABLED",
    testId: "cr.action.approval-decide.approve",
  }) satisfies ApprovalControl;

  it("renders only the caller-supplied command id", () => {
    const { rerender } = render(<DecisionControl control={enabled} />);
    expect(screen.getByRole("button").getAttribute("data-command-id"))
      .toBe("cmd-fx-approval-decide");

    rerender(<DecisionControl control={{
      ...enabled,
      commandId: null,
      reasonCode: "CAPABILITY_DENIED",
      refusedBy: "AFFORDANCE_ABSENT",
      state: "DISABLED",
    }} />);
    const disabled = screen.getByRole("button");
    expect(disabled.getAttribute("data-command-id")).toBeNull();
    expect(disabled.getAttribute("data-reason-code")).toBe("CAPABILITY_DENIED");
    expect(disabled.getAttribute("data-refused-by")).toBe("AFFORDANCE_ABSENT");
  });
});
