import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { SqliteEventStore } from "@moe/store";
import { createStoreDependencies, readStoreDependencyEnv }
  from "../../../apps/daemon/src/daemon-store-dependencies.js";
import { productionDeployPorts } from "../../../apps/daemon/src/deployment/deploy-command.js";
import { createDeploymentImageBuilder } from "../../../apps/daemon/src/deployment/deploy-image-build.js";
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

/**
 * A `docker` child that answers from the double instead of a container runtime.
 *
 * The shipped builder pipes `git archive` INTO `docker build -` and reads the pair's close
 * codes, so a port-level stub cannot stand in for it without discarding everything the builder
 * does around the pipe. This is a ChildProcess-shaped double for the DOCKER leg only: `stdin`
 * drains the archive, `stdout`/`stderr` carry the double's bytes, and `close` carries its code -
 * including the `null` that DEPLOY_DOCKER_UNAVAILABLE answers with.
 */
function dockerChildDouble(args: readonly string[]): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr, kill: () => true, pid: process.pid });
  stdin.resume();
  void docker(args).then((result) => {
    if (result.stdout !== "") stdout.write(result.stdout);
    if (result.stderr !== "") stderr.write(result.stderr);
    stdout.end(); stderr.end();
    child.emit("close", result.code);
  });
  return child;
}

/**
 * THE BUILD IS FAKED AT ITS DOCKER SPAWN, NOT AT ITS PORT.
 *
 * Spreading `authority` alone left `build` as the shipped `nodeDeployBuild`, which shells out to
 * a REAL `docker build` - the one thing this lane must never do (epic rail 4). Replacing the
 * whole PORT was worse in a quieter way: it also discarded the builder's own git preflight, and
 * a drill then deployed a sha the repository does not contain and got outcome DEPLOYED. So the
 * production builder is kept and only its `docker` spawn is intercepted. `rev-parse --verify
 * <sha>^{commit}`, the objects/alternates setup and `git archive` all still really run, so
 * DEPLOY_COMMIT_UNAVAILABLE is still raised by the code that ships.
 */
const build = createDeploymentImageBuilder({
  spawn: (file: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    if (file !== "docker") return nodeSpawn(file, [...args], options);
    record("docker", args);
    return dockerChildDouble(args);
  },
});

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
    // THE LANE'S OWN GIT WORKSPACE when the daemon was given one: the scratch root is
    // deliberately not a repository, and a build context that is not a repository is what the
    // shipped builder refuses DEPLOY_COMMIT_UNAVAILABLE on. Falls back to the old value so a
    // lane that sets no workspace behaves as it did.
    buildContext: process.env["MOE_NODE_WORKSPACE"] ?? dirname(config.storePath),
    healthBudgetMs: 10, pollMs: 1,
    sleep: () => Promise.resolve(),
    ports: { ...authority, docker,
      build,
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
