import { afterEach, expect, it } from "vitest";
import { closeStores, driveThrough, envelope, GOAL_ID, goalPayload, openStore, PROJECT_ID, send }
  from "../bootstrap/bootstrap-test-fixtures.js";
import { createAffordancePort } from "./affordance-read.js";
import { createAsyncCommandEntries } from "../daemon-command-async-entries.js";
import { createDockerDouble } from "../deployment/deploy-ports.js";
import { candidateContainerName } from "../deployment/deploy-service.js";
import { deploymentInfrastructureFiles } from "../repository/deployment/deployment-infrastructure-templates.js";
import { CONTROLLED_PROFILE_VERSION } from "../repository/controlled-profile/controlled-profile-generator.js";
import type { CommandHandlerInput } from "./http-contract.js";

afterEach(closeStores);

it("retains a published goal's deployment offer when another goal is created", () => {
  const store = openStore();
  driveThrough(store, "goal.close");
  let id = 0;
  const port = createAffordancePort({ store, projectId: PROJECT_ID,
    mintId: (kind) => `deploy-${kind}-${++id}`,
    deployTarget: () => ({ network: "moe-test", sshTarget: null, url: null }),
  });
  const deploymentOffers = () => {
    const surface = port.readSurface();
    if (surface.outcome !== "SURFACE") throw new Error(surface.code);
    return surface.nextAllowedCommands.filter((offer) => offer.commandKind === "deployment.deploy");
  };
  expect(deploymentOffers()).toMatchObject([{ targetAggregateId: `deploy:${GOAL_ID}` }]);
  expect(send(store, envelope("goal.create", 0, goalPayload(), "another-goal")).ok).toBe(true);
  expect(deploymentOffers()).toMatchObject([{ targetAggregateId: `deploy:${GOAL_ID}` }]);
});

it("dispatches an offered deployment at that goal's aggregate version", async () => {
  const store = openStore(); driveThrough(store, "goal.close");
  const target = { network: "moe-test", sshTarget: null, url: null };
  const surface = createAffordancePort({ store, projectId: PROJECT_ID, mintId: () => "deploy-roundtrip",
    deployTarget: () => target }).readSurface();
  if (surface.outcome !== "SURFACE") throw new Error(surface.code);
  const offer = surface.nextAllowedCommands.find((row) => row.commandKind === "deployment.deploy")!;
  const sha = "a".repeat(40);
  const docker = createDockerDouble({ proxyConfig: deploymentInfrastructureFiles(CONTROLLED_PROFILE_VERSION, []).get("docker/Caddyfile")!,
    health: { [candidateContainerName("preview", sha, offer.commandId)]: ["HEALTHY"] } });
  const handler = createAsyncCommandEntries({ operatorPrincipalId: "principal-1", projectId: PROJECT_ID, store,
    deploymentDeploy: { buildContext: "/workspace", ports: { build: docker.build, docker: docker.docker,
      ssh: docker.ssh, transfer: docker.transfer, target: () => target, releaseDecision: () => null } },
  })["deployment.deploy"].asyncHandler!;
  const input: CommandHandlerInput = { principal: { principalId: "principal-1", projectId: PROJECT_ID, capabilities: ["goal.write"] },
    envelope: { commandId: offer.commandId, commandKind: "deployment.deploy", correlationId: "roundtrip",
      targetAggregateId: offer.targetAggregateId, expectedVersion: offer.expectedVersion,
      payload: { environment: "preview", sha }, requestDigest: "d".repeat(64),
      schemaVersion: "moe-runtime-command/1", sessionCredential: "test-deploy" } };
  await handler(input);
  expect(store.getCommandDecision({ commandId: offer.commandId, principalId: "principal-1", projectId: PROJECT_ID }))
    .toMatchObject({ targetAggregateId: `deploy:${GOAL_ID}`, currentVersion: 1 });
  await expect(handler({ ...input, envelope: { ...input.envelope, commandId: "stale-deploy" } }))
    .rejects.toMatchObject({ code: "BOOTSTRAP_EXPECTED_VERSION_STALE" });
});
