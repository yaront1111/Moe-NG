import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { SqliteEventStore } from "@moe/store";
import type { RepositoryExecutionController, RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { INTEGRATION_REF_PREFIX } from "../repository/repository-workflow-ref.js";

/**
 * Where the nodes' parallel work meets again (owner decision 2026-09-16). Each node commits on
 * its own branch in its own working tree, so nothing reaches the project's own branch until a
 * merge can be judged: a clean merge is taken as soon as the node's work is landed, and a merge
 * that conflicts is aborted whole and left for a person to answer, never resolved by guessing.
 *
 * The merge happens in the project's own checkout, which this holds through the same reservation
 * every other repository workflow uses, so it cannot run beside a publish, a criterion run, or a
 * node that still shares the project's tree. A checkout with uncommitted work is left alone: that
 * work belongs to whoever made it.
 *
 * Every outcome is recorded durably, so the operator's surface reads what happened rather than
 * inferring it from Git, and a merge already taken is never taken twice.
 */
const MERGED = "NodeBranchMerged";
const CONFLICTED = "NodeBranchConflicted";
const VERSION = "moe-repository-integration/1";
const encoder = new TextEncoder();

export interface LandedBranch {
  readonly branch: string;
  readonly nodeRef: string;
  readonly sha: string;
}

export interface IntegrationReport {
  readonly detail: string;
  readonly nodeRef: string;
  readonly outcome: "MERGED" | "CONFLICT" | "SKIPPED" | "UNAVAILABLE";
}

export type IntegrationGit = (cwd: string, args: readonly string[]) => { readonly code: number; readonly stdout: string };

const runGit: IntegrationGit = (cwd, args) => {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  try {
    const stdout = execFileSync("git", [...args], {
      cwd, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 4_194_304, stdio: ["ignore", "pipe", "pipe"],
      env: { ...environment, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    return { code: 0, stdout };
  } catch (error: unknown) {
    const failure = error as { status?: number; stdout?: string };
    return { code: typeof failure.status === "number" ? failure.status : 1, stdout: failure.stdout ?? "" };
  }
};

export interface NodeIntegrationConfig {
  readonly candidates: () => readonly LandedBranch[];
  readonly clock: () => string;
  readonly controller: RepositoryExecutionController;
  readonly git?: IntegrationGit;
  readonly projectId: string;
  readonly repository: RepositoryExecutionPort;
  readonly store: SqliteEventStore;
  readonly storeId: string;
  /** The project's own checkout, where the node branches meet. Absent = nothing to integrate. */
  readonly workspace: string | null;
}

export function createNodeIntegration(config: NodeIntegrationConfig) {
  const git = config.git ?? runGit;
  const aggregateId = `repository-integration/${createHash("sha256").update(config.projectId, "utf8").digest("hex")}`;
  const record = (eventType: string, facts: Record<string, unknown>): void => {
    try {
      const version = config.store.getAggregateVersion(aggregateId);
      const commandId = `rin-${createHash("sha256").update(aggregateId, "utf8").digest("hex").slice(0, 32)}-${String(version)}`;
      config.store.commit({
        aggregateId, commandBytes: encoder.encode(JSON.stringify({ eventType })), commandId,
        committedAt: config.clock(),
        events: [{ eventId: `${commandId}-e1`, eventType, payload: encoder.encode(JSON.stringify({ ...facts, version: VERSION })) }],
        expectedVersion: version,
      });
    } catch { /* an unrecorded outcome only costs the surface its line; Git is the truth */ }
  };
  const report = (nodeRef: string, outcome: IntegrationReport["outcome"], detail: string): IntegrationReport =>
    Object.freeze({ detail, nodeRef, outcome });

  const integrateOnce = async (): Promise<readonly IntegrationReport[]> => {
    const workspace = config.workspace;
    if (workspace === null) return [];
    let landed: readonly LandedBranch[];
    try { landed = config.candidates(); } catch { return []; }
    if (landed.length === 0) return [];
    // Only branches the project's own branch does not already contain.
    const pending = landed.filter((entry) => git(workspace, ["merge-base", "--is-ancestor", entry.sha, "HEAD"]).code !== 0);
    if (pending.length === 0) return [];
    const dirty = git(workspace, ["status", "--porcelain=v1", "--untracked-files=no"]);
    if (dirty.code !== 0) return [report(pending[0]!.nodeRef, "UNAVAILABLE", "the project checkout could not be read")];
    if (dirty.stdout.trim() !== "") {
      return [report(pending[0]!.nodeRef, "SKIPPED", "the project checkout holds uncommitted work; nothing was merged")];
    }
    const owner = { projectId: config.projectId, nodeRef: `${INTEGRATION_REF_PREFIX}${config.projectId}`,
      ownershipToken: randomBytes(32).toString("hex"), storeId: config.storeId };
    const acquired = config.repository.acquire(workspace, owner, config.controller);
    if (!acquired.ok) return [];
    const reports: IntegrationReport[] = [];
    try {
      for (const entry of pending) {
        const merged = git(workspace, ["merge", "--no-ff", "--no-edit", entry.sha]);
        if (merged.code === 0) {
          const head = git(workspace, ["rev-parse", "HEAD"]);
          record(MERGED, { at: config.clock(), branch: entry.branch, mergeSha: head.stdout.trim(),
            nodeRef: entry.nodeRef, projectId: config.projectId, sha: entry.sha });
          reports.push(report(entry.nodeRef, "MERGED", `${entry.branch} ${entry.sha.slice(0, 10)} merged`));
          continue;
        }
        const conflicts = git(workspace, ["diff", "--name-only", "--diff-filter=U"]);
        const paths = conflicts.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "").slice(0, 64);
        git(workspace, ["merge", "--abort"]);
        record(CONFLICTED, { at: config.clock(), branch: entry.branch, nodeRef: entry.nodeRef,
          paths, projectId: config.projectId, sha: entry.sha });
        reports.push(report(entry.nodeRef, "CONFLICT",
          `${entry.branch} conflicts with the project branch in ${String(paths.length)} path(s): ${paths.slice(0, 5).join(", ")}`));
        // One conflict at a time: a branch merged on top of an unanswered conflict hides it.
        break;
      }
    } finally {
      config.repository.release(workspace, owner, acquired.handle.reservation.revision, "YIELDED", config.controller.controllerId);
    }
    return Object.freeze(reports);
  };
  return Object.freeze({ integrateOnce });
}
