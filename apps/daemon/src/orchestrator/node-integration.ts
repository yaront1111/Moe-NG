import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { SqliteEventStore } from "@moe/store";
import { isMoeMetadata } from "../repository/git-landing-port.js";
import type { RepositoryExecutionController, RepositoryExecutionPort } from "../repository/repository-execution-contracts.js";
import { readIntegrationRecords } from "../repository/repository-integration-read.js";
import type { IntegrationRecords } from "../repository/repository-integration-read.js";
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
 * inferring it from Git, and a merge already taken is never taken twice. A conflict is only ever
 * paths Git could not join: a merge it stopped for a reason of its own (a lock, an untracked file
 * in the way, a commit it cannot reach) records nothing and is tried again on the next pass, as is
 * a conflict some earlier pass recorded with no paths. A recorded conflict withdraws its node's
 * acceptance (node-delivery-withdrawal.ts): the node returns to a seat and leaves the candidates,
 * so the halt lasts one pass, and the conflict is answered by the node landing again. The same
 * commit is never tried twice.
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

export type IntegrationGit = (cwd: string, args: readonly string[]) =>
  { readonly code: number; readonly stderr?: string; readonly stdout: string };

/** Exported so the lander's adoption probe asks Git the same way; never copy it a third time. */
export const runGit: IntegrationGit = (cwd, args) => {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  try {
    const stdout = execFileSync("git", [...args], {
      cwd, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 4_194_304, stdio: ["ignore", "pipe", "pipe"],
      env: { ...environment, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    return { code: 0, stdout };
  } catch (error: unknown) {
    const failure = error as { status?: number; stderr?: string; stdout?: string };
    // A timeout or a spawn failure has no status: Git never answered. 1 is `merge-base
    // --is-ancestor`'s own "no", which the withdrawal and the adoption probe act on, so it is 128.
    return { code: typeof failure.status === "number" ? failure.status : 128, stderr: failure.stderr ?? "", stdout: failure.stdout ?? "" };
  }
};

/** Git's own words for a merge it stopped, on one line, so the report says why. Shared with the tree sync. */
export const reasonOf = (stderr: string | undefined): string => {
  const words = (stderr ?? "").split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "").join(" ");
  return words === "" ? "Git gave no reason" : words.slice(0, 240);
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
  /** Whether the record was WRITTEN: a merge's missing record holds its dependents and its publication. */
  const record = (eventType: string, facts: Record<string, unknown>): boolean => {
    try {
      const version = config.store.getAggregateVersion(aggregateId);
      const commandId = `rin-${createHash("sha256").update(aggregateId, "utf8").digest("hex").slice(0, 32)}-${String(version)}`;
      return config.store.commit({
        aggregateId, commandBytes: encoder.encode(JSON.stringify({ eventType })), commandId,
        committedAt: config.clock(),
        events: [{ eventId: `${commandId}-e1`, eventType, payload: encoder.encode(JSON.stringify({ ...facts, version: VERSION })) }],
        expectedVersion: version,
      }).disposition === "COMMITTED";
    } catch { return false; /* Git is the truth: a merge's missing record is written by `reconcile` on a later pass */ }
  };
  const report = (nodeRef: string, outcome: IntegrationReport["outcome"], detail: string): IntegrationReport =>
    Object.freeze({ detail, nodeRef, outcome });
  /**
   * A merge Git holds and no record names: this integrator's own whose record the store refused, or
   * one the owner made by hand. Its sha is an ancestor already, so no pass merges it again, yet the
   * dependency gate and the publication credit both wait on the record, forever. Git's own "this is
   * contained" is the positive evidence; the merge commit is unknown and never invented. No Git
   * effect and no hold. Reported only once written: a store that keeps refusing is retried in silence.
   */
  const reconcile = (contained: ReadonlySet<LandedBranch>, records: IntegrationRecords): IntegrationReport[] =>
    !records.whole ? [] : [...contained].filter((entry) => !records.merged(entry.nodeRef, entry.sha)).flatMap((entry) =>
      record(MERGED, { at: config.clock(), branch: entry.branch, mergeSha: null,
        nodeRef: entry.nodeRef, projectId: config.projectId, sha: entry.sha })
        ? [report(entry.nodeRef, "MERGED", `${entry.branch} ${entry.sha.slice(0, 10)} was already on the project branch; its missing record was written`)]
        : []);
  /**
   * The merge commit's name, asked for twice: the operator's surface serves a merge only with its
   * name, so a merge Git will not name is recorded as taken, with no name, and served as nothing.
   */
  const mergeNameOf = (workspace: string): string | null => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const head = git(workspace, ["rev-parse", "HEAD"]);
      if (head.code === 0 && head.stdout.trim() !== "") return head.stdout.trim();
    }
    return null;
  };

  const integrateOnce = async (): Promise<readonly IntegrationReport[]> => {
    const workspace = config.workspace;
    if (workspace === null) return [];
    let landed: readonly LandedBranch[];
    try { landed = config.candidates(); } catch { return []; }
    if (landed.length === 0) return [];
    // Exit 0 EXACTLY is Git saying "contained": 1 is its "no" and 128 is no answer, and neither proves anything.
    const contained = new Set(landed.filter((entry) => git(workspace, ["merge-base", "--is-ancestor", entry.sha, "HEAD"]).code === 0));
    // Only branches the project's own branch does not already contain.
    const pending = landed.filter((entry) => !contained.has(entry));
    // ONE walk of the aggregate per pass serves the reconciliation and the conflict check below.
    const records = readIntegrationRecords(config.store, config.projectId);
    // BEFORE every early return: nothing pending, a parked conflict, a dirty checkout and a held
    // repository are exactly the states a dependent stranded by a missing record sits behind.
    const reconciled = reconcile(contained, records);
    if (pending.length === 0) return Object.freeze(reconciled);
    // A conflict already recorded at a node's exact commit is answered by that node landing again,
    // not by trying the same merge every pass; nothing later merges until it is. A record with no
    // paths names nothing a node could answer, so it holds nothing back: it is simply tried again.
    const recorded = records.view(pending).branches;
    if (recorded.some((branch) => branch.state === "CONFLICTED" && branch.conflictPaths.length > 0)) return Object.freeze(reconciled);
    const dirty = git(workspace, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=no"]);
    if (dirty.code !== 0) return [...reconciled, report(pending[0]!.nodeRef, "UNAVAILABLE", "the project checkout could not be read")];
    // Moe's own tracked runtime files are nobody's uncommitted work (the lander's own reading,
    // git-landing-port.ts). Only a node staffed IN this checkout ever checkpoints them, so once every
    // node lived in a tree one operator edit to .moe-next/start.ps1 skipped every merge, forever
    // (UnAI 2026-09-19). A merge that would touch the edited file is still refused, by Git, whole.
    if (dirty.stdout.split("\0").some((entry) => entry.length > 3 && !isMoeMetadata(entry.slice(3)))) {
      return [...reconciled, report(pending[0]!.nodeRef, "SKIPPED", "the project checkout holds uncommitted work; nothing was merged")];
    }
    const owner = { projectId: config.projectId, nodeRef: `${INTEGRATION_REF_PREFIX}${config.projectId}`,
      ownershipToken: randomBytes(32).toString("hex"), storeId: config.storeId };
    const acquired = config.repository.acquire(workspace, owner, config.controller);
    if (!acquired.ok) return Object.freeze(reconciled);
    const reports: IntegrationReport[] = [...reconciled];
    try {
      for (const entry of pending) {
        const merged = git(workspace, ["merge", "--no-ff", "--no-edit", entry.sha]);
        if (merged.code === 0) {
          // A merge whose commit cannot be named is still a merge; its name stays unknown, never empty.
          const mergeSha = mergeNameOf(workspace);
          const written = record(MERGED, { at: config.clock(), branch: entry.branch, mergeSha,
            nodeRef: entry.nodeRef, projectId: config.projectId, sha: entry.sha });
          reports.push(report(entry.nodeRef, "MERGED",
            `${entry.branch} ${entry.sha.slice(0, 10)} merged${mergeSha === null ? "; the merge commit could not be read" : ""}${
              written ? "" : "; the record could not be written and is retried next pass"}`));
          continue;
        }
        const conflicts = git(workspace, ["diff", "--name-only", "--diff-filter=U"]);
        const paths = conflicts.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "").slice(0, 64);
        git(workspace, ["merge", "--abort"]);
        // Only paths Git could not join make a conflict. A merge it stopped for a reason of its own
        // leaves nothing durable: a node briefed with no paths could answer nothing.
        if (paths.length === 0) {
          reports.push(report(entry.nodeRef, "UNAVAILABLE", `${entry.branch} could not be merged: ${reasonOf(merged.stderr)}`));
          break;
        }
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
