import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  closeStores, driveThrough, openStore, PROJECT_ID,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { createAsyncCommandEntries } from "../daemon-command-async-entries.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import type { AuthenticatedPrincipal } from "../http/http-contract.js";
import { CONTROLLED_PROFILE_VERSION }
  from "../repository/controlled-profile/controlled-profile-generator.js";
import { deploymentInfrastructureFiles }
  from "../repository/deployment/deployment-infrastructure-templates.js";
import { readDeployLedger, readPreviousDeployReceipt } from "./deploy-ledger.js";
import { createDockerDouble } from "./deploy-ports.js";
import type { DockerDouble, DockerDoubleOptions, DeployTarget } from "./deploy-ports.js";
import {
  DEPLOY_BUILD_FAILED, DEPLOY_DOCKER_UNAVAILABLE, DEPLOY_ENGINE_STAMP, DEPLOY_HEALTH_TIMEOUT,
  DEPLOY_RECEIPT_VERSION, DEPLOY_TARGET_MISSING, deployImageTag, deployReceiptId,
} from "./deploy-receipt-contracts.js";
import { NO_RELEASE_DECISION_NOTE, candidateContainerName } from "./deploy-service.js";
import { DEPLOYMENT_DEPLOY_COMMAND_KIND } from "./deploy-target-contracts.js";

/**
 * `deployment.deploy` END TO END THROUGH THE REGISTERED COMMAND, not through the engine.
 *
 * The engine's own suite (deploy-service.test.ts) already proves the argv, the flip and the
 * refusals in isolation. What this file proves is that those behaviours SURVIVE THE WIRING: the
 * async entry, the operator fence, the admit-first gate against a durable ledger, and the
 * receipt a caller can read back afterwards — in one pass against a real store.
 *
 * NO NETWORK, NO DOCKER DAEMON, NO CHILD PROCESS in any arm: every port is the state-machine
 * double production ships beside the engine, and the health poll runs in poll COUNTS rather than
 * wall clock. Store handles come from the shared bootstrap fixture and are released by
 * `afterEach(closeStores)`, which vitest also runs when an arm throws.
 *
 * THE TARGET IS AN INJECTED PORT, never a hand-written durable row: `deployment.set_target`'s
 * durable shape belongs to a sibling row that has not landed, and asserting against a shape its
 * owner has not shipped would pin something nothing serves. `DeployTargetPort` is production's
 * own seam (deploy-ports.ts), so injecting it tests the wiring that exists today.
 */

afterEach(closeStores);

const OPERATOR = "principal-1";
const PRODUCTION = "production";
const STAGING = "staging";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const NEXT_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const CONTEXT = "/workspace/product";
const INCUMBENT = "app";
const DECIDED_AT = "2026-09-06T00:00:00.000Z";
const PROXY_CONFIG =
  deploymentInfrastructureFiles(CONTROLLED_PROFILE_VERSION, []).get("docker/Caddyfile") ?? "";
const LOCAL: DeployTarget = { network: "moe-net", sshTarget: null, url: "https://app.example.test" };

interface Journey {
  readonly candidateFor: (commandId: string, sha?: string) => string;
  readonly docker: DockerDouble;
  deploy(input?: {
    readonly commandId?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly principalId?: string;
  }): Promise<unknown>;
  readonly store: SqliteEventStore;
}

function principal(principalId: string): AuthenticatedPrincipal {
  return { capabilities: ["goal.write"], principalId, projectId: PROJECT_ID };
}

/**
 * One deploy through the registered kind. The candidate reports `starting` once and then
 * `healthy`, so the poll loop genuinely runs; a caller that wants the timeout passes
 * `health` itself.
 */
function journey(options: {
  readonly commandId?: string;
  readonly double?: DockerDoubleOptions;
  readonly environment?: string;
  readonly release?: string | null;
  readonly sha?: string;
  readonly target?: DeployTarget | null;
} = {}): Journey {
  const environment = options.environment ?? STAGING;
  const sha = options.sha ?? SHA;
  const commandId = options.commandId ?? "cmd-deploy-journey";
  const candidateFor = (id: string, forSha: string = sha): string =>
    candidateContainerName(environment, forSha, id);
  const store = openStore();
  driveThrough(store, "goal.close");
  const docker = createDockerDouble({
    proxyConfig: PROXY_CONFIG,
    running: { [INCUMBENT]: "HEALTHY" },
    health: { [candidateFor(commandId)]: ["STARTING", "HEALTHY"] },
    ...options.double,
  });
  const entries = createAsyncCommandEntries({
    operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store,
    deploymentDeploy: {
      buildContext: CONTEXT, clock: (): string => DECIDED_AT,
      // Zero-cost time: the budget is exercised in poll COUNTS, never in wall clock.
      healthBudgetMs: 10, pollMs: 1, sleep: (): Promise<void> => Promise.resolve(),
      ports: {
        docker: docker.docker, releaseDecision: (): string | null => options.release ?? null,
        ssh: docker.ssh, transfer: docker.transfer,
        target: (): DeployTarget | null => (options.target === undefined ? LOCAL : options.target),
      },
    },
  });
  const handler = entries[DEPLOYMENT_DEPLOY_COMMAND_KIND].asyncHandler;
  return {
    candidateFor, docker, store,
    deploy: async (input = {}): Promise<unknown> => {
      if (handler === undefined) throw new Error("deployment.deploy carries no async handler");
      const envelope: RuntimeCommandEnvelope = {
        commandId: input.commandId ?? commandId,
        commandKind: DEPLOYMENT_DEPLOY_COMMAND_KIND,
        correlationId: "corr-deploy-journey",
        // READ from the store, never pinned: the seeded chain's project version is whatever the
        // fixture left, and a literal would start refusing CONFLICT as the fixture grows.
        expectedVersion: store.getAggregateVersion(PROJECT_ID),
        payload: (input.payload ?? { environment, sha }) as RuntimeCommandEnvelope["payload"],
        requestDigest: "d".repeat(64),
        schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
        sessionCredential: "deploy-journey-credential",
        targetAggregateId: PROJECT_ID,
      };
      return handler({ envelope, principal: principal(input.principalId ?? OPERATOR) });
    },
  };
}

/** The DETAIL the command durably committed, decoded from the store. Read rather than returned:
 *  a caller-composed string would prove only that the test can concatenate. */
function committedDetail(store: SqliteEventStore, commandId: string): string {
  const decision = store.getCommandDecision({ commandId, principalId: OPERATOR, projectId: PROJECT_ID });
  if (decision === null) throw new Error(`no committed decision for ${commandId}`);
  const result: unknown = JSON.parse(new TextDecoder().decode(decision.resultBytes));
  const detail = (result as { detail?: unknown }).detail;
  return typeof detail === "string" ? detail : JSON.stringify(result);
}

/** The refusal a throwing dispatch produced, or a failure naming what came back instead — so an
 *  arm cannot pass by swallowing a success it was supposed to refuse. */
async function refusalOf(promise: Promise<unknown>): Promise<DomainRefusal> {
  try {
    const answered = await promise;
    throw new Error(`expected a refusal, received ${JSON.stringify(answered)}`);
  } catch (error) {
    if (error instanceof DomainRefusal) return error;
    throw error;
  }
}

describe("the registered deploy builds the landed sha (DoD 3)", () => {
  it("tags the image with the sha VALUE through the wiring, and answers a durable decision",
    async () => {
      const context = journey();

      const decision = await context.deploy();

      // The sha VALUE, byte for byte. A `/[0-9a-f]{40}/` pattern passes for the WRONG sha, and
      // every rollback and dossier claim downstream resolves through this tag.
      expect(context.docker.calls.find((call) => call[0] === "build"))
        .toEqual(["build", "--tag", deployImageTag(STAGING, SHA), CONTEXT]);
      expect(context.docker.calls.find((call) => call[0] === "build")?.[2])
        .toBe(`moe-deploy-${STAGING}:${SHA}`);
      expect(decision).toMatchObject({ disposition: "DECIDED" });
    });

  it("REPLACES ATOMICALLY: something serves at every transition, and the candidate ends up live",
    async () => {
      const context = journey();

      await context.deploy();

      // ATOMICITY IS EXPRESSIBLE AT THIS HEAD: the shipped Caddyfile routes the public port
      // through a `reverse_proxy` directive the deploy rewrites and reloads, so the double can
      // answer "who was serving" at every step. Were the compose override still publishing the
      // host port straight off `app`, there would be no flip to observe and this arm could only
      // have asserted the candidate started.
      expect(PROXY_CONFIG).toMatch(/reverse_proxy\s+[\w.-]+:3000/u);
      expect(context.docker.transitions.length).toBeGreaterThan(5);
      for (const [index, transition] of context.docker.transitions.entries()) {
        // NO WINDOW IN WHICH NEITHER SERVES — the difference between a deploy and an outage.
        expect(transition.serving.length, `transition ${index}: ${transition.argv.join(" ")}`)
          .toBeGreaterThan(0);
      }
      expect(context.docker.serving()).toEqual([context.candidateFor("cmd-deploy-journey")]);
      // The incumbent is retired only AFTER the flip: it stopped, it was never removed mid-flight.
      expect(context.docker.state(INCUMBENT)).toBe("STOPPED");
    });
});

describe("the registered deploy refuses with code AND layer (DoD 4, 6)", () => {
  it("DEPLOY_HEALTH_TIMEOUT leaves the environment DEFINED, with the old container still serving",
    async () => {
      const context = journey({ double: { health: {} } });

      const refusal = await refusalOf(context.deploy());

      expect([refusal.code, refusal.layer]).toEqual([DEPLOY_HEALTH_TIMEOUT, DEPLOY_ENGINE_STAMP]);
      // READ FROM THE PORT'S FINAL STATE, not from the return value: a refusal that claimed a
      // defined environment while nothing served would pass an assertion on its own words.
      expect(context.docker.serving()).toEqual([INCUMBENT]);
      expect(context.docker.state(INCUMBENT)).toBe("HEALTHY");
      expect(context.docker.state(context.candidateFor("cmd-deploy-journey"))).toBe("REMOVED");
    });

  it("DEPLOY_TARGET_MISSING when no target is bound, before docker is asked anything",
    async () => {
      const context = journey({ target: null });

      const refusal = await refusalOf(context.deploy());

      expect([refusal.code, refusal.layer]).toEqual([DEPLOY_TARGET_MISSING, DEPLOY_ENGINE_STAMP]);
      expect(context.docker.calls).toEqual([]);
    });

  it("DEPLOY_DOCKER_UNAVAILABLE when docker does not answer at all", async () => {
    const context = journey({ double: { dockerUnavailable: true } });

    const refusal = await refusalOf(context.deploy());

    expect([refusal.code, refusal.layer])
      .toEqual([DEPLOY_DOCKER_UNAVAILABLE, DEPLOY_ENGINE_STAMP]);
  });

  it("carries docker's ACTUAL last stderr line into DEPLOY_BUILD_FAILED", async () => {
    const stderr = "Step 7/9 : RUN pnpm build\n#12 4.2 ERR_PNPM_NO_SCRIPT missing script: build";
    const context = journey({ double: { buildStderr: stderr } });

    const refusal = await refusalOf(context.deploy());

    expect([refusal.code, refusal.layer]).toEqual([DEPLOY_BUILD_FAILED, DEPLOY_ENGINE_STAMP]);
    // THE TOOL'S OWN WORDS. A generic message is undiagnosable from a receipt read weeks later,
    // and the LAST line is the one docker fails on.
    expect(refusal.detail)
      .toContain("#12 4.2 ERR_PNPM_NO_SCRIPT missing script: build");
  });
});

describe("the deploy receipt is durable and keeps its predecessor (DoD 5)", () => {
  it("records moe-deploy-receipt/1 with every member, readable from a real store", async () => {
    const context = journey();

    await context.deploy();

    const receipt = readDeployLedger(context.store, PROJECT_ID).get(STAGING)?.current;
    expect(receipt).toEqual({
      decidedAt: DECIDED_AT,
      decisionId: "cmd-deploy-journey",
      environment: STAGING,
      imageDigest: `sha256:${"a".repeat(64)}`,
      outcome: "DEPLOYED",
      projectId: PROJECT_ID,
      receiptId: deployReceiptId(PROJECT_ID, STAGING, "cmd-deploy-journey"),
      refusal: null,
      releaseDecision: null,
      sha: SHA,
      url: LOCAL.url,
      version: DEPLOY_RECEIPT_VERSION,
    });
  });

  it("keeps the PREVIOUS receipt retrievable across two successive deploys", async () => {
    const context = journey({ double: { health: {
      [candidateContainerName(STAGING, SHA, "cmd-deploy-one")]: ["STARTING", "HEALTHY"],
      [candidateContainerName(STAGING, NEXT_SHA, "cmd-deploy-two")]: ["STARTING", "HEALTHY"],
    } } });

    await context.deploy({ commandId: "cmd-deploy-one" });
    await context.deploy({
      commandId: "cmd-deploy-two", payload: { environment: STAGING, sha: NEXT_SHA },
    });

    // The rollback row resolves through exactly this pair and cannot depend on this one, so
    // BOTH receipts are asserted here rather than only the current.
    const previous = readPreviousDeployReceipt(context.store, PROJECT_ID, STAGING);
    expect([previous?.sha, previous?.decisionId]).toEqual([SHA, "cmd-deploy-one"]);
    expect(readDeployLedger(context.store, PROJECT_ID).get(STAGING)?.current.sha).toBe(NEXT_SHA);
    expect(readDeployLedger(context.store, PROJECT_ID).get(STAGING)?.receipts).toHaveLength(2);
  });
});

describe("a production deploy states its release standing (DoD 7)", () => {
  it("CITES the decision the port answers, and does not refuse for having one", async () => {
    const context = journey({
      environment: PRODUCTION, release: "release-decision-42",
      double: { health: {
        [candidateContainerName(PRODUCTION, SHA, "cmd-deploy-journey")]: ["STARTING", "HEALTHY"],
      } },
    });

    await context.deploy();

    const receipt = readDeployLedger(context.store, PROJECT_ID).get(PRODUCTION)?.current;
    expect([receipt?.outcome, receipt?.releaseDecision])
      .toEqual(["DEPLOYED", "release-decision-42"]);
    // THE WORDING, read off the DURABLE decision the command committed rather than off a
    // return value the caller could have composed: this is what a reader downstream sees.
    expect(committedDetail(context.store, "cmd-deploy-journey"))
      .toContain("cites release decision release-decision-42");
  });

  it("states 'no release decision' when the goal carries none, and does not refuse", async () => {
    const context = journey({
      environment: PRODUCTION, release: null,
      double: { health: {
        [candidateContainerName(PRODUCTION, SHA, "cmd-deploy-journey")]: ["STARTING", "HEALTHY"],
      } },
    });

    await context.deploy();

    const receipt = readDeployLedger(context.store, PROJECT_ID).get(PRODUCTION)?.current;
    // BOTH WORDINGS ASSERTED, here and above: the deploy neither invents an approval nor
    // refuses for the lack of one, and the absence is STATED rather than left to be inferred.
    expect([receipt?.outcome, receipt?.releaseDecision]).toEqual(["DEPLOYED", null]);
    expect(committedDetail(context.store, "cmd-deploy-journey"))
      .toContain(NO_RELEASE_DECISION_NOTE);
    // The literal the production constant carries, so the arm above cannot pass against a
    // renamed note that no longer says anything to an operator.
    expect(NO_RELEASE_DECISION_NOTE).toBe("no release decision");
  });
});
