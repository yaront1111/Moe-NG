/**
 * THE FRESH PRODUCT'S DEPLOYABLE SURFACE: the server the container runs, its healthcheck, and
 * the Dockerfile a real `docker build` consumes.
 *
 * WHY THIS IS WRITTEN HERE AND NOT BY THE PRODUCT. Moe DOES carry an infrastructure generator --
 * `repository/deployment/deployment-infrastructure-generator.ts`, which emits a Dockerfile, a
 * compose override, a Caddyfile, a healthcheck and a .dockerignore from the contract's
 * deployment requirements. MEASURED 2026-09-09: `grep -rn "planDeploymentInfrastructure"
 * --include=*.ts apps/daemon/src | grep -v test` returns ZERO callers. The generator is wired to
 * no command kind, so no browser action and no operator action can ask a repository for its
 * infrastructure -- and its template targets a pnpm workspace with a `packages/api` that
 * compiles to `dist/server.js`, which a freshly bootstrapped repository does not have. So the
 * product cannot generate this, and the transcript says so rather than implying it did. The gap
 * is recorded as a follow-up item, not papered over.
 *
 * THE SHAPE STILL TRACES TO PRODUCTION. Every constant below -- the base image, the port, the
 * health route, the healthcheck's path inside the image and its timeout -- is IMPORTED from the
 * production templates module rather than retyped, so this scaffolding cannot drift from the
 * shape the product would emit if the generator were ever wired.
 *
 * WHAT IT IS NOT. It is not product logic: no criterion is checked here, no sign-in, no entry,
 * no error code. The server answers a health route and re-exports whatever the SEATS delivered.
 * If the seats delivered nothing the container still starts and still answers health, and the
 * criteria -- which are checked elsewhere, against the modules -- are what would fail.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEPLOYMENT_APP_PORT, DEPLOYMENT_HEALTHCHECK_PATH, DEPLOYMENT_HEALTH_PATH,
  DEPLOYMENT_HEALTH_TIMEOUT_SECONDS, DEPLOYMENT_NODE_IMAGE,
} from "../../../apps/daemon/src/repository/deployment/deployment-infrastructure-templates.js";

/** Where the healthcheck script lives in the repository, before the image relocates it. */
const HEALTHCHECK_SOURCE = "docker/healthcheck.mjs";
const SERVER = "server.mjs";

/**
 * The manifest, which exists for the PREVIEW rather than for the image.
 *
 * `preview-runner.ts:162` spawns `npm run <script>` and `PREVIEW_SCRIPT_ORDER` prefers
 * `preview` -> `dev` -> `start`. Exactly ONE of the three is declared so which script ran is
 * never ambiguous. The image installs nothing: this application declares no dependencies.
 */
const MANIFEST = `${JSON.stringify({
  name: "standup", private: true, scripts: { start: "node server.mjs" }, type: "module",
}, null, 2)}
`;

const serverSource = (): string => [
  '// The fresh product\'s HTTP surface. It serves the health route the image probes and,',
  '// when the seats have delivered, the integration module they built.',
  'import { createServer } from "node:http";',
  "",
  "const PORT = Number(process.env.PORT ?? 0);",
  "let product = null;",
  "try {",
  '  product = await import("./node-integration/module.mjs");',
  "} catch (error) {",
  '  console.log(`product module unavailable: ${String(error)}`);',
  "}",
  "",
  "const server = createServer((request, response) => {",
  '  const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);',
  `  if (url.pathname === ${JSON.stringify(DEPLOYMENT_HEALTH_PATH)}) {`,
  '    response.writeHead(200, { "content-type": "application/json" });',
  "    response.end(JSON.stringify({ product: product !== null, status: \"UP\" }));",
  "    return;",
  "  }",
  '  if (url.pathname === "/api/entries" && product !== null) {',
  '    const session = request.headers["x-session-email"] === undefined',
  '      ? null : { email: String(request.headers["x-session-email"]) };',
  '    const answer = product.getEntries(session, url.searchParams.get("date") ?? "");',
  '    response.writeHead(answer.status, { "content-type": "application/json" });',
  "    response.end(JSON.stringify(answer.body));",
  "    return;",
  "  }",
  "  response.writeHead(404);",
  '  response.end("");',
  "});",
  '// `listen(0)` when PORT is unset, so a preview never collides with another lane on this',
  "// host. The PRINTED LINE IS THE CONTRACT: `detectPreviewPort` matches an",
  "// `http(s)://127.0.0.1:<port>` ORIGIN and nothing else, so a server that printed only its",
  "// number would never be detected and the preview would time out with no cause on screen.",
  'server.listen(PORT, "0.0.0.0", () => {',
  "  const address = server.address();",
  '  const port = typeof address === "object" && address !== null ? address.port : PORT;',
  '  process.stdout.write(`http://127.0.0.1:${port}\\n`);',
  "});",
  "",
].join("\n");

const healthcheckSource = (): string => [
  "// Probes the app's OWN health route from inside the container. Exit 0 is healthy.",
  'import { request } from "node:http";',
  "",
  `const timer = setTimeout(() => { process.exit(1); }, ${String(DEPLOYMENT_HEALTH_TIMEOUT_SECONDS * 1000)});`,
  "const probe = request({",
  `  host: "127.0.0.1", path: ${JSON.stringify(DEPLOYMENT_HEALTH_PATH)},`,
  `  port: Number(process.env.PORT ?? ${String(DEPLOYMENT_APP_PORT)}), timeout: ${String(DEPLOYMENT_HEALTH_TIMEOUT_SECONDS * 1000)},`,
  "}, (response) => {",
  "  clearTimeout(timer);",
  "  process.exit(response.statusCode === 200 ? 0 : 1);",
  "});",
  'probe.on("error", () => { clearTimeout(timer); process.exit(1); });',
  "probe.end();",
  "",
].join("\n");

const dockerfileSource = (): string => [
  "# The fresh product's image. Single stage on purpose: this application declares NO",
  "# dependencies and needs no build, so a build stage would install nothing and compile",
  "# nothing. The image therefore needs no network at build time.",
  `FROM ${DEPLOYMENT_NODE_IMAGE} AS runtime`,
  "WORKDIR /app",
  "ENV NODE_ENV=production",
  `ENV PORT=${String(DEPLOYMENT_APP_PORT)}`,
  "COPY . .",
  `COPY ${HEALTHCHECK_SOURCE} ./healthcheck.mjs`,
  `EXPOSE ${String(DEPLOYMENT_APP_PORT)}`,
  "# Exec form: no shell, so the signal reaching PID 1 is the one docker sent.",
  `HEALTHCHECK --interval=5s --timeout=${String(DEPLOYMENT_HEALTH_TIMEOUT_SECONDS)}s --start-period=5s --retries=20 \\`,
  `  CMD ["node", "${DEPLOYMENT_HEALTHCHECK_PATH}"]`,
  "USER node",
  `CMD ["node", "/app/${SERVER}"]`,
  "",
].join("\n");

/** Paths that must never reach the build context: the daemon's own confined backup tree. */
const dockerignoreSource = (): string => [
  ".moe-next/",
  ".git/",
  "",
].join("\n");

/** The path the healthcheck occupies INSIDE the image, for a caller that probes the container. */
export const IMAGE_HEALTHCHECK_PATH = DEPLOYMENT_HEALTHCHECK_PATH;

/**
 * Writes the deployable surface into the product repository and answers the paths written.
 *
 * The caller commits them: this function performs no git, so the same bytes can be inspected
 * before they are ever committed.
 */
export function writeDeployableSurface(workspace: string): readonly string[] {
  mkdirSync(join(workspace, "docker"), { recursive: true });
  writeFileSync(join(workspace, "package.json"), MANIFEST, "utf8");
  writeFileSync(join(workspace, SERVER), serverSource(), "utf8");
  writeFileSync(join(workspace, HEALTHCHECK_SOURCE), healthcheckSource(), "utf8");
  writeFileSync(join(workspace, "Dockerfile"), dockerfileSource(), "utf8");
  writeFileSync(join(workspace, ".dockerignore"), dockerignoreSource(), "utf8");
  return Object.freeze([".dockerignore", "Dockerfile", HEALTHCHECK_SOURCE, "package.json", SERVER]);
}
