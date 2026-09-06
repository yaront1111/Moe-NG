import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { SqliteEventStore } from "@moe/store";
import { createNodePublisher } from "../orchestrator/node-publisher.js";
import { createGitPublicationPort } from "../repository/git-publication-port.js";
import { createRepositoryExecutionPort } from "../repository/repository-execution-port.js";
import { readReleaseDossierInput } from "./release-durable-facts.js";
import { readReleaseDossier, recordReleaseDossier } from "./release-dossier-ledger.js";
import { releaseDossierId } from "./release-dossier-contracts.js";
import type { AncestryPredicate } from "./release-dossier-contracts.js";
import type { ReleaseDossierFactsPort } from "./release-decide-service.js";
import { releaseDossierGaps, renderReleaseDossier } from "./release-dossier.js";

const OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

function ancestryAt(workspace: string, sha: string): AncestryPredicate | null {
  if (!OBJECT_ID.test(sha)) return null;
  const object = spawnSync("git", ["--no-replace-objects", "-C", workspace, "cat-file", "-t", sha], {
    encoding: "utf8", maxBuffer: 1024, shell: false, timeout: 10_000, windowsHide: true,
  });
  if (object.status !== 0 || object.stdout.trim() !== "commit") return null;
  return (commit) => {
    if (!OBJECT_ID.test(commit)) return "UNMEASURABLE";
    const result = spawnSync("git", ["--no-replace-objects", "-C", workspace,
      "merge-base", "--is-ancestor", commit, sha], {
      shell: false, stdio: "ignore", timeout: 10_000, windowsHide: true,
    });
    return result.status === 0 ? "ANCESTOR" : result.status === 1 ? "NOT_ANCESTOR" : "UNMEASURABLE";
  };
}

/**
 * THE SAME ancestry measurement the decide edge folds, handed to the release READ so the card
 * and the command can never disagree about which citations are re-measurable. A null answer is
 * "no workspace bound, or this sha names no commit here" — the read renders that as UNKNOWN
 * landings with `ancestryMeasured: false` rather than as failed evidence.
 */
export function createAncestryFactory(
  workspace: string | null,
): (sha: string) => AncestryPredicate | null {
  return (sha) => workspace === null ? null : ancestryAt(workspace, sha);
}

/** One publisher shared by this process's release command and delivery runtime. */
export function createProductionReleaseSeams(options: {
  readonly store: SqliteEventStore; readonly projectId: string; readonly storePath: string;
  readonly workspace: string | null; readonly clock: () => string;
}) {
  const { store, projectId, workspace, clock } = options;
  const publisher = createNodePublisher({ clock, store, projectId, workspace,
    git: createGitPublicationPort(), repository: createRepositoryExecutionPort(),
    storeId: realpathSync.native(options.storePath),
    controller: { controllerId: randomUUID(), controllerPid: process.pid },
  });
  const dossierFacts: ReleaseDossierFactsPort = (goalId, sha) => {
    if (workspace === null) return null;
    const input = readReleaseDossierInput(store, projectId, goalId);
    if (input === null || input.criteria.length === 0) return null;
    const ancestry = ancestryAt(workspace, sha);
    if (ancestry === null) return null;
    if (releaseDossierGaps(input, sha, ancestry).length > 0) return { input, ancestry };
    const markdown = renderReleaseDossier(input, sha, ancestry);
    const existing = readReleaseDossier(store, projectId, releaseDossierId(projectId, goalId, sha));
    if (existing.ok && existing.dossier.markdown !== markdown) return null;
    if (!existing.ok) {
      if (existing.code !== "RELEASE_DOSSIER_NOT_FOUND") return null;
      const recorded = recordReleaseDossier(store, { decidedAt: clock(), goalId, projectId, sha,
        markdown });
      if (!recorded.ok) return null;
    }
    return { input, ancestry };
  };
  return Object.freeze({ clock, dossierFacts, publisher, workspace });
}
