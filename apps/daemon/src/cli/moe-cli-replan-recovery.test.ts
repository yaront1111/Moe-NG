import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseCliArgv } from "./moe-cli-argv.js";
import { runMoeCli } from "./moe-cli-main.js";
import { MOE_CONFIG_SCHEMA_VERSION } from "./moe-init.js";
import { executeReplanRecovery, reservationWorkspaces } from "./moe-cli-replan-recovery.js";
import { createReplanRecoveryWorld } from "../repository/repository-replan-recovery-test-fixtures.js";
import { createReviewResumeWorld, closeReviewResumeWorlds } from "../repository/repository-review-resume-test-fixtures.js";

const roots: string[] = [];
afterEach(closeReviewResumeWorlds);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
/**
 * A node briefed into its own tree holds its reservation under `<main>/.git/worktrees/<name>/`,
 * not under the project root. This path scanned the project root alone, so a replanned node
 * holding its own tree could not be released by any CLI command — measured on UnAI 2026-09-16,
 * where the checkout stayed held with nothing able to free it. (The daemon's own recovery service
 * already saw node trees: `daemon-repository-workflow-wiring.ts` derives them from node missions.
 * The CLI runs before any stack exists, so it reads Git's worktree registry instead.)
 */
it("names the project root and only the node trees that actually hold a reservation", () => {
  const root = mkdtempSync(join(tmpdir(), "moe-replan-trees-")); roots.push(root);
  const held = join(root, ".git", "worktrees", "node-held");
  const idle = join(root, ".git", "worktrees", "node-idle");
  const heldTree = join(root, ".moe-next", "trees", "node-held");
  mkdirSync(held, { recursive: true });
  mkdirSync(idle, { recursive: true });
  mkdirSync(heldTree, { recursive: true });
  writeFileSync(join(held, "gitdir"), `${join(heldTree, ".git")}\n`);
  writeFileSync(join(held, "moe-repository-execution.sqlite"), "");
  // No reservation database: this tree holds nothing and must not be named. The bound matters —
  // `scan` refuses above 32 workspaces and a real project had 70 trees, so naming them all would
  // break recovery for everyone.
  writeFileSync(join(idle, "gitdir"), `${join(root, ".moe-next", "trees", "node-idle", ".git")}\n`);

  expect(reservationWorkspaces(root)).toEqual([root, heldTree]);
});

it("still names the project root when the repository has no linked worktrees at all", () => {
  const root = mkdtempSync(join(tmpdir(), "moe-replan-notrees-")); roots.push(root);

  expect(reservationWorkspaces(root)).toEqual([root]);
});

it("releases every replanned owner, not just the first", async () => {
  // Governance retired two nodes 22 ms apart on UnAI 2026-09-16 — one holding the project's own
  // checkout, one holding its node tree. Refusing on sight of the second left BOTH held.
  const recovered: string[] = [];
  const reservationFor = (nodeRef: string) => ({
    actions: [{
      action: "RELEASE_REPLANNED" as const, available: true, code: null,
      expectedReviewDigest: "d".repeat(64), expectedReviewVersion: 3,
      offer: { commandId: `cmd-${nodeRef}`, expectedVersion: 3, targetAggregateId: nodeRef },
    }],
    expectedReservationRevision: 1,
    nodeRef,
    phase: "RESERVED" as const,
  });
  const service = {
    readRecovery: () => ({
      code: null, projectId: "project-1",
      reservations: [reservationFor("node-a"), reservationFor("node-b")],
      version: "moe-repository-recovery/1",
    }),
    recover: (command: { readonly payload: { readonly nodeRef: string } }) => {
      recovered.push(command.payload.nodeRef);
      return Promise.resolve({ ok: true as const, resultCode: "REPOSITORY_RECOVERY_RELEASED" });
    },
  };

  expect(await executeReplanRecovery(service as never, "operator", () => {})).toEqual({ ok: true });
  expect(recovered).toEqual(["node-a", "node-b"]);
});

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
/**
 * A startup release that cannot be proved must not stop the project from starting (addendum
 * 2026-09-15): the drain needs the replanned owner's original runtime alive, so after any stop
 * the refusal was permanent and `moe start` exited 1 on every attempt.
 */
it.each(["RUNTIME_REVIEW_DRAIN_UNPROVEN", "MOE_CLI_REPLAN_RECOVERY_SCOPE_AMBIGUOUS", "THROWN"])(
  "start still starts the project when the startup replan release refuses (%s)", async (outcome) => {
    const root = mkdtempSync(join(tmpdir(), "moe-start-replan-refused-")); roots.push(root);
    writeFileSync(join(root, "moe.config.json"), JSON.stringify({ schemaVersion: MOE_CONFIG_SCHEMA_VERSION, projectId: "project-1",
      credential: "a".repeat(64), storePath: "store.sqlite" }));
    const starts = vi.fn(async () => 0);
    const recoverReplan = vi.fn(async () => {
      if (outcome === "THROWN") throw new Error("observer crashed");
      return { ok: false as const, code: outcome };
    });
    const logs: string[] = [];

    const code = await runMoeCli({ artifactRoot: root, argv: ["start"], cwd: root, env: {}, log: line => logs.push(line),
      nodeVersion: "v24.16.0", packageVersion: "0.1.0", randomHex: () => "a".repeat(64),
      recoverReplan, startStack: starts, startManager: async () => 0 });

    expect(code, logs.join("\n")).toBe(0);
    expect(starts).toHaveBeenCalledOnce();
    const named = outcome === "THROWN" ? "MOE_CLI_REPLAN_RECOVERY_UNAVAILABLE" : outcome;
    expect(logs.some((line) => line.includes(named) && line.includes("every repository reservation is kept"))).toBe(true);
  });

it.each(["bound", "missing"] as const)("automatic startup does not drain ordinary work without REPLAN (%s seat)", async (seat) => {
  const w = await createReviewResumeWorld({ seat });
  expect(await executeReplanRecovery(w.service, "operator", () => {}, true)).toEqual({ ok: true });
  expect(w.drains()).toBe(0);
  expect(w.port.readOwned(w.workspace, w.owner.storeId, w.owner.projectId)).toMatchObject({ ok: true, handle: w.blocked });
});
