/**
 * THE PREVIEW ENVIRONMENT THE DEPLOY UPDATES (task-161b7e9d, DoD 1's deploy receipt).
 *
 * WHY THIS EXISTS. MEASURED 2026-09-09 on a real drive: `deployment.deploy` refused
 * `DEPLOY_BUILD_FAILED / DEPLOY_PROXY_MISSING_OR_AMBIGUOUS`. That is not a gap in the engine --
 * it is the engine's shape. `deploy-service.ts:91` discovers a container labelled
 * `com.docker.compose.service=proxy` on the target network, reads its Caddyfile, and FLIPS
 * `reverse_proxy` to the candidate it just built and proved healthy. A deploy is therefore an
 * UPDATE to a running environment, and something has to have brought that environment up.
 *
 * WHO BRINGS IT UP, SAID PLAINLY. The operator, with `docker compose`, exactly as the generated
 * infrastructure intends -- `deployment-infrastructure-templates.ts` emits an app service, a
 * caddy proxy and the Caddyfile for this purpose, and no Moe command kind stands an environment
 * up. So this file is an OPERATOR STEP, disclosed as one, and never presented as the product
 * doing it.
 *
 * THE CADDYFILE IS THE PRODUCTION TEMPLATE'S OWN BYTES, taken from
 * `deploymentInfrastructureFiles` rather than retyped. `acquireProxy` compares the running
 * config against those same bytes and refuses `DEPLOY_PROXY_CONFIG_UNSUPPORTED` on any
 * difference, so importing them is what makes this environment one the shipped engine will
 * accept -- and a template change moves both sides together.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deploymentInfrastructureFiles }
  from "../../../apps/daemon/src/repository/deployment/deployment-infrastructure-templates.js";

/** The proxy image the generated override pins. Same tag, so the topology is the same one. */
const PROXY_IMAGE = "caddy:2.11.4-alpine";
/** The database the PRODUCT's own deploy-time migration reaches. Same major as the scaffold's. */
const POSTGRES_IMAGE = "postgres:17-alpine";
const DATABASE = "standup";
/** Inert: this database exists for the length of one drive and is published on loopback only. */
const PASSWORD = "live-proof-not-a-secret";
/** The port the app serves and the proxy listens on, inside the network. */
const APP_PORT = 3000;
const UP_TIMEOUT_MS = 900_000;

export interface LivePreviewEnvironment {
  /** The compose file this pass wrote, kept out of the product tree. */
  readonly composePath: string;
  /** Every docker invocation, with its status, so the record can quote the bring-up. */
  readonly log: readonly { readonly argv: readonly string[]; readonly status: number; readonly tail: string }[];
  /** The database container compose created, for a read-back that asks postgres itself. */
  readonly database: string;
  /** What `environment.set_variable` binds as DATABASE_URL, and what the migration reaches. */
  readonly databaseUrl: string;
  readonly databasePort: number;
  readonly hostPort: number;
  readonly incumbent: string;
  readonly network: string;
  readonly project: string;
  readonly proxy: string;
  /** Non-null when the environment did NOT come up; the caller records it and asserts. */
  readonly refusal: string | null;
  /** Where the proxy answers from the HOST, which is the deploy receipt's url. */
  readonly url: string;
}

function docker(argv: readonly string[], timeoutMs = 120_000): { status: number; out: string } {
  try {
    return {
      out: execFileSync("docker", [...argv],
        { encoding: "utf8", shell: false, timeout: timeoutMs, windowsHide: true }).trim(),
      status: 0,
    };
  } catch (error) {
    const shaped = error as { status?: number; stderr?: string; stdout?: string };
    return {
      out: `${String(shaped.stdout ?? "")}${String(shaped.stderr ?? "")}`.trim().slice(-600),
      status: shaped.status ?? -1,
    };
  }
}

/** Compose reads a Windows path fine, but only with forward slashes inside a volume mapping. */
const posix = (path: string): string => path.replace(/\\/gu, "/");

const composeFile = (options: {
  readonly caddyfile: string; readonly databasePort: number; readonly hostPort: number;
  readonly image: string; readonly network: string; readonly project: string;
}): string => [
  `name: ${options.project}`,
  "services:",
  // THE DATABASE IS PUBLISHED ON LOOPBACK because two different processes must reach it: the
  // product's `node-pg-migrate`, which the daemon runs on the HOST, and the daemon's own pg_dump,
  // which runs in a container and rewrites 127.0.0.1 to host.docker.internal itself
  // (`backup-ports.ts:71`). One address that works for both is the published one.
  "  db:",
  `    image: ${POSTGRES_IMAGE}`,
  "    restart: unless-stopped",
  "    environment:",
  `      POSTGRES_PASSWORD: ${PASSWORD}`,
  `      POSTGRES_DB: ${DATABASE}`,
  "    ports:",
  `      - "127.0.0.1:${String(options.databasePort)}:5432"`,
  "    healthcheck:",
  '      test: ["CMD", "pg_isready", "--username", "postgres", "--dbname", "standup"]',
  "      interval: 3s",
  "      timeout: 5s",
  "      retries: 30",
  "  app:",
  `    image: ${options.image}`,
  "    restart: unless-stopped",
  "    healthcheck:",
  '      test: ["CMD", "node", "/app/healthcheck.mjs"]',
  "      interval: 5s",
  "      timeout: 5s",
  "      retries: 20",
  "  proxy:",
  `    image: ${PROXY_IMAGE}`,
  "    restart: unless-stopped",
  "    depends_on:",
  "      app:",
  "        condition: service_healthy",
  "    ports:",
  `      - "${String(options.hostPort)}:${String(APP_PORT)}"`,
  "    volumes:",
  `      - "${posix(options.caddyfile)}:/etc/caddy/Caddyfile:rw"`,
  "networks:",
  "  default:",
  `    name: ${options.network}`,
  "",
].join("\n");

/**
 * Builds an incumbent image from the product's own Dockerfile and brings up app + proxy.
 *
 * THE INCUMBENT IS REQUIRED, not decorative: `acquireProxy` refuses
 * `DEPLOY_PROXY_INCUMBENT_MISSING` when the config's upstream resolves to no container. It is
 * the thing the deploy REPLACES, so the flip is a real cutover rather than a first start.
 */
export function startPreviewEnvironment(options: {
  readonly databasePort: number; readonly hostPort: number; readonly prefix: string;
  readonly workspace: string;
}): LivePreviewEnvironment {
  const log: { argv: readonly string[]; status: number; tail: string }[] = [];
  const run = (argv: readonly string[], timeoutMs?: number): { status: number; out: string } => {
    const result = docker(argv, timeoutMs);
    log.push({ argv, status: result.status, tail: result.out.slice(-300) });
    return result;
  };
  const network = `${options.prefix}-net`;
  const project = options.prefix;
  const image = `${options.prefix}-incumbent:live`;
  const bytes = deploymentInfrastructureFiles("", []).get("docker/Caddyfile") ?? "";
  const directory = mkdtempSync(join(tmpdir(), "moe-liveproof-env-"));
  const caddyfile = join(directory, "Caddyfile");
  writeFileSync(caddyfile, bytes, "utf8");
  const composePath = join(directory, "docker-compose.yml");
  writeFileSync(composePath, composeFile({
    caddyfile, databasePort: options.databasePort, hostPort: options.hostPort, image, network,
    project,
  }), "utf8");
  const answer = (refusal: string | null): LivePreviewEnvironment => ({
    composePath, database: `${project}-db-1`, databasePort: options.databasePort,
    databaseUrl: `postgres://postgres:${PASSWORD}@127.0.0.1:${String(options.databasePort)}/${DATABASE}`,
    hostPort: options.hostPort, incumbent: `${project}-app-1`, log, network, project,
    proxy: `${project}-proxy-1`, refusal, url: `http://127.0.0.1:${String(options.hostPort)}`,
  });
  const built = run(["build", "--tag", image, options.workspace], UP_TIMEOUT_MS);
  if (built.status !== 0) return answer(`INCUMBENT_BUILD_FAILED ${built.out}`);
  const up = run(["compose", "--file", composePath, "up", "--detach", "--wait"], UP_TIMEOUT_MS);
  if (up.status !== 0) return answer(`COMPOSE_UP_FAILED ${up.out}`);
  // DISCOVERED THE WAY THE ENGINE DISCOVERS, so a name compose chose differently is caught here
  // rather than as a deploy refusal three minutes later.
  const proxy = run(["ps", "--filter", "label=com.docker.compose.service=proxy",
    "--filter", `network=${network}`, "--format", "{{.Names}}"]);
  const app = run(["ps", "--filter", "label=com.docker.compose.service=app",
    "--filter", `network=${network}`, "--format", "{{.Names}}"]);
  const db = run(["ps", "--filter", "label=com.docker.compose.service=db",
    "--filter", `network=${network}`, "--format", "{{.Names}}"]);
  const names = [proxy.out, app.out].map((value) => value.split(/\r?\n/u).filter((line) => line !== ""));
  if (names[0]?.length !== 1 || names[1]?.length !== 1) {
    return answer(`ENVIRONMENT_NOT_DISCOVERABLE proxy=${proxy.out} app=${app.out}`);
  }
  const database = db.out.split(/\r?\n/u).filter((line) => line !== "");
  if (database.length !== 1) return answer(`DATABASE_NOT_DISCOVERABLE ${db.out}`);
  return {
    ...answer(null), database: database[0] ?? "", incumbent: names[1][0] ?? "",
    proxy: names[0][0] ?? "",
  };
}

/** Removes exactly what this pass created: its own compose project and its incumbent image. */
export function stopPreviewEnvironment(environment: LivePreviewEnvironment | null): void {
  if (environment === null) return;
  docker(["compose", "--file", environment.composePath, "down", "--volumes", "--remove-orphans"],
    UP_TIMEOUT_MS);
  docker(["image", "rm", "--force", `${environment.project}-incumbent:live`]);
}

export interface LiveProductInstall {
  readonly status: number;
  readonly tail: string;
}

/**
 * Installs the product's declared dependencies, which is what makes its OWN migration runnable.
 *
 * AN OPERATOR STEP AND NOTHING MORE. `migration-ports.ts` resolves `node-pg-migrate` from the
 * product workspace and fails MIGRATION_TOOL_MISSING on a tree that was never installed; no Moe
 * command kind installs a product's dependencies. The manifest it installs from is the product's
 * own, committed at the deployed sha.
 */
export function installProductDependencies(workspace: string): LiveProductInstall {
  try {
    const out = execFileSync("npm", ["install", "--no-audit", "--no-fund"],
      { cwd: workspace, encoding: "utf8", shell: true, timeout: UP_TIMEOUT_MS, windowsHide: true });
    return { status: 0, tail: out.trim().slice(-400) };
  } catch (error) {
    const shaped = error as { status?: number; stderr?: string; stdout?: string };
    return {
      status: shaped.status ?? -1,
      tail: `${String(shaped.stdout ?? "")}${String(shaped.stderr ?? "")}`.trim().slice(-600),
    };
  }
}

export interface LiveHostProbe {
  readonly body: string;
  readonly ok: boolean;
  readonly status: number;
  readonly url: string;
}

/**
 * Asks the DEPLOY RECEIPT'S OWN URL, from the host, through the proxy the deploy flipped.
 *
 * This is the one probe that crosses every hop the receipt claims: host socket -> caddy ->
 * the candidate container the engine started. `docker inspect` says only what docker believes.
 */
export async function probeHealthUrl(url: string, path: string): Promise<LiveHostProbe> {
  const target = `${url.replace(/\/$/u, "")}${path}`;
  try {
    const response = await fetch(target);
    return { body: (await response.text()).slice(0, 300), ok: response.ok, status: response.status, url: target };
  } catch (error) {
    return { body: String(error).slice(0, 300), ok: false, status: 0, url: target };
  }
}
