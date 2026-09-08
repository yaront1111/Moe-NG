import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  DEPLOY_DOCKER_UNAVAILABLE,
  dockerUnavailableLine,
  probeDocker,
} from "../../../apps/daemon/src/repository/deployment/deployment-docker-probe.js";
import { candidateContainerName, createDeployService } from "../../../apps/daemon/src/deployment/deploy-service.js";
import { readDeployLedger } from "../../../apps/daemon/src/deployment/deploy-ledger.js";
import { resolveRollbackOffers } from "../../../apps/daemon/src/http/affordance-rollback-offers.js";
import { resolveRollbackTarget } from "../../../apps/daemon/src/deployment/rollback-target.js";
import { productionDeployPorts } from "../../../apps/daemon/src/deployment/deploy-command.js";
import { nodeDeployBuild } from "../../../apps/daemon/src/deployment/deploy-image-build.js";
import type { DeployMigrationResult } from "../../../apps/daemon/src/deployment/deploy-ports.js";
import { resolveDeployMigrationContext } from "../../../apps/daemon/src/deployment/deploy-migration-context.js";
import { migrateWithBackup } from "../../../apps/daemon/src/repository/migrations/migration-service.js";
import { setEnvironmentVariable } from "../../../apps/daemon/src/environment/environment-store.js";
import {
  BUILD_ROUTE, HEALTH_PATH, PUBLIC_PORT, awaitAnswer, composeDown, composeUp, dockerQuietly,
  excludeLocally, installWorkspace, legDetail, liveContainers, liveNetworks, materialize,
  removeWorkspace, request, reservePublicPort, rewriteBuildRoute,
  withBuildRoute,
} from "./platform-pipeline-harness.js";

/**
 * DoD 2 AND DoD 3 FOR THE EPIC-FINAL ROW: one goal reaches a running deployed environment, and
 * back out again — both proven by an HTTP RESPONSE from the running thing, never by a receipt.
 *
 * WHY THE LIVE ARM IS OPT-IN (`MOE_PLATFORM_PIPELINE=1`), and why that is not a skip. The identical
 * question was already decided one band down, in `deployment-image-build.test.ts`: an arm that
 * pulls base images and installs from the network cannot run unconditionally inside a gate every
 * row on this board executes — and this file is matched by the ROOT `vitest.config.ts` include
 * (`tests/**\/*.test.ts`), so unconditionally it would land in `pnpm test` for every seat. The flag
 * separates two different conditions with two different answers: without it the expensive arm does
 * not run and the always-on arms below carry the wiring; WITH it and no docker daemon the arm FAILS
 * LOUDLY with a `DEPLOY_DOCKER_UNAVAILABLE:` line — never a skip, never a silent pass.
 *
 * NOTHING IN THE CHAIN IS DOUBLED (task rail 1). The scaffold is the real generator, the topology
 * is real `docker compose`, the build is the real archive builder against a real commit, the
 * variables go through the real encrypted environment store, the migration is the real
 * `migrateWithBackup` behind the real resolver, and the deploy and rollback are the real
 * `createDeployService`. The two things this file supplies itself are named here so a reader does
 * not have to hunt for them: the DEPLOY TARGET (which network and URL an environment is bound to)
 * is configuration a real operator sets once via `deployment.set_target`, not a link in the chain;
 * and the ENVIRONMENT CREDENTIAL is the daemon's own key material, supplied by the composition
 * root in production. Neither carries any of the behaviour under test.
 *
 * THESE LIVE FILES CANNOT RUN IN PARALLEL WITH EACH OTHER. Each stands up the generated topology
 * VERBATIM, which publishes the product's real host ports (3000 for the proxy, 5432 for the
 * database), so two of them at once lose the bind — measured: `docker compose up --wait` exits
 * non-zero for whichever loses. Run them with `--no-file-parallelism` (or one file at a time) when
 * `MOE_PLATFORM_PIPELINE=1` is set. Flagless, they neither bind nor conflict, which is why the
 * root gate is unaffected.
 */

const RUN_PIPELINE = process.env.MOE_PLATFORM_PIPELINE === "1";
const ENVIRONMENT = "preview";
const PROJECT_ID = "project-platform-pipeline";
/** Deliberately not credential-shaped: a plausible-looking secret in a test trips real scanners. */
const CANARY = `canary-not-a-secret-${randomBytes(6).toString("hex")}`;

function git(directory: string, args: readonly string[]): void {
  const outcome = spawnSync("git", [...args], { cwd: directory, encoding: "utf8", shell: false, timeout: 120_000 });
  if (outcome.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${outcome.stderr ?? ""}`);
  }
}

/** Commit the whole worktree and return the sha the deploy will be asked for, verbatim. */
function commitAll(directory: string, message: string): string {
  git(directory, ["add", "--all"]);
  git(directory, ["-c", "user.name=platform", "-c", "user.email=platform@moe.invalid", "commit", "--message", message]);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8", shell: false });
  const sha = (head.stdout ?? "").trim();
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error(`git rev-parse produced no sha: ${head.stderr ?? ""}`);
  return sha;
}

function why(report: { readonly detail: string; readonly receipt: { readonly refusal: { readonly code: string; readonly detail: string } | null } | null }): string {
  const refusal = report.receipt?.refusal;
  return refusal === null || refusal === undefined ? report.detail : `${report.detail} / ${refusal.code}: ${refusal.detail}`;
}

/** The tables the deployed database actually holds, as postgres itself reports them. */
function tables(container: string): string {
  // A plain SQL query rather than psql's `\dt` meta-command: the backslash would have to survive
  // a TypeScript string, a Node argv and psql's own parser, and it does not.
  const listed = dockerQuietly(["exec", container, "psql", "-U", "app", "-d", "app", "--tuples-only",
    "--command", "select tablename from pg_tables where schemaname = 'public' order by tablename"], 60_000);
  return `${listed.stdout}${listed.stderr}`;
}

interface ServedBuild {
  readonly build: string;
}

async function servedBuild(): Promise<string> {
  const answer = await awaitAnswer(BUILD_ROUTE, 120_000);
  expect(answer.status, `${BUILD_ROUTE} answered ${String(answer.status)}: ${answer.body}`).toBe(200);
  return (JSON.parse(answer.body) as ServedBuild).build;
}

describe("the platform pipeline", () => {
  it("marks the served build inside the generated server, so a response names it", () => {
    const source = ['  if (url === "/health") {', "    return ok;", "  }"].join("\n");
    const marked = withBuildRoute(source, "build-alpha");
    expect(marked).toContain('if (url === "/build")');
    expect(marked).toContain('{ build: "build-alpha" }');
    // The anchor must still be there: a marker that REPLACED /health would prove nothing about
    // health and would make the incumbent's own healthcheck fail for an unrelated reason.
    expect(marked).toContain('if (url === "/health") {');
  });

  it("refuses to mark a server that no longer carries the route it anchors on", () => {
    expect(() => withBuildRoute("export function handle() { return null; }", "build-alpha"))
      .toThrow(/no longer carries the \/health route/u);
  });

  it("fails loudly, with the reason code on the line, when the live arm cannot reach docker", () => {
    // The exact line the arm below fails with, produced by the same shipped function it calls.
    const line = dockerUnavailableLine("no docker daemon answered (exit 1): ...");
    expect(line.startsWith(`${DEPLOY_DOCKER_UNAVAILABLE}: `)).toBe(true);
  });

  it("names the candidate container after the environment, the sha and the decision", () => {
    const name = candidateContainerName(ENVIRONMENT, "a".repeat(40), "decision-1");
    expect(name).toBe(`moe-deploy-${ENVIRONMENT}-${"a".repeat(12)}-decision1`);
  });

  it.runIf(RUN_PIPELINE)(
    "drives one goal to a running deployed environment and back out again",
    async () => {
      const availability = probeDocker();
      if (!availability.available) {
        // NOT a skip and NOT a silent pass: the arm was asked to run and cannot.
        expect.fail(dockerUnavailableLine(availability.detail));
      }
      await reservePublicPort();

      const project = `moepipeline${randomBytes(4).toString("hex")}`;
      const network = `${project}_default`;
      const buildA = `build-a-${randomBytes(4).toString("hex")}`;
      const buildB = `build-b-${randomBytes(4).toString("hex")}`;
      const workspace = materialize("pipeline-product", buildA, CANARY);
      const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
      const candidates: string[] = [];

      try {
        git(workspace.directory, ["init", "--initial-branch=main"]);
        // The scratch pnpm store lives inside the workspace so it dies with it; keep it out of the
        // product's history and out of the deploy's archive context.
        excludeLocally(workspace.directory, [".pnpm-store/", "node_modules/"]);
        const shaA = commitAll(workspace.directory, "the scaffolded product");

        // The migration TOOL is a workspace dependency, so the tree must be installed before the
        // deploy can migrate it — the same state a CI checkout is in before it deploys.
        const install = installWorkspace(workspace.directory, 1_800_000);
        expect(install.status, legDetail(install)).toBe(0);

        // LINK 1 AND 2: the generated topology, brought up by real compose. This is the INCUMBENT
        // the deploy will replace, and `--wait` returns only once every healthcheck passes.
        const up = composeUp(project, workspace.directory, 1_800_000);
        expect(up.status, legDetail(up)).toBe(0);

        // DoD 2, first half, BY RESPONSE: the deployed thing SERVES.
        const health = await awaitAnswer(HEALTH_PATH, 300_000);
        expect(health.status).toBe(200);
        expect(JSON.parse(health.body)).toEqual({ status: "ok" });
        expect(await servedBuild()).toBe(buildA);

        // CROSS-BAND CONTRACT, asserted before the deploy depends on it: the deploy engine finds
        // the proxy by the compose SERVICE LABEL scoped to the network, so a scaffold that stopped
        // emitting a `proxy` service — or a deploy bound to another network — is a defect neither
        // band's own tests can see.
        const discovered = dockerQuietly(["ps", "--filter", "label=com.docker.compose.service=proxy",
          "--filter", `network=${network}`, "--format", "{{.Names}}"]);
        expect(discovered.stdout.trim(), legDetail(discovered)).not.toBe("");

        // The archive builder, exercised on its own so its stderr is readable: the deploy engine
        // buckets every build failure under DEPLOY_BUILD_FAILED and the receipt detail is redacted.
        const probeBuild = await nodeDeployBuild({
          context: workspace.directory, sha: shaA, tag: `moe-deploy-${ENVIRONMENT}:${shaA}`,
        });
        expect(probeBuild.code, `${probeBuild.stdout.slice(-1500)}
${probeBuild.stderr.slice(-1500)}`).toBe(0);

        // LINK 3: the variables, through the REAL encrypted store. The migration reads them back
        // from here — nothing hands the connection string to it directly.
        const credential = randomBytes(32).toString("hex");
        const now = (): string => new Date().toISOString();
        const environmentConfig = { credential: () => credential, now, projectId: PROJECT_ID, store };
        for (const [name, value] of [
          ["DATABASE_URL", `postgres://app:${CANARY}@127.0.0.1:5432/app`],
          ["POSTGRES_PASSWORD", CANARY],
        ] as const) {
          const set = setEnvironmentVariable(environmentConfig, { environment: ENVIRONMENT, name, value });
          expect(set.ok, `setting ${name} refused: ${set.ok ? "" : set.code}`).toBe(true);
        }

        // LINK 4 AND 5: the real migration behind the real resolver, composed exactly as
        // `deploy-command.ts` composes it for every production deploy.
        const migrate = async (
          environment: string, sha: string, decisionId: string,
        ): Promise<DeployMigrationResult> => {
          const resolved = resolveDeployMigrationContext({
            credential: () => credential, now, projectId: PROJECT_ID,
            projectRoot: workspace.directory, store, workspace: workspace.directory,
          }, { environment, requestId: decisionId, sha });
          if (!resolved.ok) return { code: resolved.code, detail: "", layer: resolved.layer, ok: false };
          const receipt = await migrateWithBackup(store, resolved.input);
          if (receipt.outcome === "APPLIED") return { applied: receipt.applied, ok: true };
          return {
            code: receipt.refusal?.code ?? "MIGRATION_FAILED",
            detail: receipt.refusal?.detail ?? "",
            layer: receipt.refusal?.layer ?? "DAEMON_INGRESS",
            ok: false,
          };
        };

        // The migration, exercised on its own for the same reason as the build: the deploy engine
        // carries a migration refusal in a detail the receipt redacts.
        const probeMigration = await migrate(ENVIRONMENT, shaA, "decision-probe");
        expect(probeMigration.ok, JSON.stringify(probeMigration)).toBe(true);

        const service = createDeployService({
          ports: {
            ...productionDeployPorts(store, PROJECT_ID),
            migrate,
            target: () => ({ network, sshTarget: null, url: `http://127.0.0.1:${String(PUBLIC_PORT)}` }),
          },
          projectId: PROJECT_ID,
          store,
        });

        const first = await service.deploy({
          context: workspace.directory, decisionId: "decision-a", environment: ENVIRONMENT, sha: shaA,
        });
        candidates.push(candidateContainerName(ENVIRONMENT, shaA, "decision-a"));
        expect(first.outcome, why(first)).toBe("DEPLOYED");
        expect(await servedBuild()).toBe(buildA);

        // A SECOND, REAL COMMIT: two deploys of byte-identical trees are indistinguishable over
        // HTTP, so "the previous sha is serving" could only be shown by receipt — which DoD 3
        // refuses. This is the smallest honest source change a new sha can carry.
        rewriteBuildRoute(workspace, buildB);
        const shaB = commitAll(workspace.directory, "the second build");
        expect(shaB).not.toBe(shaA);

        const second = await service.deploy({
          context: workspace.directory, decisionId: "decision-b", environment: ENVIRONMENT, sha: shaB,
        });
        candidates.push(candidateContainerName(ENVIRONMENT, shaB, "decision-b"));
        expect(second.outcome, why(second)).toBe("DEPLOYED");

        // DoD 2, THE WHOLE CLAUSE: the running environment answers, and the answer names the sha
        // that was just deployed rather than merely proving something is up on the port.
        expect(await servedBuild()).toBe(buildB);
        expect((await request(HEALTH_PATH)).status).toBe(200);

        // DoD 3: BACK OUT AGAIN, and the PREVIOUS build answers.
        const receiptA = first.receipt;
        expect(receiptA).not.toBeNull();
        // DoD 3, THE CLAUSE THAT CATCHES A HARNESS-ONLY ROLLBACK: the control an operator actually
        // has is an OFFER on `/affordances/read`, and the receipt it would spend is chosen by the
        // shared resolver — not by this test. A rollback provable only from a harness would pass
        // without these three lines.
        const offered = resolveRollbackOffers({ projectId: PROJECT_ID, store });
        expect(offered.refused).toBeNull();
        expect(offered.offers).toHaveLength(1);
        expect(offered.offers[0]?.aggregateId).toBe(PROJECT_ID);
        expect(offered.offers[0]?.kind).toBe("deployment.rollback");
        const operatorTarget = resolveRollbackTarget(
          readDeployLedger(store, PROJECT_ID).get(ENVIRONMENT) ?? null,
        );
        expect(operatorTarget?.sha, "the operator's offered target is not the previous deploy").toBe(shaA);
        // The receipt the OPERATOR would spend, not one this test picked out of its own variables.
        expect(operatorTarget?.toReceiptRef).toBe(receiptA?.receiptId);

        // The schema BEFORE the rollback: the migration ran during the deploys, so the table the
        // scaffold's initial migration creates must already be there.
        const database = dockerQuietly(["ps", "--filter", "label=com.docker.compose.service=db",
          "--filter", `network=${network}`, "--format", "{{.Names}}"]).stdout.trim();
        expect(database, "the compose db service was not discoverable").not.toBe("");
        expect(tables(database)).toContain("app_metadata");

        // The ROLLBACK STARTS A CONTAINER TOO, under its own decision id. Registering it before the
        // call rather than after is the difference between a cleanup list and a leak: measured on
        // this row, an unregistered rollback candidate survived the run and then pinned the compose
        // network open, so `compose down` could not remove it either.
        candidates.push(candidateContainerName(ENVIRONMENT, shaA, "decision-rollback"));
        const rolled = await service.rollback({
          decisionId: "decision-rollback", environment: ENVIRONMENT,
          receiptId: operatorTarget?.toReceiptRef ?? "",
        });
        expect(rolled.outcome, why(rolled)).toBe("DEPLOYED");
        expect(await servedBuild()).toBe(buildA);

        // WHAT HAPPENED TO THE SCHEMA ACROSS THE ROLLBACK, stated rather than assumed. The engine
        // runs `migrateFor` on the rollback leg too (deploy-service.ts, after the digest check and
        // before the candidate starts), with the PREVIOUS sha and a new decision id — so the
        // forward migration is re-attempted, finds nothing to apply, and the schema STAYS
        // MIGRATED. A rollback does NOT revert it. That is a real property of the shipped code and
        // an operator reading "rolled back" must not infer their schema moved with it.
        expect(tables(database)).toContain("app_metadata");

        process.stdout.write(
          `PLATFORM PIPELINE server=${availability.serverVersion} shaA=${shaA} shaB=${shaB}\n`
          + `PLATFORM PIPELINE deployed=${buildB} rolledBackTo=${buildA}\n`,
        );
      } finally {
        // Rail 2: anything this row starts, it stops — on the throwing path too.
        for (const name of candidates) dockerQuietly(["rm", "--force", name], 120_000);
        composeDown(project, workspace.directory);
        // Compose removes the network only when nothing is still attached. A candidate this run
        // started and failed to remove would leave it behind, so the network is removed by name
        // and the census below is what proves it.
        dockerQuietly(["network", "rm", network], 60_000);
        store.close();
        removeWorkspace(workspace.directory);
        // Rail 2, by REAL QUERY rather than by a cleanup function that returned: docker itself is
        // asked what is still alive. Raised from the `finally` so a leak is reported even when the
        // body already failed — a leaked container makes the NEXT gate on this board inadmissible.
        const orphanContainers = liveContainers().filter((name) => candidates.includes(name));
        const orphanNetworks = liveNetworks().filter((name) => name === network);
        if (orphanContainers.length > 0 || orphanNetworks.length > 0) {
          throw new Error(
            `the pipeline leaked: containers=${orphanContainers.join(",")} networks=${orphanNetworks.join(",")}`,
          );
        }
      }
    },
    3_600_000,
  );
});
