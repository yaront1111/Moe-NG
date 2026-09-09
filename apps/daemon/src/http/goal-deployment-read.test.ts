import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { closeStores, driveThrough, envelope, GOAL_ID, openStore, PROJECT_ID, send } from "../bootstrap/bootstrap-test-fixtures.js";
import { DEPLOY_BUILD_CONTEXT_ENV_KEY } from "../deployment/deploy-command.js";
import { recordDeployReceipt } from "../deployment/deploy-ledger.js";
import { MigrationExecutionError } from "../repository/migrations/migration-ports.js";
import type { MigrationPorts } from "../repository/migrations/migration-ports.js";
import { migrateWithBackup } from "../repository/migrations/migration-service.js";
import { readPublishLedger, recordPublishReceipt } from "../repository/publish-ledger.js";
import { recordReleaseReceipt } from "../release/release-receipt-ledger.js";
import { readGoalDeployments } from "./goal-deployment-read.js";

afterEach(closeStores);
const NOW = "2026-09-06T12:00:00.000Z";
it("joins a goal's published SHA and release to durable environment targets and receipts", () => {
  const store = openStore(); driveThrough(store, "goal.close");
  const publication = readPublishLedger(store, PROJECT_ID).get(GOAL_ID)!.requests.at(-1)!;
  const sha = "a".repeat(40);
  expect(recordPublishReceipt(store, { projectId: PROJECT_ID, goalId: GOAL_ID, decisionId: publication.decisionId,
    decidedAt: NOW, branch: "main", remoteUrl: publication.remoteUrl, refusal: null, sha, url: null }).ok).toBe(true);
  expect(send(store, envelope("deployment.set_target", 0, { environment: "preview", network: "moe-read",
    sshTarget: null, url: "https://preview.example.test" })).ok).toBe(true);
  expect(recordDeployReceipt(store, { projectId: PROJECT_ID, environment: "preview", decisionId: "earlier-deploy",
    decidedAt: NOW, imageDigest: `sha256:${"c".repeat(64)}`, refusal: null, releaseDecision: null,
    sha: "b".repeat(40), url: "https://preview.example.test" }).ok).toBe(true);
  const release = recordReleaseReceipt(store, { projectId: PROJECT_ID, goalId: GOAL_ID, sha,
    decidedAt: NOW, dossierSha256: "d".repeat(64), outcome: "RELEASED", refusalCode: null,
    prUrl: "https://github.com/example/product/pull/1" });
  if (!release.ok) throw new Error(release.code);
  const answer = readGoalDeployments(store, PROJECT_ID, GOAL_ID);
  expect(answer).toMatchObject({ outcome: "DEPLOYMENTS", goalRef: GOAL_ID, sha,
    releaseDecision: release.receipt.receiptId });
  if (answer.outcome !== "DEPLOYMENTS") throw new Error(answer.code);
  expect(answer.environments.find((row) => row.environment === "preview")).toMatchObject({
    target: "local Docker (moe-read)", outcome: "DEPLOYED", sha: "b".repeat(40), time: NOW,
  });
  expect(answer.environments.find((row) => row.environment === "production")).toMatchObject({
    target: null, outcome: null, sha: null,
  });
});

it("refuses foreign goals and does not call a queued publication a deployed SHA", () => {
  const store = openStore(); driveThrough(store, "goal.close");
  expect(readGoalDeployments(store, PROJECT_ID, "another-goal")).toMatchObject({ outcome: "REFUSED", code: "DEPLOYMENTS_GOAL_UNBOUND" });
  expect(readGoalDeployments(store, "another-project", GOAL_ID)).toMatchObject({ outcome: "REFUSED", code: "DEPLOYMENTS_GOAL_UNBOUND" });
  expect(readGoalDeployments(store, PROJECT_ID, GOAL_ID)).toMatchObject({ outcome: "DEPLOYMENTS", sha: null, releaseDecision: null });
});

/**
 * THE MIGRATION OBSERVATION ON THE ENVIRONMENT ROW, over receipts written by the PRODUCTION
 * engine and joined by the deploy receipt's own `decisionId`. The exact safe shape is pinned so a
 * later field cannot widen the served surface unnoticed.
 */
describe("migration observations on the deployment read", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const BATCH = ["1700000000001-first.js"];
  const DATABASE_URL = "postgresql://admin:hunter2@db.internal:5432/product";
  const UNKNOWN_KEYS = ["backupSha256", "backupState", "environment", "migrations", "outcome",
    "receiptId", "refusalCode", "refusalFile", "refusalLayer", "state", "subject", "unknownCode",
    "unknownLayer"];

  function seeded() {
    const projectRoot = mkdtempSync(join(tmpdir(), "moe-deployment-migration-")); roots.push(projectRoot);
    const store = openStore(); driveThrough(store, "goal.close");
    const migrate = (requestId: string, environment: string, hour: number, ports: Partial<MigrationPorts>) =>
      migrateWithBackup(store, { projectRoot, workspace: projectRoot, projectId: PROJECT_ID, requestId,
        environment, sha: "a".repeat(40), databaseUrl: DATABASE_URL, now: new Date(`2026-09-06T0${hour}:00:00.000Z`) },
      { dump: async (_connection, path) => { writeFileSync(path, "fixture backup"); },
        apply: async () => BATCH, ...ports });
    const deploy = (environment: string, decisionId: string) => {
      const result = recordDeployReceipt(store, { projectId: PROJECT_ID, environment, decisionId,
        decidedAt: NOW, imageDigest: `sha256:${"c".repeat(64)}`, refusal: null, releaseDecision: null,
        sha: "b".repeat(40), url: null });
      if (!result.ok) throw new Error(result.code);
    };
    const rowFor = (environment: string) => {
      const answer = readGoalDeployments(store, PROJECT_ID, GOAL_ID);
      if (answer.outcome !== "DEPLOYMENTS") throw new Error(answer.code);
      const row = answer.environments.find((entry) => entry.environment === environment);
      if (row === undefined) throw new Error(`no row for ${environment}`);
      return { row, answer };
    };
    return { projectRoot, store, migrate, deploy, rowFor };
  }

  it("carries an APPLIED receipt as a bounded PROJECT/ENVIRONMENT observation", async () => {
    const w = seeded();
    process.env[DEPLOY_BUILD_CONTEXT_ENV_KEY] = w.projectRoot;
    try {
      const applied = await w.migrate("deploy-1", "preview", 1, {});
      w.deploy("preview", "deploy-1");
      const { row } = w.rowFor("preview");
      expect(row.migration).toEqual({ subject: "PROJECT_ENVIRONMENT", environment: "preview",
        state: "OBSERVED", receiptId: applied.receiptId, outcome: "APPLIED", migrations: BATCH,
        backupState: "VERIFIED", backupSha256: applied.backupRef!.split("@sha256:")[1],
        refusalCode: null, refusalLayer: null, refusalFile: null, unknownCode: null, unknownLayer: null });
    } finally { delete process.env[DEPLOY_BUILD_CONTEXT_ENV_KEY]; }
  });

  it("carries a REFUSED receipt with its code, its layer, the failing basename and no backup", async () => {
    const w = seeded();
    await w.migrate("deploy-1", "preview", 1, {
      apply: async () => { throw new MigrationExecutionError("1700000000009-broken.js"); },
    });
    w.deploy("preview", "deploy-1");
    const { row } = w.rowFor("preview");
    expect(row.migration).toMatchObject({ state: "OBSERVED", outcome: "REFUSED",
      refusalCode: "MIGRATION_FAILED", refusalLayer: "DAEMON_INGRESS",
      refusalFile: "1700000000009-broken.js", migrations: [] });
    // No build context is exported here, so the backup cannot be confined and its hash is withheld
    // rather than served as an existing backup.
    expect(row.migration).toMatchObject({ backupState: "UNVERIFIED", backupSha256: null });
  });

  it("reads UNKNOWN for an environment with no migration, distinct from a known-none list", async () => {
    const w = seeded();
    w.deploy("preview", "deploy-1");
    const { row, answer } = w.rowFor("preview");
    expect(row.migration).toEqual({ subject: "PROJECT_ENVIRONMENT", environment: "preview",
      state: "UNKNOWN", receiptId: null, outcome: null, migrations: null, backupState: null,
      backupSha256: null, refusalCode: null, refusalLayer: null, refusalFile: null,
      unknownCode: "MIGRATION_RECEIPT_ABSENT", unknownLayer: "DAEMON_INGRESS" });
    // Every environment carries the member, including ones that never deployed at all.
    for (const entry of answer.environments) {
      expect(Object.keys(entry.migration).toSorted()).toEqual(UNKNOWN_KEYS);
      expect(entry.migration.environment).toBe(entry.environment);
    }
    const none = await w.migrate("deploy-2", "production", 2, { apply: async () => [] });
    expect(none.outcome).toBe("APPLIED");
    w.deploy("production", "deploy-2");
    expect(w.rowFor("production").row.migration.migrations).toEqual([]);
    expect(w.rowFor("preview").row.migration.migrations).toBeNull();
  });

  it("serves no database URL, credential, SQL or untrusted path anywhere in the frame", async () => {
    const w = seeded();
    process.env[DEPLOY_BUILD_CONTEXT_ENV_KEY] = w.projectRoot;
    try {
      const applied = await w.migrate("deploy-1", "preview", 1, {});
      w.deploy("preview", "deploy-1");
      const backupPath = applied.backupRef!.split("@sha256:")[0]!;
      const { answer } = w.rowFor("preview");
      const served = JSON.stringify(answer);
      // POSITIVE CONTROL: both needles are genuinely in the durable receipt, so their absence
      // below is a bound holding rather than a value that was never there.
      expect(JSON.stringify(applied)).toContain(JSON.stringify(backupPath).slice(1, -1));
      expect(DATABASE_URL).toContain("hunter2");
      for (const needle of ["hunter2", DATABASE_URL, "postgresql://", "CREATE TABLE", ".sql",
        JSON.stringify(backupPath).slice(1, -1), JSON.stringify(w.projectRoot).slice(1, -1)]) {
        expect(served).not.toContain(needle);
      }
    } finally { delete process.env[DEPLOY_BUILD_CONTEXT_ENV_KEY]; }
  });
});
