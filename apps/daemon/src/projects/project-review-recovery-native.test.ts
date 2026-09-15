import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliIo, ReviewRecoveryResult } from "../cli/moe-cli-main.js";
import { runMoeCli } from "../cli/moe-cli-main.js";
import { runProjectReviewRecovery } from "../cli/moe-cli-review-recovery.js";
import { createReviewResumeWorld, closeReviewResumeWorlds } from "../repository/repository-review-resume-test-fixtures.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { privateListenerOpen, runPackagedReviewRecoveryCli, startPrivateReviewRuntime } from "./project-review-recovery-test-fixtures.js";

afterEach(closeReviewResumeWorlds);
describe.skipIf(process.platform !== "win32")("private CLI review recovery with the actual Windows Job observer", () => {
  it("resumes the same compiled reservation before restart without changing application/index/HEAD or granting review credit", async () => {
    const project = realpathSync.native(mkdtempSync(join(tmpdir(), "moe-review-recovery-journey-")));
    const artifact = process.env["MOE_REVIEW_DRAIN_ARTIFACT_ROOT"];
    const runtimeRoot = artifact === undefined ? resolve("../..") : resolve(artifact);
    const configPath = join(project, "moe.config.json");
    writeFileSync(configPath, JSON.stringify({ schemaVersion: "moe-cli-config/1", projectId: PROJECT_ID,
      storePath: "store.sqlite", credential: "ab".repeat(32) }));
    const baselineAt = new Date().toISOString();
    const old = await startPrivateReviewRuntime(project, runtimeRoot);
    try {
      expect(() => process.kill(old.workerPid, 0)).toThrow();
      const w = await createReviewResumeWorld({ workspace: project, controllerPid: old.controllerPid, workerPid: old.workerPid,
        baselineAt, startedAt: old.startedAt, reviewAt: new Date().toISOString(), clock: () => new Date().toISOString() });
      const bytes = () => ({ app: readFileSync(join(project, "app.txt")).toString("hex"),
        index: readFileSync(join(project, ".git", "index")).toString("hex"), head: w.git("rev-parse", "HEAD"),
        config: readFileSync(configPath).toString("hex") });
      const before = bytes();
      const reviewAuthority = () => { const { decisionCount: _cacheHorizon, ...authority } = readReviewLedger(w.store, w.owner.projectId, w.owner.nodeRef); return authority; };
      const originalReview = reviewAuthority();
      expect(await privateListenerOpen(old.port)).toBe(true);
      const events: string[] = []; const logs: string[] = [];
      let recoveryResult: ReviewRecoveryResult | undefined;
      const checkRecovered = async () => {
        expect(w.port.readOwned(project, w.owner.storeId, w.owner.projectId)).toMatchObject({ ok: true, handle: {
          owner: w.owner, reservation: { phase: "RESERVED", baselineId: w.baseline.baselineId,
            sessionId: null, pid: null, revision: w.blocked.reservation.revision + 1 } } });
        expect(bytes()).toEqual(before);
        expect(reviewAuthority()).toEqual(originalReview);
        for (const pid of [old.cliPid, old.brokerPid, old.daemonPid, old.controllerPid]) expect(() => process.kill(pid, 0)).toThrow();
        expect(await privateListenerOpen(old.port)).toBe(false);
      };
      const io: CliIo = { artifactRoot: runtimeRoot, argv: ["recover-review", project, "--operator-stdin"], cwd: project,
        env: {}, log: (line) => { logs.push(line); }, nodeVersion: process.version, packageVersion: "private-test", randomHex: () => "ab".repeat(32),
        startManager: async () => { throw new Error("MANAGER_MUST_NOT_START"); },
        recoverReview: async (request) => {
          events.push("recover");
          recoveryResult = await runProjectReviewRecovery(request); return recoveryResult;
        },
        startStack: async (request) => {
          expect(recoveryResult).toEqual({ ok: true });
          expect(request).toMatchObject({ projectRoot: project, operatorStdin: true });
          await checkRecovered();
          events.push("restart"); return 17;
        },
      };
      if (artifact === undefined) expect(await runMoeCli(io), logs.join("\n")).toBe(17);
      else {
        const result = await runPackagedReviewRecoveryCli(runtimeRoot, project, { owner: w.owner,
          storeId: w.owner.storeId, projectId: w.owner.projectId, baselineId: w.baseline.baselineId,
          revision: w.blocked.reservation.revision + 1 });
        expect(result.code, [...result.logs, result.diagnostic ?? ""].join("\n")).toBe(17);
        expect(result.recoveryResult).toEqual({ ok: true });
        events.push(...result.events); logs.push(...result.logs);
        await checkRecovered();
      }
      expect(events).toEqual(["recover", "restart"]);
      expect(logs.join("\n")).not.toContain("ab".repeat(32));
      expect(originalReview.accepted).toBeUndefined();
      expect(originalReview.rounds.at(-1)?.routing.route).toBe("REJECT_IMPLEMENTATION");
    } finally {
      await old.close(); closeReviewResumeWorlds();
      if (!resolve(project).startsWith(resolve(tmpdir(), "moe-review-recovery-journey-"))) throw new Error("PRIVATE_PROJECT_ROOT_INVALID");
      rmSync(project, { recursive: true, force: true });
    }
  // Measured on windows-latest: starting Windows PowerShell and compiling the observer took 10 s
  // to over 35 s under the daemon suite's load; the port now gives that start its own budget.
  }, 180_000);
});
