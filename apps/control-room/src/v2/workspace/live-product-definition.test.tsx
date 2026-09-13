import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductContractRef } from "@moe/control-room-model";
import type { LiveSetup } from "../../live/live-config.js";
import { mapGate1Answer, readPendingContract } from "../goals/gate1-approval.js";
import type { Gate1ReadOutcome } from "../goals/gate1-approval.js";
import { readPendingContractV1 } from "../goals/gate1-v1-approval.js";
import type { Gate1PendingViewV1 } from "../goals/gate1-v1-approval.js";
import { GATE1_V2_CURRENT_BODY, GATE1_V2_READY_BODY } from "../goals/gate1-v2-test-fixture.js";
import { LiveProductDefinition } from "./live-product-definition.js";

const ports = vi.hoisted(() => ({ v1: { answer: vi.fn(), submit: vi.fn() }, v2: { answer: vi.fn(), submit: vi.fn() } }));
vi.mock("../goals/gate1-approval.js", async importOriginal => ({
  ...await importOriginal<typeof import("../goals/gate1-approval.js")>(),
  readPendingContract: vi.fn(), createGate1ApprovalPort: () => ports.v2,
}));
vi.mock("../goals/gate1-v1-approval.js", async importOriginal => ({
  ...await importOriginal<typeof import("../goals/gate1-v1-approval.js")>(),
  readPendingContractV1: vi.fn(), createGate1ApprovalPortV1: () => ports.v1,
}));
beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  vi.clearAllMocks();
  ports.v1.submit.mockResolvedValue({ ok: false, code: "TEST_REFUSAL", layer: "TEST" });
  ports.v2.submit.mockResolvedValue({ ok: false, code: "TEST_REFUSAL", layer: "TEST" });
});
afterEach(cleanup);

const v1: Gate1PendingViewV1 = { status: "PENDING", contractId: "contract-a", revisionId: "revision-a",
  revisionDigest: "a".repeat(64), approval: { affordance: {}, commandId: "approve-a", requestDigest: "b".repeat(64) },
  clarifications: [], criteria: [{ criterionId: "criterion-a", statement: "Selected criterion" }],
  requirements: [{ requirementId: "requirement-a", statement: "Selected requirement" }],
};
const setupFor = (plane: "V1" | "V2"): LiveSetup => ({ commandAuthorityPlane: plane,
  headers: { "content-type": "application/json" }, projectId: "project-1",
}) as unknown as LiveSetup;
function reference(outcome: Gate1PendingViewV1 | Extract<Gate1ReadOutcome, { status: "PENDING" | "CURRENT" }>,
  plane: "V1" | "V2"): ProductContractRef {
  return { plane, contractId: outcome.contractId, revisionId: outcome.revisionId, revisionDigest: outcome.revisionDigest };
}
async function answerFor(plane: "V1" | "V2") {
  if (plane === "V1") { vi.mocked(readPendingContractV1).mockResolvedValue(v1); return v1; }
  const answer = await mapGate1Answer(200, GATE1_V2_READY_BODY, "project-1");
  if (answer.status !== "PENDING") throw new Error("invalid V2 fixture");
  vi.mocked(readPendingContract).mockResolvedValue(answer);
  return answer;
}

describe("selected definition identity", () => {
  for (const plane of ["V1", "V2"] as const) {
    for (const field of ["contractId", "revisionId", "revisionDigest", "plane"] as const) {
      it(`${plane} refuses changed ${field} before exposing an approval`, async () => {
        const answer = await answerFor(plane);
        const expected = { ...reference(answer, plane), [field]: field === "plane" ? plane === "V1" ? "V2" : "V1" : "different" } as ProductContractRef;
        await act(async () => { render(<LiveProductDefinition setup={setupFor(plane)} goalId="goal-a" source={null} expectedRef={expected} />); });
        expect(document.body.textContent).toContain("VIEWED_DEFINITION_CHANGED");
        expect(document.body.textContent).toContain("CONTROL_ROOM_PRODUCT");
        expect(screen.queryByTestId("cr.gate1.approve")).toBeNull();
        expect(ports.v1.submit).not.toHaveBeenCalled(); expect(ports.v2.submit).not.toHaveBeenCalled();
      });
    }
    it(`${plane} submits the exact matching pending read unchanged`, async () => {
      const answer = await answerFor(plane);
      await act(async () => { render(<LiveProductDefinition setup={setupFor(plane)} goalId="goal-a" source={null} expectedRef={reference(answer, plane)} />); });
      await act(async () => { fireEvent.click(screen.getByTestId("cr.gate1.approve")); });
      expect(ports[plane === "V1" ? "v1" : "v2"].submit.mock.calls[0]?.[0]).toBe(answer);
      expect(ports[plane === "V1" ? "v2" : "v1"].submit).not.toHaveBeenCalled();
    });
    it(`${plane} does not treat an absent current read as the selected definition`, async () => {
      if (plane === "V1") vi.mocked(readPendingContractV1).mockResolvedValue({ status: "NONE" });
      else vi.mocked(readPendingContract).mockResolvedValue({ status: "NONE" });
      await act(async () => { render(<LiveProductDefinition setup={setupFor(plane)} goalId="goal-a" source={null}
        expectedRef={{ ...reference(v1, plane) }} />); });
      expect(document.body.textContent).toContain("VIEWED_DEFINITION_CHANGED");
      expect(screen.queryByTestId("cr.gate1.approve")).toBeNull();
    });
    it(`${plane} refuses a new approval at the port even if disabled presentation is bypassed`, async () => {
      const answer = await answerFor(plane), setup = setupFor(plane);
      const view = render(<LiveProductDefinition setup={setup} goalId="goal-a" source={null} expectedRef={reference(answer, plane)} />);
      const approve = await screen.findByTestId("cr.gate1.approve");
      await act(async () => { view.rerender(<LiveProductDefinition setup={setup} goalId="goal-a" source={null}
        expectedRef={reference(answer, plane)} readOnly />); });
      expect(screen.getByTestId("cr.gate1.approve")).toBe(approve);
      expect(approve.matches(":disabled")).toBe(true);
      approve.closest("fieldset")!.disabled = false;
      await act(async () => { fireEvent.click(approve); });
      expect(ports.v1.submit).not.toHaveBeenCalled(); expect(ports.v2.submit).not.toHaveBeenCalled();
      expect(screen.getByTestId("cr.gate1.dispatchrefusal").textContent).toContain("VIEWED_DEFINITION_NOT_CURRENT");
    });
    it(`${plane} refuses a clarification at the read-only port`, async () => {
      const answer = await answerFor(plane);
      if ("revision" in answer) {
        if (answer.approval === null) throw new Error("missing fixture approval");
        vi.mocked(readPendingContract).mockResolvedValue({ ...answer, approval: null, clarifications: [{
          clarificationId: "question", question: "Which option?", options: [{ optionId: "option", label: "Choose option",
            answer: answer.approval, projectionDigest: "projection", revisionDigest: answer.revisionDigest }],
        }] });
      } else {
        vi.mocked(readPendingContractV1).mockResolvedValue({ ...answer, approval: null, clarifications: [{
          clarificationId: "question", question: "Which option?", answered: false, answerAffordance: {},
          options: [{ optionId: "option", label: "Choose option" }], optionDigests: [{ optionId: "option", projectionDigest: "projection" }],
        }] });
      }
      render(<LiveProductDefinition setup={setupFor(plane)} goalId="goal-a" source={null} expectedRef={reference(answer, plane)} readOnly />);
      const choose = await screen.findByRole("button", { name: "Choose option" });
      expect(choose.matches(":disabled")).toBe(true);
      choose.closest("fieldset")!.disabled = false;
      await act(async () => { fireEvent.click(choose); });
      expect(ports.v1.answer).not.toHaveBeenCalled(); expect(ports.v2.answer).not.toHaveBeenCalled();
      expect(screen.getByTestId("cr.gate1.dispatchrefusal").textContent).toContain("VIEWED_DEFINITION_NOT_CURRENT");
    });
  }

  it("renders the exact selected current V2 revision without adding approval", async () => {
    const answer = await mapGate1Answer(200, GATE1_V2_CURRENT_BODY, "project-1");
    if (answer.status !== "CURRENT") throw new Error("invalid CURRENT fixture");
    vi.mocked(readPendingContract).mockResolvedValue(answer);
    await act(async () => { render(<LiveProductDefinition setup={setupFor("V2")} goalId="goal-a" source={null} expectedRef={reference(answer, "V2")} />); });
    expect(document.body.textContent).toContain(answer.revisionDigest);
    expect(document.body.textContent).not.toContain("VIEWED_DEFINITION_CHANGED");
    expect(screen.queryByTestId("cr.gate1.approve")).toBeNull();
  });

  it("keeps the current proposal experience when no artifact identity has been selected", async () => {
    await answerFor("V1");
    await act(async () => { render(<LiveProductDefinition setup={setupFor("V1")} goalId="goal-a" source={null} />); });
    expect(screen.getByTestId("cr.gate1.approve")).toBeTruthy();
  });

  it("does not carry an in-flight decision or its refusal into another goal", async () => {
    let finish!: (value: { ok: false; code: string; layer: string }) => void;
    ports.v1.submit.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const other: Gate1PendingViewV1 = { ...v1, contractId: "contract-b", revisionId: "revision-b",
      requirements: [{ requirementId: "requirement-b", statement: "Product B requirement" }],
    };
    vi.mocked(readPendingContractV1).mockImplementation(async (_headers, goal) => goal === "goal-a" ? v1 : other);
    const setup = setupFor("V1");
    const rendered = render(<LiveProductDefinition setup={setup} goalId="goal-a" source={null} expectedRef={reference(v1, "V1")} />);
    await screen.findByTestId("cr.gate1.approve");
    await act(async () => { fireEvent.click(screen.getByTestId("cr.gate1.approve")); });
    await act(async () => { rendered.rerender(<LiveProductDefinition setup={setup} goalId="goal-b" source={null} expectedRef={reference(other, "V1")} />); });
    expect(document.body.textContent).toContain("Product B requirement");
    expect(document.body.textContent).not.toContain("Selected requirement");
    expect((screen.getByTestId("cr.gate1.approve") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { finish({ ok: false, code: "OLD_GOAL_REFUSAL", layer: "DAEMON" }); });
    expect(document.body.textContent).not.toContain("OLD_GOAL_REFUSAL");
    expect(ports.v1.submit).toHaveBeenCalledTimes(1);
  });

  it("keeps a pending decision locked when an equivalent selected model is recomposed", async () => {
    ports.v1.submit.mockReturnValueOnce(new Promise(() => undefined));
    vi.mocked(readPendingContractV1).mockResolvedValue(v1);
    const setup = setupFor("V1");
    const rendered = render(<LiveProductDefinition setup={setup} goalId="goal-a" source={null} expectedRef={reference(v1, "V1")} />);
    await screen.findByTestId("cr.gate1.approve");
    await act(async () => { fireEvent.click(screen.getByTestId("cr.gate1.approve")); });
    await act(async () => { rendered.rerender(<LiveProductDefinition setup={setup} goalId="goal-a" source={null} expectedRef={reference(v1, "V1")} />); });
    expect((screen.getByTestId("cr.gate1.approve") as HTMLButtonElement).disabled).toBe(true);
    expect(readPendingContractV1).toHaveBeenCalledTimes(1);
    expect(ports.v1.submit).toHaveBeenCalledTimes(1);
  });
});
