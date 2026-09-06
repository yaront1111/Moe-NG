import type { SqliteEventStore } from "@moe/store";
import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { productionDeployPorts } from "../deployment/deploy-command.js";
import { readDeployLedger } from "../deployment/deploy-ledger.js";
import { ENVIRONMENT_NAMES } from "../environment/environment-contracts.js";
import { readPublishLedger } from "../repository/publish-ledger.js";
import { readReleaseReceipt } from "../release/release-receipt-ledger.js";
import { releaseReceiptId } from "../release/release-receipt-contracts.js";
import { record } from "./affordance-planning-offers.js";
import { readRunGoalPublication } from "./run-goal-publication.js";

export interface DeploymentEnvironmentRead {
  readonly environment: string;
  readonly target: string | null;
  readonly url: string | null;
  readonly outcome: "DEPLOYED" | "REFUSED" | null;
  readonly sha: string | null;
  readonly time: string | null;
  readonly code: string | null;
  readonly detail: string | null;
  readonly releaseDecision: string | null;
}
export type GoalDeploymentRead = Readonly<{ outcome: "DEPLOYMENTS"; goalRef: string;
  sha: string | null; releaseDecision: string | null; environments: readonly DeploymentEnvironmentRead[] }>
  | Readonly<{ outcome: "REFUSED"; code: string; layer: string }>;

/** Host targets and environment receipts are project facts; the deployable SHA belongs to this goal. */
export function readGoalDeployments(store: SqliteEventStore, projectId: string, goalRef: string): GoalDeploymentRead {
  const refused = (code: string): GoalDeploymentRead => ({ outcome: "REFUSED", code, layer: "REPOSITORY_WORKFLOW_READ" });
  try {
    const goal = record(stateOf(readDurableLedger(store, projectId), goalRef));
    if (goal?.["goalId"] !== goalRef || goal["projectId"] !== projectId) return refused("DEPLOYMENTS_GOAL_UNBOUND");
    const publication = readRunGoalPublication(store, projectId, readPublishLedger(store, projectId).get(goalRef));
    const sha = publication?.outcome === "PUSHED" ? publication.sha : null;
    const release = sha === null ? null : readReleaseReceipt(store, projectId,
      releaseReceiptId(projectId, goalRef, sha, "RELEASED", null));
    if (release !== null && !release.ok && release.code !== "RELEASE_RECEIPT_NOT_FOUND") return refused(release.code);
    const deployments = readDeployLedger(store, projectId);
    const targets = productionDeployPorts(store, projectId).target;
    return { outcome: "DEPLOYMENTS", goalRef, sha,
      releaseDecision: release?.ok === true ? release.receipt.receiptId : null,
      environments: ENVIRONMENT_NAMES.map((environment) => {
        const target = targets(environment); const receipt = deployments.get(environment)?.current;
        return { environment, target: target === null ? null : target.sshTarget ?? `local Docker (${target.network})`,
          url: receipt?.url ?? target?.url ?? null, outcome: receipt?.outcome ?? null,
          sha: receipt?.sha ?? null, time: receipt?.decidedAt ?? null,
          code: receipt?.refusal?.code ?? null, detail: receipt?.refusal?.detail ?? null,
          releaseDecision: receipt?.releaseDecision ?? null };
      }),
    };
  } catch { return refused("DEPLOYMENTS_READ_UNREADABLE"); }
}
