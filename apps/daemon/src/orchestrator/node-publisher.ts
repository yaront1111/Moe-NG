import type { SqliteEventStore } from "@moe/store";

import type { GitPublishPort } from "../repository/git-landing-port.js";
import { readPublishLedger, recordPublishReceipt } from "../repository/publish-ledger.js";
import { publishLinkFor } from "../repository/publish-receipt-contracts.js";

/**
 * THE PUBLISHER: the effect behind a human's `repository.publish` decision.
 * Each pass reads every publish request the daemon recorded, and for each one
 * without a receipt pushes the workspace's current branch to the remote the
 * decision names, then records ONE receipt per decision: PUSHED with the sha,
 * branch and browse link, or REFUSED with git's own words. A refused push is
 * never retried under the same decision — the human decides again, which mints
 * a new decision id, which the publisher answers once.
 *
 * Nothing here chooses a remote, a branch, or a moment: the decision names the
 * remote, the workspace names the branch, and the wrapper loop names the pass.
 */

export interface NodePublisherConfig {
  readonly clock?: () => string;
  readonly git: GitPublishPort;
  readonly projectId: string;
  readonly store: SqliteEventStore;
  /** The compiled-node workspace; null means no publish can happen (reported, not recorded). */
  readonly workspace: string | null;
}

export interface PublishReport {
  readonly detail: string;
  readonly goalId: string;
  readonly outcome: "PUSHED" | "REFUSED" | string;
}

export function createNodePublisher(config: NodePublisherConfig) {
  const clock = config.clock ?? ((): string => new Date().toISOString());

  const publishOnce = async (): Promise<readonly PublishReport[]> => {
    const reports: PublishReport[] = [];
    for (const [goalId, state] of readPublishLedger(config.store, config.projectId)) {
      for (const request of state.requests) {
        if (state.receipts.has(request.decisionId)) continue;
        if (config.workspace === null) {
          reports.push({ detail: "MOE_NODE_WORKSPACE is not set", goalId, outcome: "WORKSPACE_UNSET" });
          continue;
        }
        const pushed = await config.git.push(config.workspace, request.remoteUrl);
        const recorded = recordPublishReceipt(config.store, {
          branch: pushed.ok ? pushed.receipt.branch : null,
          decidedAt: clock(),
          decisionId: request.decisionId,
          goalId,
          projectId: config.projectId,
          refusal: pushed.ok ? null : { code: pushed.code, detail: pushed.detail },
          remoteUrl: request.remoteUrl,
          sha: pushed.ok ? pushed.receipt.sha : null,
          url: pushed.ok ? publishLinkFor(request.remoteUrl, pushed.receipt.branch) : null,
        });
        if (!recorded.ok) {
          reports.push({ detail: recorded.code, goalId, outcome: recorded.code });
          continue;
        }
        reports.push(pushed.ok
          ? {
            detail: `${pushed.receipt.sha.slice(0, 10)} ${pushed.receipt.branch} -> ${request.remoteUrl}`
              + (recorded.receipt.url === null ? "" : ` (${recorded.receipt.url})`),
            goalId,
            outcome: "PUSHED",
          }
          : { detail: `${pushed.code}: ${pushed.detail}`, goalId, outcome: "REFUSED" });
      }
    }
    return reports;
  };

  return Object.freeze({ publishOnce });
}
