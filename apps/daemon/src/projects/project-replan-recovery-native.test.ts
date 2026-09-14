import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRepositoryRecoveryService } from "../repository/repository-recovery-service.js";
import { createReplanRecoveryWorld } from "../repository/repository-replan-recovery-test-fixtures.js";
import { closeReviewResumeWorlds } from "../repository/repository-review-resume-test-fixtures.js";
import type { RepositoryReviewDrainEvidence, RepositoryReviewDrainPort }
  from "../repository/repository-review-drain-contracts.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { createProjectReviewDrainPort } from "./project-review-drain.js";
import { privateListenerOpen, startPrivateReviewRuntime } from "./project-review-recovery-test-fixtures.js";
import { runPackagedReplanRecovery } from "./project-replan-recovery-test-fixtures.js";

afterEach(closeReviewResumeWorlds);

describe.skipIf(process.platform !== "win32")("replanned repository release with the actual native Job observer", () => {
  it.each(["release", "foreign-workspace"] as const)("proves a private recovery journey: %s", async (scenario) => {
    const project = realpathSync.native(mkdtempSync(join(tmpdir(), "moe-replan-recovery-native-")));
    const artifact = process.env["MOE_REVIEW_DRAIN_ARTIFACT_ROOT"];
    const runtimeRoot = artifact === undefined ? resolve("../..") : resolve(artifact);
    const baselineAt = new Date().toISOString();
    const old = await startPrivateReviewRuntime(project, runtimeRoot,
      scenario === "release" ? "recover-replan" : "start");
    let observed: RepositoryReviewDrainEvidence | undefined;
    let closes = 0;
    try {
      expect(() => process.kill(old.workerPid, 0)).toThrow();
      const w = await createReplanRecoveryWorld({ workspace: project, controllerPid: old.controllerPid,
        workerPid: old.workerPid, baselineAt, startedAt: old.startedAt,
        reviewAt: new Date().toISOString(), clock: () => new Date().toISOString() });
      const bytes = () => ({ app: readFileSync(join(project, "app.txt")).toString("hex"),
        index: readFileSync(join(project, ".git", "index")).toString("hex"),
        head: w.git("rev-parse", "HEAD"), tree: w.git("rev-parse", "HEAD^{tree}"),
        history: w.git("rev-list", "--all", "--parents") });
      const before = bytes();
      const reviewAuthority = () => {
        const { decisionCount: _horizon, ...authority } = readReviewLedger(w.store, w.owner.projectId, w.owner.nodeRef);
        return authority;
      };
      const reviewBefore = reviewAuthority();
      expect(reviewBefore).toMatchObject({ replanned: true, accepted: undefined });
      expect("continuation" in reviewBefore).toBe(false);
      expect(await privateListenerOpen(old.port)).toBe(true);
      const native = createProjectReviewDrainPort();
      const drain: RepositoryReviewDrainPort = { drain: async (input) => {
        expect(input).toEqual({ controllerPid: old.controllerPid, notStartedAfter: old.startedAt, workspace: project });
        const result = await native.drain(scenario === "foreign-workspace"
          ? { ...input, workspace: join(project, "other-project") } : input);
        if (!result.ok) return result;
        observed = result.evidence;
        return { ...result, close: async () => { closes += 1; await result.close(); } };
      } };
      const result = artifact === undefined
        ? await createRepositoryRecoveryService({ ...w.options, reviewDrain: drain }).recover(w.input)
        : await (async () => {
          const packaged = await runPackagedReplanRecovery({ runtimeRoot, workspace: project, storeId: w.owner.storeId,
            projectId: w.owner.projectId, command: w.input, scenario,
            expectedDrain: { controllerPid: old.controllerPid, notStartedAfter: old.startedAt, workspace: project } });
          observed = packaged.observed; closes = packaged.closes;
          return packaged.result;
        })();
      if (scenario === "foreign-workspace") {
        expect(result).toMatchObject({ ok: false, code: "RUNTIME_REVIEW_DRAIN_IDENTITY_MISMATCH" });
        expect(w.port.readOwned(project, w.owner.storeId, w.owner.projectId))
          .toMatchObject({ ok: true, handle: w.blocked });
        expect(await privateListenerOpen(old.port)).toBe(true);
        for (const pid of [old.cliPid, old.brokerPid, old.daemonPid, old.controllerPid]) {
          expect(() => process.kill(pid, 0)).not.toThrow();
        }
        expect(observed).toBeUndefined(); expect(closes).toBe(0);
      } else {
        expect(result).toMatchObject({ ok: true, disposition: "COMMITTED", resultCode: "REPOSITORY_RECOVERY_RELEASED" });
        expect(observed).toMatchObject({ controllerPid: old.controllerPid, brokerPid: old.brokerPid,
          cliPid: old.cliPid, daemonPid: old.daemonPid, jobEmpty: true });
        expect(closes).toBe(1);
        expect(w.port.readOwned(project, w.owner.storeId, w.owner.projectId)).toMatchObject({ ok: true, handle: null });
        for (const pid of [old.cliPid, old.brokerPid, old.daemonPid, old.controllerPid]) {
          expect(() => process.kill(pid, 0)).toThrow();
        }
        expect(await privateListenerOpen(old.port)).toBe(false);
        const successor = { ...w.owner, nodeRef: "private-successor-node", ownershipToken: "d".repeat(64) };
        const acquired = w.port.acquire(project, successor, { controllerId: "private-successor", controllerPid: process.pid });
        expect(acquired.ok).toBe(true);
        expect(w.port.readOwned(project, w.owner.storeId, w.owner.projectId)).toMatchObject({ ok: true,
          handle: { owner: successor, reservation: { phase: "RESERVED", baselineId: null, sessionId: null, pid: null } } });
      }
      expect(bytes()).toEqual(before);
      expect(reviewAuthority()).toEqual(reviewBefore);
      expect(w.drains()).toBe(0); // The injected fixture proof was never used.
    } finally {
      await old.close();
      expect(await privateListenerOpen(old.port)).toBe(false);
      for (const pid of [old.cliPid, old.brokerPid, old.daemonPid, old.controllerPid]) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
      closeReviewResumeWorlds();
      if (!resolve(project).startsWith(resolve(tmpdir(), "moe-replan-recovery-native-"))) {
        throw new Error("PRIVATE_REPLAN_WORKSPACE_IDENTITY_INVALID");
      }
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);
});
