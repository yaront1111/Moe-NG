/**
 * The infrastructure files the controlled profile does NOT ship: a multi-stage Dockerfile, the
 * build-context exclusions it needs, app/proxy services, and a healthcheck the image can run itself.
 *
 * SAME DETERMINISM RULE AS THE SCAFFOLD SIBLING: line arrays joined with "\n" plus a trailing "\n",
 * never a multi-line template literal (whose indentation and line endings follow this file's own
 * formatting), no clock, no random source, no cwd, no host tool version, no `os.EOL`.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT EMIT: a `docker-compose.yml`, and any postgres service.
 * The scaffold (task-4a0f7064, landed) already emits `docker-compose.yml` with exactly one postgres
 * service `db`, and an operator's compose is theirs. The app and its public proxy arrive as
 * `docker-compose.override.yml`, which `docker compose` merges into the base file by default, so a
 * product ends up with ONE project and ONE database — which is what the migrations row assumes.
 *
 * NO CREDENTIAL LITERAL LIVES IN ANY EMITTED BYTE. Every value is `${VAR}` or read from the
 * environment at runtime, mirroring the discipline the scaffold's own compose comment states.
 */

/** Joined with "\n" and terminated with one — the profile's file shape, byte for byte. */
const file = (lines: readonly string[]): string => `${lines.join("\n")}\n`;

/**
 * Pinned to the profile's own `engines.node` (">=24.16.0 <25") and to the node version its CI
 * workflow sets up. A floating `node:24-alpine` would make two builds of the same contract differ.
 */
export const DEPLOYMENT_NODE_IMAGE = "node:24.16.0-alpine" as const;

/** The app's internal port and the public port owned only by the override's proxy. */
export const DEPLOYMENT_APP_PORT = 3000 as const;

/** The route the profile's api answers 200 on. The healthcheck probes exactly this. */
export const DEPLOYMENT_HEALTH_PATH = "/health" as const;

/** Where the runtime stage puts the compiled api, and therefore what `CMD` names. */
export const DEPLOYMENT_ENTRY_PATH = "/app/dist/server.js" as const;

/** Where the healthcheck script lands inside the image. */
export const DEPLOYMENT_HEALTHCHECK_PATH = "/app/healthcheck.mjs" as const;

/**
 * ONE timeout, spent in two places: the script's own socket deadline and docker's `--timeout`.
 * They must not drift. An inner deadline SHORTER than docker's would call a slow-but-healthy app
 * unhealthy and restart a working container, before docker had decided to give up on it.
 */
export const DEPLOYMENT_HEALTH_TIMEOUT_SECONDS = 5 as const;

/**
 * The provenance header. The contract's deployment requirements are PROSE — they carry no port,
 * image or path field — so they are not parsed into build parameters. They are recorded here, so a
 * different requirement set is different bytes and the generated file traces to what it satisfies.
 */
function provenance(comment: string, profileVersion: string, requirementIds: readonly string[]): readonly string[] {
  return [
    `${comment} Generated for profile ${profileVersion}. Do not edit: regenerate instead.`,
    `${comment} Satisfies deployment requirements: ${requirementIds.join(", ")}`,
  ];
}

/**
 * Multi-stage: the build stage carries pnpm, the toolchain and every devDependency; the runtime
 * stage carries node and the compiled output. `packages/api` declares NO runtime dependencies, so
 * the runtime stage needs no `node_modules` at all — which is why nothing is copied from the build
 * stage except `dist`.
 */
export function dockerfile(profileVersion: string, requirementIds: readonly string[]): string {
  return file([
    ...provenance("#", profileVersion, requirementIds),
    "#",
    "# The runtime stage carries no package manager, no source and no node_modules: packages/api",
    "# declares only devDependencies, so the compiled output plus node is the whole application.",
    "",
    `FROM ${DEPLOYMENT_NODE_IMAGE} AS build`,
    "WORKDIR /src",
    "RUN corepack enable",
    "# The whole workspace, minus everything .dockerignore excludes. The lockfile is committed and",
    "# the install is frozen, so this layer is reproducible for a given tree.",
    "COPY . .",
    "RUN pnpm install --frozen-lockfile",
    "RUN pnpm --filter api build",
    "",
    `FROM ${DEPLOYMENT_NODE_IMAGE} AS runtime`,
    "WORKDIR /app",
    "ENV NODE_ENV=production",
    `ENV PORT=${String(DEPLOYMENT_APP_PORT)}`,
    "COPY --from=build /src/packages/api/dist ./dist",
    "COPY docker/healthcheck.mjs ./healthcheck.mjs",
    `EXPOSE ${String(DEPLOYMENT_APP_PORT)}`,
    "# Exec form: no shell, so the signal reaching PID 1 is the one docker sent.",
    `HEALTHCHECK --interval=5s --timeout=${String(DEPLOYMENT_HEALTH_TIMEOUT_SECONDS)}s --start-period=5s --retries=20 \\`,
    `  CMD ["node", "${DEPLOYMENT_HEALTHCHECK_PATH}"]`,
    "USER node",
    `CMD ["node", "${DEPLOYMENT_ENTRY_PATH}"]`,
  ]);
}

/**
 * Without this the build context is the whole checkout: the host's `node_modules` (megabytes of
 * platform-specific binaries that would then be baked over by the install), a stale `dist`, and —
 * the one that matters — a real `.env`, which carries the very password the compose file goes out
 * of its way never to inline.
 */
export function dockerignore(profileVersion: string, requirementIds: readonly string[]): string {
  return file([
    ...provenance("#", profileVersion, requirementIds),
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
}

/**
 * ONLY the `app` service. `docker compose` reads `docker-compose.yml` and this file together by
 * default, so `db`, its healthcheck and the `db-data` volume all come from the scaffold's base file
 * and are not restated here — restating them is how a product ends up with two databases.
 */
export function dockerComposeOverride(profileVersion: string, requirementIds: readonly string[]): string {
  const port = String(DEPLOYMENT_APP_PORT);
  // Official caddy-docker tag pinned by fba2853501d36e8a72f946ac8cb7ff64d07e48f2/2.11/alpine.
  return file([
    ...provenance("#", profileVersion, requirementIds),
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
    `      PORT: ${port}`,
    "      DATABASE_URL: ${DATABASE_URL:?set DATABASE_URL in .env}",
    "    healthcheck:",
    `      test: ["CMD", "node", "${DEPLOYMENT_HEALTHCHECK_PATH}"]`,
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
    `      - "${port}:${port}"`,
    "    volumes:",
    '      - "./docker/Caddyfile:/etc/caddy/Caddyfile:rw"',
  ]);
}

/** Only the proxy owns the public socket. Reload uses its private, loopback-only admin API. */
function caddyfile(profileVersion: string, requirementIds: readonly string[]): string {
  return file([
    ...provenance("#", profileVersion, requirementIds),
    "{",
    "\tadmin 127.0.0.1:2019",
    "}",
    "",
    `:${String(DEPLOYMENT_APP_PORT)} {`,
    `\treverse_proxy app:${String(DEPLOYMENT_APP_PORT)}`,
    "}",
  ]);
}

/**
 * A node script rather than `curl` or `wget`: the runtime image is `node:*-alpine`, whose shell
 * tools are busybox applets that may change between base image revisions. Probing with the runtime
 * that is definitionally present makes the check depend on nothing the image does not already have.
 */
export function healthcheckScript(profileVersion: string, requirementIds: readonly string[]): string {
  return file([
    ...provenance("//", profileVersion, requirementIds),
    "//",
    "// Exit 0 only on a 200. Any other status, a transport error or a timeout exits 1, which is what",
    "// docker reads as unhealthy. A check that exits 0 on a connection refusal reports a dead app up.",
    'import { get } from "node:http";',
    "",
    `const port = process.env.PORT ?? "${String(DEPLOYMENT_APP_PORT)}";`,
    "",
    "const request = get(",
    `  { host: "127.0.0.1", port, path: "${DEPLOYMENT_HEALTH_PATH}", timeout: ${String(DEPLOYMENT_HEALTH_TIMEOUT_SECONDS * 1000)} },`,
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
}

/**
 * Every artifact this row generates, keyed by forward-slash relative path, sorted by UTF-16 code
 * unit like the scaffold's own maps. The caller decides which of these the repository lacks.
 */
export function deploymentInfrastructureFiles(
  profileVersion: string,
  requirementIds: readonly string[],
): ReadonlyMap<string, string> {
  return new Map([
    [".dockerignore", dockerignore(profileVersion, requirementIds)],
    ["Dockerfile", dockerfile(profileVersion, requirementIds)],
    ["docker-compose.override.yml", dockerComposeOverride(profileVersion, requirementIds)],
    ["docker/Caddyfile", caddyfile(profileVersion, requirementIds)],
    ["docker/healthcheck.mjs", healthcheckScript(profileVersion, requirementIds)],
  ]);
}
