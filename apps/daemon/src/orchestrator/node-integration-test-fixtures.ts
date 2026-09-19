import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import type { RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import { ensureNodeTree, forgetNodeTrees } from "./node-worktrees.js";
import { createNodeIntegration } from "./node-integration.js";
import type { IntegrationGit, LandedBranch } from "./node-integration.js";

/**
 * The world node-integration.test.ts runs in: a real project checkout, real node trees, a real
 * store and the production integrator. Moved out of that file when it reached the size this
 * repository splits at; nothing here is stood in but the clock and, where an arm asks, one Git call.
 */
const roots: string[] = [];
const stores: SqliteEventStore[] = [];
/** For the suite's `afterEach`. */
export function closeWorlds(): void {
  forgetNodeTrees();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
/** The real Git, in the integrator's own shape, for a test that fails one call of it. */
export const realGit: IntegrationGit = (cwd, args) => {
  try {
    return { code: 0, stdout: execFileSync("git", [...args], { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error: unknown) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, stderr: failure.stderr ?? "", stdout: failure.stdout ?? "" };
  }
};

export function world(runner?: IntegrationGit) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "moe-integration-"))); roots.push(workspace);
  git(workspace, "init", "--quiet");
  git(workspace, "config", "user.email", "integration@example.test");
  git(workspace, "config", "user.name", "Integration Fixture");
  // Line endings are pinned so a checkout reads the same bytes on every host.
  git(workspace, "config", "core.autocrlf", "false");
  writeFileSync(join(workspace, "shared.txt"), "base\n", "utf8");
  git(workspace, "add", "shared.txt");
  git(workspace, "commit", "--quiet", "-m", "base");
  const store = SqliteEventStore.openForProject(join(realpathSync(mkdtempSync(join(tmpdir(), "moe-integration-store-"))), "store.sqlite"), "project-a");
  stores.push(store);
  const port = createRepositoryExecutionPort();
  let acquisitions = 0;
  const repository: RepositoryExecutionPort = { ...port, acquire: (...args) => { acquisitions += 1; return port.acquire(...args); } };
  const landed: LandedBranch[] = [];
  /** The integrator's store counts its calls and refuses `refusals[method]` more of them. The instance is sealed, so no spy lies on it. */
  const refusals: Record<string, number> = {};
  const calls: Record<string, number> = {};
  const refusing = new Proxy(store, { get(target, property): unknown {
    const held: unknown = Reflect.get(target, property, target);
    if (typeof held !== "function") return held;
    return (...args: unknown[]): unknown => {
      calls[String(property)] = (calls[String(property)] ?? 0) + 1;
      if ((refusals[String(property)] ?? 0) > 0) { refusals[String(property)]! -= 1; throw new Error("the store is busy"); }
      return (held as (...inner: unknown[]) => unknown).apply(target, args);
    };
  } });
  const integration = createNodeIntegration({
    candidates: () => landed, clock: () => "2026-09-16T10:00:00.000Z",
    controller: { controllerId: "controller-a", controllerPid: 101 },
    ...(runner === undefined ? {} : { git: runner }),
    projectId: "project-a", repository, store: refusing, storeId: "store-a", workspace,
  });
  /** A node that coded in its own tree and landed one commit on its own branch (its latest landing counts). */
  const landedNode = (nodeRef: string, file: string, body: string): LandedBranch => {
    const tree = ensureNodeTree({ nodeRef, projectRoot: workspace });
    if (tree === null) throw new Error("expected a tree");
    writeFileSync(join(tree.path, file), body, "utf8");
    git(tree.path, "add", file);
    git(tree.path, "commit", "--quiet", "-m", `${nodeRef} work`);
    const entry = { branch: tree.branch, fromTree: true, nodeRef, sha: git(tree.path, "rev-parse", "HEAD") };
    const known = landed.findIndex((candidate) => candidate.nodeRef === nodeRef);
    if (known === -1) landed.push(entry); else landed.splice(known, 1, entry);
    return entry;
  };
  const aggregateId = `repository-integration/${createHash("sha256").update("project-a", "utf8").digest("hex")}`;
  const events = (): readonly { type: string; facts: Record<string, unknown> }[] => {
    const rows = store.readEvents(aggregateId);
    return rows.map((row) => ({ facts: JSON.parse(new TextDecoder().decode(row.payload)) as Record<string, unknown>, type: row.eventType }));
  };
  /** A record in the integrator's own shape, as an earlier pass of this daemon or of one before it left it. */
  const recorded = (eventType: string, facts: Record<string, unknown>): void => {
    const version = store.getAggregateVersion(aggregateId);
    const commandId = `rin-fixture-${String(version)}`;
    store.commit({ aggregateId, commandBytes: new TextEncoder().encode(JSON.stringify({ eventType })), commandId,
      committedAt: "2026-09-16T09:00:00.000Z", expectedVersion: version,
      events: [{ eventId: `${commandId}-e1`, eventType, payload: new TextEncoder().encode(JSON.stringify({ ...facts, version: "moe-repository-integration/1" })) }] });
  };
  return { acquisitions: () => acquisitions, calls, events, integration, landed, landedNode, port, recorded, refusals, store, workspace };
}
export type World = ReturnType<typeof world>;
