import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ProductContractV2Requirement } from "@moe/core";

import { CONTROLLED_PROFILE_VERSION } from "../controlled-profile/controlled-profile-generator.js";
import { controlledProfilePackageFiles } from "../controlled-profile/controlled-profile-package-templates.js";
import { controlledProfileRootFiles } from "../controlled-profile/controlled-profile-root-templates.js";
import {
  DEPLOY_PROFILE_VERSION_UNKNOWN,
  DEPLOY_REQUIREMENTS_ABSENT,
  planDeploymentInfrastructure,
} from "./deployment-infrastructure-generator.js";
import {
  DEPLOYMENT_APP_PORT,
  DEPLOYMENT_ENTRY_PATH,
  DEPLOYMENT_HEALTH_PATH,
} from "./deployment-infrastructure-templates.js";

const lines = (body: readonly string[]): string => `${body.join("\n")}\n`;

const requirement = (requirementId: string): ProductContractV2Requirement => ({
  dependsOnRequirementIds: [],
  priority: "MUST",
  requirementId,
  statement: `the product is deployable: ${requirementId}`,
  supersedesRequirementId: null,
});

/** Two ids, deliberately given to the generator out of order so the sort is observable. */
const REQUIREMENTS = [requirement("deployment-runtime"), requirement("deployment-loopback")];

const plan = (overrides: Partial<Parameters<typeof planDeploymentInfrastructure>[0]> = {}) =>
  planDeploymentInfrastructure({
    deploymentRequirements: REQUIREMENTS,
    existingPaths: [],
    profileVersion: CONTROLLED_PROFILE_VERSION,
    ...overrides,
  });

function written(): ReadonlyMap<string, string> {
  const result = plan();
  if (!result.ok) {
    throw new Error(`the generator refused its own profile version: ${result.code}`);
  }
  return result.write;
}

const PROVENANCE = (comment: string): readonly string[] => [
  `${comment} Generated for profile controlled-1. Do not edit: regenerate instead.`,
  `${comment} Satisfies deployment requirements: deployment-loopback, deployment-runtime`,
];

const EXPECTED_DOCKERFILE = lines([
  ...PROVENANCE("#"),
  "#",
  "# The runtime stage carries no package manager, no source and no node_modules: packages/api",
  "# declares only devDependencies, so the compiled output plus node is the whole application.",
  "",
  "FROM node:24.16.0-alpine AS build",
  "WORKDIR /src",
  "RUN corepack enable",
  "# The whole workspace, minus everything .dockerignore excludes. The lockfile is committed and",
  "# the install is frozen, so this layer is reproducible for a given tree.",
  "COPY . .",
  "RUN pnpm install --frozen-lockfile",
  "RUN pnpm --filter api build",
  "",
  "FROM node:24.16.0-alpine AS runtime",
  "WORKDIR /app",
  "ENV NODE_ENV=production",
  "ENV PORT=3000",
  "COPY --from=build /src/packages/api/dist ./dist",
  "COPY docker/healthcheck.mjs ./healthcheck.mjs",
  "EXPOSE 3000",
  "# Exec form: no shell, so the signal reaching PID 1 is the one docker sent.",
  "HEALTHCHECK --interval=5s --timeout=5s --start-period=5s --retries=20 \\",
  '  CMD ["node", "/app/healthcheck.mjs"]',
  "USER node",
  'CMD ["node", "/app/dist/server.js"]',
]);

const EXPECTED_DOCKERIGNORE = lines([
  ...PROVENANCE("#"),
  "#",
  "# .env is excluded because it holds real credentials: a secret must never reach an image layer.",
  "node_modules",
  "**/node_modules",
  "dist",
  "**/dist",
  ".env",
  "*.log",
  ".git",
  "playwright-report",
  "test-results",
]);

const EXPECTED_OVERRIDE = lines([
  ...PROVENANCE("#"),
  "#",
  "# `docker compose` merges this into docker-compose.yml automatically. The `db` service, its",
  "# healthcheck and the db-data volume live THERE and are deliberately not repeated here.",
  "services:",
  "  app:",
  "    build:",
  "      context: .",
  "      dockerfile: Dockerfile",
  "    restart: unless-stopped",
  "    depends_on:",
  "      db:",
  "        condition: service_healthy",
  "    environment:",
  "      PORT: 3000",
  "      DATABASE_URL: ${DATABASE_URL:?set DATABASE_URL in .env}",
  "    healthcheck:",
  '      test: ["CMD", "node", "/app/healthcheck.mjs"]',
  "      interval: 5s",
  "      timeout: 5s",
  "      retries: 20",
  "  proxy:",
  "    image: caddy:2.11.4-alpine",
  "    restart: unless-stopped",
  "    depends_on:",
  "      app:",
  "        condition: service_healthy",
  "    ports:",
  '      - "3000:3000"',
  "    volumes:",
  '      - "./docker/Caddyfile:/etc/caddy/Caddyfile:rw"',
]);

const EXPECTED_CADDYFILE = lines([
  ...PROVENANCE("#"),
  "{",
  "\tadmin 127.0.0.1:2019",
  "}",
  "",
  ":3000 {",
  "\treverse_proxy app:3000",
  "}",
]);

const EXPECTED_HEALTHCHECK = lines([
  ...PROVENANCE("//"),
  "//",
  "// Exit 0 only on a 200. Any other status, a transport error or a timeout exits 1, which is what",
  "// docker reads as unhealthy. A check that exits 0 on a connection refusal reports a dead app up.",
  'import { get } from "node:http";',
  "",
  'const port = process.env.PORT ?? "3000";',
  "",
  "const request = get(",
  '  { host: "127.0.0.1", port, path: "/health", timeout: 5000 },',
  "  (response) => {",
  "    response.resume();",
  "    process.exit(response.statusCode === 200 ? 0 : 1);",
  "  },",
  ");",
  "",
  'request.on("timeout", () => {',
  "  request.destroy();",
  "  process.exit(1);",
  "});",
  'request.on("error", () => {',
  "  process.exit(1);",
  "});",
]);

/**
 * A reader for THESE TWO compose files, not a YAML implementation. Both are emitted by generators
 * in this repository with fixed two-space service indentation, so mapping `  name:` to the block
 * under it is exact for the only inputs it is ever handed.
 */
function composeServices(yaml: string): ReadonlyMap<string, readonly string[]> {
  const services = new Map<string, string[]>();
  let inServices = false;
  let current: string[] | null = null;

  for (const line of yaml.split("\n")) {
    if (/^\S/.test(line)) {
      inServices = line.startsWith("services:");
      current = null;
      continue;
    }
    if (!inServices) {
      continue;
    }
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header?.[1] !== undefined) {
      current = [];
      services.set(header[1], current);
      continue;
    }
    current?.push(line);
  }
  return services;
}

const imageOf = (body: readonly string[]): string | null => {
  for (const line of body) {
    const match = /^\s{4}image:\s*(\S+)\s*$/.exec(line);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return null;
};

describe("the generated deployment infrastructure", () => {
  it("pins every deployment artifact including the proxy configuration", () => {
    const files = written();

    expect(new Set(files.keys())).toEqual(new Set([
      ".dockerignore", "Dockerfile", "docker-compose.override.yml", "docker/Caddyfile", "docker/healthcheck.mjs",
    ]));
    expect(files.get("Dockerfile")).toEqual(EXPECTED_DOCKERFILE);
    expect(files.get(".dockerignore")).toEqual(EXPECTED_DOCKERIGNORE);
    expect(files.get("docker-compose.override.yml")).toEqual(EXPECTED_OVERRIDE);
    expect(files.get("docker/healthcheck.mjs")).toEqual(EXPECTED_HEALTHCHECK);
    expect(files.get("docker/Caddyfile")).toEqual(EXPECTED_CADDYFILE);

    for (const [path, body] of files) {
      expect(body.includes("\r"), path).toBe(false);
    }
  });

  it("emits byte-identical files for the same contract, whatever order it lists the requirements in", () => {
    const first = plan();
    const shuffled = plan({ deploymentRequirements: [...REQUIREMENTS].reverse() });
    const duplicated = plan({ deploymentRequirements: [...REQUIREMENTS, requirement("deployment-runtime")] });

    expect(first.ok && shuffled.ok && duplicated.ok).toBe(true);
    if (!first.ok || !shuffled.ok || !duplicated.ok) {
      return;
    }
    expect([...shuffled.write]).toEqual([...first.write]);
    expect([...duplicated.write]).toEqual([...first.write]);
    expect(first.requirementIds).toEqual(["deployment-loopback", "deployment-runtime"]);
  });

  it("changes the emitted bytes when the contract's deployment requirements change", () => {
    const other = plan({ deploymentRequirements: [requirement("deployment-elsewhere")] });

    expect(other.ok).toBe(true);
    if (!other.ok) {
      return;
    }
    // The contract is load-bearing on the bytes, not decoration: a different set is different files.
    expect(other.write.get("Dockerfile")).not.toEqual(EXPECTED_DOCKERFILE);
    expect(other.write.get("Dockerfile")).toContain("deployment-elsewhere");
  });

  it("never hands back bytes for a path the repository already carries", () => {
    const operatorDockerfile = "FROM scratch\n# the operator's own, hand-tuned\n";
    const result = plan({ existingPaths: ["Dockerfile", "docker-compose.override.yml"] });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(new Set(result.kept)).toEqual(new Set(["Dockerfile", "docker-compose.override.yml"]));
    expect(result.write.has("Dockerfile")).toBe(false);
    expect(result.write.has("docker-compose.override.yml")).toBe(false);
    // The point is the operator's BYTES surviving, not a boolean: writing the plan leaves them alone.
    const disk = new Map<string, string>([["Dockerfile", operatorDockerfile]]);
    for (const [path, body] of result.write) {
      disk.set(path, body);
    }
    expect(disk.get("Dockerfile")).toBe(operatorDockerfile);
    // What the repository lacks is still generated — conditional, not disabled.
    expect(new Set(result.write.keys())).toEqual(new Set([".dockerignore", "docker/Caddyfile", "docker/healthcheck.mjs"]));
  });

  it("keeps an existing proxy configuration instead of overwriting its upstream", () => {
    const result = plan({ existingPaths: ["docker/Caddyfile"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new Set(result.kept)).toEqual(new Set(["docker/Caddyfile"]));
    expect(new Set(result.write.keys())).toEqual(new Set([
      ".dockerignore", "Dockerfile", "docker-compose.override.yml", "docker/healthcheck.mjs",
    ]));
  });

  it("refuses an unknown profile version with DEPLOY_PROFILE_VERSION_UNKNOWN", () => {
    const result = plan({ profileVersion: "controlled-99" });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe(DEPLOY_PROFILE_VERSION_UNKNOWN);
  });

  it("refuses a contract with no deployment requirements with DEPLOY_REQUIREMENTS_ABSENT", () => {
    const result = plan({ deploymentRequirements: [] });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe(DEPLOY_REQUIREMENTS_ABSENT);
  });

  it("leaves the product with one compose project and exactly one postgres service", () => {
    // The scaffold's REAL base compose, read from its producer — not a copy pasted into this file.
    const base = controlledProfileRootFiles("probe").get("docker-compose.yml") ?? "";
    const override = written().get("docker-compose.override.yml") ?? "";

    const merged = new Map([...composeServices(base), ...composeServices(override)]);
    expect(new Set(merged.keys())).toEqual(new Set(["app", "db", "proxy"]));

    const postgres = [...merged].filter(([, body]) => (imageOf(body) ?? "").startsWith("postgres:"));
    expect(postgres.map(([name]) => name)).toEqual(["db"]);

    // The override contributes NO database and NO volumes block: both belong to the base file.
    expect(new Set(composeServices(override).keys())).toEqual(new Set(["app", "proxy"]));
    expect(override).not.toContain("postgres");
    expect(override).not.toContain("\nvolumes:");
  });

  it("publishes only the proxy port and keeps its writable admin configuration private", () => {
    const services = composeServices(written().get("docker-compose.override.yml") ?? "");
    expect(new Set(services.keys())).toEqual(new Set(["app", "proxy"]));
    const app = services.get("app") ?? [];
    const proxy = services.get("proxy") ?? [];
    expect(app).not.toContain("    ports:");
    expect(proxy).toContain("    ports:");
    expect(proxy.filter((line) => /^      - "\d+:\d+"$/.test(line))).toEqual(['      - "3000:3000"']);
    expect(imageOf(proxy)).toBe("caddy:2.11.4-alpine");
    expect(proxy).toContain('      - "./docker/Caddyfile:/etc/caddy/Caddyfile:rw"');
    expect(written().get("docker/Caddyfile")).toEqual(EXPECTED_CADDYFILE);
    expect(proxy.join("\n")).not.toContain("2019");
  });

  it("describes the app the scaffold actually generates", () => {
    // Preconditions the docker build arm depends on, read out of the scaffold's own templates so
    // the golden above cannot drift into pinning a Dockerfile that points at nothing.
    const packages = controlledProfilePackageFiles();
    const apiManifest = JSON.parse(packages.get("packages/api/package.json") ?? "{}") as {
      scripts?: Record<string, string>;
    };
    const server = packages.get("packages/api/src/server.ts") ?? "";
    const dockerfile = written().get("Dockerfile") ?? "";

    expect(dockerfile).toContain(`WORKDIR /app`);
    expect(`/app/${(apiManifest.scripts?.start ?? "").replace("node ", "")}`).toBe(DEPLOYMENT_ENTRY_PATH);
    expect(dockerfile).toContain(`CMD ["node", "${DEPLOYMENT_ENTRY_PATH}"]`);

    expect(/process\.env\.PORT \?\? "(\d+)"/.exec(server)?.[1]).toBe(String(DEPLOYMENT_APP_PORT));
    expect(dockerfile).toContain(`EXPOSE ${String(DEPLOYMENT_APP_PORT)}`);

    expect(/url === "([^"]+)"/.exec(server)?.[1]).toBe(DEPLOYMENT_HEALTH_PATH);
    expect(written().get("docker/healthcheck.mjs")).toContain(`path: "${DEPLOYMENT_HEALTH_PATH}"`);
  });

  it("runs the healthcheck it generates: 0 only when the app answers 200", async () => {
    // The byte-golden arm above pins this script's TEXT. That is not the same as its BEHAVIOUR:
    // rewriting its body to `process.exit(0)` reds the golden and nothing else, and a healthcheck
    // that always exits 0 reports a dead container as healthy. On a host with no docker this is the
    // only arm that can catch it, so it EXECUTES the generated script against a real server.
    const directory = mkdtempSync(join(tmpdir(), "moe-healthcheck-"));
    const script = join(directory, "healthcheck.mjs");
    let server: Server | null = null;
    try {
      writeFileSync(script, written().get("docker/healthcheck.mjs") ?? "", "utf8");

      // The app's own answer is what varies, so the 503 case exercises a REACHABLE but unhealthy
      // app — the state a check that exits 0 on any status would wave through.
      let answerWith = 200;
      const port = await new Promise<number>((resolve, reject) => {
        const created = createServer((request, response) => {
          const ok = request.url === DEPLOYMENT_HEALTH_PATH && answerWith === 200;
          response.writeHead(ok ? 200 : answerWith, { "content-type": "application/json" });
          response.end(JSON.stringify(ok ? { status: "ok" } : { error: "not ready" }));
        });
        server = created;
        created.on("error", reject);
        created.listen(0, "127.0.0.1", () => {
          const address = created.address();
          resolve(typeof address === "object" && address !== null ? address.port : 0);
        });
      });

      // ASYNCHRONOUS on purpose. `spawnSync` blocks this process's event loop, so the server above
      // could never accept the child's connection and every check would "time out" against a server
      // that is fine — a test that fails for its own reason and looks like a product defect.
      const check = async (port: number): Promise<number | null> =>
        await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [script], {
            env: { ...process.env, PORT: String(port) },
            shell: false,
            stdio: "ignore",
          });
          child.on("error", reject);
          child.on("close", (code) => resolve(code));
        });

      expect(await check(port)).toBe(0);

      // REACHABLE BUT UNHEALTHY. This is the case that catches `process.exit(0)`: the connection
      // succeeds and the app answers, so only reading the STATUS can tell the two apart.
      answerWith = 503;
      expect(await check(port)).toBe(1);

      // Nothing is listening here, so a check that still exits 0 is reporting a dead app up.
      answerWith = 200;
      expect(await check(port + 1)).toBe(1);
    } finally {
      // Epic rail 4: the port and the directory are released on the throwing path too.
      await new Promise<void>((resolve) => {
        server === null ? resolve() : (server as Server).close(() => resolve());
      });
      rmSync(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 200 });
    }
  }, 180_000);

  it("puts no credential in any emitted byte", () => {
    const root = controlledProfileRootFiles("probe");
    // The profile's own placeholder, read from .env.example rather than restated here.
    const placeholder = /POSTGRES_PASSWORD=(\S+)/.exec(root.get(".env.example") ?? "")?.[1];
    expect(placeholder).toBe("CHANGE_ME");

    for (const [path, body] of written()) {
      expect(body.includes(placeholder ?? "CHANGE_ME"), path).toBe(false);
      expect(/(?:PASSWORD|SECRET|TOKEN)\s*[:=]\s*(?!\$\{)\S/.test(body), path).toBe(false);
    }
    // .env carries the real values, so it must never reach a build context — layers outlive files.
    expect(written().get(".dockerignore")).toContain("\n.env\n");
  });
});
