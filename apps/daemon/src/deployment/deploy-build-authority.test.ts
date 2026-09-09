import { afterEach, describe, expect, it } from "vitest";
import { closeStores, openStore } from "../review/review-test-fixtures.js";
import { deploymentInfrastructureFiles } from "../repository/deployment/deployment-infrastructure-templates.js";
import { createDockerDouble } from "./deploy-ports.js";
import { candidateContainerName, createDeployService } from "./deploy-service.js";

afterEach(closeStores);
const SHA = "a".repeat(40);
const request = { context: "D:/configured/product", decisionId: "build-authority", environment: "production", sha: SHA };

function harness(buildCode: number, remote: boolean) {
  const built: unknown[] = [];
  const docker = createDockerDouble({
    proxyConfig: deploymentInfrastructureFiles("", []).get("docker/Caddyfile") ?? "",
    running: { app: "HEALTHY" },
    health: { [candidateContainerName(request.environment, SHA, request.decisionId)]: ["HEALTHY"] },
  });
  const ports = {
    build: async (input: unknown) => { built.push(input); return { code: buildCode, stdout: "", stderr: "DEPLOY_COMMIT_UNAVAILABLE" }; },
    docker: docker.docker, ssh: docker.ssh, transfer: docker.transfer, releaseDecision: () => null,
    target: () => ({ network: "product", sshTarget: remote ? "deploy@example.test" : null, url: null }),
  };
  return { built, docker, service: createDeployService({ ports, store: openStore(), projectId: "project-review-1" }) };
}

describe("revision-bound local builds", () => {
  it("does not start a container when the requested commit cannot be materialized", async () => {
    const context = harness(1, false);
    const report = await context.service.deploy(request);
    expect(report.outcome).toBe("REFUSED");
    expect(context.docker.calls.some(args => args[0] === "run")).toBe(false);
  });
  it("binds the local build to the exact commit before transferring to SSH", async () => {
    const context = harness(0, true);
    expect((await context.service.deploy(request)).outcome).toBe("DEPLOYED");
    expect(context.built).toEqual([{ context: request.context, sha: SHA, tag: `moe-deploy-production:${SHA}` }]);
    expect(context.docker.sshCalls.some(args => args[2] === "build")).toBe(false);
    expect(context.docker.sshCalls).toContainEqual(["deploy@example.test", "docker", "load"]);
  });
});
