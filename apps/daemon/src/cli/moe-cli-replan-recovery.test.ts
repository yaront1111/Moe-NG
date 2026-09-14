import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseCliArgv } from "./moe-cli-argv.js";
import { runMoeCli } from "./moe-cli-main.js";
import { MOE_CONFIG_SCHEMA_VERSION } from "./moe-init.js";
import { executeReplanRecovery } from "./moe-cli-replan-recovery.js";
import { createReplanRecoveryWorld } from "../repository/repository-replan-recovery-test-fixtures.js";
import { createReviewResumeWorld, closeReviewResumeWorlds } from "../repository/repository-review-resume-test-fixtures.js";

afterEach(closeReviewResumeWorlds);
it("parses recover-replan with exact single-project arguments", () => {
  expect(parseCliArgv(["recover-replan", "D:/project path", "--operator-stdin"]))
    .toEqual({ ok: true, command: "recover-replan", targetDir: "D:/project path", operatorStdin: true });
});
it.each(["recover-replan", "start"])("%s releases the exact human-replanned owner before starting its successor", async (command) => {
  const w = await createReplanRecoveryWorld();
  writeFileSync(join(w.workspace, "moe.config.json"), JSON.stringify({ schemaVersion: MOE_CONFIG_SCHEMA_VERSION, projectId: "project-1",
    credential: "a".repeat(64), storePath: "store.sqlite" }));
  // Runtime configuration is excluded by real init; this fixture creates that private equivalent.
  writeFileSync(join(w.workspace, ".git", "info", "exclude"), "/store.sqlite*\n/moe.config.json\n");
  const starts = vi.fn(async () => {
    expect(w.port.readOwned(w.workspace, w.owner.storeId, w.owner.projectId)).toMatchObject({ ok: true, handle: null });
    return 0;
  });
  const recoverReplan = vi.fn(async (request) => executeReplanRecovery(w.service, "operator", request.log, request.automatic === true));
  const logs: string[] = [];
  const code = await runMoeCli({ artifactRoot: w.workspace, argv: [command], cwd: w.workspace, env: {}, log: line => logs.push(line),
    nodeVersion: "v24.16.0", packageVersion: "0.1.0", randomHex: () => "a".repeat(64),
    recoverReplan, startStack: starts, startManager: async () => 0 });
  expect(code, logs.join("\n")).toBe(0);
  expect(starts).toHaveBeenCalledOnce(); expect(w.drains()).toBe(1);
});
it.each(["bound", "missing"] as const)("automatic startup does not drain ordinary work without REPLAN (%s seat)", async (seat) => {
  const w = await createReviewResumeWorld({ seat });
  expect(await executeReplanRecovery(w.service, "operator", () => {}, true)).toEqual({ ok: true });
  expect(w.drains()).toBe(0);
  expect(w.port.readOwned(w.workspace, w.owner.storeId, w.owner.projectId)).toMatchObject({ ok: true, handle: w.blocked });
});
