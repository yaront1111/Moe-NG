import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  Gate1ApprovalOutcome, Gate1ApprovalPort, Gate1ReadOutcome,
} from "./gate1-approval.js";
import { mapGate1Answer } from "./gate1-approval.js";
import { Gate1Card } from "./gate1-card.js";
import {
  GATE1_V2_OPEN_BODY,
  GATE1_V2_READY_BODY,
  GATE1_V2_REVISION,
} from "./gate1-v2-test-fixture.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function pending(body: unknown): Promise<Extract<Gate1ReadOutcome, { status: "PENDING" }>> {
  const outcome = await mapGate1Answer(200, body);
  if (outcome.status !== "PENDING") throw new Error(`expected PENDING, got ${outcome.status}`);
  return outcome;
}

function portWith(overrides: Partial<Gate1ApprovalPort> = {}): Gate1ApprovalPort {
  return {
    answer: vi.fn(async () => ({ commandId: "answer-cmd-1", ok: true as const })),
    submit: vi.fn(async () => ({ commandId: "gate1-cmd-1", ok: true as const })),
    ...overrides,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T) => void;
} {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, reject, resolve };
}

describe("the Product Contract /2 Gate 1 dossier", () => {
  it("renders every admitted contract section instead of a flattened summary", async () => {
    const outcome = await pending(GATE1_V2_OPEN_BODY);
    render(<Gate1Card goalId="goal-live-1" port={portWith()} read={async () => outcome} />);
    const sectionIds = [
      "objectives", "user-jobs", "journeys", "requirements.functional",
      "requirements.non-functional", "requirements.security-privacy",
      "requirements.technology", "requirements.ux-accessibility",
      "requirements.deployment", "criteria", "negative-scope", "assumptions",
      "budgets", "success-metrics", "material-decisions", "product-complete",
      "provenance", "retired",
    ];
    await screen.findByTestId("cr.gate1.pending");
    for (const sectionId of sectionIds) {
      expect(screen.getByTestId(`cr.gate1.contract.${sectionId}`)).toBeTruthy();
    }
  });

  it("shows verification, relationships, decisions, and exact provenance", async () => {
    const outcome = await pending(GATE1_V2_OPEN_BODY);
    render(<Gate1Card goalId="goal-live-1" port={portWith()} read={async () => outcome} />);
    await screen.findByTestId("cr.gate1.pending");
    expect(screen.getByTestId("cr.gate1.contract.criteria").textContent)
      .toContain("Verify criterion-login deterministically.");
    expect(screen.getByTestId("cr.gate1.contract.requirements.non-functional").textContent)
      .toContain("depends on requirement-login");
    expect(screen.getByTestId("cr.gate1.contract.material-decisions").textContent)
      .toContain("Use Next.js and TypeScript.");
    expect(screen.getByTestId("cr.gate1.contract.product-complete").textContent)
      .toContain("Every approved criterion is independently verified.");
    const provenance = screen.getByTestId("cr.gate1.contract.provenance").textContent ?? "";
    expect(provenance).toContain(GATE1_V2_REVISION.authorRef);
    expect(provenance).toContain(GATE1_V2_REVISION.version);
    expect(provenance).toContain(GATE1_V2_REVISION.sourceDocumentDigests[0]);
    expect(provenance).toContain(GATE1_V2_REVISION.lineage?.parentRevisionId);
    expect(screen.getByTestId("cr.gate1.contract.retired").textContent)
      .toContain("requirement-retired");

    const contains = (sectionId: string, values: readonly unknown[]): void => {
      const text = screen.getByTestId(`cr.gate1.contract.${sectionId}`).textContent ?? "";
      for (const value of values) expect(text).toContain(String(value));
    };
    for (const row of GATE1_V2_REVISION.objectives) {
      contains("objectives", [row.objectiveId, row.statement]);
    }
    for (const row of GATE1_V2_REVISION.userJobs) {
      contains("user-jobs", [row.userJobId, row.user, row.job]);
    }
    for (const row of GATE1_V2_REVISION.journeys) {
      contains("journeys", [row.journeyId, row.userJobId, row.statement, ...row.criterionIds]);
    }
    const requirementSections = [
      ["requirements.functional", GATE1_V2_REVISION.functionalRequirements],
      ["requirements.non-functional", GATE1_V2_REVISION.nonFunctionalRequirements],
      ["requirements.security-privacy", GATE1_V2_REVISION.securityPrivacyRequirements],
      ["requirements.technology", GATE1_V2_REVISION.technologyRequirements],
      ["requirements.ux-accessibility", GATE1_V2_REVISION.uxAccessibilityRequirements],
      ["requirements.deployment", GATE1_V2_REVISION.deploymentRequirements],
    ] as const;
    for (const [sectionId, rows] of requirementSections) {
      for (const row of rows) contains(sectionId, [
        row.requirementId, row.statement, row.priority, ...row.dependsOnRequirementIds,
        row.supersedesRequirementId ?? "supersedes none",
      ]);
    }
    for (const row of GATE1_V2_REVISION.criteria) contains("criteria", [
      row.criterionId, row.requirementId, row.statement, row.verification,
      row.supersedesCriterionId ?? "supersedes none",
    ]);
    for (const row of GATE1_V2_REVISION.negativeScope) {
      contains("negative-scope", [row.scopeId, row.statement]);
    }
    for (const row of GATE1_V2_REVISION.assumptions) contains("assumptions", [
      row.assumptionId, row.statement, row.validationCriterionId,
    ]);
    for (const row of GATE1_V2_REVISION.budgets) {
      contains("budgets", [row.budgetId, row.kind, row.limit, row.unit]);
    }
    for (const row of GATE1_V2_REVISION.successMetrics) contains("success-metrics", [
      row.metricId, row.statement, row.target, row.measurement, ...row.objectiveIds,
    ]);
    for (const row of GATE1_V2_REVISION.materialDecisions) contains("material-decisions", [
      row.decisionId, row.question, row.selectedOptionId,
      ...row.options.flatMap((option) => [option.optionId, option.statement]),
    ]);
    contains("product-complete", [
      GATE1_V2_REVISION.productCompleteDefinition.statement,
      ...GATE1_V2_REVISION.productCompleteDefinition.criterionIds,
    ]);
    contains("provenance", [
      GATE1_V2_REVISION.authorRef, GATE1_V2_REVISION.version, GATE1_V2_REVISION.contractId,
      GATE1_V2_REVISION.revisionId, GATE1_V2_REVISION.revisionDigest,
      GATE1_V2_REVISION.advisoryOnly, ...GATE1_V2_REVISION.sourceDocumentDigests,
      GATE1_V2_REVISION.lineage!.parentRevisionId,
      GATE1_V2_REVISION.lineage!.parentRevisionDigest,
    ]);
    contains("retired", [
      ...GATE1_V2_REVISION.retiredRequirementIds, ...GATE1_V2_REVISION.retiredCriterionIds,
    ]);
  });

  it("uses a named busy region, ordered headings, and live status semantics", async () => {
    const read = deferred<Gate1ReadOutcome>();
    render(<Gate1Card goalId="goal-live-1" port={portWith()} read={() => read.promise} />);
    const region = screen.getByRole("region", { name: /PRODUCT CONTRACT.*GATE 1.*goal-live-1/ });
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toContain("Reading the contract");

    const outcome = await pending(GATE1_V2_OPEN_BODY);
    await act(async () => { read.resolve(outcome); await read.promise; });
    expect(region.getAttribute("aria-busy")).toBe("false");
    expect(screen.getByRole("heading", {
      level: 2, name: /PRODUCT CONTRACT.*GATE 1.*goal-live-1/,
    })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: /OBJECTIVES/ })).toBeTruthy();
  });

  it("dispatches the selected daemon option and re-reads for approval", async () => {
    const user = userEvent.setup();
    const open = await pending(GATE1_V2_OPEN_BODY);
    const ready = await pending(GATE1_V2_READY_BODY);
    const reads = [open, ready];
    const read = vi.fn(async () => reads.shift() ?? ready);
    const port = portWith();
    render(<Gate1Card goalId="goal-live-1" port={port} read={read} />);
    await user.click(await screen.findByTestId(
      "cr.gate1.answer.clarification-profile.option-a",
    ));
    await screen.findByTestId("cr.gate1.approve");
    expect(port.answer).toHaveBeenCalledWith(open.clarifications[0], "option-a");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("re-reads after approval and announces the daemon-confirmed retirement", async () => {
    const user = userEvent.setup();
    const ready = await pending(GATE1_V2_READY_BODY);
    const reads: Gate1ReadOutcome[] = [ready, { status: "NONE" }];
    const read = vi.fn(async () => reads.shift() ?? { status: "NONE" as const });
    const port = portWith();
    render(<Gate1Card goalId="goal-live-1" port={port} read={read} />);
    await user.click(await screen.findByTestId("cr.gate1.approve"));
    expect((await screen.findByRole("status")).textContent).toContain("Contract approved");
    expect(port.submit).toHaveBeenCalledWith(ready);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("announces exact dispatch and read refusal provenance as alerts", async () => {
    const user = userEvent.setup();
    const ready = await pending(GATE1_V2_READY_BODY);
    const refused: Gate1ApprovalOutcome = {
      code: "PRODUCT_CONTRACT_GATE_1_BEARER_REPLAYED",
      layer: "DAEMON_PRODUCT_CONTRACT_GATE_1_BEARER",
      ok: false,
    };
    const port = portWith({ submit: vi.fn(async () => refused) });
    const { rerender } = render(
      <Gate1Card goalId="goal-live-1" port={port} read={async () => ready} />,
    );
    await user.click(await screen.findByTestId("cr.gate1.approve"));
    expect((await screen.findByRole("alert")).textContent)
      .toContain(`${refused.code} · ${refused.layer}`);

    rerender(<Gate1Card
      goalId="goal-live-2"
      port={port}
      read={async () => ({ code: "READ_REFUSED", layer: "DAEMON_READ", status: "REFUSED" })}
    />);
    expect((await screen.findByRole("alert")).textContent)
      .toContain("REFUSED · READ_REFUSED · DAEMON_READ");
  });

  it("turns a synchronous read failure into an accessible local error", async () => {
    render(<Gate1Card
      goalId="goal-live-1"
      port={portWith()}
      read={() => { throw new Error("offline"); }}
    />);
    expect((await screen.findByRole("alert")).textContent)
      .toContain("ERROR · GATE1_READ_FAILED · CONTROL_ROOM_GATE1");
  });

  it("ignores an old goal dispatch and resets busy/refusal state for the new goal", async () => {
    const user = userEvent.setup();
    const ready = await pending(GATE1_V2_READY_BODY);
    const first = deferred<Gate1ApprovalOutcome>();
    const submit = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ commandId: "gate1-cmd-2", ok: true as const });
    const port = portWith({ submit });
    const read = vi.fn(async () => ready);
    const view = render(<Gate1Card goalId="goal-a" port={port} read={read} />);
    await user.click(await screen.findByTestId("cr.gate1.approve"));
    expect(screen.getByRole("region").getAttribute("aria-busy")).toBe("true");

    view.rerender(<Gate1Card goalId="goal-b" port={port} read={read} />);
    const goalB = await screen.findByRole("region", { name: /goal-b/ });
    await waitFor(() => { expect(goalB.getAttribute("aria-busy")).toBe("false"); });
    expect((screen.getByTestId("cr.gate1.approve") as HTMLButtonElement).disabled).toBe(false);

    view.rerender(<Gate1Card goalId="goal-a" port={port} read={read} />);
    const nextGoalA = await screen.findByRole("region", { name: /goal-a/ });
    await waitFor(() => { expect(nextGoalA.getAttribute("aria-busy")).toBe("false"); });
    expect((screen.getByTestId("cr.gate1.approve") as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      first.resolve({ code: "OLD_REFUSAL", layer: "OLD_GOAL", ok: false });
      await first.promise;
    });
    expect(screen.queryByText(/OLD_REFUSAL/)).toBeNull();
    expect((screen.getByTestId("cr.gate1.approve") as HTMLButtonElement).disabled).toBe(false);
  });
});
