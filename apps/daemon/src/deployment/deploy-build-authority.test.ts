import { afterEach, describe, expect, it } from "vitest";
import { closeStores, openStore } from "../review/review-test-fixtures.js";
import { deploymentInfrastructureFiles } from "../repository/deployment/deployment-infrastructure-templates.js";
import { createDockerDouble } from "./deploy-ports.js";
import {
  candidateContainerName, createCandidateArgv, createDeployService, startCandidateArgv,
} from "./deploy-service.js";

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

/**
 * "NO CANDIDATE WAS BROUGHT UP", spelled against BOTH verbs that can bring one up. The old spelling
 * named only `run`; once the engine creates and starts instead, that asserts the absence of
 * something impossible and stays green while a container is started. The verbs are read off the
 * PRODUCTION builders so the next rename reds here rather than emptying the filters, and the
 * double's state machine is asserted too, which no rename can hollow out.
 */
const expectNoCandidateBroughtUp = (docker: ReturnType<typeof createDockerDouble>): void => {
  const candidate = candidateContainerName(request.environment, SHA, request.decisionId);
  expect(docker.calls.length).toBeGreaterThan(0);
  expect(docker.calls.filter(args => args[0] === "create" && args.includes(candidate))).toEqual([]);
  expect(docker.calls.filter(args => args[0] === "start" && args.includes(candidate))).toEqual([]);
  expect([createCandidateArgv("c", "n", "t")[0], startCandidateArgv("c")[0]]).toEqual(["create", "start"]);
  expect(docker.state(candidate)).toBe("ABSENT");
};

describe("revision-bound local builds", () => {
  it("does not start a container when the requested commit cannot be materialized", async () => {
    const context = harness(1, false);
    const report = await context.service.deploy(request);
    expect(report.outcome).toBe("REFUSED");
    expectNoCandidateBroughtUp(context.docker);
  });

  // THE ABSENCE ASSERTION ABOVE MUST STILL BE ABLE TO FAIL. It names the verbs that bring a
  // candidate up, and a verb rename turns any such arm into a tautology that stays green while a
  // container starts. Rather than trusting a mutation drill nobody will re-run, the same helper is
  // pointed at a deploy that DID start one and required to throw.
  it("that absence assertion still fails when a candidate IS brought up", async () => {
    const context = harness(0, false);
    expect((await context.service.deploy(request)).outcome).toBe("DEPLOYED");
    expect(() => { expectNoCandidateBroughtUp(context.docker); }).toThrow();
  });
  it("binds the local build to the exact commit before transferring to SSH", async () => {
    const context = harness(0, true);
    expect((await context.service.deploy(request)).outcome).toBe("DEPLOYED");
    expect(context.built).toEqual([{ context: request.context, sha: SHA, tag: `moe-deploy-production:${SHA}` }]);
    expect(context.docker.sshCalls.some(args => args[2] === "build")).toBe(false);
    expect(context.docker.sshCalls).toContainEqual(["deploy@example.test", "docker", "load"]);
  });
});
