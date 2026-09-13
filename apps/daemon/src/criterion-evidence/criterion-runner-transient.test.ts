import { afterEach, describe, expect, it, vi } from "vitest";
import type { CriterionCheckExecutor, CriterionCheckExecutionResult } from "@moe/runner";
import { GOAL_ID, PROJECT_ID, closeStores } from "../bootstrap/bootstrap-test-fixtures.js";
import type { RepositoryExecutionHandle, RepositoryExecutionPort, RepositoryExecutionReleaseReason } from "../repository/repository-execution-contracts.js";
import { criterionWorld } from "./criterion-test-fixtures.js";
import { queueAutomaticCriterionVerification } from "./criterion-run.js";

type CaptureAnswer = { ok: true; binding: { root: string; headSha: string; treeSha: string } } | { ok: false; code: string; detail: string };
// The next capture answers are consumed in order; an empty queue answers the run's own artifact.
const captures = vi.hoisted(() => ({ next: [] as CaptureAnswer[] }));
vi.mock("../repository/git-verified-workspace-port.js", () => ({ createVerifiedWorkspacePort: () => ({
  capture: async (root: string) => captures.next.shift() ?? { ok: true, binding: { root, headSha: "a".repeat(40), treeSha: "b".repeat(40) } },
}) }));
afterEach(() => { captures.next.length = 0; vi.restoreAllMocks(); closeStores(); });
const artifact = { root: "D:/criterion-transient", sha: "a".repeat(40), treeSha: "b".repeat(40) };
const passed: CriterionCheckExecutionResult = { executorVersion: "moe-criterion-check-executor/1", containment: "PROVEN",
  exitCode: 0, outputSha256: "c".repeat(64), byteCount: 8, refusal: null };

/** The recovery fence's shape, recording every release REASON instead of asserting one. */
function fence() {
  let held: RepositoryExecutionHandle | null = null; const releases: RepositoryExecutionReleaseReason[] = [];
  const port: RepositoryExecutionPort = {
    acquire: (_workspace, owner, controller) => {
      if (held !== null) return { ok: false, code: "REPOSITORY_EXECUTION_BUSY", detail: "busy" };
      held = { owner, reservation: { ...owner, ...controller, identity: { root: artifact.root, gitDirectory: `${artifact.root}/.git` },
        phase: "RESERVED", baselineId: null, sessionId: null, pid: null, revision: 1 } };
      return { ok: true, handle: held };
    },
    inspect: () => ({ ok: true, reservation: held?.reservation ?? null }),
    readOwned: () => ({ ok: true, handle: held }),
    claimController: () => { throw new Error("no controller change in this file"); },
    transition: (_workspace, owner, revision, state) => {
      if (held?.owner !== owner || held.reservation.revision !== revision
        || held.reservation.controllerId !== state.controllerId) return { ok: false, code: "REPOSITORY_EXECUTION_CONTROLLER_MISMATCH", detail: "mismatch" };
      held = { ...held, reservation: { ...held.reservation, ...state, revision: revision + 1 } };
      return { ok: true, handle: held };
    },
    release: (_workspace, owner, revision, reason, controllerId) => {
      expect(held?.owner).toBe(owner); expect(held?.reservation.revision).toBe(revision);
      expect(held?.reservation.controllerId).toBe(controllerId);
      // The real port admits ABORTED_BEFORE_EXECUTION from RESERVED only (repository-execution-port.ts:101).
      if (reason === "ABORTED_BEFORE_EXECUTION" && held?.reservation.phase !== "RESERVED") {
        return { ok: false, code: "REPOSITORY_EXECUTION_TRANSITION_INVALID", detail: "not reserved" };
      }
      releases.push(reason); held = null; return { ok: true, released: true };
    },
  };
  return { port, releases, held: () => held };
}
function world(executor: CriterionCheckExecutor, reservation = fence()) {
  const built = criterionWorld({ workspace: artifact.root, readIntegrated: () => artifact, executor, repository: reservation.port });
  built.approveAll();
  return { ...built, reservation };
}

describe("criterion runner on a capture that refuses before any check runs", () => {
  // The lander's own table (node-lander-verification.ts) calls each of these a moment, not a verdict.
  it.each(["VERIFIED_WORKSPACE_GIT_FAILED", "VERIFIED_WORKSPACE_DRIFT", "VERIFIED_WORKSPACE_IDENTITY_UNKNOWN", "VERIFIED_WORKSPACE_UNKNOWN"])(
    "gives the untouched reservation back on %s, keeps the run QUEUED, and completes it on the next tick", async (code) => {
      const runCheck = vi.fn<CriterionCheckExecutor["run"]>(async (_input, started) => { started(1234); return passed; });
      const w = world({ run: runCheck, async close() {} });
      captures.next.push({ ok: false, code, detail: code });
      try {
        await w.service.advance();
        expect(runCheck).not.toHaveBeenCalled();
        expect(w.service.read(GOAL_ID)).toMatchObject({ run: { status: "QUEUED" } });
        expect(w.reservation.held()).toBeNull();
        expect(w.reservation.releases).toEqual(["ABORTED_BEFORE_EXECUTION"]);
        await w.service.advance();
        expect(w.service.read(GOAL_ID)).toMatchObject({ run: { status: "COMPLETED" }, criteria: [{ evidence: { status: "PASSED" } }, { evidence: { status: "PASSED" } }] });
        expect(runCheck).toHaveBeenCalledTimes(2);
        expect(w.reservation.releases).toEqual(["ABORTED_BEFORE_EXECUTION", "CRITERIA_COMPLETED"]);
      } finally { await w.service.close(); }
    });

  it("still blocks when the capture proves the workspace is not the run's artifact", async () => {
    const runCheck = vi.fn<CriterionCheckExecutor["run"]>(async (_input, started) => { started(1234); return passed; });
    const w = world({ run: runCheck, async close() {} });
    captures.next.push({ ok: true, binding: { root: artifact.root, headSha: "d".repeat(40), treeSha: artifact.treeSha } });
    try {
      await w.service.advance();
      expect(runCheck).not.toHaveBeenCalled();
      expect(w.service.read(GOAL_ID)).toMatchObject({ run: { status: "BLOCKED" } });
      expect(w.reservation.held()?.reservation.phase).toBe("BLOCKED");
      expect(w.reservation.releases).toEqual([]);
      expect(queueAutomaticCriterionVerification(w.store, PROJECT_ID, GOAL_ID, "2026-09-06T00:00:00.000Z", () => artifact))
        .toMatchObject({ ok: false, code: "CRITERION_CHECK_RUN_PENDING" });
    } finally { await w.service.close(); }
  });

  it("still blocks a structural capture refusal", async () => {
    const runCheck = vi.fn<CriterionCheckExecutor["run"]>(async (_input, started) => { started(1234); return passed; });
    const w = world({ run: runCheck, async close() {} });
    captures.next.push({ ok: false, code: "VERIFIED_WORKSPACE_SUBMODULE_UNSUPPORTED", detail: "submodules" });
    try {
      await w.service.advance();
      expect(runCheck).not.toHaveBeenCalled();
      expect(w.service.read(GOAL_ID)).toMatchObject({ run: { status: "BLOCKED" } });
      expect(w.reservation.held()?.reservation.phase).toBe("BLOCKED");
      expect(w.reservation.releases).toEqual([]);
    } finally { await w.service.close(); }
  });
});
