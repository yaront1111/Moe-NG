import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { SqliteEventStore } from "@moe/store";
import { installTestRecoveryBinding } from "../../identity/session-test-fixtures.js";
import { createVerifierDatabaseRunner } from "../../orchestrator/verifier-database.js";
import { CONTROLLED_PROFILE_VERSION, generateControlledProfile } from "../controlled-profile/controlled-profile-generator.js";
import { migrateWithBackup } from "./migration-service.js";
import { nodeMigrationPorts } from "./migration-ports.js";
import { readMigrationReceipt } from "./migration-receipt.js";

const RUN = process.env.MOE_MIGRATION_RESTORE === "1";
const initial = "1700000000000-initial.js";
const added = "1700000000001_added.js";
const broken = "1700000000002-broken.js";
function docker(args: readonly string[], input?: number): string {
  const result = spawnSync("docker", [...args], { shell: false, windowsHide: true,
    timeout: 30_000, encoding: "utf8", stdio: [input ?? "ignore", "pipe", "pipe"] });
  if (result.status !== 0 || result.error) throw new Error("MIGRATION_TEST_DOCKER_FAILED");
  return result.stdout;
}
function materialize(root: string): void {
  const generated = generateControlledProfile({ productName: "migration-proof", profileVersion: CONTROLLED_PROFILE_VERSION });
  if (!generated.ok) throw new Error(`${generated.code}@${generated.refusedBy}`);
  for (const [path, body] of generated.files) {
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body);
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("npm_") || key === "NODE_OPTIONS") delete env[key];
  const install = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: root, env, shell: false, encoding: "utf8", timeout: 600_000,
  });
  expect(install.error).toBeUndefined();
  expect(install.status, "GENERATED_PRODUCT_INSTALL_FAILED").toBe(0);
  writeFileSync(join(root, "holding-recipe.mjs"),
    "import { existsSync } from 'node:fs'; while (!existsSync('release')) await new Promise(r => setTimeout(r, 30));\n");
}

it("pins the live restore gate and actual lifecycle/engine imports", () => {
  expect(typeof createVerifierDatabaseRunner).toBe("function");
  expect(typeof migrateWithBackup).toBe("function");
  expect(typeof nodeMigrationPorts().dump).toBe("function");
});

// Opt-in performs real work; Docker unavailable with flag=1 FAILS, never silently skips.
it.runIf(RUN)("restores the changed schema and keeps it untouched after a failed backup", async () => {
  docker(["version", "--format", "{{.Server.Version}}"]);
  const root = mkdtempSync(join(tmpdir(), "moe-migration-live-"));
  const names: string[] = [];
  let ready: (url: string) => void = () => undefined;
  const connection = new Promise<string>(resolve => { ready = resolve; });
  const brief = { workspace: root, test: "node holding-recipe.mjs", instructions: "restore proof", title: "restore proof" };
  const runner = createVerifierDatabaseRunner({ timeoutMs: 180_000, spawn: (file, args, options) => {
    if (file === "docker" && args[0] === "run") names.push(args[args.indexOf("--name") + 1]!);
    if (file === brief.test && typeof options.env?.DATABASE_URL === "string") ready(options.env.DATABASE_URL);
    return spawn(file, [...args], options);
  } });
  let operation: ReturnType<typeof runner> | undefined;
  let store: SqliteEventStore | undefined;
  try {
    materialize(root);
    operation = runner(brief);
    const url = await Promise.race([connection, operation.then(() => { throw new Error("MIGRATION_RECIPE_NOT_STARTED"); })]);
    expect(names).toHaveLength(1);
    const name = names[0]!;
    const query = (sql: string) => docker(["exec", name, "psql", "-U", "app", "-d", "app", "-v", "ON_ERROR_STOP=1", "-tAc", sql]).trim();
    const schema = () => query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position");
    const before = schema();
    expect(before).toContain("app_metadata");
    writeFileSync(join(root, "migrations", added), "export const up = pgm => pgm.createTable('added_by_migration', { id: 'integer' });\n");
    store = SqliteEventStore.openForProject(join(root, "events.sqlite"), "project");
    installTestRecoveryBinding(store);
    const input = { projectRoot: root, workspace: root, projectId: "project", requestId: "first", environment: "production",
      sha: "a".repeat(40), databaseUrl: url, now: new Date("2026-09-06T10:00:00.000Z") };
    const applied = await migrateWithBackup(store, input);
    expect(applied.refusal).toBeNull();
    expect(applied.applied).toEqual([added]);
    expect(schema()).toContain("added_by_migration");
    expect(readMigrationReceipt(store, "project", "first")).toEqual(applied);
    query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    const fd = openSync(applied.backupRef!.split("@sha256:")[0]!, "r");
    try { docker(["exec", "-i", name, "psql", "-X", "-q", "-U", "app", "-d", "app", "-v", "ON_ERROR_STOP=1"], fd); }
    finally { closeSync(fd); }
    expect(schema()).toBe(before);
    const refused = await migrateWithBackup(store, { ...input, requestId: "backup-failed", now: new Date(input.now.getTime() + 1) }, {
      ...nodeMigrationPorts(), dump: async () => { throw new Error("dump unavailable"); },
    });
    expect(schema()).toBe(before);
    expect(refused.refusal).toMatchObject({ code: "MIGRATION_BACKUP_FAILED", layer: "DAEMON_INGRESS" });
    writeFileSync(join(root, "migrations", broken), "export const up = () => { throw new Error('migration failed'); };\n");
    const failed = await migrateWithBackup(store, { ...input, requestId: "migration-failed", now: new Date(input.now.getTime() + 2) });
    expect(failed).toMatchObject({ outcome: "REFUSED", applied: [], refusal: {
      code: "MIGRATION_FAILED", layer: "DAEMON_INGRESS", detail: broken,
    } });
    expect(schema()).toBe(before);
    expect(query("SELECT name FROM pgmigrations ORDER BY name")).toBe(initial.replace(".js", ""));
    process.stdout.write("REAL MIGRATION: schema changed, restored exactly, backup-failure unchanged, failing-file named\n");
  } finally {
    store?.close();
    writeFileSync(join(root, "release"), "release");
    try { if (operation) await operation; } finally {
      try { await runner.close(); } finally {
        rmSync(root, { recursive: true, force: true });
        for (const name of names) expect(docker(["ps", "-aq", "--filter", `name=^/${name}$`]).trim()).toBe("");
      }
    }
  }
}, 600_000);
