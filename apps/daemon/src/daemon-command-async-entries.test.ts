import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { BOOTSTRAP_HANDLERS } from "./bootstrap/bootstrap-services.js";
import { closeStores, driveThrough, openStore, PROJECT_ID }
  from "./bootstrap/bootstrap-test-fixtures.js";
import { createAsyncCommandEntries } from "./daemon-command-async-entries.js";
import { PAYLOAD_KEYS } from "./daemon-command-vocabulary.js";
import { DomainRefusal } from "./daemon-command-dispatch.js";
import { DEPLOY_BUILD_CONTEXT_UNCONFIGURED } from "./deployment/deploy-command.js";
import { readDeployLedger } from "./deployment/deploy-ledger.js";
import { createDockerDouble } from "./deployment/deploy-ports.js";
import type { DockerDouble, DeployTarget } from "./deployment/deploy-ports.js";
import { deployImageTag } from "./deployment/deploy-receipt-contracts.js";
import { DEPLOYMENT_DEPLOY_COMMAND_KIND } from "./deployment/deploy-target-contracts.js";
import { GOAL_HANDLERS } from "./goals/goal-services.js";
import type { AuthenticatedPrincipal, CommandHandlerInput } from "./http/http-contract.js";
import { PLANNING_HANDLERS } from "./planning/planning-services.js";
import { deploymentInfrastructureFiles }
  from "./repository/deployment/deployment-infrastructure-templates.js";
import { CONTROLLED_PROFILE_VERSION }
  from "./repository/controlled-profile/controlled-profile-generator.js";
import { REPOSITORY_BOOTSTRAP_COMMAND_KIND }
  from "./repository/repository-bootstrap-contracts.js";

/**
 * THE ASYNC SEAM'S OWN CONTRACT. Until this file the module had no test: it was exercised only
 * incidentally through `foundation-registry.test.ts` and `mcp-dispatch-port.test.ts`, so nothing
 * asserted the thing that actually matters about it — that a kind registered here is served
 * ASYNCHRONOUSLY and is unreachable through the synchronous handler tables.
 *
 * OFFLINE IN EVERY ARM. `deployment.deploy`'s ports are the state-machine docker double shipped
 * beside the engine, so no arm touches a real docker daemon, spawns a child or reaches the
 * network. Every store handle is registered with the shared fixture and released by
 * `afterEach(closeStores)`, which vitest runs on the throwing path too.
 */

afterEach(closeStores);

const OPERATOR = "principal-1";
const AGENT = "agent-7";
const ENVIRONMENT = "staging";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const CONTEXT = "/workspace/product";
const INCUMBENT = "app";
const DECIDED_AT = "2026-09-06T00:00:00.000Z";
const PROXY_CONFIG =
  deploymentInfrastructureFiles(CONTROLLED_PROFILE_VERSION, []).get("docker/Caddyfile") ?? "";
const LOCAL: DeployTarget = { network: "moe-net", sshTarget: null, url: "https://staging.test" };

/** The candidate answers `starting` once and then `healthy`, so the engine's poll loop runs
 *  rather than short-circuiting on its first probe — with a zero-cost sleep. */
function deployDouble(candidatePrefix: string): DockerDouble {
  return createDockerDouble({
    proxyConfig: PROXY_CONFIG,
    running: { [INCUMBENT]: "HEALTHY" },
    // Keyed by PREFIX is not possible on the double, so the arms below pass the exact name.
    health: { [candidatePrefix]: ["STARTING", "HEALTHY"] },
  });
}

function principal(principalId: string): AuthenticatedPrincipal {
  return { capabilities: ["goal.write"], principalId, projectId: PROJECT_ID };
}

function envelopeFor(
  store: SqliteEventStore, payload: Readonly<Record<string, unknown>>, commandId: string,
): RuntimeCommandEnvelope {
  return {
    commandId,
    commandKind: DEPLOYMENT_DEPLOY_COMMAND_KIND,
    correlationId: "corr-async-entries",
    // READ, never pinned: the project aggregate's version is whatever the seeded chain left,
    // and a literal here would start refusing CONFLICT the day the fixture grows a command.
    expectedVersion: store.getAggregateVersion(PROJECT_ID),
    payload: payload as RuntimeCommandEnvelope["payload"],
    requestDigest: "c".repeat(64),
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: "async-entries-credential",
    targetAggregateId: PROJECT_ID,
  };
}

interface Seam {
  readonly docker: DockerDouble;
  deploy(input: {
    readonly commandId?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly principalId?: string;
  }): Promise<unknown>;
  readonly entries: ReturnType<typeof createAsyncCommandEntries>;
  readonly store: SqliteEventStore;
}

/** `published` seeds the durable chain through `repository.publish`, which is what
 *  `COMMAND_PREREQUISITES["deployment.deploy"]` requires. An arm that wants the admission
 *  refusal passes false and gets a store that stops short of it. */
function seam(options: {
  readonly buildContext?: string;
  readonly candidate?: string;
  readonly published?: boolean;
} = {}): Seam {
  const store = openStore();
  if (options.published !== false) driveThrough(store, "goal.close");
  const docker = deployDouble(options.candidate ?? "unused-candidate");
  const entries = createAsyncCommandEntries({
    operatorPrincipalId: OPERATOR,
    projectId: PROJECT_ID,
    store,
    deploymentDeploy: {
      clock: (): string => DECIDED_AT,
      // Zero-cost time: the budget is exercised in poll COUNTS, never in wall clock.
      healthBudgetMs: 10, pollMs: 1, sleep: (): Promise<void> => Promise.resolve(),
      ports: {
        docker: docker.docker, releaseDecision: (): null => null, ssh: docker.ssh,
        target: (): DeployTarget => LOCAL, transfer: docker.transfer,
      },
      ...(options.buildContext === undefined ? {} : { buildContext: options.buildContext }),
    },
  });
  const entry = entries[DEPLOYMENT_DEPLOY_COMMAND_KIND];
  return {
    docker, entries, store,
    deploy: async (input): Promise<unknown> => {
      const handler = entry.asyncHandler;
      if (handler === undefined) throw new Error("deployment.deploy carries no async handler");
      const handlerInput: CommandHandlerInput = {
        envelope: envelopeFor(store,
          input.payload ?? { environment: ENVIRONMENT, sha: SHA },
          input.commandId ?? "cmd-deploy-1"),
        principal: principal(input.principalId ?? OPERATOR),
      };
      return handler(handlerInput);
    },
  };
}

/** The refusal a `DomainRefusal`-throwing handler produced, or a failure naming what came back
 *  instead: an arm that swallowed a non-refusal would otherwise read as a passing refusal arm. */
async function refusalOf(promise: Promise<unknown>): Promise<DomainRefusal> {
  try {
    const answered = await promise;
    throw new Error(`expected a refusal, received ${JSON.stringify(answered)}`);
  } catch (error) {
    if (error instanceof DomainRefusal) return error;
    throw error;
  }
}

describe("the async command seam serves deployment.deploy", () => {
  it("reaches the engine with the payload the roster declares, tagging the LANDED sha", async () => {
    const candidate = `moe-deploy-${ENVIRONMENT}-${SHA.slice(0, 12)}-cmddeploy1`;
    const context = seam({ buildContext: CONTEXT, candidate });

    const decision = await context.deploy({ commandId: "cmd-deploy-1" });

    // The advertised payload, read off the production roster rather than restated: the engine
    // is reached with exactly the two keys the wire allows.
    expect(context.entries[DEPLOYMENT_DEPLOY_COMMAND_KIND].payloadKeys)
      .toBe(PAYLOAD_KEYS[DEPLOYMENT_DEPLOY_COMMAND_KIND]);
    expect([...context.entries[DEPLOYMENT_DEPLOY_COMMAND_KIND].payloadKeys])
      .toEqual(["environment", "sha"]);
    // BYTE-FOR-BYTE against the sha VALUE. A `/[0-9a-f]{40}/` pattern passes for the WRONG sha,
    // and every later rollback and dossier claim resolves through this tag.
    expect(context.docker.calls.find((call) => call[0] === "build"))
      .toEqual(["build", "--tag", `moe-deploy-${ENVIRONMENT}:${SHA}`, CONTEXT]);
    expect(context.docker.calls.find((call) => call[0] === "build")?.[2])
      .toBe(deployImageTag(ENVIRONMENT, SHA));
    // The DURABLE receipt, read back from the store the handler committed through.
    const state = readDeployLedger(context.store, PROJECT_ID).get(ENVIRONMENT);
    expect([state?.current.outcome, state?.current.sha]).toEqual(["DEPLOYED", SHA]);
    expect(decision).toMatchObject({ commandId: "cmd-deploy-1", disposition: "DECIDED" });
  });

  it("is NOT reachable through any synchronous handler table", () => {
    const synchronous = Object.keys({
      ...BOOTSTRAP_HANDLERS, ...GOAL_HANDLERS, ...PLANNING_HANDLERS,
    });

    // The vocabulary comment states this kind "never reaches the registry's synchronous
    // operator check". This arm is what makes that true rather than aspirational: a future
    // sync adapter would red here instead of silently answering before the deploy happened.
    expect(synchronous).not.toContain(DEPLOYMENT_DEPLOY_COMMAND_KIND);
    const context = seam({ buildContext: CONTEXT, published: false });
    const entry = context.entries[DEPLOYMENT_DEPLOY_COMMAND_KIND];
    expect(entry.asyncHandler).toBeDefined();
    // Its synchronous half is the SHARED refusing handler, the same one every async entry
    // carries — not a second implementation of the deploy.
    expect(entry.handler)
      .toBe(context.entries[REPOSITORY_BOOTSTRAP_COMMAND_KIND].handler);
  });

  it("refuses an AGENT principal at the authorization layer, before any effect", async () => {
    const context = seam({ buildContext: CONTEXT });

    const refusal = await refusalOf(context.deploy({ principalId: AGENT }));

    // CODE AND LAYER, never merely "it failed": a second refusal layer answering first would
    // leave this arm green while no longer testing the operator fence.
    expect([refusal.code, refusal.layer, refusal.httpStatus])
      .toEqual(["OPERATOR_PRINCIPAL_REQUIRED", "DAEMON_AUTHORIZATION", 403]);
    // Deploying a product is never an agent's decision: nothing was invoked on docker at all.
    expect(context.docker.calls).toEqual([]);
  });

  it("refuses when the daemon has NO configured build context, before any effect", async () => {
    const context = seam({});

    const refusal = await refusalOf(context.deploy({}));

    expect([refusal.code, refusal.layer])
      .toEqual([DEPLOY_BUILD_CONTEXT_UNCONFIGURED, "DAEMON_COMMAND_SEAM"]);
    expect(context.docker.calls).toEqual([]);
  });

  it("ADMITS FIRST: an unmet repository.publish refuses before docker is asked anything",
    async () => {
      const context = seam({ buildContext: CONTEXT, published: false });

      const refusal = await refusalOf(context.deploy({}));

      expect([refusal.code, refusal.layer])
        .toEqual(["BOOTSTRAP_PREREQUISITE_MISSING", "DAEMON_PREREQUISITE"]);
      expect(context.docker.calls).toEqual([]);
    });

  it("serves repository.bootstrap on the same seam, with the roster's payload keys", () => {
    const context = seam({ published: false });
    const entry = context.entries[REPOSITORY_BOOTSTRAP_COMMAND_KIND];

    expect(entry.asyncHandler).toBeDefined();
    expect(entry.payloadKeys).toBe(PAYLOAD_KEYS[REPOSITORY_BOOTSTRAP_COMMAND_KIND]);
    expect(entry.kind).toBe(REPOSITORY_BOOTSTRAP_COMMAND_KIND);
  });
});
