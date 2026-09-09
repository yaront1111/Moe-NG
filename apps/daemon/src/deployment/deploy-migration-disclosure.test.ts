import { afterEach, describe, expect, it } from "vitest";

import { closeStores, openStore, PROJECT_ID } from "../review/review-test-fixtures.js";
import { deploymentInfrastructureFiles }
  from "../repository/deployment/deployment-infrastructure-templates.js";
import { CONTROLLED_PROFILE_VERSION }
  from "../repository/controlled-profile/controlled-profile-generator.js";
import { DEPLOY_BUILD_FAILED, DEPLOY_ENGINE_STAMP, deployAggregateId } from "./deploy-receipt-contracts.js";
import { createDockerDouble } from "./deploy-ports.js";
import type { DeployMigrationPort, DeployTarget } from "./deploy-ports.js";
import { readDeployLedger } from "./deploy-ledger.js";
import { buildArgv, candidateContainerName, createDeployService } from "./deploy-service.js";

/**
 * WHAT AN OPERATOR CAN READ OFF THE DEPLOY RECEIPT, which is this row's actual promise.
 *
 * The migration receipt is never declassified; the DEPLOY receipt is. So a correct migration
 * refusal does NOT imply a legible deploy receipt — they are two different records and only one
 * passes through `declassifyRefusal`. These arms drive the production deploy service and read the
 * DURABLE ledger, not the object handed back, because a marker on a returned object proves
 * nothing about what landed.
 *
 * THE DISTINCTION UNDER TEST: "your workspace was never installed" must be tellable from "your
 * migration file is broken" with no debugger and no free text. It is carried by the CODE, so the
 * tool-missing composite survives verbatim while the file failure reads `[REDACTED]` — and the
 * filename must not appear anywhere in the deploy receipt's bytes.
 *
 * Its own file rather than deploy-refusal-redaction.test.ts, which is already past the line cap.
 */

afterEach(closeStores);

const REDACTED = "[REDACTED]";
const ENVIRONMENT = "production";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const DECIDED_AT = "2026-09-08T00:00:00.000Z";
const CONTEXT = "/workspace/app";
const INCUMBENT = "app";
const BROKEN_FILE = "1700000000009-broken.js";
const TOOL_MISSING = "MIGRATION_TOOL_MISSING";
const TOOL_MISSING_DETAIL = "MIGRATION_TOOL_MISSING@DAEMON_INGRESS: MIGRATION_TOOL_MISSING";
const PROXY_CONFIG =
  deploymentInfrastructureFiles(CONTROLLED_PROFILE_VERSION, []).get("docker/Caddyfile") ?? "";
const LOCAL: DeployTarget = { network: "moe-net", sshTarget: null, url: "https://app.example.test" };

/** Every byte the deploy actually wrote: decision results and both halves of every event. */
function durableBytes(store: ReturnType<typeof openStore>): readonly Uint8Array[] {
  const decisions = store.readCommandDecisionsAfter(0n, 500).items.map((one) => one.resultBytes);
  const events = store.readEvents(deployAggregateId(PROJECT_ID, ENVIRONMENT))
    .flatMap((event) => [event.payload, event.metadata]);
  return [...decisions, ...events];
}

function deployWith(store: ReturnType<typeof openStore>, migrate: DeployMigrationPort) {
  const decisionId = "decision-1";
  const candidate = candidateContainerName(ENVIRONMENT, SHA, decisionId);
  const docker = createDockerDouble({
    proxyConfig: PROXY_CONFIG, health: { [candidate]: ["HEALTHY"] }, running: { [INCUMBENT]: "HEALTHY" },
  });
  const deployer = createDeployService({
    clock: () => DECIDED_AT, healthBudgetMs: 10, pollMs: 1, sleep: () => Promise.resolve(),
    ports: {
      build: (request) => docker.docker(buildArgv(request.tag)), docker: docker.docker, migrate,
      releaseDecision: () => null, ssh: docker.ssh, target: () => LOCAL, transfer: docker.transfer,
    },
    projectId: PROJECT_ID, store,
  });
  return deployer.deploy({ context: CONTEXT, decisionId, environment: ENVIRONMENT, sha: SHA });
}

const refusing = (code: string, detail: string): DeployMigrationPort => () =>
  Promise.resolve({ code, detail, layer: "DAEMON_INGRESS", ok: false });

describe("an operator can tell an uninstalled workspace from a broken migration file", () => {
  it("keeps the tool-missing code verbatim on the durable deploy receipt", async () => {
    const store = openStore();

    const report = await deployWith(store, refusing(TOOL_MISSING, TOOL_MISSING));

    expect(report.outcome).toBe("REFUSED");
    // The deploy engine still stamps its OWN code and layer — the migration's answer rides in the
    // detail, which is exactly the field redaction eats. That is why this arm exists.
    const current = readDeployLedger(store, PROJECT_ID).get(ENVIRONMENT)?.current;
    expect(current?.refusal?.code).toBe(DEPLOY_BUILD_FAILED);
    expect(current?.refusal?.layer).toBe(DEPLOY_ENGINE_STAMP);
    expect(current?.refusal?.detail).toBe(TOOL_MISSING_DETAIL);
    expect(current?.refusal?.detail).not.toBe(REDACTED);
  });

  it("redacts the file failure and keeps the filename out of every durable byte", async () => {
    const store = openStore();

    const report = await deployWith(store, refusing("MIGRATION_FAILED", BROKEN_FILE));

    expect(report.outcome).toBe("REFUSED");
    const current = readDeployLedger(store, PROJECT_ID).get(ENVIRONMENT)?.current;
    expect(current?.refusal?.code).toBe(DEPLOY_BUILD_FAILED);
    expect(current?.refusal?.detail).toBe(REDACTED);
    for (const bytes of durableBytes(store)) {
      expect(Buffer.from(bytes).includes(Buffer.from(BROKEN_FILE, "utf8"))).toBe(false);
    }
    expect(report.detail.includes(BROKEN_FILE)).toBe(false);
  });

  it("does not admit the tool-missing code with a filename tail", async () => {
    // The half that proves the allowlist did not become a blanket on this code and layer.
    const store = openStore();

    await deployWith(store, refusing(TOOL_MISSING, BROKEN_FILE));

    const current = readDeployLedger(store, PROJECT_ID).get(ENVIRONMENT)?.current;
    expect(current?.refusal?.detail).toBe(REDACTED);
    for (const bytes of durableBytes(store)) {
      expect(Buffer.from(bytes).includes(Buffer.from(BROKEN_FILE, "utf8"))).toBe(false);
    }
  });

  it("makes the two conditions different strings on the receipt, not merely both refusals", async () => {
    // The defect this row closes was two causes collapsing into ONE answer. Asserting each arm
    // "refused" would have stayed green through it, so the inequality is the load-bearing claim.
    const tool = openStore();
    const file = openStore();

    await deployWith(tool, refusing(TOOL_MISSING, TOOL_MISSING));
    await deployWith(file, refusing("MIGRATION_FAILED", BROKEN_FILE));

    const toolDetail = readDeployLedger(tool, PROJECT_ID).get(ENVIRONMENT)?.current?.refusal?.detail;
    const fileDetail = readDeployLedger(file, PROJECT_ID).get(ENVIRONMENT)?.current?.refusal?.detail;
    expect(toolDetail).toBe(TOOL_MISSING_DETAIL);
    expect(fileDetail).toBe(REDACTED);
    expect(toolDetail === fileDetail).toBe(false);
  });
});
