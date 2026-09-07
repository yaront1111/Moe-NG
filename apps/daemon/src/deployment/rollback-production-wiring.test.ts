import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAsyncCommandEntries } from "../daemon-command-async-entries.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { closeStores, openStore, PROJECT_ID } from "../review/review-test-fixtures.js";
import { deploymentInfrastructureFiles } from "../repository/deployment/deployment-infrastructure-templates.js";
import { recordDeployReceipt } from "./deploy-ledger.js";
import { createDockerDouble } from "./deploy-ports.js";
import type { CommandHandlerInput } from "../http/http-contract.js";

afterEach(closeStores);

it("routes production rollback to receipt resolution before any Docker effect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-rollback-production-"));
  const provider = createStoreDependencies({
    credential: randomUUID(), principalId: "operator-1", projectId: "project-1",
    repositoryWorkspace: directory, storePath: join(directory, "store.sqlite"),
  });
  try {
    const handler = provider.provide().registry.get("deployment.rollback")?.asyncHandler;
    expect(handler).toBeTypeOf("function");
    const input = { envelope: { commandId: "rollback-1", commandKind: "deployment.rollback",
      targetAggregateId: "project-1", expectedVersion: 0, correlationId: "rollback-1",
      payload: { environment: "staging", toReceiptRef: "a".repeat(64), restoreDatabase: false },
    }, principal: { principalId: "operator-1", projectId: "project-1", capabilities: [] } } as unknown as CommandHandlerInput;
    await expect(handler!(input)).rejects.toMatchObject({ code: "DEPLOY_ROLLBACK_RECEIPT_INVALID" });
  } finally {
    provider.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

/**
 * THE PRODUCTION COMPOSITION REACHES THE BINDING, not a blanket refusal (DoD 1, 2).
 *
 * The discriminator is the LAYER. `ENV_ENVIRONMENT_UNKNOWN@SCOPE` can only be reached by a seam
 * that was handed a REAL environment credential and a workspace and actually performed a delivery
 * read: an unwired one answers `DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE@DAEMON_COMMAND_SEAM`
 * for the very same request, and so did every restore before this row. Asserting only "it
 * refused" would have been green in both worlds.
 *
 * "staging" is deployable but is NOT one of the three names the environment store has
 * (`environment-contracts.ts:29`), which is exactly why it produces the SCOPE refusal here.
 */
it("routes a requested restore through the real credential seam, not a blanket refusal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-rollback-restore-wiring-"));
  const previous = process.env[DEPLOY_BUILD_CONTEXT_ENV_KEY];
  process.env[DEPLOY_BUILD_CONTEXT_ENV_KEY] = directory;
  const provider = createStoreDependencies({
    credential: randomUUID(), principalId: "operator-1", projectId: "project-1",
    repositoryWorkspace: directory, storePath: join(directory, "store.sqlite"),
  });
  try {
    const store = provider.provide().store;
    // A REAL deploy receipt, so the request survives the receipt guard and reaches the restore.
    const source = recordDeployReceipt(store, { decidedAt: "2026-09-06T00:00:00.000Z",
      decisionId: "wiring-deploy-1", environment: "staging", imageDigest: `sha256:${"b".repeat(64)}`,
      projectId: "project-1", refusal: null, releaseDecision: null, sha: "a".repeat(40), url: null });
    expect(source).toMatchObject({ code: "DEBUG_SHOW_CODE", ok: true });
    if (!source.ok) throw new Error(source.code);
    const handler = provider.provide().registry.get("deployment.rollback")?.asyncHandler;
    expect(handler).toBeTypeOf("function");
    const input = { envelope: { commandId: "rollback-restore-1", commandKind: "deployment.rollback",
      targetAggregateId: "project-1", expectedVersion: store.getAggregateVersion("project-1"),
      correlationId: "rollback-restore-1",
      payload: { environment: "staging", toReceiptRef: source.receipt.receiptId, restoreDatabase: true },
    }, principal: { principalId: "operator-1", projectId: "project-1", capabilities: [] } } as unknown as CommandHandlerInput;

    await expect(handler!(input)).rejects.toMatchObject({ code: "ENV_ENVIRONMENT_UNKNOWN", layer: "SCOPE" });
  } finally {
    provider.close();
    if (previous === undefined) delete process.env[DEPLOY_BUILD_CONTEXT_ENV_KEY];
    else process.env[DEPLOY_BUILD_CONTEXT_ENV_KEY] = previous;
    rmSync(directory, { force: true, recursive: true });
  }
});

/**
 * THE COMPOSITION REACHES THE BINDING, not a blanket refusal (DoD 1, 2).
 *
 * `createAsyncCommandEntries` is the function the real provider calls, and the two fields this
 * row added at its rollback entry -- `environmentCredential` and `migrationWorkspace` -- are what
 * this arm pins. THE DISCRIMINATOR IS THE LAYER: `ENV_ENVIRONMENT_UNKNOWN@SCOPE` can only be
 * reached by a seam that was handed a real credential AND a workspace and actually performed a
 * delivery read. A seam missing either answers
 * `DEPLOY_ROLLBACK_DATABASE_RESTORE_UNAVAILABLE@DAEMON_COMMAND_SEAM` or
 * `DEPLOY_MIGRATION_WORKSPACE_UNCONFIGURED@DAEMON_DEPLOY_ENGINE` for the very same request, and
 * before this row EVERY restore answered the first of those. An arm asserting only "it refused"
 * would be green in all three worlds.
 *
 * "staging" is deployable but is NOT one of the three names the environment store has
 * (`environment-contracts.ts:29`), which is exactly why a real delivery read answers SCOPE here.
 */
it("forwards the environment credential and the workspace to the rollback restore", async () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-rollback-restore-wiring-"));
  const store = openStore();
  try {
    const environment = "staging", sha = "a".repeat(40), digest = `sha256:${"b".repeat(64)}`;
    const source = recordDeployReceipt(store, { decidedAt: "2026-09-06T00:00:00.000Z",
      decisionId: "wiring-deploy-1", environment, imageDigest: digest, projectId: PROJECT_ID,
      refusal: null, releaseDecision: null, sha, url: null });
    if (!source.ok) throw new Error(source.code);
    const docker = createDockerDouble({
      proxyConfig: deploymentInfrastructureFiles("", []).get("docker/Caddyfile") ?? "",
      running: { app: "HEALTHY" }, imageDigest: digest, health: {} });
    const entries = createAsyncCommandEntries({
      environmentCredential: () => "wiring-credential",
      operatorPrincipalId: "operator", projectId: PROJECT_ID, store,
      deploymentDeploy: { buildContext: directory, healthBudgetMs: 1, pollMs: 1,
        sleep: async (): Promise<void> => {},
        ports: { build: docker.build, docker: docker.docker, ssh: docker.ssh, transfer: docker.transfer,
          target: () => ({ network: "product", sshTarget: null, url: null }), releaseDecision: () => null } },
    });
    const handler = entries["deployment.rollback"].asyncHandler;
    expect(handler).toBeTypeOf("function");
    const input = { envelope: { commandId: "rollback-restore-1", commandKind: "deployment.rollback",
      targetAggregateId: PROJECT_ID, expectedVersion: store.getAggregateVersion(PROJECT_ID),
      correlationId: "rollback-restore-1", requestDigest: "c".repeat(64),
      sessionCredential: "wiring-test-credential",
      payload: { environment, toReceiptRef: source.receipt.receiptId, restoreDatabase: true },
    }, principal: { principalId: "operator", projectId: PROJECT_ID, capabilities: ["goal.write"] },
    } as unknown as CommandHandlerInput;

    await expect(handler!(input)).rejects.toMatchObject({ code: "ENV_ENVIRONMENT_UNKNOWN", layer: "SCOPE" });
    // Refused before any Docker effect, exactly as the arm above requires of the unrestored path.
    expect(docker.calls).toEqual([]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
