import { createHash } from "node:crypto";
import { MAX_PAGE_SIZE } from "@moe/store";
import type { SqliteEventStore } from "@moe/store";
import type { LandedBranch } from "../orchestrator/node-integration.js";

/**
 * What became of each node's branch, for the operator's surface (owner decision 2026-09-16).
 * Read from the integrator's own durable records joined to the branches the nodes landed, never
 * inferred from Git: a merge that happened is a recorded merge, and a conflict keeps the paths it
 * could not join so the reader sees what to answer.
 *
 * A branch with no record yet is WAITING: the integrator takes it on its next pass, or it is
 * waiting behind a conflict that has to be answered first. A merge the integrator could not name
 * is left out: the surface serves a merge only with its name, and one nameless row would cost it
 * the whole read.
 */
export const REPOSITORY_INTEGRATION_READ_VERSION = "moe-repository-integration-read/1" as const;
const MERGED = "NodeBranchMerged";
const CONFLICTED = "NodeBranchConflicted";
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface IntegrationBranchView {
  readonly branch: string;
  /** The paths a conflicted merge could not join; empty for every other state. */
  readonly conflictPaths: readonly string[];
  readonly mergeSha: string | null;
  readonly nodeRef: string;
  readonly sha: string;
  readonly state: "MERGED" | "CONFLICTED" | "WAITING";
}

export interface RepositoryIntegrationView {
  readonly branches: readonly IntegrationBranchView[];
  readonly projectId: string;
  readonly version: typeof REPOSITORY_INTEGRATION_READ_VERSION;
}

/** What this read joins on. WHERE a branch landed (`fromTree`) is the integrator's question, never the reader's. */
export type LandedSha = Omit<LandedBranch, "fromTree">;

interface Outcome { readonly mergeSha: string | null; readonly paths: readonly string[]; readonly state: "MERGED" | "CONFLICTED" }

/** NUL joins the pair: neither a node ref nor a sha can hold one, so no two pairs share a key. */
const keyOf = (nodeRef: string, sha: string): string => `${nodeRef}\0${sha}`;

/** ONE walk of the integration aggregate, asked as often as the caller likes. */
export interface IntegrationRecords {
  /** Whether the integrator recorded this node's exact commit MERGED, named or not. */
  readonly merged: (nodeRef: string, sha: string) => boolean;
  readonly view: (landed: readonly LandedSha[]) => RepositoryIntegrationView;
  /**
   * False when a record could not be read. What was folded before it still answers, as it always
   * did; but a caller that WRITES on "no record" must never take "could not read" for it, or it
   * writes the same record again on every pass.
   */
  readonly whole: boolean;
}

export function readIntegrationRecords(store: SqliteEventStore, projectId: string): IntegrationRecords {
  const outcomes = new Map<string, Outcome>();
  let whole = true;
  try {
    const aggregateId = `repository-integration/${createHash("sha256").update(projectId, "utf8").digest("hex")}`;
    // PAGED, in sequence order. The aggregate gains an event per merge, conflict and reconciliation
    // and is never compacted, and `readEvents` refuses a whole aggregate past one page: at the
    // 1001st record every merge read as unrecorded, every dependent BLOCKED, and nothing said why.
    for (let cursor = 0; ;) {
      const page = store.readAggregateEvents(aggregateId, cursor, MAX_PAGE_SIZE);
      for (const event of page.items) {
        if (event.eventType !== MERGED && event.eventType !== CONFLICTED) continue;
        const value: unknown = JSON.parse(decoder.decode(event.payload));
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
        const facts = value as Record<string, unknown>;
        const nodeRef = facts["nodeRef"]; const sha = facts["sha"]; const mergeSha = facts["mergeSha"];
        if (typeof nodeRef !== "string" || typeof sha !== "string") continue;
        const paths = Array.isArray(facts["paths"]) ? facts["paths"].filter((path): path is string => typeof path === "string") : [];
        // The latest record for a node's exact commit wins: a conflict answered and merged reads MERGED.
        outcomes.set(keyOf(nodeRef, sha), event.eventType === MERGED
          ? { mergeSha: typeof mergeSha === "string" && mergeSha !== "" ? mergeSha : null, paths: [], state: "MERGED" }
          : { mergeSha: null, paths: Object.freeze(paths.slice(0, 64)), state: "CONFLICTED" });
      }
      if (!page.hasMore) break;
      // A page that says "more" and does not move on is a read that failed, never the end of the records.
      if (page.nextCursor === null || page.nextCursor <= cursor) throw new Error("the integration aggregate's page did not advance");
      cursor = page.nextCursor;
    }
  } catch { whole = false; /* an unreadable record leaves its branch WAITING, never a guessed outcome */ }
  const view = (landed: readonly LandedSha[]): RepositoryIntegrationView => {
    const branches = landed.flatMap((entry) => {
      const outcome = outcomes.get(keyOf(entry.nodeRef, entry.sha));
      // A merge with no name is one this cannot vouch for: served as MERGED it would fail the whole read.
      if (outcome?.state === "MERGED" && outcome.mergeSha === null) return [];
      return [Object.freeze({
        branch: entry.branch,
        conflictPaths: outcome?.state === "CONFLICTED" ? outcome.paths : Object.freeze([]),
        mergeSha: outcome?.state === "MERGED" ? outcome.mergeSha : null,
        nodeRef: entry.nodeRef,
        sha: entry.sha,
        state: outcome?.state ?? "WAITING",
      })];
    });
    return Object.freeze({ branches: Object.freeze(branches), projectId, version: REPOSITORY_INTEGRATION_READ_VERSION });
  };
  const merged = (nodeRef: string, sha: string): boolean => outcomes.get(keyOf(nodeRef, sha))?.state === "MERGED";
  return Object.freeze({ merged, view, whole });
}

/**
 * Whether the integrator recorded this node's exact commit MERGED, mergeSha or not. The view above
 * drops a merge the integrator could not name; a DEPENDENT asking "is my dependency on the
 * project branch" must still hear yes, or it waits forever. The sha is already an ancestor, so the
 * integrator never MERGES it again: a merge whose record is missing is written by the integrator's
 * reconciliation (node-integration.ts), from Git's own word that the sha is on the project branch.
 */
export function nodeCommitMerged(store: SqliteEventStore, projectId: string, nodeRef: string, sha: string): boolean {
  return readIntegrationRecords(store, projectId).merged(nodeRef, sha);
}

export function readRepositoryIntegration(
  store: SqliteEventStore, projectId: string, landed: readonly LandedSha[],
): RepositoryIntegrationView {
  return readIntegrationRecords(store, projectId).view(landed);
}
