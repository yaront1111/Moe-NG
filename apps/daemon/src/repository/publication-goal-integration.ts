import type { SqliteEventStore } from "@moe/store";
import { execFileSync } from "node:child_process";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { legacyCompiledNodeKeys } from "../orchestrator/compiled-node-identity.js";
import { readReviewLedgers } from "../review/review-read-model.js";
import { landingEnvironment } from "./git-landing-port.js";
import { landedWithNoEffect } from "./landing-receipt-contracts.js";
import { validPublicationSha } from "./publication-approval-contracts.js";
import type { PublicationCandidate } from "./publication-approval-contracts.js";
/**
 * Partial publication is allowed; every credited scoped landing must remain in the approved
 * ancestry. A node that PROVABLY HAD NOTHING TO COMMIT is credited WITHOUT a sha: it satisfies
 * "the goal landed something" and is never submitted to the ancestry check, because its receipt
 * carries no commit (task-f7d38f752b074dc89da30631783aae04, reading A). Every other refusal was
 * decided after the lander journaled its intent to commit and still credits nothing — see
 * `landing-receipt-contracts.ts` for why the code is the discriminator this layer can read.
 */
export function publicationGoalIntegrated(store: SqliteEventStore, projectId: string, goalId: string,
  candidate: PublicationCandidate, contains?: (sha: string) => boolean): boolean {
  try {
    const graphs = activeCompiledGraphs(store, projectId, new Set(["EXECUTION_ENABLED", "CLOSING", "COMPLETED"]));
    const legacy = legacyCompiledNodeKeys(store, projectId, graphs);
    const refs = new Set<string>();
    for (const graph of graphs) {
      if (graph.goalRef !== goalId) continue;
      const keys = new Set([...graph.content.snapshot.nodes.filter((node) => node.executionBearing).map((node) => node.nodeKey),
        ...graph.content.nodeAuthority.definitions.map((node) => node.nodeKey)]);
      for (const key of keys) if (!legacy.has(key)) refs.add(compiledExecutionRef(projectId, graph, key));
    }
    const landed = [...readReviewLedgers(store, projectId, refs).landings.values()]
      .filter((receipt) => receipt.outcome === "COMMITTED" || landedWithNoEffect(receipt));
    if (landed.length === 0) return false;
    // The ancestry check runs over the COMMITTED subset ALONE. A no-effect receipt has no sha, so
    // including it would refuse on `validPublicationSha(undefined)` rather than be skipped.
    const receipts = landed.filter((receipt) => receipt.outcome === "COMMITTED");
    const includes = contains ?? ((sha: string) => {
      try {
        execFileSync("git", [`--git-dir=${candidate.identity.gitDirectory}`, "merge-base", "--is-ancestor", sha, candidate.approval.sha], {
          cwd: candidate.identity.root, env: landingEnvironment(), shell: false, windowsHide: true,
          timeout: 10_000, maxBuffer: 16_384, stdio: ["ignore", "pipe", "pipe"],
        }); return true;
      } catch { return false; }
    });
    return receipts.every((receipt) => validPublicationSha(receipt.commit?.sha) && includes(receipt.commit.sha));
  } catch { return false; }
}
