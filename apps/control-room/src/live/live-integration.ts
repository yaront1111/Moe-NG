import { effectList, effectRecord, effectRefusal, effectText, readEffect } from "./live-effect-read.js";
import type { EffectReadFailure } from "./live-effect-read.js";

/**
 * What became of each node's own branch (owner decision 2026-09-16). Nodes code in their own
 * working trees, so their work reaches the project's branch only through a merge: this read is
 * how the operator sees which branches merged, which one conflicts and what it conflicts over,
 * and which are still waiting. Pushing is the Publish card's job and is unchanged.
 */
export type IntegrationState = "MERGED" | "CONFLICTED" | "WAITING";

export interface IntegrationBranchView {
  readonly branch: string;
  readonly conflictPaths: readonly string[];
  readonly mergeSha: string | null;
  readonly nodeRef: string;
  readonly sha: string;
  readonly state: IntegrationState;
}

export interface RepositoryIntegrationView {
  readonly branches: readonly IntegrationBranchView[];
  readonly projectId: string;
  readonly version: "moe-repository-integration-read/1";
}

export type RepositoryIntegrationOutcome =
  | EffectReadFailure
  | { readonly status: "INTEGRATION"; readonly view: RepositoryIntegrationView };

const LAYER = "CONTROL_ROOM_INTEGRATION";
const invalid = (): EffectReadFailure => ({ status: "ERROR", code: "REPOSITORY_INTEGRATION_RESPONSE_INVALID", layer: LAYER });
const pathOf = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : null;

function branchOf(value: unknown): IntegrationBranchView | null {
  const row = effectRecord(value, ["branch", "conflictPaths", "mergeSha", "nodeRef", "sha", "state"]);
  if (row === null || !effectText(row.branch) || !effectText(row.nodeRef) || !effectText(row.sha)) return null;
  if (row.state !== "MERGED" && row.state !== "CONFLICTED" && row.state !== "WAITING") return null;
  if (row.mergeSha !== null && !effectText(row.mergeSha)) return null;
  const conflictPaths = effectList(row.conflictPaths, pathOf, 64);
  if (conflictPaths === null) return null;
  // Each state carries exactly its own evidence: a merge names its merge, a conflict its paths.
  if (row.state === "MERGED" && (row.mergeSha === null || conflictPaths.length > 0)) return null;
  if (row.state !== "MERGED" && row.mergeSha !== null) return null;
  if (row.state !== "CONFLICTED" && conflictPaths.length > 0) return null;
  return Object.freeze({ branch: row.branch, conflictPaths, mergeSha: row.mergeSha as string | null,
    nodeRef: row.nodeRef, sha: row.sha, state: row.state });
}

export function mapRepositoryIntegrationAnswer(status: number, body: unknown): RepositoryIntegrationOutcome {
  const refusal = effectRefusal(body); if (refusal !== null) return refusal;
  const row = effectRecord(body, ["version", "projectId", "branches"]);
  if (status !== 200 || row === null || row.version !== "moe-repository-integration-read/1"
    || !effectText(row.projectId)) return invalid();
  const branches = effectList(row.branches, branchOf);
  if (branches === null || new Set(branches.map((branch) => branch.nodeRef)).size !== branches.length) return invalid();
  return Object.freeze({ status: "INTEGRATION",
    view: Object.freeze({ branches, projectId: row.projectId, version: row.version }) });
}

export async function readRepositoryIntegration(
  headers: Readonly<Record<string, string>>, post?: (body: string) => Promise<Response>,
): Promise<RepositoryIntegrationOutcome> {
  return readEffect(headers, "/repository/integration/read", {}, mapRepositoryIntegrationAnswer, LAYER, post);
}
