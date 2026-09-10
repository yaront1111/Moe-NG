import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { probeDocker } from "../deployment/deployment-docker-probe.js";
import { CONTROLLED_PROFILE_VERSION, generateControlledProfile } from "./controlled-profile-generator.js";

/**
 * LIVE PROOF THAT A NEWLINE-BEARING DATABASE PASSWORD NEVER REACHES `initdb`.
 *
 * The defect this file pins: postgres reads POSTGRES_PASSWORD_FILE through `$(< "$file")`, and
 * command substitution strips ALL trailing newlines. The mounted secret carries the operator's
 * exact bytes, the database initialises a DIFFERENT credential, and the operator can never log in
 * while the container reports healthy. Exact-byte delivery cannot be achieved from outside the
 * image, so the generated compose REFUSES the input instead, at a guard the database depends on.
 *
 * Like MOE_SCAFFOLD_BUILD and MOE_SCAFFOLD_MIGRATE, the live half is opt-in
 * (`MOE_SCAFFOLD_PASSWORD_GUARD=1`) because it needs a docker daemon. Opt-in, never a silent skip:
 * with the flag set, an unavailable daemon FAILS the arm with its refusal code.
 *
 * NOTHING HERE MAY PERSIST A VALUE. Every planted password is random, lives only in the scratch
 * `.env`, and is compared by COUNT or by boolean. No assertion message interpolates one.
 */

const RUN_GUARD = process.env.MOE_SCAFFOLD_PASSWORD_GUARD === "1";
const NEWLINE_MARKER = "POSTGRES_PASSWORD_NEWLINE_UNSUPPORTED";
const UNREADABLE_MARKER = "POSTGRES_PASSWORD_SECRET_UNREADABLE";
const GUARD = "db-password-guard";
/** The guard's own secret mount, ending at the top-level `volumes:` key. Removed to inject a fault. */
const GUARD_SECRET_BLOCK =
  "    secrets:\n      - source: POSTGRES_PASSWORD\n        target: postgres_password\n\nvolumes:\n";
const MISSING_SECRET_STDERR =
  'secret "POSTGRES_PASSWORD" must declare either `file` or `environment`: invalid compose project\n';
/**
 * `$0` is a label, `$1` the container's own network address - NEVER loopback, where pg_hba answers
 * `trust` and a wrong password authenticates too. The `.` sentinel survives the trailing newline
 * that the command substitution would otherwise strip, so psql receives the exact planted bytes.
 */
const AUTH_SHELL =
  'PGPASSWORD=$(cat; printf .); PGPASSWORD=${PGPASSWORD%.}; export PGPASSWORD; ' +
  'exec psql -h "$1" -U app -d app -v ON_ERROR_STOP=1 -tAc "SELECT 1"';

type Variant = "normal" | "space-dollar";

function emitted(): ReadonlyMap<string, string> {
  const result = generateControlledProfile({
    productName: "password-probe", profileVersion: CONTROLLED_PROFILE_VERSION,
  });
  if (!result.ok) throw new Error(`${result.code}@${result.refusedBy}`);
  return result.files;
}

/** Inherited `npm_*`/NODE_OPTIONS confuse child tooling; an inherited password would poison compose. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_") || key === "NODE_OPTIONS") delete env[key];
  }
  delete env.POSTGRES_PASSWORD;
  return env;
}

function docker(args: readonly string[], input?: string) {
  const result = spawnSync("docker", [...args], {
    env: childEnv(), encoding: "utf8", shell: false, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  if (result.error !== undefined) throw new Error("DOCKER_SPAWN_FAILED");
  return result;
}

function checked(args: readonly string[]): string {
  const result = docker(args);
  expect(result.status, `DOCKER_COMMAND_FAILED: docker ${args[0] ?? ""}`).toBe(0);
  return result.stdout ?? "";
}

/** `docker logs` relays the container's stderr on the CLI's stderr, so stdout alone reads EMPTY. */
function logsOf(id: string): string {
  const result = docker(["logs", id]);
  expect(result.status, "DOCKER_LOGS_FAILED").toBe(0);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function inspected(id: string, format: string): string {
  return checked(["inspect", "--format", format, id]).trim();
}

/** A random value with the shape under test. `space-dollar` keeps special characters supported. */
function plant(variant: Variant | "newline"): string {
  const body = randomBytes(24).toString("hex");
  if (variant === "space-dollar") return `${body} $ trailing `;
  return variant === "newline" ? `${body}\n` : body;
}

function writeDotEnv(root: string, value: string): void {
  writeFileSync(join(root, ".env"), `POSTGRES_PASSWORD='${value}'\nPOSTGRES_USER=app\nPOSTGRES_DB=app\n`, "utf8");
}

function materialize(root: string, overrides: ReadonlyMap<string, string> = new Map()): void {
  for (const [relative, body] of emitted()) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, overrides.get(relative) ?? body, "utf8");
  }
}

/** Ids of a service's containers, running or exited, scoped to this project only. */
function containerIds(project: string, service: string): readonly string[] {
  const output = checked(["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`,
    "--filter", `label=com.docker.compose.service=${service}`]).trim();
  return output === "" ? [] : output.split("\n");
}

function labelled(project: string, kind: "volume" | "network"): readonly string[] {
  const output = checked([kind, "ls", "--quiet", "--filter", `label=com.docker.compose.project=${project}`]).trim();
  return output === "" ? [] : output.split("\n");
}

interface Project {
  readonly root: string;
  readonly project: string;
  readonly base: readonly string[];
}

function open(files: readonly string[] = ["docker-compose.yml"], overrides?: ReadonlyMap<string, string>): Project {
  const root = mkdtempSync(join(tmpdir(), "moe-password-guard-"));
  materialize(root, overrides);
  const project = `moe-guard-${randomUUID().slice(0, 8)}`;
  const base = ["compose", "--project-name", project, "--project-directory", root,
    "--env-file", join(root, ".env"), ...files.flatMap((file) => ["-f", join(root, file)])];
  return { root, project, base };
}

/**
 * TEARDOWN ON EVERY EXIT PATH, INCLUDING THE THROWING ONE. `.env` is rewritten with a FRESH random
 * value first: `down` re-resolves the secret declaration, so an unset/empty `.env` would refuse the
 * teardown itself and leak the containers this file created.
 */
function close({ root, project, base }: Project): void {
  try {
    writeDotEnv(root, plant("normal"));
    expect(docker([...base, "down", "--volumes", "--remove-orphans"]).status, "COMPOSE_TEARDOWN_FAILED").toBe(0);
    expect(checked(["ps", "--all", "--quiet", "--filter",
      `label=com.docker.compose.project=${project}`]).trim(), "COMPOSE_LEAKED_CONTAINERS").toBe("");
    expect(labelled(project, "volume").length, "COMPOSE_LEAKED_VOLUMES").toBe(0);
    expect(labelled(project, "network").length, "COMPOSE_LEAKED_NETWORKS").toBe(0);
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error("UNSAFE_SCRATCH_ROOT");
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

function requireDocker(): void {
  const availability = probeDocker();
  if (!availability.available) expect.fail(availability.code);
}

/** The guard refused, the database was never created, and nothing was left to hold a half cluster. */
function expectRefusedBeforeInitialisation(open_: Project, marker: string, value: string): void {
  const { project, base } = open_;
  expect(docker([...base, "up", "--detach", "--wait", "--wait-timeout", "90", "db"]).status,
    "GUARD_DID_NOT_REFUSE").not.toBe(0);

  const guards = containerIds(project, GUARD);
  expect(guards).toHaveLength(1);
  const logs = logsOf(guards[0] ?? "");
  expect(logs, "GUARD_REFUSED_FOR_THE_WRONG_REASON").toContain(marker);
  expect(logs).toContain("POSTGRES_PASSWORD");
  // The guard prints fixed literals only: its own output must never carry the planted value.
  expect(logs.split(value).length - 1, "GUARD_LEAKED_THE_VALUE").toBe(0);
  expect(inspected(guards[0] ?? "", "{{.State.ExitCode}}"), "GUARD_EXITED_CLEAN").not.toBe("0");

  // MEASURED, not assumed: compose CREATES the database container and its named volume before it
  // runs the dependency, so "no db container" and "no volume" are the wrong bar - both exist. The
  // bar that matters is that the database never STARTED, so `initdb` never chose a credential.
  const databases = containerIds(project, "db");
  expect(databases).toHaveLength(1);
  expect(inspected(databases[0] ?? "", "{{.State.Status}}"),
    "DATABASE_STARTED_BEHIND_A_FAILED_GUARD").toBe("created");
  expect(inspected(databases[0] ?? "", "{{.State.StartedAt}}")).toBe("0001-01-01T00:00:00Z");

  // And prove the storage directly rather than by inference from the container state: the volume
  // exists and is EMPTY, so nothing carries a half-initialised cluster into the operator's retry.
  const volumes = labelled(project, "volume");
  expect(volumes).toHaveLength(1);
  expect(checked(["run", "--rm", "--volume", `${volumes[0] ?? ""}:/probe:ro`, "postgres:17-alpine",
    "ls", "-A", "/probe"]).trim(), "HALF_INITIALISED_CLUSTER_PERSISTED").toBe("");
}

describe("the generated scaffold's database password guard", () => {
  it("emits the exact markers and the exact secret block this file's live arms assert on", () => {
    const compose = emitted().get("docker-compose.yml") ?? "";

    // ANTI-DRIFT. Renaming a marker in the template would leave every live arm below asserting a
    // string the scaffold no longer emits, and they would fail for a reason nobody could read.
    expect(compose.split(NEWLINE_MARKER)).toHaveLength(2);
    expect(compose.split(UNREADABLE_MARKER)).toHaveLength(2);
    expect(compose).toContain(`  ${GUARD}:\n`);
    expect(compose).toContain(`    depends_on:\n      ${GUARD}:\n        condition: service_completed_successfully\n`);
    // NON-VACUITY FOR THE FAULT INJECTION: the surgery below removes exactly this one occurrence.
    expect(compose.split(GUARD_SECRET_BLOCK)).toHaveLength(2);
  });

  it.runIf(RUN_GUARD).each(["normal", "space-dollar"] as const)(
    "authenticates with the exact supplied bytes and refuses a wrong password: %s", async (variant: Variant) => {
      requireDocker();
      const value = plant(variant);
      const project = open();
      try {
        writeDotEnv(project.root, value);
        expect(docker([...project.base, "up", "--detach", "--wait", "--wait-timeout", "180", "db"]).status,
          "DATABASE_DID_NOT_START").toBe(0);
        expect(containerIds(project.project, GUARD), "GUARD_DID_NOT_RUN").toHaveLength(1);

        const id = checked([...project.base, "ps", "--quiet", "db"]).trim();
        expect(id).toMatch(/^[a-f0-9]{64}$/u);
        const address = checked(["inspect", "--format",
          "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", id]).trim();
        expect(address).toMatch(/^\d{1,3}(?:\.\d{1,3}){3}$/u);

        const auth = docker(["exec", "--interactive", id, "sh", "-c", AUTH_SHELL, "password-probe", address], value);
        expect(auth.status, "EXACT_BYTE_AUTH_FAILED").toBe(0);
        expect(auth.stdout.trim()).toBe("1");

        // NEGATIVE CONTROL: without it, an arm that authenticates everything reads identical.
        const wrong = docker(["exec", "--interactive", id, "sh", "-c", AUTH_SHELL, "password-probe", address],
          randomBytes(24).toString("hex"));
        expect(wrong.status, "WRONG_PASSWORD_WAS_ACCEPTED").toBe(2);
        expect(wrong.stderr).toContain("password authentication failed");
      } finally {
        close(project);
      }
    }, 900_000);

  it.runIf(RUN_GUARD)("refuses a trailing-newline password before the database initialises", async () => {
    requireDocker();
    const value = plant("newline");
    const project = open();
    try {
      writeDotEnv(project.root, value);
      expectRefusedBeforeInitialisation(project, NEWLINE_MARKER, value);
    } finally {
      close(project);
    }
  }, 900_000);

  it.runIf(RUN_GUARD)("refuses to start the database when the guard cannot read the secret", async () => {
    requireDocker();
    const value = plant("normal");
    const compose = emitted().get("docker-compose.yml") ?? "";
    const mutant = compose.replace(GUARD_SECRET_BLOCK, "\nvolumes:\n");
    // The injected fault must actually have applied, or this arm proves nothing.
    expect(mutant).not.toBe(compose);
    expect(mutant.split("      - source: POSTGRES_PASSWORD\n")).toHaveLength(2);

    const project = open(["docker-compose.yml"], new Map([["docker-compose.yml", mutant]]));
    try {
      writeDotEnv(project.root, value);
      expectRefusedBeforeInitialisation(project, UNREADABLE_MARKER, value);
    } finally {
      close(project);
    }
  }, 900_000);

  it.runIf(RUN_GUARD)("refuses to start the database when the guard itself cannot start", async () => {
    requireDocker();
    const fault = `services:\n  ${GUARD}:\n    image: moe-guard-absent:${randomUUID().slice(0, 8)}\n`;
    const project = open(["docker-compose.yml", "fault.yml"]);
    try {
      writeFileSync(join(project.root, "fault.yml"), fault, "utf8");
      writeDotEnv(project.root, plant("normal"));
      expect(docker([...project.base, "up", "--detach", "--wait", "--wait-timeout", "90", "db"]).status,
        "DATABASE_STARTED_WITHOUT_A_WORKING_GUARD").not.toBe(0);
      expect(containerIds(project.project, "db"), "DATABASE_STARTED_WITHOUT_A_WORKING_GUARD").toEqual([]);
      expect(labelled(project.project, "volume"), "HALF_INITIALISED_CLUSTER_PERSISTED").toEqual([]);
    } finally {
      close(project);
    }
  }, 900_000);

  it.runIf(RUN_GUARD).each(["unset", "empty"] as const)(
    "still refuses a missing password with the compose project error: %s", async (mode) => {
      requireDocker();
      const project = open();
      try {
        writeFileSync(join(project.root, ".env"), mode === "unset" ? "" : "POSTGRES_PASSWORD=''\n", "utf8");
        const result = docker([...project.base, "up", "--detach", "db"]);
        expect(result.status, "MISSING_PASSWORD_GUARD_WEAKENED").toBe(1);
        expect(result.stderr).toBe(MISSING_SECRET_STDERR);
        expect(containerIds(project.project, GUARD)).toEqual([]);
        expect(containerIds(project.project, "db")).toEqual([]);
      } finally {
        close(project);
      }
    }, 900_000);
});
