import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CriterionEvidenceCard } from "./criterion-evidence-card.js";
import type { CriterionEvidenceView } from "../../live/live-criterion-evidence-contracts.js";
const offer = (commandKind: string) => ({ commandEnvelopeVersion: "moe-runtime-command/1", commandId: commandKind,
  commandKind, expectedVersion: 3, inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: "catalog" });
const view: CriterionEvidenceView = { outcome: "CRITERION_EVIDENCE", goalRef: "goal-a", planningRunRef: "plan-a",
  contractRef: { contractId: "contract-a", revisionId: "revision-a", revisionDigest: "a".repeat(64) }, graphContentHash: "b".repeat(64),
  integratedArtifact: { sha: "c".repeat(40), treeSha: "d".repeat(40) }, criteria: [{ criterionId: "result", statement: "The result appears",
    approveOffer: offer("criterion_check.approve"), approval: null, evidence: null }], run: null, verifyOffer: null };
const outcome = (next: CriterionEvidenceView = view) => ({ status: "CRITERION_EVIDENCE" as const, view: next });
afterEach(cleanup);
describe("criterion evidence operator card", () => {
  it("approves an explicit criterion check without asking the browser for a verdict", async () => {
    const approve = vi.fn(async () => ({ ok: true as const, commandId: "approved" }));
    render(<CriterionEvidenceCard outcome={outcome()} port={{ approve, verify: vi.fn() }} />);
    fireEvent.change(screen.getByLabelText("Executable for result"), { target: { value: "C:\\tools\\node.exe" } });
    fireEvent.change(screen.getByLabelText("Arguments for result"), { target: { value: '["test.mjs", ""]' } });
    fireEvent.click(screen.getByRole("button", { name: "Approve check for result" }));
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    expect(approve).toHaveBeenCalledWith(view, view.criteria[0], { checkId: "result", checkVersion: "1",
      program: "C:\\tools\\node.exe", args: ["test.mjs", ""], timeoutMs: 60000 });
    expect(screen.queryByRole("button", { name: /mark.*passed/i })).toBeNull();
    expect((screen.getByRole("button", { name: "Verify approved criteria" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("rejects shell-like arguments instead of splitting them into an approved command", async () => {
    const approve = vi.fn();
    render(<CriterionEvidenceCard outcome={outcome()} port={{ approve, verify: vi.fn() }} />);
    fireEvent.change(screen.getByLabelText("Executable for result"), { target: { value: "C:\\tools\\node.exe" } });
    fireEvent.change(screen.getByLabelText("Arguments for result"), { target: { value: "test.mjs && echo passed" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve check for result" }));
    await waitFor(() => expect(screen.getByText("Arguments must be a JSON array of strings.").textContent)
      .toBe("Arguments must be a JSON array of strings."));
    expect(approve).not.toHaveBeenCalled();
  });
  it("displays the receipt and exact artifact then verifies only the offered snapshot", async () => {
    const approved: CriterionEvidenceView = { ...view, criteria: [{ ...view.criteria[0]!,
      approval: { approvalId: "approved", checkId: "result", checkVersion: "1", program: "C:\\tools\\node.exe", args: ["test.mjs"], timeoutMs: 60000, executorDigest: "e".repeat(64) },
      evidence: { receiptId: "receipt-a", runRef: "run-a", status: "PASSED", sha: "c".repeat(40), treeSha: "d".repeat(40),
        exitCode: 0, outputSha256: "f".repeat(64), byteCount: 4, finishedAt: "2026-09-06T00:00:00.000Z" },
    }], verifyOffer: offer("criterion_check.verify") };
    const verify = vi.fn(async () => ({ ok: true as const, commandId: "new-run" }));
    render(<CriterionEvidenceCard outcome={outcome(approved)} port={{ approve: vi.fn(), verify }} />);
    expect(screen.getByTestId("cr.criteria.result.result").textContent).toContain("PASSED");
    expect(screen.getByTestId("cr.criteria.result.result").textContent).toContain("receipt-a");
    expect(screen.getByTestId("cr.criteria.artifact").textContent).toContain("c".repeat(40));
    fireEvent.click(screen.getByRole("button", { name: "Verify approved criteria" }));
    await waitFor(() => expect(verify).toHaveBeenCalledWith(approved));
  });
  it("withholds old controls when a new goal read fails", () => {
    const approve = vi.fn();
    const rendered = render(<CriterionEvidenceCard outcome={outcome()} port={{ approve, verify: vi.fn() }} />);
    rendered.rerender(<CriterionEvidenceCard outcome={{ status: "REFUSED", code: "NO_BINDING", layer: "CRITERION_EVIDENCE" }} port={{ approve, verify: vi.fn() }} />);
    expect(screen.queryByRole("button", { name: "Approve check for result" })).toBeNull(); expect(approve).not.toHaveBeenCalled();
  });
  it("says no checks exist, not that the read failed, while the goal is a DRAFT no approved plan binds", () => {
    // apps/daemon/src/criterion-evidence/criterion-goal.ts readCriterionGoal answers exactly this pair for
    // exactly one state: the goal exists and its lifecycle is DRAFT. Nothing failed to read, and the words
    // promise nothing: a statement of what exists, not of what will appear.
    render(<CriterionEvidenceCard outcome={{ status: "REFUSED", code: "CRITERION_CHECK_GOAL_UNBOUND", layer: "CRITERION_EVIDENCE" }}
      port={{ approve: vi.fn(), verify: vi.fn() }} />);
    expect(screen.getByTestId("cr.criteria.none").textContent).toBe("No criterion checks: none exist until a plan is approved.");
    expect(screen.queryByTestId("cr.criteria.read-refusal")).toBeNull();
    expect(screen.getByTestId("cr.criteria.card").textContent).not.toContain("could not be read");
    expect(screen.queryByRole("button", { name: "Verify approved criteria" })).toBeNull();
  });
  it("keeps saying the read failed for every other answer, the same code at another layer or status included", () => {
    for (const outcome of [
      // An ENABLED goal whose sealed plan no longer re-proves: a failure on an approved plan, never emptiness.
      { status: "REFUSED" as const, code: "CRITERION_CHECK_UNREADABLE", layer: "CRITERION_EVIDENCE" },
      // A goalRef no goal carries, and a cancelled goal: the daemon names each, neither is "nothing yet".
      { status: "REFUSED" as const, code: "CRITERION_CHECK_GOAL_ABSENT", layer: "CRITERION_EVIDENCE" },
      { status: "REFUSED" as const, code: "CRITERION_CHECK_GOAL_CANCELLED", layer: "CRITERION_EVIDENCE" },
      // The approved-without-a-contract journey (tests/e2e/control-room/repository-workflows.spec.ts:35) stays a refusal.
      { status: "REFUSED" as const, code: "COMPILED_CONTRACT_BINDING_ABSENT", layer: "CRITERION_EVIDENCE" },
      { status: "REFUSED" as const, code: "CRITERION_CHECK_GOAL_UNBOUND", layer: "CONTROL_ROOM_CRITERIA" },
      { status: "ERROR" as const, code: "CRITERION_CHECK_GOAL_UNBOUND", layer: "CRITERION_EVIDENCE" },
      { status: "ERROR" as const, code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_CRITERIA" },
    ]) {
      cleanup();
      render(<CriterionEvidenceCard outcome={outcome} port={null} />);
      const note = screen.getByTestId("cr.criteria.read-refusal");
      expect(note.querySelector(".cr2-outcome-said")?.textContent, `${outcome.status} ${outcome.code}`).toBe("Criterion evidence could not be read.");
      expect(note.querySelector("code")?.textContent, outcome.code).toBe(`${outcome.code} @ ${outcome.layer}`);
      expect(screen.queryByTestId("cr.criteria.none"), `${outcome.status} ${outcome.code}`).toBeNull();
    }
  });
});
