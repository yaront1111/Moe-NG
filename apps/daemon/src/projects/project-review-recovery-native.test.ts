import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CliIo, ReviewRecoveryResult } from "../cli/moe-cli-main.js";
import { runMoeCli } from "../cli/moe-cli-main.js";
import { runProjectReviewRecovery } from "../cli/moe-cli-review-recovery.js";
import { createReviewResumeWorld, closeReviewResumeWorlds } from "../repository/repository-review-resume-test-fixtures.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { privateListenerOpen, startPrivateReviewRuntime } from "./project-review-recovery-test-fixtures.js";

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
      const cli: typeof runMoeCli = artifact === undefined ? runMoeCli
        : (await import(pathToFileURL(join(runtimeRoot, "apps/daemon/src/cli/moe-cli-main.js")).href)).runMoeCli;
      let recoveryResult: ReviewRecoveryResult | undefined;
      const io: CliIo = { artifactRoot: runtimeRoot, argv: ["recover-review", project, "--operator-stdin"], cwd: project,
        env: {}, log: (line) => { logs.push(line); }, nodeVersion: process.version, packageVersion: "private-test", randomHex: () => "ab".repeat(32),
        startManager: async () => { throw new Error("MANAGER_MUST_NOT_START"); },
        recoverReview: async (request) => {
          events.push("recover");
          // Same lazy load used by the production CLI; packaged workspace links exist by this point.
          const recover: typeof runProjectReviewRecovery = artifact === undefined ? runProjectReviewRecovery
            : (await import(pathToFileURL(join(runtimeRoot, "apps/daemon/src/cli/moe-cli-review-recovery.js")).href)).runProjectReviewRecovery;
          recoveryResult = await recover(request); return recoveryResult;
        },
        startStack: async (request) => {
          expect(recoveryResult).toEqual({ ok: true });
          expect(request).toMatchObject({ projectRoot: project, operatorStdin: true });
          expect(w.port.readOwned(project, w.owner.storeId, w.owner.projectId)).toMatchObject({ ok: true, handle: {
            owner: w.owner, reservation: { phase: "RESERVED", baselineId: w.baseline.baselineId,
              sessionId: null, pid: null, revision: w.blocked.reservation.revision + 1 } } });
          expect(bytes()).toEqual(before);
          expect(reviewAuthority()).toEqual(originalReview);
          for (const pid of [old.cliPid, old.brokerPid, old.daemonPid, old.controllerPid]) expect(() => process.kill(pid, 0)).toThrow();
          expect(await privateListenerOpen(old.port)).toBe(false);
          events.push("restart"); return 17;
        },
      };
      expect(await cli(io), logs.join("\n")).toBe(17);
      expect(events).toEqual(["recover", "restart"]);
      expect(logs.join("\n")).not.toContain("ab".repeat(32));
      expect(originalReview.accepted).toBeUndefined();
      expect(originalReview.rounds.at(-1)?.routing.route).toBe("REJECT_IMPLEMENTATION");
    } finally {
      await old.close(); closeReviewResumeWorlds();
      if (!resolve(project).startsWith(resolve(tmpdir(), "moe-review-recovery-journey-"))) throw new Error("PRIVATE_PROJECT_ROOT_INVALID");
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);
});
