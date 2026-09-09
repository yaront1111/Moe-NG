/**
 * LIVE ACCEPTANCE for task-f4f45c281ab64f6dbf2c4ff163140010 — DoD 1 and DoD 2.
 *
 * Deploys through the REAL `createDeployService` with `productionDeployPorts` to a target whose
 * `sshTarget` is non-null, so every docker call travels `ssh <target> docker ...` with real stdin
 * carriage, and proves the delivered variable arrived BY RESPONSE from the deployed build.
 * Teardown runs on every exit path and the run ends with a census.
 *
 * Run: pnpm exec tsx apps/daemon/remote-deploy-acceptance.mts
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";

import { candidateContainerName, createDeployService } from "./src/deployment/deploy-service.js";
import { candidateEnvironmentPort } from "./src/deployment/deploy-candidate-environment.js";
import { productionDeployPorts } from "./src/deployment/deploy-command.js";
import { setEnvironmentVariable } from "./src/environment/environment-store.js";
import { deploymentInfrastructureFiles, DEPLOYMENT_NODE_IMAGE } from "./src/repository/deployment/deployment-infrastructure-templates.js";

const SSH_TARGET = "moe-canary-remote";
const RUN = randomBytes(4).toString("hex");
const NETWORK = `moe-acc-${RUN}`;
const PROXY = `moe-acc-proxy-${RUN}`;
const INCUMBENT = `moe-acc-app-${RUN}`;
const IMAGE = `moe-acc-app-${RUN}:1`;
const PROJECT = `project-acc-${RUN}`;
const ENVIRONMENT = "preview";
const DECISION = `decision-acc-${RUN}`;
/** SHAPE, not a credential: nothing a scanner would classify as live. */
const MARKER = `canary-not-a-secret-${randomBytes(6).toString("hex")}`;
const PORT = 18080 + (parseInt(RUN.slice(0, 2), 16) % 400);

const created: string[] = [];
let workspace: string | null = null;
let store: SqliteEventStore | null = null;
const failures: string[] = [];

const docker = (args: readonly string[], stdin?: string): { code: number | null; out: string } => {
  const r = spawnSync("docker", [...args], { encoding: "utf8", shell: false, input: stdin, timeout: 300_000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const check = (label: string, condition: boolean, detail = ""): void => {
  if (condition) { process.stdout.write(`  PASS ${label}\n`); return; }
  failures.push(label);
  process.stdout.write(`  FAIL ${label} ${detail}\n`);
};
const answer = async (path: string): Promise<string> => {
  const response = await fetch(`http://127.0.0.1:${String(PORT)}${path}`);
  return `${String(response.status)} ${await response.text()}`;
};
const settle = async (path: string, ms: number): Promise<string> => {
  const deadline = Date.now() + ms;
  for (;;) {
    try { return await answer(path); }
    catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
};

async function main(): Promise<void> {
  // ---- PRECONDITIONS, quoted rather than assumed --------------------------------------------
  const local = docker(["version", "--format", "{{.Server.Version}}"]);
  const remote = spawnSync("ssh", [SSH_TARGET, "docker", "version", "--format", "{{.Server.Version}}"],
    { encoding: "utf8", shell: false, timeout: 60_000 });
  process.stdout.write(`docker(local)=${local.out.trim()} exit=${String(local.code)}\n`);
  process.stdout.write(`docker(ssh ${SSH_TARGET})=${(remote.stdout ?? "").trim()} exit=${String(remote.status)}\n`);
  check("both docker endpoints answer", local.code === 0 && remote.status === 0);

  // ---- A REAL PRODUCT: a git repo the production builder can archive -------------------------
  workspace = mkdtempSync(join(tmpdir(), "moe-acc-"));
  writeFileSync(join(workspace, "server.mjs"), [
    'import { createServer } from "node:http";',
    "createServer((request, response) => {",
    '  response.writeHead(200, { "content-type": "text/plain" });',
    '  response.end(`MARKER=${process.env.ACCEPTANCE_MARKER ?? "<unset>"}`);',
    "}).listen(3000);",
    "",
  ].join("\n"));
  writeFileSync(join(workspace, "healthcheck.mjs"), [
    'import { get } from "node:http";',
    'get("http://127.0.0.1:3000/", (r) => { process.exit(r.statusCode === 200 ? 0 : 1); })',
    '  .on("error", () => { process.exit(1); });',
    "",
  ].join("\n"));
  writeFileSync(join(workspace, "Dockerfile"), [
    `FROM ${DEPLOYMENT_NODE_IMAGE}`,
    "WORKDIR /app",
    "COPY server.mjs healthcheck.mjs /app/",
    "USER node",
    "EXPOSE 3000",
    "HEALTHCHECK --interval=3s --timeout=3s --start-period=3s --retries=10 CMD [\"node\",\"/app/healthcheck.mjs\"]",
    'ENTRYPOINT ["node"]',
    'CMD ["/app/server.mjs"]',
    "",
  ].join("\n"));
  const git = (args: readonly string[]): string =>
    execFileSync("git", args, { cwd: workspace ?? "", encoding: "utf8" });
  git(["init", "--initial-branch=main"]);
  git(["add", "--all"]);
  git(["-c", "user.name=acc", "-c", "user.email=acc@moe.invalid", "commit", "--message", "acceptance product"]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  check("the product is a real commit", /^[a-f0-9]{40}$/u.test(sha), sha);

  // ---- THE TOPOLOGY the deploy engine expects -------------------------------------------------
  check("network created", docker(["network", "create", NETWORK]).code === 0);
  created.push(`network:${NETWORK}`);
  check("image built", docker(["build", "--tag", IMAGE, workspace]).code === 0);
  created.push(`image:${IMAGE}`);
  // THE INCUMBENT IS THE SAME BUILD WITH NO DELIVERY — that is what makes the negative control
  // exact: an identical image answering without the marker before the flip.
  const app = docker(["run", "--detach", "--name", INCUMBENT, "--network", NETWORK,
    "--network-alias", "app", "--label", "com.docker.compose.service=app", IMAGE]);
  check("incumbent started", app.code === 0, app.out);
  created.push(`container:${INCUMBENT}`);
  const caddyfile = deploymentInfrastructureFiles("", []).get("docker/Caddyfile") ?? "";
  writeFileSync(join(workspace, "Caddyfile"), caddyfile);
  const proxy = docker(["run", "--detach", "--name", PROXY, "--network", NETWORK,
    "--label", "com.docker.compose.service=proxy", "--publish", `127.0.0.1:${String(PORT)}:3000`,
    "--volume", `${join(workspace, "Caddyfile").replaceAll("\\", "/")}:/etc/caddy/Caddyfile:rw`,
    "caddy:2-alpine"]);
  check("proxy started", proxy.code === 0, proxy.out);
  created.push(`container:${PROXY}`);

  // ---- NEGATIVE CONTROL, before anything is delivered ------------------------------------------
  const before = await settle("/", 120_000);
  process.stdout.write(`BEFORE the flip: ${before}\n`);
  check("the incumbent answers", before.startsWith("200"), before);
  check("NEGATIVE CONTROL: the marker is absent before the deploy", !before.includes(MARKER), before);
  check("the incumbent read no delivery at all", before.includes("MARKER=<unset>"), before);

  // ---- THE PLANTED VALUE, through the REAL encrypted store --------------------------------------
  store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
  const credential = randomBytes(32).toString("hex");
  const config = { credential: () => credential, now: () => new Date().toISOString(), projectId: PROJECT, store };
  check("variable planted", setEnvironmentVariable(config,
    { environment: ENVIRONMENT, name: "ACCEPTANCE_MARKER", value: MARKER }).ok);

  // ---- THE DEPLOY, to a target whose docker host is reached over ssh ----------------------------
  // A TRACE, so a refusal names its leg. The receipt declassifies the detail on purpose, so the
  // only way to see WHICH call failed is at the port. Values never reach here: only argv[0..1].
  const base = productionDeployPorts(store, PROJECT);
  const trace = (label: string, code: number | null, err: string): void => {
    process.stdout.write(`  leg ${label} exit=${String(code)}${code === 0 ? "" : ` :: ${err.split(/\r?\n/u).filter((l) => l.trim() !== "").at(-1) ?? ""}`}\n`);
  };
  const service = createDeployService({
    healthBudgetMs: 150_000,
    ports: {
      ...base,
      build: async (request) => { const r = await base.build(request); trace("build", r.code, r.stderr); return r; },
      docker: async (args, stdin) => {
        const r = await base.docker(args, stdin);
        trace(`docker ${args.slice(0, 2).join(" ")}`, r.code, r.stderr); return r;
      },
      ssh: async (args, stdin) => {
        const r = await base.ssh(args, stdin);
        trace(`ssh ${args.slice(1, 3).join(" ")}`, r.code, r.stderr); return r;
      },
      transfer: async (tag, target) => { const r = await base.transfer(tag, target); trace("transfer", r.code, r.stderr); return r; },
      environment: candidateEnvironmentPort(config),
      target: () => ({ network: NETWORK, sshTarget: SSH_TARGET, url: `http://127.0.0.1:${String(PORT)}` }),
    },
    projectId: PROJECT, store,
  });
  const candidate = candidateContainerName(ENVIRONMENT, sha, DECISION);
  created.push(`container:${candidate}`);
  created.push(`image:moe-deploy-${ENVIRONMENT}:${sha}`);
  const report = await service.deploy({ context: workspace, decisionId: DECISION, environment: ENVIRONMENT, sha });
  process.stdout.write(`DEPLOY outcome=${report.outcome} detail=${report.detail}\n`);
  check("DoD 1: the remote deploy DEPLOYED", report.outcome === "DEPLOYED", report.detail);

  // ---- DoD 1: PROVEN BY RESPONSE FROM THE DEPLOYED BUILD ----------------------------------------
  const after = await settle("/", 120_000);
  process.stdout.write(`AFTER the flip:  ${after.replace(MARKER, "<the marker>")}\n`);
  check("DoD 1: the candidate ANSWERS with the delivered value", after.includes(`MARKER=${MARKER}`), after);
  check("the answer came from the candidate, not the incumbent",
    docker(["exec", PROXY, "cat", "/etc/caddy/Caddyfile"]).out.includes(`reverse_proxy ${candidate}:3000`));

  // ---- DoD 2: THE SWEEP, with its denominator ----------------------------------------------------
  const sweeps: { label: string; text: string }[] = [
    { label: "the candidate container's inspected configuration", text: docker(["inspect", candidate]).out },
    { label: "the candidate container's logs", text: docker(["logs", candidate]).out },
    { label: "the incumbent container's inspected configuration", text: docker(["inspect", INCUMBENT]).out },
    { label: "the proxy container's inspected configuration", text: docker(["inspect", PROXY]).out },
    { label: "the deployed image's inspected configuration", text: docker(["inspect", `moe-deploy-${ENVIRONMENT}:${sha}`]).out },
    { label: "the deployed image's history", text: docker(["history", "--no-trunc", `moe-deploy-${ENVIRONMENT}:${sha}`]).out },
    { label: "the whole container census", text: docker(["ps", "--all", "--no-trunc"]).out },
    { label: "the deploy report detail", text: report.detail },
    { label: "the deploy receipt", text: JSON.stringify(report.receipt) },
    { label: "the proxy Caddyfile after the flip", text: docker(["exec", PROXY, "cat", "/etc/caddy/Caddyfile"]).out },
    { label: "the ssh argv the engine composed for the copy", text: `ssh ${SSH_TARGET} docker cp - ${candidate}:/` },
  ];
  const hit = sweeps.filter((sweep) => sweep.text.includes(MARKER)).map((sweep) => sweep.label);
  // A SWEEP THAT SWEPT NOTHING PASSES WHILE PROVING NOTHING: prove the predicate can fire.
  check("the sweep can find the marker at all",
    [...sweeps, { label: "control", text: `x${MARKER}y` }].filter((s) => s.text.includes(MARKER)).length === 1);
  check("every swept artifact has content", sweeps.every((sweep) => sweep.text.length > 0));
  process.stdout.write(`SWEEP shape=canary-not-a-secret-<12 hex> swept=${String(sweeps.length)} artifacts, hits=${String(hit.length)}\n`);
  check(`DoD 2: no artifact carries the value (swept=${String(sweeps.length)})`, hit.length === 0, hit.join(", "));

  // ---- and the delivery really is a FILE in the container, not an env var -----------------------
  const inside = docker(["exec", "--user", "root", candidate, "ls", "-ln", "/run/moe/env"]);
  process.stdout.write(`INSIDE: ${inside.out.trim()}\n`);
  check("the delivery is a 0600 file owned by uid 1000", /^-rw-------\s+1\s+1000\s+1000\b/u.test(inside.out.trim()), inside.out);
  check("no ACCEPTANCE_MARKER in .Config.Env",
    !docker(["inspect", "--format", "{{json .Config.Env}}", candidate]).out.includes("ACCEPTANCE_MARKER"));
}

// TEARDOWN IS PART OF THE ARM. Epic rail 4: everything this run started, it stops — on the failure
// paths too — and the run ends with a census proving nothing of this run survived.
async function teardown(): Promise<void> {
  process.stdout.write("TEARDOWN\n");
  for (const owned of created.reverse()) {
    const [kind, ...rest] = owned.split(":");
    const name = rest.join(":");
    if (kind === "container") docker(["rm", "--force", "--volumes", name]);
    if (kind === "network") docker(["network", "rm", name]);
    if (kind === "image") docker(["image", "rm", "--force", name]);
  }
  store?.close();
  if (workspace !== null) { try { rmSync(workspace, { force: true, recursive: true }); } catch { /* windows handles */ } }
  const census = docker(["ps", "--all", "--format", "{{.Names}}"]).out;
  const survivors = census.split(/\r?\n/u).map((line) => line.trim())
    .filter((line) => line.includes(RUN) || line.startsWith("moe-deploy-"));
  process.stdout.write(`CENSUS docker ps -a survivors-of-this-run=${survivors.length === 0 ? "NONE" : survivors.join(",")}\n`);
  const images = docker(["images", "--format", "{{.Repository}}:{{.Tag}}"]).out;
  const leftImages = images.split(/\r?\n/u).map((line) => line.trim())
    // THIS RUN's images only. Other rows on this host leave `moe-deploy-preview:<their sha>`
    // behind; claiming those as leaks would be a false report in both directions.
    .filter((line) => line.includes(RUN) || created.includes(`image:${line}`));
  process.stdout.write(`CENSUS docker images survivors-of-this-run=${leftImages.length === 0 ? "NONE" : leftImages.join(",")}\n`);
  const networks = docker(["network", "ls", "--format", "{{.Name}}"]).out;
  process.stdout.write(`CENSUS docker networks survivors-of-this-run=${networks.includes(NETWORK) ? NETWORK : "NONE"}\n`);
  check("TEARDOWN: no container of this run survives", survivors.length === 0, survivors.join(","));
  check("TEARDOWN: no image of this run survives", leftImages.length === 0, leftImages.join(","));
  check("TEARDOWN: no network of this run survives", !networks.includes(NETWORK));
}

// The engine's own `nodeSleep` UNREFS its timer, so while it polls the candidate's health this
// process has nothing ref'd and node exits 13 mid-deploy. A daemon always has a ref'd server; a
// script does not. Held here rather than by overriding `sleep`, so the production sleep is the one
// under test.
const keepAlive = setInterval(() => {}, 1000);
try { await main(); }
catch (error) { failures.push(`THREW: ${String(error)}`); process.stdout.write(`THREW ${String(error)}\n`); }
finally { await teardown(); clearInterval(keepAlive); }
process.stdout.write(`\nRESULT ${failures.length === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures.join(" | ")}`}\n`);
process.exit(failures.length === 0 ? 0 : 1);
