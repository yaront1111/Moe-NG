import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SqliteEventStore } from "@moe/store";

import type { GitLandingPort } from "../repository/git-landing-port.js";
import {
  readEarliestLandingBaseline, readLandingBaseline, readLandingReceipt, readLatestLandingBaseline,
  recordLandingBaseline, recordLandingReceipt,
} from "../repository/landing-ledger.js";
import { DELETED_BLOB, landingReceiptId } from "../repository/landing-receipt-contracts.js";
import type { LandingBaselineEntry, LandingRefusal } from "../repository/landing-receipt-contracts.js";
import { readReviewLedger } from "../review/review-read-model.js";
import type { NodeMission } from "./agent-wrapper.js";
import { untrackedImports } from "./landing-imports.js";
import { checkLandingVerification } from "./node-lander-verification.js";
import type { VerifiedWorkspaceBinding, VerifiedWorkspacePort } from "../repository/verified-workspace-contracts.js";

/**
 * THE LANDER: once the daemon has accepted a node (a verifier receipt consumed
 * by `integration.accept_output`), commit what the seat changed in the
 * workspace as ONE git commit on the workspace's current branch, and record a
 * receipt beside the node. Local only — nothing here pushes; publishing is a
 * separate human decision.
 *
 * What the seat changed is measured, not trusted: a BASELINE of every dirty
 * path (with its blob id) is recorded the moment the seat is staffed, and the
 * landing commits exactly the paths whose content differs from that baseline.
 * The operator's own uncommitted work, present before the seat started, is
 * never swept into a Moe commit.
 *
 * One landing per acceptance: the receipt id is a function of the verifier
 * receipt, so a wrapper restart lands nothing twice, and a refusal is recorded
 * with its code rather than retried forever.
 */

export interface NodeLanderConfig {
  readonly verifiedWorkspace?: VerifiedWorkspacePort;
  /** Test injection; production reads the exact accepted verifier receipt from the store. */
  readonly readVerifiedBinding?: (nodeRef: string, receiptId: string) => VerifiedWorkspaceBinding | null;
  /** Original reservation baseline; absent keeps the legacy test composition readable. */
  readonly baselineId?: (nodeRef: string) => string | null;
  readonly clock?: () => string;
  readonly git: GitLandingPort;
  readonly nodeMission: (nodeRef: string) => NodeMission | null;
  readonly nodes: () => readonly { nodeRef: string }[];
  readonly projectId: string;
  /** INJECTED in tests; production reads the node's review ledger. */
  readonly readAccepted?: (nodeRef: string) => { readonly verifierReceiptId: string } | null;
  /** A root-relative path's current text, or null; production reads the workspace. */
  readonly readText?: (root: string, path: string) => string | null;
  readonly store: SqliteEventStore;
}

export interface LanderReport {
  readonly baselineId?: string;
  readonly detail: string;
  readonly nodeRef: string;
  readonly outcome: "BASELINE_RECORDED" | "COMMITTED" | "REFUSED" | string;
}

const SUBJECT_MAX = 72;

function subjectLine(title: string): string {
  const first = title.split(/\r?\n/u)[0]?.trim() ?? "";
  const text = first === "" ? "Moe: landed a verified node" : first;
  return text.length <= SUBJECT_MAX ? text : `${text.slice(0, SUBJECT_MAX - 1)}…`;
}

/**
 * The node's OWN earlier attempts' files: untracked now, unchanged since the latest baseline
 * (so not "delivered" by this seat), and absent from the node's FIRST baseline. A seat that
 * dies mid-node leaves its files in the tree; the re-staffed seat finds them, writes nothing,
 * and the latest baseline calls them operator dirt — kernel-redaction on UnAI (2026-09-05) was
 * verified ACCEPTED and then refused NOTHING_TO_COMMIT, leaving HEAD without it. Files the
 * operator had before the node was ever staffed stay the operator's.
 */
export function earlierAttemptPaths(
  first: readonly LandingBaselineEntry[], latest: readonly LandingBaselineEntry[],
  observed: readonly LandingBaselineEntry[], untracked: ReadonlySet<string>,
): readonly string[] {
  const before = new Set(first.map((entry) => entry.path));
  const staffed = new Map(latest.map((entry) => [entry.path, entry.blobId]));
  return observed
    .filter((entry) => entry.blobId !== DELETED_BLOB && untracked.has(entry.path)
      && !before.has(entry.path) && staffed.get(entry.path) === entry.blobId)
    .map((entry) => entry.path);
}

/** The paths whose content the seat changed: present now, and not identical in the baseline. */
export function deliveredPaths(
  baseline: readonly LandingBaselineEntry[], observed: readonly LandingBaselineEntry[],
): readonly string[] {
  const before = new Map(baseline.map((entry) => [entry.path, entry.blobId]));
  return observed
    .filter((entry) => before.get(entry.path) !== entry.blobId)
    .map((entry) => entry.path);
}

export function landingMessage(
  brief: NodeMission, nodeRef: string, verifierReceiptId: string,
): string {
  return [
    subjectLine(brief.title),
    "",
    `Moe landed node ${nodeRef} after the daemon verified it.`,
    `Verified: ${brief.test} in ${brief.workspace}`,
    `Verifier receipt: ${verifierReceiptId}`,
    "",
  ].join("\n");
}

function readWorkspaceText(root: string, path: string): string | null {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
}

export function createNodeLander(config: NodeLanderConfig) {
  const clock = config.clock ?? ((): string => new Date().toISOString());
  const readText = config.readText ?? readWorkspaceText;
  const readAccepted = config.readAccepted ?? ((nodeRef: string) => {
    const ledger = readReviewLedger(config.store, config.projectId, nodeRef);
    return ledger.accepted === undefined
      ? null : { verifierReceiptId: ledger.accepted.verifierReceiptId };
  });

  /** Record what is dirty NOW, before the seat for this node starts working. */
  const baseline = async (nodeRef: string): Promise<LanderReport> => {
    const brief = config.nodeMission(nodeRef);
    if (brief === null) return { detail: "no spec brief", nodeRef, outcome: "NODE_BRIEF_MISSING" };
    const observed = await config.git.observe(brief.workspace);
    if (!observed.ok) return { detail: observed.detail, nodeRef, outcome: observed.code };
    const recorded = recordLandingBaseline(config.store, {
      entries: observed.observation.entries,
      observedAt: clock(),
      projectId: config.projectId,
      subjectRef: nodeRef,
      workspace: brief.workspace,
    });
    if (!recorded.ok) return { detail: recorded.code, nodeRef, outcome: recorded.code };
    return {
      baselineId: recorded.baselineId,
      detail: `${String(observed.observation.entries.length)} dirty path(s) before the seat`,
      nodeRef,
      outcome: "BASELINE_RECORDED",
    };
  };

  const refuse = (
    nodeRef: string, workspace: string, verifierReceiptId: string, refusal: LandingRefusal,
  ): LanderReport => {
    const recorded = recordLandingReceipt(config.store, {
      commit: null, decidedAt: clock(), projectId: config.projectId, refusal,
      subjectRef: nodeRef, verifierReceiptId, workspace,
    });
    return {
      detail: recorded.ok ? `${refusal.code}: ${refusal.detail}` : recorded.code,
      nodeRef,
      outcome: recorded.ok ? "REFUSED" : recorded.code,
    };
  };

  const landOne = async (nodeRef: string, verifierReceiptId: string): Promise<LanderReport | null> => {
    const receiptId = landingReceiptId(config.projectId, nodeRef, verifierReceiptId);
    const existing = readLandingReceipt(config.store, config.projectId, receiptId);
    if (existing.ok) return null;
    if (existing.code === "LANDING_RECEIPT_INVALID") {
      return { detail: existing.code, nodeRef, outcome: existing.code };
    }
    const brief = config.nodeMission(nodeRef);
    if (brief === null) return { detail: "no spec brief", nodeRef, outcome: "NODE_BRIEF_MISSING" };
    const selectedBaseline = config.baselineId?.(nodeRef);
    const before = config.baselineId === undefined
      ? readLatestLandingBaseline(config.store, config.projectId, nodeRef)
      : selectedBaseline === null || selectedBaseline === undefined ? null
        : readLandingBaseline(config.store, config.projectId, nodeRef, selectedBaseline);
    if (before === null) {
      return refuse(nodeRef, brief.workspace, verifierReceiptId, {
        code: "LANDING_BASELINE_MISSING",
        detail: "no baseline was recorded when this node was staffed, so its changes cannot be told apart",
      });
    }
    const observed = await config.git.observe(brief.workspace);
    if (!observed.ok) {
      if (observed.code === "NOT_A_REPOSITORY") {
        return refuse(nodeRef, brief.workspace, verifierReceiptId, {
          code: observed.code, detail: observed.detail,
        });
      }
      // A git failure that is not structural is reported, not recorded: the next pass retries.
      return { detail: observed.detail, nodeRef, outcome: observed.code };
    }
    const untracked = new Set(observed.observation.untracked ?? []);
    const first = readEarliestLandingBaseline(config.store, config.projectId, nodeRef) ?? before;
    const earlier = earlierAttemptPaths(
      first.entries, before.entries, observed.observation.entries, untracked,
    );
    const delivered = [...deliveredPaths(before.entries, observed.observation.entries), ...earlier];
    if (delivered.length === 0) {
      return refuse(nodeRef, brief.workspace, verifierReceiptId, {
        code: "NOTHING_TO_COMMIT", detail: "no path in the workspace differs from the staffing baseline",
      });
    }
    // Untracked modules the delivered code imports ride the same commit — see landing-imports.ts.
    // The verifier ran with them present, so the state it accepted is the state HEAD gets.
    const { root } = observed.observation;
    const carried = untrackedImports(delivered, untracked, (path) => readText(root, path));
    const paths = [...delivered, ...carried];
    const message = landingMessage(brief, nodeRef, verifierReceiptId);
    const checked = await checkLandingVerification({
      brief, nodeRef, port: config.verifiedWorkspace, projectId: config.projectId,
      readBinding: config.readVerifiedBinding, receiptId: verifierReceiptId, store: config.store,
    });
    if (!checked.ok) return refuse(nodeRef, brief.workspace, verifierReceiptId, { code: checked.code, detail: checked.detail });
    const committed = await checked.port.commit(brief.workspace, paths, message, checked.binding);
    if (!committed.ok) {
      // Only the strict port's no-effect refusal permits retry. Error prose cannot prove
      // whether a commit or ref update happened before the failure.
      if (committed.code === "VERIFIED_WORKSPACE_INDEX_LOCKED") {
        return { detail: committed.detail, nodeRef, outcome: "GIT_INDEX_LOCKED" };
      }
      return refuse(nodeRef, brief.workspace, verifierReceiptId, {
        code: committed.code, detail: committed.detail,
      });
    }
    const recorded = recordLandingReceipt(config.store, {
      commit: {
        branch: committed.receipt.branch, files: paths, message,
        parentSha: committed.receipt.parentSha, sha: committed.receipt.sha,
      },
      decidedAt: clock(),
      projectId: config.projectId,
      refusal: null,
      subjectRef: nodeRef,
      verifierReceiptId,
      workspace: brief.workspace,
    });
    if (!recorded.ok) return { detail: recorded.code, nodeRef, outcome: recorded.code };
    const imports = carried.length === 0 ? "" : `, ${String(carried.length)} imported untracked file(s) carried`;
    const attempts = earlier.length === 0 ? "" : `, ${String(earlier.length)} from an earlier attempt`;
    return {
      detail: `${committed.receipt.sha.slice(0, 10)} on ${committed.receipt.branch}, ${String(paths.length)} file(s)${imports}${attempts}`,
      nodeRef,
      outcome: "COMMITTED",
    };
  };

  /** Land every accepted node that has no landing receipt yet. Silent for the rest. */
  const landOnce = async (): Promise<readonly LanderReport[]> => {
    const reports: LanderReport[] = [];
    for (const { nodeRef } of config.nodes()) {
      const accepted = readAccepted(nodeRef);
      if (accepted === null) continue;
      const report = await landOne(nodeRef, accepted.verifierReceiptId);
      if (report !== null) reports.push(report);
    }
    return reports;
  };

  return Object.freeze({ baseline, landOnce });
}
