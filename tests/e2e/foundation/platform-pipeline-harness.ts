import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CONTROLLED_PROFILE_VERSION,
  generateControlledProfile,
} from "../../../apps/daemon/src/repository/controlled-profile/controlled-profile-generator.js";
import { planDeploymentInfrastructure } from "../../../apps/daemon/src/repository/deployment/deployment-infrastructure-generator.js";
import {
  DEPLOYMENT_APP_PORT,
  DEPLOYMENT_HEALTH_PATH,
} from "../../../apps/daemon/src/repository/deployment/deployment-infrastructure-templates.js";

/**
 * THE PIPELINE HARNESS for the epic-final row: the real generated topology, brought up by real
 * `docker compose`, reachable over real HTTP.
 *
 * WHAT IS DELIBERATELY NOT HERE: any double. `createDockerDouble` exists in `deploy-ports.ts` and
 * every mid-epic arm uses it; this row's whole subject is what the bands got wrong about each
 * other, and a double cannot be wrong about anything. The only things this module fabricates are
 * a product name, a scratch directory and two synthetic shas — none of which is a link in the
 * chain under test.
 *
 * THE GENERATED TOPOLOGY IS USED VERBATIM. No extra compose file remaps the published port, so
 * `proxy` binds the host's 3000 exactly as a real operator's would. `reservePublicPort` refuses
 * loudly when that port is taken rather than quietly moving to another one: a run that proved the
 * pipeline on a port the product does not actually publish has proved the wrong thing.
 */

/** The public socket the generated compose file publishes. Not configurable, by design. */
export const PUBLIC_PORT = DEPLOYMENT_APP_PORT;

/** The route this harness adds so a RESPONSE, not a receipt, says which build is serving. */
export const BUILD_ROUTE = "/build";

export interface Leg {
  readonly argv: readonly string[];
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

/** One foreground leg. Argv array, `shell:false`, never an `&&` chain and never a pipe. */
export function docker(args: readonly string[], timeoutMs = 120_000): Leg {
  const outcome = spawnSync("docker", [...args], { encoding: "utf8", shell: false, timeout: timeoutMs });
  if (outcome.error !== undefined) throw outcome.error;
  return {
    argv: ["docker", ...args],
    status: outcome.status,
    stderr: outcome.stderr ?? "",
    stdout: outcome.stdout ?? "",
  };
}

/** Never throws and never asserts: cleanup runs on the failure path, where a throw hides the cause. */
export function dockerQuietly(args: readonly string[], timeoutMs = 120_000): Leg {
  const outcome = spawnSync("docker", [...args], { encoding: "utf8", shell: false, timeout: timeoutMs });
  return {
    argv: ["docker", ...args],
    status: outcome.status,
    stderr: outcome.stderr ?? "",
    stdout: outcome.stdout ?? "",
  };
}

export function legDetail(leg: Leg): string {
  return `${leg.argv.join(" ")}\nexit=${String(leg.status)}\n${leg.stdout.slice(-1500)}\n${leg.stderr.slice(-1500)}`;
}

/**
 * Refuses when the generated topology's public port is already bound.
 *
 * A silent fallback port would still answer 200 and would still look green, while proving the
 * pipeline on a socket the product never publishes.
 */
export async function reservePublicPort(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.on("error", (error: Error) => {
      reject(new Error(
        `the generated topology publishes ${String(PUBLIC_PORT)} and it is already bound: ${error.message}`,
      ));
    });
    server.listen(PUBLIC_PORT, "127.0.0.1", () => { server.close(() => { resolve(); }); });
  });
}

export interface HttpAnswer {
  readonly body: string;
  readonly status: number;
}

export async function request(path: string, port = PUBLIC_PORT): Promise<HttpAnswer> {
  return await new Promise((resolve, reject) => {
    const attempt = get({ host: "127.0.0.1", path, port, timeout: 5_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => { resolve({ body, status: response.statusCode ?? 0 }); });
    });
    attempt.on("timeout", () => { attempt.destroy(new Error("request timed out")); });
    attempt.on("error", reject);
  });
}

/** How often `awaitAnswer` retries. A FIXED step, so the wait is a COUNT rather than a duration. */
export const ANSWER_POLL_MS = 500;

/**
 * Polls until the URL ANSWERS. A container that is running is not the same as an app that serves.
 *
 * BOUNDED BY AN ATTEMPT COUNT, NOT A WALL CLOCK. `e2e-harness.test.ts` scans every harness module
 * in this directory for wall-clock and random sources and fails on any hit — the logical clock in
 * `e2e-harness.ts` is the only time source these modules may have. (The scan is a plain substring
 * match over the file's text, so even naming the banned identifiers in a comment trips it; that is
 * why they are described here rather than quoted.) A deadline loop would also make the number of
 * attempts depend on how slow the host is, which is the non-determinism that invariant exists to
 * prevent. The caller still passes a budget in milliseconds; it is converted to attempts here and
 * never compared against a clock.
 */
export async function awaitAnswer(path: string, budgetMs: number): Promise<HttpAnswer> {
  const attempts = Math.max(1, Math.ceil(budgetMs / ANSWER_POLL_MS));
  let last = "never answered";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await request(path);
    } catch (error: unknown) {
      last = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, ANSWER_POLL_MS));
    }
  }
  throw new Error(`${path} never answered in ${String(attempts)} attempts ${String(ANSWER_POLL_MS)}ms apart: ${last}`);
}

/**
 * The build marker route, added to the generated server source.
 *
 * WHY THE TREE IS EDITED AT ALL: two deploys of a byte-identical tree produce two builds that are
 * indistinguishable over HTTP, so "the previous sha is serving" could not be proven by response —
 * only by receipt, which DoD 3 explicitly refuses. A real second deploy carries a real source
 * change; this is the smallest honest one.
 */
export function withBuildRoute(source: string, build: string): string {
  const anchor = '  if (url === "/health") {';
  if (!source.includes(anchor)) {
    throw new Error("the generated server no longer carries the /health route this marker anchors on");
  }
  const marker = [
    `  if (url === "${BUILD_ROUTE}") {`,
    `    return { status: 200, body: JSON.stringify({ build: ${JSON.stringify(build)} }) };`,
    "  }",
    anchor,
  ].join("\n");
  return source.replace(anchor, marker);
}

/**
 * The delivery marker route, added to the generated server source beside the build marker.
 *
 * WHY A ROUTE AND NOT `docker exec … printenv`: an exec builds its environment from the IMAGE's
 * `Config.Env`, not from the running process's — measured, it prints nothing even when PID 1 has
 * the value — so an exec would have been a false negative here. More importantly the question is
 * what the DEPLOYED BUILD sees: the application process reading its own `process.env` and
 * answering on the port the proxy flips to. That is what production depends on, and a container
 * whose PID 1 has the value but whose app never inherited it would still pass an exec probe.
 *
 * `/health` cannot carry this proof: it is a pure function that touches nothing, which is exactly
 * why a candidate with no variables at all reported healthy for as long as it did.
 */
export const DELIVERY_ROUTE = "/delivered";
/** Read at REQUEST time, so the answer is the live process environment rather than a build-time literal. */
export const DELIVERY_MARKER_VARIABLE = "MOE_DELIVERY_MARKER";

export function withDeliveryRoute(source: string): string {
  const anchor = '  if (url === "/health") {';
  if (!source.includes(anchor)) {
    throw new Error("the generated server no longer carries the /health route this marker anchors on");
  }
  return source.replace(anchor, [
    `  if (url === "${DELIVERY_ROUTE}") {`,
    `    return { status: 200, body: JSON.stringify({ marker: process.env.${DELIVERY_MARKER_VARIABLE} ?? null }) };`,
    "  }",
    anchor,
  ].join("\n"));
}

export interface Workspace {
  readonly directory: string;
  readonly serverPath: string;
}

/** The scaffold tree plus the generated infrastructure, written to a disposable directory. */
export function materialize(productName: string, build: string, canaryPassword: string): Workspace {
  const scaffold = generateControlledProfile({
    productName,
    profileVersion: CONTROLLED_PROFILE_VERSION,
  });
  if (!scaffold.ok) throw new Error(`the scaffold refused its own profile version: ${scaffold.code}`);
  const infrastructure = planDeploymentInfrastructure({
    deploymentRequirements: [{
      dependsOnRequirementIds: [],
      priority: "MUST",
      requirementId: "platform-pipeline",
      statement: "one goal reaches a running deployed environment and back out again",
      supersedesRequirementId: null,
    }],
    existingPaths: scaffold.files.keys(),
    profileVersion: CONTROLLED_PROFILE_VERSION,
  });
  if (!infrastructure.ok) throw new Error(`the infrastructure generator refused: ${infrastructure.code}`);

  const directory = mkdtempSync(join(tmpdir(), "moe-platform-"));
  for (const [relative, body] of [...scaffold.files, ...infrastructure.write]) {
    const target = join(directory, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, "utf8");
  }

  const serverPath = join(directory, "packages", "api", "src", "server.ts");
  writeFileSync(serverPath,
    withDeliveryRoute(withBuildRoute(readFileSync(serverPath, "utf8"), build)), "utf8");

  // The canary reaches the process ONLY through the environment: `.env` is what compose reads for
  // `${POSTGRES_PASSWORD:?...}` and `${DATABASE_URL:?...}`, and `.dockerignore` excludes it from
  // every build context, which is the property DoD 5's sweep exists to confirm.
  writeFileSync(join(directory, ".env"), [
    "POSTGRES_USER=app",
    `POSTGRES_PASSWORD=${canaryPassword}`,
    "POSTGRES_DB=app",
    `DATABASE_URL=postgres://app:${canaryPassword}@db:5432/app`,
    "",
  ].join("\n"), "utf8");

  return { directory, serverPath };
}

export function rewriteBuildRoute(workspace: Workspace, build: string): void {
  const current = readFileSync(workspace.serverPath, "utf8");
  const stripped = current.replace(
    /  if \(url === "\/build"\) \{\n {4}return \{ status: 200, body: JSON\.stringify\(\{ build: "[^"]*" \}\) \};\n {2}\}\n/u,
    "",
  );
  writeFileSync(workspace.serverPath, withBuildRoute(stripped, build), "utf8");
}

/**
 * Install the generated workspace's dependencies, which is what makes its migration TOOL present.
 *
 * `--store-dir` IS NOT OPTIONAL and is not a speed knob: a bare `pnpm install` run from a scratch
 * directory re-resolves the DEFAULT store and has emptied this machine's shared `.pnpm` before,
 * which breaks every other agent's `--filter` mid-run. The store here is inside the disposable
 * workspace, so it dies with it.
 */
export function installWorkspace(directory: string, timeoutMs: number): Leg {
  // `pnpm` unqualified: the host resolves it (a real `pnpm.exe` on this Windows box). Naming
  // `pnpm.cmd` explicitly is what Node 24 refuses with EINVAL when `shell` is false.
  const pnpm = "pnpm";
  const args = ["install", "--frozen-lockfile", "--filter", "api", "--store-dir", join(directory, ".pnpm-store")];
  const outcome = spawnSync(pnpm, args, { cwd: directory, encoding: "utf8", shell: false, timeout: timeoutMs });
  if (outcome.error !== undefined) throw outcome.error;
  return {
    argv: [pnpm, ...args],
    status: outcome.status,
    stderr: outcome.stderr ?? "",
    stdout: outcome.stdout ?? "",
  };
}

/**
 * Keep run-local scratch out of the product's history WITHOUT editing the product's own
 * `.gitignore`.
 *
 * `.git/info/exclude` is local to the clone and never ships, so the emitted tree stays byte-exact
 * while `.pnpm-store` — which this harness puts inside the workspace so it dies with it — is not
 * committed. Measured before this existed: `git add --all` swept the store in and `git ls-files`
 * answered 2234 paths for a 22-file product, every one of which then entered the deploy's
 * `git archive` build context.
 */
export function excludeLocally(directory: string, patterns: readonly string[]): void {
  writeFileSync(join(directory, ".git", "info", "exclude"), `${patterns.join("\n")}\n`, "utf8");
}

export function removeWorkspace(directory: string): void {
  rmSync(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 200 });
}

/** Compose argv against the generated files only — the override merge the product ships with. */
export function composeArgv(project: string, directory: string, rest: readonly string[]): readonly string[] {
  return ["compose", "--project-name", project, "--project-directory", directory,
    "--file", join(directory, "docker-compose.yml"),
    "--file", join(directory, "docker-compose.override.yml"), ...rest];
}

export function composeUp(project: string, directory: string, timeoutMs: number): Leg {
  return docker(composeArgv(project, directory, ["up", "--detach", "--wait"]), timeoutMs);
}

export function composeDown(project: string, directory: string): Leg {
  return dockerQuietly(composeArgv(project, directory, ["down", "--volumes", "--remove-orphans"]), 300_000);
}

export const HEALTH_PATH = DEPLOYMENT_HEALTH_PATH;

/** An unavailable observation is UNKNOWN, never evidence that no resources remain. */
function censusNames(args: readonly string[]): readonly string[] {
  try {
    const outcome = spawnSync("docker", [...args], {
      encoding: "utf8", shell: false, timeout: 60_000,
    });
    if (outcome.error !== undefined || outcome.status !== 0 || typeof outcome.stdout !== "string") {
      throw new Error();
    }
    return outcome.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "");
  } catch {
    throw Object.assign(new Error("PLATFORM_CENSUS_UNAVAILABLE"), {
      code: "PLATFORM_CENSUS_UNAVAILABLE", layer: "PLATFORM_PIPELINE_HARNESS", truthClass: "UNKNOWN",
    });
  }
}

/** Container names currently alive on this host, as docker itself reports them. */
export function liveContainers(): readonly string[] {
  return censusNames(["ps", "--format", "{{.Names}}"]);
}

/** Network names currently present on this host. */
export function liveNetworks(): readonly string[] {
  return censusNames(["network", "ls", "--format", "{{.Name}}"]);
}

/** True when the OS reports the port free, i.e. nothing is listening on it any more. */
export async function portIsFree(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.on("error", () => { resolve(false); });
    server.listen(port, "127.0.0.1", () => { server.close(() => { resolve(true); }); });
  });
}
