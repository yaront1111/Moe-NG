import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { dockerUnavailableLine, probeDocker } from "../../../apps/daemon/src/repository/deployment/deployment-docker-probe.js";
import { candidateContainerName, createDeployService } from "../../../apps/daemon/src/deployment/deploy-service.js";
import { productionDeployPorts } from "../../../apps/daemon/src/deployment/deploy-command.js";
import { readDeployLedger } from "../../../apps/daemon/src/deployment/deploy-ledger.js";
import type { DeployMigrationResult } from "../../../apps/daemon/src/deployment/deploy-ports.js";
import { resolveDeployMigrationContext } from "../../../apps/daemon/src/deployment/deploy-migration-context.js";
import { migrateWithBackup } from "../../../apps/daemon/src/repository/migrations/migration-service.js";
import { readMigrationReceipt } from "../../../apps/daemon/src/repository/migrations/migration-receipt.js";
import { setEnvironmentVariable } from "../../../apps/daemon/src/environment/environment-store.js";
import { readEnvironmentDelivery } from "../../../apps/daemon/src/environment/environment-delivery.js";
import {
  PUBLIC_PORT, awaitAnswer, composeDown, composeUp, dockerQuietly, excludeLocally, installWorkspace,
  legDetail,
  liveContainers, materialize, removeWorkspace, reservePublicPort,
} from "./platform-pipeline-harness.js";

/**
 * DoD 5 FOR THE EPIC-FINAL ROW: NO SECRET SURFACES ANYWHERE ALONG THE PIPELINE.
 *
 * A GREP THAT FINDS NOTHING PROVES NOTHING ON ITS OWN. Zero hits is equally consistent with
 * perfect secrecy and with a canary that was never set, so this file proves DELIVERY FIRST — the
 * planted value is shown to have reached a real deployed process — and only then sweeps. Every
 * swept artifact is enumerated in the assertion message, because an unenumerated sweep is not
 * reproducible.
 *
 * THE CANARY'S SHAPE, never its value: `canary-not-a-secret-<12 hex>`. Deliberately NOT
 * credential-shaped. A plausible-looking secret committed to a test tree trips real credential
 * scanners and becomes its own incident, which is a worse outcome than the one being prevented.
 *
 * THE ERROR PATHS ARE SWEPT DELIBERATELY. A value leaks from a failed probe echoing a connection
 * string, a migration error quoting a DSN, or a docker argv logged with its `-e` arguments — none
 * of which a green run ever executes. So this file forces a REFUSED deploy and sweeps its detail
 * and its receipt alongside the successful one's.
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
const PROJECT_ID = "project-platform-canary";
/** SHAPE, not value: `canary-not-a-secret-` + 12 hex characters, minted per run. */
const CANARY = `canary-not-a-secret-${randomBytes(6).toString("hex")}`;
const CANARY_SHAPE = "canary-not-a-secret-<12 hex>";

interface Sweep {
  readonly label: string;
  readonly text: string;
}

/** Every artifact swept, named. The label is what the failure message prints. */
function hits(sweeps: readonly Sweep[]): readonly string[] {
  return sweeps.filter((sweep) => sweep.text.includes(CANARY)).map((sweep) => sweep.label);
}

function git(directory: string, args: readonly string[]): { readonly out: string; readonly status: number | null } {
  const outcome = spawnSync("git", [...args], { cwd: directory, encoding: "utf8", shell: false, timeout: 120_000 });
  return { out: `${outcome.stdout ?? ""}${outcome.stderr ?? ""}`, status: outcome.status };
}

function commitAll(directory: string, message: string): string {
  git(directory, ["add", "--all"]);
  git(directory, ["-c", "user.name=platform", "-c", "user.email=platform@moe.invalid", "commit", "--message", message]);
  const sha = git(directory, ["rev-parse", "HEAD"]).out.trim();
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("git rev-parse produced no sha");
  return sha;
}

interface Planted {
  readonly directory: string;
  readonly network: string;
  readonly project: string;
  readonly sha: string;
  readonly store: SqliteEventStore;
  readonly credential: string;
}

let planted: Planted | null = null;

afterAll(() => {
  if (planted === null) return;
  dockerQuietly(["rm", "--force", candidateContainerName(ENVIRONMENT, planted.sha, "decision-canary")], 120_000);
  composeDown(planted.project, planted.directory);
  dockerQuietly(["network", "rm", planted.network], 60_000);
  planted.store.close();
  removeWorkspace(planted.directory);
}, 600_000);

describe("the planted canary", () => {
  it("is shaped so it cannot occur naturally and cannot be mistaken for a credential", () => {
    expect(CANARY).toMatch(/^canary-not-a-secret-[0-9a-f]{12}$/u);
    // No scheme, no `@`, no `password=`: nothing a scanner would classify as a live secret.
    expect(CANARY).not.toMatch(/[:@/]|password|secret=|token/iu);
    expect(hits([{ label: "a text carrying the canary", text: `x${CANARY}y` }])).toEqual([
      "a text carrying the canary",
    ]);
    // The sweep must be able to FAIL, or a zero-hit result is meaningless.
    expect(hits([{ label: "a clean text", text: "nothing here" }])).toEqual([]);
  });

  it.runIf(RUN_PIPELINE)(
    "reaches the deployed process, and then appears in none of the delivered artifacts",
    async () => {
      const availability = probeDocker();
      if (!availability.available) expect.fail(dockerUnavailableLine(availability.detail));
      await reservePublicPort();

      const project = `moecanary${randomBytes(4).toString("hex")}`;
      const workspace = materialize("canary-product", `build-${randomBytes(3).toString("hex")}`, CANARY);
      const install = installWorkspace(workspace.directory, 1_800_000);
      expect(install.status, legDetail(install)).toBe(0);
      git(workspace.directory, ["init", "--initial-branch=main"]);
      // The scratch pnpm store lives inside the workspace so it dies with it; keep it out of the
      // product's history and out of the deploy's archive context.
      excludeLocally(workspace.directory, [".pnpm-store/", "node_modules/"]);
      const sha = commitAll(workspace.directory, "the scaffolded product");
      const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
      const credential = randomBytes(32).toString("hex");
      planted = { credential, directory: workspace.directory, network: `${project}_default`, project, sha, store };

      const up = composeUp(project, workspace.directory, 1_800_000);
      expect(up.status, legDetail(up)).toBe(0);
      await awaitAnswer("/health", 300_000);

      // PLANTED through the REAL encrypted store, not written straight to a file.
      const now = (): string => new Date().toISOString();
      const environmentConfig = { credential: () => credential, now, projectId: PROJECT_ID, store };
      const databaseUrl = `postgres://app:${CANARY}@127.0.0.1:5432/app`;
      for (const [name, value] of [["DATABASE_URL", databaseUrl], ["POSTGRES_PASSWORD", CANARY]] as const) {
        expect(setEnvironmentVariable(environmentConfig, { environment: ENVIRONMENT, name, value }).ok).toBe(true);
      }

      // DELIVERY PROOF 1 — the daemon's own read-back returns the planted value, so the store
      // round-trip (seal, then derive) is real rather than assumed.
      const delivered = readEnvironmentDelivery(
        { credential: () => credential, now, projectId: PROJECT_ID, store }, ENVIRONMENT,
      );
      expect(delivered.ok).toBe(true);
      expect(delivered.ok ? delivered.variables.POSTGRES_PASSWORD : null).toBe(CANARY);

      // DELIVERY PROOF 2 — THE DEPLOYED PROCESS. postgres accepts a connection authenticated with
      // the canary as the password, which no amount of local bookkeeping could fake: the running
      // database was started with this value and nothing else would authenticate.
      const database = dockerQuietly(["ps", "--filter", "label=com.docker.compose.service=db",
        "--filter", `network=${project}_default`, "--format", "{{.Names}}"]).stdout.trim();
      expect(database, "the compose db service was not discoverable").not.toBe("");
      const authenticated = dockerQuietly(["exec", "--env", `PGPASSWORD=${CANARY}`, database,
        "psql", "-U", "app", "-d", "app", "--tuples-only", "--command", "select 42"], 60_000);
      expect(authenticated.status, "the canary never reached the deployed database process").toBe(0);
      expect(authenticated.stdout).toContain("42");

      const migrate = async (
        environment: string, migrationSha: string, decisionId: string,
      ): Promise<DeployMigrationResult> => {
        const resolved = resolveDeployMigrationContext({
          credential: () => credential, now, projectId: PROJECT_ID, projectRoot: workspace.directory,
          store, workspace: workspace.directory,
        }, { environment, requestId: decisionId, sha: migrationSha });
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
      const service = createDeployService({
        healthBudgetMs: 150_000,
        ports: {
          ...productionDeployPorts(store, PROJECT_ID),
          migrate,
          target: () => ({ network: `${project}_default`, sshTarget: null, url: `http://127.0.0.1:${String(PUBLIC_PORT)}` }),
        },
        projectId: PROJECT_ID,
        store,
      });

      const deployed = await service.deploy({
        context: workspace.directory, decisionId: "decision-canary", environment: ENVIRONMENT, sha,
      });
      expect(deployed.outcome, deployed.detail).toBe("DEPLOYED");
      const candidate = candidateContainerName(ENVIRONMENT, sha, "decision-canary");

      // THE ERROR PATH, forced rather than hoped for: a sha that is not a commit refuses, and its
      // detail and receipt are swept alongside the successful ones.
      const refused = await service.deploy({
        context: workspace.directory, decisionId: "decision-canary-error", environment: ENVIRONMENT,
        sha: "0".repeat(40),
      });
      expect(refused.outcome).toBe("REFUSED");

      // EVERY DELIVERED ARTIFACT, ENUMERATED.
      const ledger = readDeployLedger(store, PROJECT_ID).get(ENVIRONMENT);
      const infrastructure = ["Dockerfile", ".dockerignore", "docker-compose.yml",
        "docker-compose.override.yml", "docker/Caddyfile", "docker/healthcheck.mjs"];
      const committed = git(workspace.directory, ["ls-files"]).out;
      const sweeps: Sweep[] = [
        { label: "the successful deploy's report detail", text: deployed.detail },
        { label: "the successful deploy's receipt", text: JSON.stringify(deployed.receipt) },
        { label: "the REFUSED deploy's report detail", text: refused.detail },
        { label: "the REFUSED deploy's receipt", text: JSON.stringify(refused.receipt) },
        { label: "the whole deploy ledger for this environment", text: JSON.stringify(ledger) },
        { label: "the migration receipt", text: JSON.stringify(readMigrationReceipt(store, PROJECT_ID, "decision-canary")) },
        { label: "the health probe response body", text: (await awaitAnswer("/health", 60_000)).body },
        { label: "the candidate container's inspected configuration", text: dockerQuietly(["inspect", candidate], 60_000).stdout },
        { label: "the candidate container's logs", text: `${dockerQuietly(["logs", candidate], 60_000).stdout}${dockerQuietly(["logs", candidate], 60_000).stderr}` },
        { label: "the proxy container's Caddyfile after the flip", text: dockerQuietly(["exec", dockerQuietly(["ps", "--filter", "label=com.docker.compose.service=proxy", "--filter", `network=${project}_default`, "--format", "{{.Names}}"]).stdout.trim(), "cat", "/etc/caddy/Caddyfile"], 60_000).stdout },
        { label: "the list of files git actually tracks", text: committed },
        ...infrastructure.map((relative) => ({
          label: `the generated infrastructure file ${relative}`,
          text: readFileSync(`${workspace.directory}/${relative}`, "utf8"),
        })),
        ...committed.split(/\r?\n/u).filter((line) => line.trim() !== "").map((relative) => ({
          label: `the committed fixture ${relative}`,
          text: readFileSync(`${workspace.directory}/${relative}`, "utf8"),
        })),
      ];

      expect(hits(sweeps), `the canary (shape ${CANARY_SHAPE}) surfaced in these artifacts`).toEqual([]);
      // `.env` carries the value and is the ONE place it is allowed to live — and it must never be
      // committed. The scaffold's .gitignore is what makes that true; assert it rather than trust it.
      expect(committed).not.toContain(".env\n");
      expect(readFileSync(`${workspace.directory}/.env`, "utf8")).toContain(CANARY);

      process.stdout.write(
        `SECRET CANARY shape=${CANARY_SHAPE} swept=${String(sweeps.length)} artifacts, hits=0\n`
        + `SECRET CANARY delivery proven by: encrypted-store read-back AND psql authentication against the running database\n`,
      );
      expect(liveContainers()).toContain(candidate);
    },
    3_600_000,
  );
});
