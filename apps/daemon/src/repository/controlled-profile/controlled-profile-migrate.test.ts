import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { probeDocker } from "../deployment/deployment-docker-probe.js";
import { CONTROLLED_PROFILE_VERSION, generateControlledProfile } from "./controlled-profile-generator.js";

// Like MOE_SCAFFOLD_BUILD: network + Docker are opt-in, never silently skipped when requested.
// The always-on arm pins every prerequisite that could otherwise make that opt-in vacuous.
const RUN_MIGRATE = process.env.MOE_SCAFFOLD_MIGRATE === "1";
const INITIAL_PATH = "migrations/1700000000000-initial.js";

interface Manifest {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
}

function emitted(): ReadonlyMap<string, string> {
  const result = generateControlledProfile({
    productName: "migration-probe", profileVersion: CONTROLLED_PROFILE_VERSION,
  });
  if (!result.ok) throw new Error(`${result.code}@${result.refusedBy}`);
  return result.files;
}

// Reuse the build harness convention: inherited npm_config_filter can yield exit 0/no projects.
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_") || key === "NODE_OPTIONS") delete env[key];
  }
  return env;
}

function run(cwd: string, command: "pnpm" | "docker", args: readonly string[], env = childEnv()) {
  // Executable pnpm, not pnpm.cmd (EINVAL on Windows); never shell command strings/chains/pipes.
  const result = spawnSync(command, [...args], {
    cwd, env, shell: false, encoding: "utf8", timeout: 600_000,
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

function checked(cwd: string, command: "pnpm" | "docker", args: readonly string[], env = childEnv()): string {
  const result = run(cwd, command, args, env);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (command === "pnpm") {
    process.stdout.write(`GENERATED PRODUCT pnpm ${args.join(" ")} -> ${String(result.status)}\n${output}\n`);
  }
  expect(result.status, `${command} ${args.join(" ")}\n${output}`).toBe(0);
  return result.stdout ?? "";
}

function materialize(dir: string): void {
  for (const [relative, body] of emitted()) {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, "utf8");
  }
}

async function awaitPostgres(dir: string, name: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    // TCP readiness excludes the temporary socket-only server used during image initialization.
    const ready = run(dir, "docker", ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "app", "-d", "app"]);
    if (ready.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("MIGRATION_POSTGRES_NOT_READY");
}

function query(dir: string, name: string, sql: string): string {
  return checked(dir, "docker", ["exec", name, "psql", "-U", "app", "-d", "app", "-v", "ON_ERROR_STOP=1", "-tAc", sql]).trim();
}

function cleanup(dir: string, name: string): void {
  try {
    // Even a timed-out docker run may have created the container. Always remove its UNIQUE name.
    run(dir, "docker", ["rm", "--force", "--volumes", name]);
    const remaining = checked(dir, "docker", ["ps", "--all", "--quiet", "--filter", `name=^/${name}$`]);
    expect(remaining.trim(), "MIGRATION_CONTAINER_CLEANUP_FAILED").toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function migrateAgainstPostgres(dir: string, name: string): Promise<void> {
  materialize(dir);
  const before = readFileSync(join(dir, "pnpm-lock.yaml"), "utf8");
  checked(dir, "pnpm", ["install", "--frozen-lockfile"]);
  expect(readFileSync(join(dir, "pnpm-lock.yaml"), "utf8")).toBe(before);
  // Disposable, loopback-only, no credentials minted or fixture secrets. Never use trust in production.
  checked(dir, "docker", ["run", "--detach", "--name", name, "--publish", "127.0.0.1::5432",
    "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--env", "POSTGRES_USER=app",
    "--env", "POSTGRES_DB=app", "postgres:17-alpine"]);
  await awaitPostgres(dir, name);
  const binding = checked(dir, "docker", ["port", name, "5432/tcp"]).trim();
  expect(binding).toMatch(/^127\.0\.0\.1:\d+$/);
  const env = { ...childEnv(), DATABASE_URL: `postgres://app@${binding}/app` };
  const tableExists = "SELECT (to_regclass('public.app_metadata') IS NOT NULL)::text";
  expect(query(dir, name, tableExists)).toBe("false");
  checked(dir, "pnpm", ["db:migrate"], env);
  expect(query(dir, name, tableExists), "MIGRATION_UP_TABLE_MISSING").toBe("true");
  expect(query(dir, name, "SELECT count(*) FROM pgmigrations")).toBe("1");
  process.stdout.write("GENERATED PRODUCT up: public.app_metadata PRESENT, pgmigrations=1\n");
  checked(dir, "pnpm", ["db:migrate:down"], env);
  expect(query(dir, name, tableExists), "MIGRATION_DOWN_TABLE_REMAINS").toBe("false");
  expect(query(dir, name, "SELECT count(*) FROM pgmigrations")).toBe("0");
  process.stdout.write("GENERATED PRODUCT down: public.app_metadata ABSENT, pgmigrations=0\n");
}

describe("the generated app's migrations", () => {
  it("always emits both runnable scripts and a nonempty migration directory", () => {
    const files = emitted();
    const manifest = JSON.parse(files.get("package.json") ?? "{}") as Manifest;
    expect.soft(manifest.scripts?.["db:migrate"]).toBe("node-pg-migrate up");
    expect.soft(manifest.scripts?.["db:migrate:down"]).toBe("node-pg-migrate down 1");
    expect.soft(manifest.dependencies?.["node-pg-migrate"]).toBe("9.0.0");
    expect.soft(manifest.dependencies?.["pg"]).toBe("8.23.0");
    expect([...files.keys()].filter((path) => path.startsWith("migrations/"))).toEqual([INITIAL_PATH]);
    expect(files.get(INITIAL_PATH)?.trim().length).toBeGreaterThan(0);
  });

  it.runIf(RUN_MIGRATE)("migrates up and down against disposable real PostgreSQL", async () => {
    const availability = probeDocker();
    if (!availability.available) expect.fail(availability.code);
    const name = `moe-migrate-${randomUUID()}`;
    const dir = mkdtempSync(join(tmpdir(), "moe-migrate-"));
    try {
      await migrateAgainstPostgres(dir, name);
    } finally {
      cleanup(dir, name);
    }
  }, 1_800_000);
});
