import { afterEach, expect, it } from "vitest";
import { closeStores, GOAL_ID, PROJECT_ID, RUN_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { OPERATOR } from "../planning/plan-reject-test-fixtures.js";
import { OPERATOR_CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { criterionWorld } from "./criterion-test-fixtures.js";
import { CRITERION_APPROVE, CRITERION_PRINCIPAL, CRITERION_SCHEMA_VERSION } from "./criterion-contracts.js";
import { criterionBytes, criterionHash } from "./criterion-codec.js";
import { CRITERION_EXECUTOR_VERSION } from "./criterion-approval.js";
import { readCriterionGoal } from "./criterion-goal.js";
import { readCriterionRuns } from "./criterion-run.js";
import { recordCriterionReceipt, readCriterionReceipt } from "./criterion-receipt.js";
import { currentCriterionReceipts } from "./criterion-read.js";
import { commitCriterionRecord, criterionReceiptId, criterionRunsId } from "./criterion-storage.js";

afterEach(closeStores);
const artifact = { root: "D:/criterion-reader-fixture", sha: "a".repeat(40), treeSha: "b".repeat(40) };
const NOW = "2026-09-06T00:00:00.000Z";

it.each(["new command identity", "same command id from another human"] as const)(
  "does not credit a receipt to a replacement approval with %s", (replacement) => {
    const world = criterionWorld({ readIntegrated: () => artifact });
    const { store, service } = world;
    world.approveAll();
    expect(service.verify(world.verifyInput(artifact.sha))).toMatchObject({ ok: true });
    const goal = readCriterionGoal(store, PROJECT_ID, GOAL_ID);
    if (!goal.ok) throw new Error(goal.code);
    const run = readCriterionRuns(store, goal)?.at(-1);
    if (run === undefined) throw new Error("Missing queued run");
    const aggregate = criterionRunsId(PROJECT_ID, GOAL_ID, RUN_ID);
    // Seed the daemon's durable run/receipt shapes; this reader test executes no child.
    for (const status of ["RUNNING", "COMPLETED"] as const) {
      expect(commitCriterionRecord(store, PROJECT_ID, "internal.criterion.run", {
        commandId: `${run.runRef}-${status}`, correlationId: run.runRef, principalId: CRITERION_PRINCIPAL,
        expectedVersion: store.getAggregateVersion(aggregate), payload: { runRef: run.runRef, status },
      }, aggregate, `CriterionVerification${status}`, { ...run, status }, NOW)).toMatchObject({ ok: true });
      if (status === "RUNNING") for (const approved of run.approvals) {
        expect(recordCriterionReceipt(store, { version: CRITERION_SCHEMA_VERSION, binding: run.binding,
          approved, artifact, executorVersion: CRITERION_EXECUTOR_VERSION,
          result: { receiptId: criterionReceiptId(run.runRef, approved.criterionId), runRef: run.runRef,
            sha: artifact.sha, treeSha: artifact.treeSha, status: "PASSED", exitCode: 0,
            outputSha256: "c".repeat(64), byteCount: 8, finishedAt: NOW },
        })).toMatchObject({ ok: true });
      }
    }
    expect(service.read(GOAL_ID)).toMatchObject({ run: { status: "COMPLETED" },
      criteria: [{ evidence: { status: "PASSED" } }, { evidence: { status: "PASSED" } }] });
    expect(currentCriterionReceipts(store, goal, () => artifact).size).toBe(2);
    let principalId = world.human.principalId;
    if (replacement === "same command id from another human") {
      const human = createOperatorSessionHandshakePort({ store, projectId: PROJECT_ID, operatorPrincipalId: OPERATOR,
        capabilities: OPERATOR_CAPABILITIES, clock: () => Date.parse(NOW), sessionTtlMs: 60000 }).mint();
      if (!human.ok) throw new Error(human.code);
      principalId = human.principalId;
      expect(principalId).not.toBe(world.human.principalId);
    }
    const input = world.approvalInput("crit-api", 2, ["--help"]);
    const replacementInput = { ...input, principalId,
      commandId: replacement === "new command identity" ? "replacement-api" : input.commandId,
      payload: { ...input.payload, check: { ...input.payload.check, checkVersion: "2" } },
    };
    if (replacement === "new command identity") {
      expect(service.approve(replacementInput)).toMatchObject({ ok: true });
    } else {
      // Command decisions are principal-scoped. Seed a valid distinct event identity;
      // the public writer's present event-id convention independently rejects this collision.
      const approved = run.approvals.find((entry) => entry.criterionId === "crit-api")!;
      const check = replacementInput.payload.check;
      const bytes = criterionBytes({ ...approved, approvedBy: principalId, approval: { ...check,
        program: approved.approval.program, approvalId: input.commandId,
        executorDigest: criterionHash([CRITERION_EXECUTOR_VERSION, approved.approval.program,
          approved.programSha256, check.args, check.timeoutMs]),
      } });
      const offer = service.read(GOAL_ID);
      if (offer.outcome !== "CRITERION_EVIDENCE") throw new Error(offer.code);
      expect(store.commitExpectedVersionDecision({ commandKind: CRITERION_APPROVE, committedResultBytes: bytes,
        correlationId: input.correlationId, decidedAt: NOW, expectedVersion: 2,
        key: { projectId: PROJECT_ID, principalId, commandId: input.commandId }, requestBytes: criterionBytes(replacementInput),
        targetAggregateId: offer.criteria[0]!.approveOffer!.targetAggregateId,
        events: [{ eventId: "distinct-human-approval-event", eventType: "CriterionCheckApproved", payload: bytes }],
      }).decision.effectDisposition).toBe("EFFECTS_COMMITTED");
    }
    expect.soft([...currentCriterionReceipts(store, goal, () => artifact).keys()]).toEqual(["crit-ui"]);
    const view = service.read(GOAL_ID);
    expect(view).toMatchObject({ integratedArtifact: { sha: artifact.sha, treeSha: artifact.treeSha },
      criteria: [{ approval: { checkVersion: "2", args: ["--help"] }, evidence: null },
        { evidence: { status: "PASSED" } }] });
    expect(readCriterionReceipt(store, run, "crit-api")?.result.status).toBe("PASSED");
  },
);
