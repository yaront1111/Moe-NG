import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseCliArgv } from "./moe-cli-argv.js";
import { runMoeCli } from "./moe-cli-main.js";
import { MOE_CONFIG_SCHEMA_VERSION } from "./moe-init.js";
import { executeReplanRecovery, reservationWorkspaces } from "./moe-cli-replan-recovery.js";
import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import { createReplanRecoveryWorld } from "../repository/repository-replan-recovery-test-fixtures.js";
import { createReviewResumeWorld, closeReviewResumeWorlds } from "../repository/repository-review-resume-test-fixtures.js";

const roots: string[] = [];
afterEach(closeReviewResumeWorlds);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: readonly string[]): void => {
  execFileSync("git", [...args], {
    cwd, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
  });
};
const ownerOf = (nodeRef: string) => ({
  nodeRef, ownershipToken: "a".repeat(64), projectId: "project-1", storeId: "store.sqlite",
});
const CONTROLLER = { controllerId: "controller-1", controllerPid: 4242 };

/**
 * A node briefed into its own tree holds its reservation under `<main>/.git/worktrees/<name>/`,
 * not under the project root. This path scanned the project root alone, so a replanned node
 * holding its own tree could not be released by any CLI command — measured on UnAI 2026-09-16,
 * where the checkout stayed held with nothing able to free it. (The daemon's own recovery service
 * already saw node trees: `daemon-repository-workflow-wiring.ts` derives them from node missions.
 * The CLI runs before any stack exists, so it reads Git's worktree registry instead.)
 *
 * REAL worktrees and REAL reservations, taken through the shipped port. An earlier version of
 * this test wrote an empty file named `moe-repository-execution.sqlite` and called that "held",
 * which passed against a check that only asked whether the file existed — so it could not have
 * failed for the reason the check was wrong.
 */
it("names the project root and only the node trees that actually hold a reservation", () => {
  const root = mkdtempSync(join(tmpdir(), "moe-replan-trees-")); roots.push(root);
  git(root, "init", "--quiet");
  writeFileSync(join(root, "app.txt"), "one\n");
  git(root, "add", "--", "app.txt");
  git(root, "-c", "commit.gpgSign=false", "commit", "-qm", "base");
  const held = join(root, "trees", "node-held");
  const freed = join(root, "trees", "node-freed");
  git(root, "worktree", "add", "--quiet", "-b", "moe/node-held", held);
  git(root, "worktree", "add", "--quiet", "-b", "moe/node-freed", freed);

  const port = createRepositoryExecutionPort();
  expect(port.acquire(held, ownerOf("node-held"), CONTROLLER)).toMatchObject({ ok: true });
  // THE CASE THAT BROKE EVERY RECOVERY: a tree that worked and then let go. Release clears the
  // row and nothing ever unlinks the database, so "the file exists" answers "has this tree ever
  // worked" — which every node tree eventually has. A project with 70 of them named 70
  // workspaces, `scan` refused REPOSITORY_RECOVERY_SCOPE_UNBOUNDED past 32, and every replan
  // recovery failed, including the project root's own, which recovered fine before node trees.
  const acquired = port.acquire(freed, ownerOf("node-freed"), CONTROLLER);
  if (!acquired.ok) throw new Error("the fixture could not reserve the freed tree");
  expect(port.release(freed, ownerOf("node-freed"), acquired.handle.reservation.revision,
    "ABORTED_BEFORE_EXECUTION", CONTROLLER.controllerId)).toMatchObject({ ok: true });
  expect(existsSync(join(root, ".git", "worktrees", "node-freed", "moe-repository-execution.sqlite")))
    .toBe(true);

  const named = reservationWorkspaces(root);
  const slashed = named.map((workspace) => workspace.replace(/\\/gu, "/"));
  expect(named).toHaveLength(2);
  expect(named[0]).toBe(root);
  expect(slashed[1]).toContain("/trees/node-held");
  expect(slashed.join("|")).not.toContain("node-freed");
});

it("still names the project root when the repository has no linked worktrees at all", () => {
  const root = mkdtempSync(join(tmpdir(), "moe-replan-notrees-")); roots.push(root);

  expect(reservationWorkspaces(root)).toEqual([root]);
});

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

const twoOwners = (recover: (nodeRef: string) => Promise<unknown>) => ({
  readRecovery: () => ({
    code: null, projectId: "project-1",
    reservations: [reservationFor("node-a"), reservationFor("node-b")],
    version: "moe-repository-recovery/1",
  }),
  recover: (command: { readonly payload: { readonly nodeRef: string } }) =>
    recover(command.payload.nodeRef),
});

it("releases every replanned owner, not just the first", async () => {
  // Governance retired two nodes 22 ms apart on UnAI 2026-09-16 — one holding the project's own
  // checkout, one holding its node tree. Refusing on sight of the second left BOTH held.
  const recovered: string[] = [];
  const service = twoOwners((nodeRef) => {
    recovered.push(nodeRef);
    return Promise.resolve({ ok: true as const, resultCode: "REPOSITORY_RECOVERY_RELEASED" });
  });

  expect(await executeReplanRecovery(service as never, "operator", () => {})).toEqual({ ok: true });
  expect(recovered).toEqual(["node-a", "node-b"]);
});

it("reports the owners it already freed when a later one refuses", async () => {
  // The loop releases each owner in turn, so a refusal on the second leaves the first genuinely
  // released. The count has to travel with the refusal, because `moe start`'s line used to
  // promise that every reservation was kept as it was — a description of a repository state that
  // no longer exists by the time it is printed.
  const recovered: string[] = [];
  const service = twoOwners((nodeRef) => {
    recovered.push(nodeRef);
    return Promise.resolve(recovered.length === 1
      ? { ok: true as const, resultCode: "REPOSITORY_RECOVERY_RELEASED" }
      : { code: "REPOSITORY_EXECUTION_REVISION_CONFLICT", ok: false as const });
  });

  expect(await executeReplanRecovery(service as never, "operator", () => {}))
    .toEqual({ code: "REPOSITORY_EXECUTION_REVISION_CONFLICT", ok: false, released: 1 });
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

it("start does not claim every reservation was kept when the release already freed some", async () => {
  // The refusal line is the only thing the owner reads about what startup did to their
  // repository. Saying "every repository reservation is kept as it was" after freeing two of
  // them describes a state that no longer exists, and sends them looking for holds that are gone.
  const root = mkdtempSync(join(tmpdir(), "moe-start-replan-partial-")); roots.push(root);
  writeFileSync(join(root, "moe.config.json"), JSON.stringify({ schemaVersion: MOE_CONFIG_SCHEMA_VERSION,
    projectId: "project-1", credential: "a".repeat(64), storePath: "store.sqlite" }));
  const starts = vi.fn(async () => 0);
  const recoverReplan = vi.fn(async () =>
    ({ code: "REPOSITORY_EXECUTION_REVISION_CONFLICT", ok: false as const, released: 2 }));
  const logs: string[] = [];

  const code = await runMoeCli({ artifactRoot: root, argv: ["start"], cwd: root, env: {},
    log: line => logs.push(line), nodeVersion: "v24.16.0", packageVersion: "0.1.0",
    randomHex: () => "a".repeat(64), recoverReplan, startStack: starts, startManager: async () => 0 });

  expect(code, logs.join("\n")).toBe(0);
  expect(starts).toHaveBeenCalledOnce();
  expect(logs.some((line) => line.includes("every repository reservation is kept"))).toBe(false);
  expect(logs.some((line) => line.includes("freeing 2 replanned owner(s)"))).toBe(true);
});

it.each(["bound", "missing"] as const)("automatic startup does not drain ordinary work without REPLAN (%s seat)", async (seat) => {
  const w = await createReviewResumeWorld({ seat });
  expect(await executeReplanRecovery(w.service, "operator", () => {}, true)).toEqual({ ok: true });
  expect(w.drains()).toBe(0);
  expect(w.port.readOwned(w.workspace, w.owner.storeId, w.owner.projectId)).toMatchObject({ ok: true, handle: w.blocked });
});
