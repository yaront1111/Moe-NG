import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTROLLED_PROFILE_VERSION,
  generateControlledProfile,
} from "../controlled-profile/controlled-profile-generator.js";
import {
  DEPLOY_DOCKER_UNAVAILABLE,
  classifyDockerProbe,
  dockerUnavailableLine,
  probeDocker,
} from "./deployment-docker-probe.js";
import { planDeploymentInfrastructure } from "./deployment-infrastructure-generator.js";
import { DEPLOYMENT_APP_PORT, DEPLOYMENT_HEALTH_PATH } from "./deployment-infrastructure-templates.js";

/**
 * A generated Dockerfile that was never built is a text file. This file is what makes it an image.
 *
 * WHY THE BUILD ARM IS OPT-IN (`MOE_DEPLOY_IMAGE_BUILD=1`), exactly as the scaffold sibling's build
 * arm is: it pulls a base image and installs from the network, and unconditionally it would execute
 * inside `pnpm --filter @moe/daemon test` — the gate EVERY row on this board runs — and red on any
 * host without a docker daemon, making every later gate on this board inadmissible.
 *
 * THE OPT-IN IS NOT PERMISSION TO SKIP DOCKER. Two different conditions, two different answers:
 * without the FLAG the expensive arm does not run and the always-on arms below carry the load; with
 * the flag set and NO DOCKER the arm FAILS LOUDLY with a `DEPLOY_DOCKER_UNAVAILABLE:` line, never a
 * skip and never a silent pass. The always-on arms pin that refusal wiring itself, so the loud path
 * is covered even on a host that has no docker to be missing from.
 */

const RUN_BUILD = process.env.MOE_DEPLOY_IMAGE_BUILD === "1";

const REQUIREMENTS = [
  {
    dependsOnRequirementIds: [],
    priority: "MUST" as const,
    requirementId: "deployment-loopback",
    statement: "the product answers its health URL when deployed",
    supersedesRequirementId: null,
  },
];

interface Leg {
  readonly argv: readonly string[];
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

/** One foreground leg. Argv array, `shell:false`, never an `&&` chain and never a pipe. */
function docker(args: readonly string[], timeoutMs: number): Leg {
  const outcome = spawnSync("docker", [...args], { encoding: "utf8", shell: false, timeout: timeoutMs });
  if (outcome.error !== undefined) {
    throw outcome.error;
  }
  return {
    argv: ["docker", ...args],
    status: outcome.status,
    stderr: outcome.stderr ?? "",
    stdout: outcome.stdout ?? "",
  };
}

function expectLeg(leg: Leg): void {
  expect(
    leg.status,
    `${leg.argv.join(" ")}\n${leg.stdout.slice(-2000)}\n${leg.stderr.slice(-2000)}`,
  ).toBe(0);
}

/** An ephemeral port the OS just told us is free. Published so the probe can reach the container. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        port > 0 ? resolve(port) : reject(new Error("the OS offered no free port"));
      });
    });
  });
}

interface HealthAnswer {
  readonly body: string;
  readonly status: number;
}

async function requestHealth(port: number): Promise<HealthAnswer> {
  return await new Promise((resolve, reject) => {
    const request = get(
      { host: "127.0.0.1", path: DEPLOYMENT_HEALTH_PATH, port, timeout: 3000 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ body, status: response.statusCode ?? 0 }));
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("health request timed out"));
    });
    request.on("error", reject);
  });
}

/** Poll until it ANSWERS. A container that is up is not the same as an app that serves. */
async function awaitHealth(port: number, deadlineMs: number): Promise<HealthAnswer> {
  const deadline = Date.now() + deadlineMs;
  let last = "never answered";
  while (Date.now() < deadline) {
    try {
      return await requestHealth(port);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`the health URL never answered within ${String(deadlineMs)}ms: ${last}`);
}

/** The scaffold tree plus the infrastructure this row generates, written to a disposable directory. */
function materialize(directory: string): void {
  const scaffold = generateControlledProfile({
    productName: "deploy-probe",
    profileVersion: CONTROLLED_PROFILE_VERSION,
  });
  if (!scaffold.ok) {
    throw new Error(`the scaffold refused its own profile version: ${scaffold.code}`);
  }
  const infrastructure = planDeploymentInfrastructure({
    deploymentRequirements: REQUIREMENTS,
    existingPaths: scaffold.files.keys(),
    profileVersion: CONTROLLED_PROFILE_VERSION,
  });
  if (!infrastructure.ok) {
    throw new Error(`the infrastructure generator refused: ${infrastructure.code}`);
  }

  for (const [relative, body] of [...scaffold.files, ...infrastructure.write]) {
    const target = join(directory, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, "utf8");
  }
}

type DockerCleanup = (args: readonly string[], timeoutMs: number) => void;

function cleanupDocker(args: readonly string[], timeoutMs: number): void {
  spawnSync("docker", [...args], { encoding: "utf8", shell: false, timeout: timeoutMs });
}

async function withDockerArtifacts(
  name: string, tag: string, body: () => Promise<void>, cleanup: DockerCleanup = cleanupDocker,
): Promise<void> {
  try {
    await body();
  } finally {
    // A timed-out run may already have created the container. Always attempt its unique name.
    try { cleanup(["rm", "--force", "--volumes", name], 120_000); }
    finally { cleanup(["rmi", "--force", tag], 300_000); }
  }
}

describe("the generated image", () => {
  it.each([true, false])("cleans the named artifacts when the run attempt fails: %s", async (fails) => {
    const calls: { args: readonly string[]; timeoutMs: number }[] = [];
    const failure = new Error("docker run timed out after starting the container");
    const attempt = withDockerArtifacts("owned-container", "owned-image",
      () => fails ? Promise.reject(failure) : Promise.resolve(),
      (args, timeoutMs) => { calls.push({ args, timeoutMs }); });
    if (fails) await expect(attempt).rejects.toBe(failure);
    else await expect(attempt).resolves.toBeUndefined();
    expect(calls).toEqual([
      { args: ["rm", "--force", "--volumes", "owned-container"], timeoutMs: 120_000 },
      { args: ["rmi", "--force", "owned-image"], timeoutMs: 300_000 },
    ]);
  });

  it("still attempts image cleanup when container cleanup throws", async () => {
    const captured: string[][] = [];
    const failure = new Error("container cleanup failed");
    await expect(withDockerArtifacts("owned-container", "owned-image", () => Promise.resolve(),
      (args) => {
        captured.push([...args]);
        if (args[0] === "rm") throw failure;
      })).rejects.toBe(failure);
    expect(captured).toEqual([
      ["rm", "--force", "--volumes", "owned-container"], ["rmi", "--force", "owned-image"],
    ]);
  });

  it("names the docker daemon, not the docker binary, as what it needs", () => {
    // A host with the CLI installed and no daemon running is the common case and the one that
    // silently poisons a build: `docker` resolves, so a binary-presence check calls it capable.
    const daemonDown = classifyDockerProbe({
      spawnError: null,
      status: 1,
      stderr: "failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine",
      stdout: "",
    });
    expect(daemonDown.available).toBe(false);
    expect(daemonDown.available ? null : daemonDown.code).toBe(DEPLOY_DOCKER_UNAVAILABLE);

    const notInstalled = classifyDockerProbe({ spawnError: "spawnSync docker ENOENT", status: null, stderr: "", stdout: "" });
    expect(notInstalled.available ? null : notInstalled.code).toBe(DEPLOY_DOCKER_UNAVAILABLE);

    const live = classifyDockerProbe({ spawnError: null, status: 0, stderr: "", stdout: "27.4.0\n" });
    expect(live).toEqual({ available: true, serverVersion: "27.4.0" });
  });

  it("refuses loudly, with the reason code on the line, when the build arm cannot run", () => {
    // DoD 4: the exact line this file fails with when docker is absent, produced by the same
    // function the arm below calls — so the completion record quotes the code, not a paraphrase.
    const line = dockerUnavailableLine("no docker daemon answered (exit 1): ...");
    expect(line.startsWith(`${DEPLOY_DOCKER_UNAVAILABLE}: `)).toBe(true);
  });

  it.runIf(RUN_BUILD)(
    "builds from the generated Dockerfile and answers its health URL",
    async () => {
      const availability = probeDocker();
      if (!availability.available) {
        // NOT a skip and NOT a silent pass: the arm was asked to run and cannot.
        expect.fail(dockerUnavailableLine(availability.detail));
      }

      const tag = `moe-deploy-probe:${String(process.pid)}-${String(Date.now())}`;
      const name = `moe-deploy-probe-${String(process.pid)}-${String(Date.now())}`;
      const directory = mkdtempSync(join(tmpdir(), "moe-deploy-"));
      try {
        await withDockerArtifacts(name, tag, async () => {
          materialize(directory);

          expectLeg(docker(["build", "--tag", tag, directory], 1_800_000));

          const port = await freePort();
          const run = docker(
            ["run", "--detach", "--name", name, "--publish", `127.0.0.1:${String(port)}:${String(DEPLOYMENT_APP_PORT)}`, tag],
            120_000,
          );
          expectLeg(run);

          // DoD 3: assert the RESPONSE. An image that builds and crashes on start passes a build.
          const answer = await awaitHealth(port, 120_000);
          expect(answer.status).toBe(200);
          expect(JSON.parse(answer.body)).toEqual({ status: "ok" });

          process.stdout.write(`DOCKER BUILD ARM RAN against server ${availability.serverVersion}\n`);
          process.stdout.write(`DOCKER BUILD ARM health ${String(answer.status)} ${answer.body}\n`);
        });
      } finally {
        // Epic rail 4: anything this epic starts, it stops — including on the throwing path.
        rmSync(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 200 });
      }
    },
    2_400_000,
  );
});
