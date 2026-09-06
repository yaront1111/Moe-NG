import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { createStoreDependencies, readStoreDependencyEnv }
  from "../../../apps/daemon/src/daemon-store-dependencies.js";
import { productionDeployPorts } from "../../../apps/daemon/src/deployment/deploy-command.js";
import { createDockerDouble } from "../../../apps/daemon/src/deployment/deploy-ports.js";
import type { ContainerState, DockerRunner } from "../../../apps/daemon/src/deployment/deploy-ports.js";
import { deploymentInfrastructureFiles }
  from "../../../apps/daemon/src/repository/deployment/deployment-infrastructure-templates.js";
import { CONTROLLED_PROFILE_VERSION }
  from "../../../apps/daemon/src/repository/controlled-profile/controlled-profile-generator.js";

/** Test-only selection: no production module reads this key or imports this provider. */
export type FakeDockerMode = "SUCCESS" | "DEPLOY_DOCKER_UNAVAILABLE"
  | "DEPLOY_BUILD_FAILED" | "DEPLOY_HEALTH_TIMEOUT";
const mode = process.env["MOE_E2E_DEPLOY_MODE"] ?? "SUCCESS";
if (!["SUCCESS", "DEPLOY_DOCKER_UNAVAILABLE", "DEPLOY_BUILD_FAILED", "DEPLOY_HEALTH_TIMEOUT"].includes(mode)) {
  throw new Error("E2E_DEPLOY_MODE_INVALID");
}
const config = readStoreDependencyEnv(process.env);
const callsPath = join(dirname(config.storePath), "deploy-spawn-calls.jsonl");
writeFileSync(callsPath, "", "utf8");
const health: Record<string, readonly ContainerState[]> = {};
const model = createDockerDouble({
  proxyConfig: deploymentInfrastructureFiles(CONTROLLED_PROFILE_VERSION, []).get("docker/Caddyfile") ?? "",
  running: { app: "HEALTHY" }, health,
  dockerUnavailable: mode === "DEPLOY_DOCKER_UNAVAILABLE",
  ...(mode === "DEPLOY_BUILD_FAILED" ? { buildStderr: "lane: scripted build refusal" } : {}),
});
const record = (port: string, argv: readonly string[]): void => {
  appendFileSync(callsPath, `${JSON.stringify({ port, argv })}\n`, "utf8");
};
const docker: DockerRunner = (args, stdin) => {
  record("docker", args);
  const name = args[args.indexOf("--name") + 1];
  if (args[0] === "run" && name !== undefined) {
    health[name] = mode === "DEPLOY_HEALTH_TIMEOUT" ? ["STARTING"] : ["STARTING", "HEALTHY"];
  }
  return model.docker(args, stdin);
};

// Resolve targets through the production reader against the SAME durable store.
// The root owns its lexical handle, so this narrow facade opens/closes each read;
// it neither seeds a target nor substitutes release authority or a decoder.
const authority = productionDeployPorts({ readEvents: (aggregateId) => {
  const store = SqliteEventStore.openForProject(config.storePath, config.projectId);
  try { return store.readEvents(aggregateId); } finally { store.close(); }
} }, config.projectId);

export default createStoreDependencies({
  ...config,
  deploymentDeploy: {
    buildContext: dirname(config.storePath), healthBudgetMs: 10, pollMs: 1,
    sleep: () => Promise.resolve(),
    ports: { ...authority, docker,
      ssh: (args, stdin) => {
        record("ssh", args);
        const offset = args.indexOf("docker");
        return offset < 0 ? model.ssh(args, stdin) : docker(args.slice(offset + 1), stdin);
      },
      transfer: (tag, destination) => {
        record("transfer", [tag, destination]); return model.transfer(tag, destination);
      },
    },
  },
});
