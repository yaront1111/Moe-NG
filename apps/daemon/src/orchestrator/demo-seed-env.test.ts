import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_GOAL_SUBJECT, DEFAULT_RUN_SUBJECT, DEFAULT_SUBJECTS } from "../http/affordance-read.js";
import { readSeedConfig } from "./demo-seed-env.js";

/**
 * The seed's DEFAULT run and goal ids are the dev-subject convention, not free
 * identities: the affordance surface offers `approval.decide`/`goal.close`
 * against exactly these ids and the control room's dev payloads address them.
 * A seed that minted `${projectId}-run` instead left the live board's one
 * human action refusing against a run the ledger never held — so the defaults
 * are pinned HERE to the surface's own exported constants, in both directions.
 */

const specsDir = mkdtempSync(join(tmpdir(), "moe-seed-env-specs-"));
writeFileSync(
  join(specsDir, "demo-node.json"),
  JSON.stringify({
    instructions: "Create math.mjs exporting add and multiply so test.mjs passes.",
    nodeRef: "node-code-1",
    test: "node test.mjs",
    title: "Implement the math module",
    workspace: "D:/demo/workspace",
  }),
  "utf8",
);

afterAll(() => {
  try {
    rmSync(specsDir, { force: true, recursive: true });
  } catch {
    // A held handle on Windows must not redden a suite that already answered.
  }
});

const BASE_ENV = Object.freeze({
  MOE_CSRF_TOKEN: "csrf-token",
  MOE_DAEMON_CREDENTIAL: "operator-credential",
  MOE_DAEMON_ORIGIN: "http://127.0.0.1:39123",
  MOE_NODE_SPECS_DIR: specsDir,
});

describe("seed defaults follow the dev-subject convention", () => {
  it("defaults the run and goal ids to the affordance surface's own subjects", () => {
    const read = readSeedConfig(BASE_ENV);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("expected a config");
    expect(read.config.runId).toBe(DEFAULT_RUN_SUBJECT);
    expect(read.config.goalId).toBe(DEFAULT_GOAL_SUBJECT);
    // Both directions: the surface must still offer the approval and the goal
    // close against the ids the seed will commit under.
    expect(DEFAULT_SUBJECTS["approval.decide"]).toBe(read.config.runId);
    expect(DEFAULT_SUBJECTS["plan.propose"]).toBe(read.config.runId);
    expect(DEFAULT_SUBJECTS["goal.create"]).toBe(read.config.goalId);
    expect(DEFAULT_SUBJECTS["goal.close"]).toBe(read.config.goalId);
  });

  it("still honors an explicit operator override for both ids", () => {
    const read = readSeedConfig({
      ...BASE_ENV, MOE_GOAL_ID: "goal-mine", MOE_RUN_ID: "run-mine",
    });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("expected a config");
    expect(read.config.runId).toBe("run-mine");
    expect(read.config.goalId).toBe("goal-mine");
  });

  it("defaults to the full chain and stops before approval only when asked", () => {
    const full = readSeedConfig(BASE_ENV);
    expect(full.ok && !full.config.stopBeforeApproval).toBe(true);
    const stopped = readSeedConfig({ ...BASE_ENV, MOE_SEED_STOP_BEFORE_APPROVAL: "1" });
    expect(stopped.ok && stopped.config.stopBeforeApproval).toBe(true);
  });
});
