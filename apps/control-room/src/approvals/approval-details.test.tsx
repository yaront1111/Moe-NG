import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  APPROVAL_FIXTURE_RECORDS,
  AUTO_APPROVED_RECORD,
  CUTOVER_CONSEQUENCE_FIXTURE,
  FIXTURE_REVISION_HASH,
  FIXTURE_SUPERSEDING_HASH,
  approvalAffordance,
  withRecord,
} from "./approval-fixtures.js";
import { ApprovalDetailAcceptance } from "./approval-detail-acceptance.js";
import { ApprovalDetailConfirmation } from "./approval-detail-confirmation.js";
import { ApprovalDetailExpansion } from "./approval-detail-expansion.js";
import { ApprovalDetailPlan, abbreviateHash } from "./approval-detail-plan.js";
import type { ApprovalDetailPlanProps } from "./approval-detail-plan.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const TARGET = "approval-detail-target";
const verified = (value: string) => ({ truthClass: "DAEMON_VERIFIED", value });
const observed = (value: string) => ({ truthClass: "OBSERVED", value });

const CURRENT = withRecord(APPROVAL_FIXTURE_RECORDS.PLAN, {
  exactRevisionHash: FIXTURE_REVISION_HASH,
});

const affordance = (kind: Parameters<typeof approvalAffordance>[0]) =>
  approvalAffordance(kind, { targetAggregateId: TARGET });

function planProps(overrides: Partial<ApprovalDetailPlanProps> = {}): ApprovalDetailPlanProps {
  return {
    affordances: [affordance("approval.decide")],
    node: "api-endpnt",
    objective: verified("POST /retry endpoint with idempotency-key"),
    oracle: verified("pnpm test:contract → exit 0"),
    recipeValid: verified("recipe valid"),
    record: CURRENT,
    steps: ["contract test for idempotency-key header", "handler + storage of key"],
    targetAggregateId: TARGET,
    writeScope: verified("src/api/**"),
    ...overrides,
  };
}

function expectFacts(factIds: readonly string[]): void {
  for (const id of factIds) expect(screen.getByTestId(`cr.fact.${id}`)).toBeDefined();
}

/** Bar 3 (§12): every displayed fact carries exactly one truth chip. */
function expectOneChipPerFact(root: HTMLElement): void {
  const facts = root.querySelectorAll("[data-testid^='cr.fact.']");
  const chips = root.querySelectorAll("[data-testid^='cr.chip.']");
  expect(facts.length).toBeGreaterThan(0);
  expect(chips.length).toBe(facts.length);
  for (const f of facts) expect(f.querySelector("[data-testid^='cr.chip.']")).not.toBeNull();
}

describe("approval detail — plan", () => {
  it("names every decision fact the operator needs before deciding", () => {
    const { container } = render(<ApprovalDetailPlan {...planProps()} />);
    expectFacts([
      "approval.risk", "approval.revisionhash", "approval.scope", "approval.budget",
      "approval.policy", "approval.objective", "approval.writescope", "approval.oracle",
      "approval.recipevalid",
    ]);
    expect(screen.getByRole("heading", { level: 2 }).getAttribute("title"))
      .toBe(FIXTURE_REVISION_HASH);
    expect(screen.getByText(/revision a3f9c2d4…$/)).toBeDefined();
    expect(within(screen.getByTestId("cr.approvals.plan.steps")).getAllByRole("listitem"))
      .toHaveLength(2);
    expect(
      screen.getByText("if idle: node waits in PLAN_REVIEW; its lease may lapse to SUSPECT."),
    ).toBeDefined();
    expectOneChipPerFact(container);
  });

  it("approves through the returned command and never through a hand-rolled action", async () => {
    const onDecide = vi.fn();
    render(<ApprovalDetailPlan {...planProps({ onDecide })} />);
    const approve = screen.getByTestId("cr.action.approval-decide.approve");
    expect(approve.hasAttribute("disabled")).toBe(false);
    await userEvent.click(approve);
    expect(onDecide).toHaveBeenCalledWith({
      commandId: "cmd-fx-approval-decide", decision: "APPROVE", reason: null,
    });
  });

  it("requires a reason in the rejection modal and repeats the destructive verb", async () => {
    const onDecide = vi.fn();
    render(<ApprovalDetailPlan {...planProps({ onDecide })} />);
    await userEvent.click(screen.getByTestId("cr.action.approval-decide.reject"));
    const modal = screen.getByRole("dialog");
    expect(within(modal).getByText("Reject plan — api-endpnt")).toBeDefined();
    expect(within(modal).getByText(
      "The plan returns to its author with your reason as a carried finding."
      + " The node returns to PLANNING.",
    )).toBeDefined();
    expect(within(modal).getByText(/^This records event approval\.decide with your identity\.$/))
      .toBeDefined();
    const confirm = within(modal).getByRole("button", { name: "Reject plan" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(onDecide).not.toHaveBeenCalled();
    await userEvent.type(within(modal).getByRole("textbox"), "{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("cr.action.approval-decide.reject"));
    await userEvent.type(screen.getByRole("textbox"), "scope too wide");
    await userEvent.click(screen.getByRole("button", { name: "Reject plan" }));
    expect(onDecide).toHaveBeenCalledWith({
      commandId: "cmd-fx-approval-decide", decision: "REJECT", reason: "scope too wide",
    });
  });

  it("refuses to submit a plan whose approval the daemon already invalidated", () => {
    render(<ApprovalDetailPlan {...planProps({
      record: withRecord(CURRENT, { validity: "INVALIDATED" }),
    })} />);
    const approve = screen.getByTestId("cr.action.approval-decide.approve");
    expect(approve.hasAttribute("disabled")).toBe(true);
    expect(approve.getAttribute("data-reason-code"))
      .toBe("APPROVAL_AUTHORITY_BINDING_MISMATCH");
    expect(approve.getAttribute("data-refusing-layer")).toBe("HUMAN_AUTHORITY_GATE");
    expect(approve.getAttribute("data-refused-by")).toBe("RECORD_VALIDITY");
  });
});

describe("approval detail — delta re-approval mode", () => {
  const delta = { supersededHash: FIXTURE_SUPERSEDING_HASH, unchangedSteps: 3 };

  it("names both revisions in the invalidation banner and strikes the superseded one", () => {
    render(<ApprovalDetailPlan {...planProps({ delta })} />);
    const banner = screen.getByTestId("cr.banner.invalidated");
    expect(banner.getAttribute("aria-live")).toBe("polite");
    expect(banner.textContent).toBe(
      `Your approval of ${abbreviateHash(FIXTURE_SUPERSEDING_HASH)} was invalidated by `
      + `${abbreviateHash(FIXTURE_REVISION_HASH)} — reviewing only the delta.`,
    );
    const struck = within(banner).getByText(abbreviateHash(FIXTURE_SUPERSEDING_HASH));
    expect(struck.style.textDecoration).toBe("line-through");
  });

  it("collapses the unchanged steps by default and says what approving supersedes", async () => {
    render(<ApprovalDetailPlan {...planProps({ delta })} />);
    const collapsed = screen.getByTestId("cr.approvals.delta.unchanged");
    expect(collapsed.textContent).toBe("3 steps unchanged — expand");
    expect(collapsed.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(collapsed);
    expect(collapsed.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(
      `Approving revision ${abbreviateHash(FIXTURE_REVISION_HASH)} (this supersedes your `
      + `approval of ${abbreviateHash(FIXTURE_SUPERSEDING_HASH)}).`,
    )).toBeDefined();
  });

  it("shows no delta device at all outside delta mode", () => {
    render(<ApprovalDetailPlan {...planProps()} />);
    expect(screen.queryByTestId("cr.banner.invalidated")).toBeNull();
    expect(screen.queryByTestId("cr.approvals.delta.unchanged")).toBeNull();
  });
});

describe("approval detail — expansion", () => {
  function expansion(overrides = {}) {
    return (
      <ApprovalDetailExpansion
        affordances={[affordance("graph.approve"), affordance("expansion.decline")]}
        goal="payments-retry-hardening"
        invalidates={verified("nothing (adds child subgraph under node payments-core)")}
        preconditions={[
          { detail: verified("api: src/api/** · ui: web/panel/** · docs: docs/**"), key: "scopes", label: "Write scopes disjoint" },
          { detail: verified("api: pnpm test:contract → exit 0"), key: "oracles", label: "Child oracles present" },
          { detail: verified("$18 of $19 remaining envelope"), key: "budget", label: "Budget reserved" },
          { detail: observed("width 3 of 6 cap · depth 2 of 3"), key: "width", label: "Fan-out width" },
        ]}
        record={withRecord(APPROVAL_FIXTURE_RECORDS.EXPANSION, {
          exactRevisionHash: FIXTURE_REVISION_HASH,
        })}
        subgraph={["api-endpnt", "ui-panel", "docs"]}
        supersedesHash={FIXTURE_SUPERSEDING_HASH}
        targetAggregateId={TARGET}
        {...overrides}
      />
    );
  }

  it("routes approval through graph.approve, not approval.decide", () => {
    render(expansion());
    expect(screen.getByTestId("cr.action.graph-approve")).toBeDefined();
    expect(screen.getByTestId("cr.action.expansion-decline")).toBeDefined();
    expect(screen.queryByTestId("cr.action.approval-decide.approve")).toBeNull();
  });

  it("renders each daemon-checked precondition with its real path set", () => {
    const { container } = render(expansion());
    for (const key of ["scopes", "oracles", "budget", "width"]) {
      expect(screen.getByTestId(`cr.approvals.precondition.${key}`)).toBeDefined();
    }
    expect(screen.getByText("api: src/api/** · ui: web/panel/** · docs: docs/**")).toBeDefined();
    expect(screen.getByText("$18 of $19 remaining envelope")).toBeDefined();
    expect(screen.getByText("if idle: children stay unscheduled.")).toBeDefined();
    expectOneChipPerFact(container);
  });

  it("stacks preconditions above the preview and pins the decision buttons last", () => {
    const { container } = render(expansion());
    const stacked = [
      "cr.approvals.preconditions", "cr.approvals.expansion.preview",
      "cr.approvals.detail.actions",
    ];
    const order = [...container.querySelectorAll("[data-testid]")]
      .map((node) => node.getAttribute("data-testid") ?? "")
      .filter((id) => stacked.includes(id));
    expect(order).toEqual(stacked);
    expect(screen.getByTestId("cr.approvals.detail.actions").getAttribute("data-pinned"))
      .toBe("true");
  });

  it("dismisses the ghost subgraph only through the reason modal", async () => {
    const onDecide = vi.fn();
    render(expansion({ onDecide }));
    await userEvent.click(screen.getByTestId("cr.action.expansion-decline"));
    const modal = screen.getByRole("dialog");
    expect(within(modal).getByText(
      "The proposed children are not created. The ghost subgraph is dismissed and the "
      + "proposal is recorded with your reason.",
    )).toBeDefined();
    await userEvent.type(within(modal).getByRole("textbox"), "width unjustified");
    await userEvent.click(within(modal).getByRole("button", { name: "Reject expansion" }));
    expect(onDecide).toHaveBeenCalledWith({
      commandId: "cmd-fx-expansion-decline", decision: "REJECT", reason: "width unjustified",
    });
  });
});

describe("approval detail — acceptance", () => {
  function acceptance(overrides = {}) {
    return (
      <ApprovalDetailAcceptance
        affordances={[affordance("approval.decide")]}
        diff={{
          baseSha: verified("454a601"),
          fileCount: verified("3 files"),
          headSha: verified("9e12f44"),
          inScope: verified("all in scope src/api/**"),
        }}
        node="api-endpnt"
        receipt={{
          digest: verified("77ab…"),
          exitCode: verified("0"),
          recipe: verified("pnpm test:contract"),
          time: verified("09:38"),
        }}
        record={withRecord(APPROVAL_FIXTURE_RECORDS.ACCEPTANCE, {
          exactRevisionHash: FIXTURE_REVISION_HASH,
        })}
        reopenBound={3}
        reopenCount={1}
        review={{
          distinctPrincipal: verified("distinct principal"),
          findings: verified("0"),
          reviewer: verified("r-1"),
        }}
        targetAggregateId={TARGET}
        {...overrides}
      />
    );
  }

  it("shows the diff, the receipt, and the reviewer as separately classed facts", () => {
    const { container } = render(acceptance());
    expectFacts([
      "approval.diff.base", "approval.diff.head", "approval.diff.files", "approval.diff.inscope",
      "approval.receipt.recipe", "approval.receipt.exit", "approval.receipt.time",
      "approval.receipt.digest", "approval.review.reviewer", "approval.review.distinct",
      "approval.review.findings",
    ]);
    expect(screen.getByText("if idle: work waits in WORK_REVIEW; branch stays unmerged."))
      .toBeDefined();
    expectOneChipPerFact(container);
  });

  it("routes both accept and decline through approval.decide", async () => {
    const onDecide = vi.fn();
    render(acceptance({ onDecide }));
    expect(screen.getByTestId("cr.action.approval-decide.decline")).toBeDefined();
    await userEvent.click(screen.getByTestId("cr.action.approval-decide.accept"));
    expect(onDecide).toHaveBeenCalledWith({
      commandId: "cmd-fx-approval-decide", decision: "APPROVE", reason: null,
    });
  });

  it("counts the decline against the reopen bound in the modal body", async () => {
    render(acceptance());
    await userEvent.click(screen.getByTestId("cr.action.approval-decide.decline"));
    expect(screen.getByText(
      "The work is not merged. The node returns to PLANNING with your reason as a carried "
      + "finding, counting toward its reopen bound (1 of 3).",
    )).toBeDefined();
  });
});

describe("approval detail — confirmation and cutover", () => {
  function confirmation(overrides = {}) {
    return (
      <ApprovalDetailConfirmation
        affordances={[affordance("cutover.activate")]}
        auditEvent="cutover.activate"
        commandKind="cutover.activate"
        confirmLabel="Activate cutover"
        consequence={CUTOVER_CONSEQUENCE_FIXTURE}
        kind="CUTOVER_ACTIVATE"
        record={withRecord(APPROVAL_FIXTURE_RECORDS.CUTOVER_ACTIVATE, {
          exactRevisionHash: FIXTURE_REVISION_HASH,
        })}
        scope="3 nodes rebound under goal-j1"
        subject="goal-j1"
        targetAggregateId={TARGET}
        {...overrides}
      />
    );
  }

  it("shows the design-derived consequence frame and marks it provisional", () => {
    const { container } = render(confirmation());
    expectFacts([
      "approval.consequence.storedhash", "approval.consequence.disposition",
      "approval.consequence.funding", "approval.consequence.fence",
      "approval.consequence.deadline", "approval.consequence.release",
      "approval.consequence.payload",
    ]);
    expect(screen.getByText(/^Provisional: derived from the system design/)).toBeDefined();
    expectOneChipPerFact(container);
  });

  it("displays the step-up authentication an R3 decision required", () => {
    render(confirmation());
    const stepUp = screen.getByTestId("cr.fact.approval.stepup");
    expect(within(stepUp).getByText("stepup/webauthn-1")).toBeDefined();
    expect(within(screen.getByTestId("cr.fact.approval.risk")).getByText("R3")).toBeDefined();
  });

  it("invents no idle consequence for a kind the spec never defined", () => {
    render(confirmation());
    expect(screen.queryByText(/^if idle:/)).toBeNull();
    cleanup();
    render(confirmation({
      auditEvent: "approval.decide",
      commandKind: "approval.decide",
      confirmLabel: "Confirm revocation",
      consequence: undefined,
      kind: "REVOCATION_CONFIRMATION",
      record: withRecord(APPROVAL_FIXTURE_RECORDS.REVOCATION_CONFIRMATION, {
        exactRevisionHash: FIXTURE_REVISION_HASH,
      }),
    }));
    expect(screen.getByText("if idle: the lease stays SUSPECT; no takeover occurs."))
      .toBeDefined();
  });

  it("never confirms straight from the button; the reason modal is the only path", async () => {
    const onDecide = vi.fn();
    render(confirmation({ onDecide }));
    await userEvent.click(screen.getByTestId("cr.action.cutover-activate"));
    expect(onDecide).not.toHaveBeenCalled();
    const modal = screen.getByRole("dialog");
    expect(within(modal).getByText("Scope of effect: 3 nodes rebound under goal-j1")).toBeDefined();
    await userEvent.type(within(modal).getByRole("textbox"), "import verified");
    await userEvent.click(within(modal).getByRole("button", { name: "Activate cutover" }));
    expect(onDecide).toHaveBeenCalledWith({
      commandId: "cmd-fx-cutover-activate", decision: "APPROVE", reason: "import verified",
    });
  });
});

describe("policy-decided records on a detail surface", () => {
  it("renders daemon-verified truth and never a human-approved chip", () => {
    const { container } = render(<ApprovalDetailPlan {...planProps({
      record: withRecord(AUTO_APPROVED_RECORD, { exactRevisionHash: FIXTURE_REVISION_HASH }),
    })} />);
    expect(container.querySelector("[data-testid='cr.chip.human_approved']")).toBeNull();
    expect(container.querySelectorAll("[data-testid='cr.chip.daemon_verified']").length)
      .toBeGreaterThan(0);
  });

  it("refuses the decision because the record's lifecycle already closed", () => {
    render(<ApprovalDetailPlan {...planProps({
      record: withRecord(AUTO_APPROVED_RECORD, { exactRevisionHash: FIXTURE_REVISION_HASH }),
    })} />);
    const approve = screen.getByTestId("cr.action.approval-decide.approve");
    expect(approve.hasAttribute("disabled")).toBe(true);
    expect(approve.getAttribute("data-reason-code"))
      .toBe("APPROVAL_AUTHORITY_BINDING_MISMATCH");
    expect(approve.getAttribute("data-refusing-layer")).toBe("HUMAN_AUTHORITY_GATE");
    expect(approve.getAttribute("data-refused-by")).toBe("RECORD_LIFECYCLE");
  });
});
