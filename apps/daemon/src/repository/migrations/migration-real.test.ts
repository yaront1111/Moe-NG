import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, it } from "vitest";
import { SqliteEventStore } from "@moe/store";
import { BACKUP_DIRECTORY } from "../../bootstrap/activation-receipts-measure.js";
import { installTestRecoveryBinding } from "../../identity/session-test-fixtures.js";
import { createVerifierDatabaseRunner } from "../../orchestrator/verifier-database.js";
import { CONTROLLED_PROFILE_VERSION, generateControlledProfile } from "../controlled-profile/controlled-profile-generator.js";
import { revertLastBatch } from "./migration-down-service.js";
import { migrateWithBackup } from "./migration-service.js";
import { MigrationExecutionError, nodeMigrationPorts } from "./migration-ports.js";
import { readMigrationReceipt } from "./migration-receipt.js";

const RUN = process.env.MOE_MIGRATION_RESTORE === "1";
const initial = "1700000000000-initial.js";
const added = "1700000000001_added.js";
const broken = "1700000000002-broken.js";
const second = "1700000000002-second.js";
const untracked = "1700000000001-untracked.js";
/** Lives in the repository ROOT's `migrations/`, never in the product subdirectory's. */
const foreign = "1700000000003-foreign.js";
const IDENTITY = ["-c", "user.name=Moe", "-c", "user.email=moe@moe.local", "-c", "commit.gpgsign=false"];
/** The workspace is a REAL repository here on purpose: the defect this file pins is WHICH TREE the
 *  migration child reads, and a fake git runner would prove nothing about a real `git checkout`. */
function git(root: string, args: readonly string[]): string {
  const result = spawnSync("git", [...IDENTITY, ...args], { cwd: root, shell: false,
    windowsHide: true, timeout: 60_000, encoding: "utf8" });
  if (result.status !== 0 || result.error) throw new Error(`MIGRATION_TEST_GIT_FAILED: ${result.stderr}`);
  return result.stdout;
}
/** Initialises `root` as a repository on first use, commits `pathspec`, answers the commit sha.
 *  `core.autocrlf=false` is pinned in the fixture so a host with the global flag on cannot make
 *  the committed bytes differ from the bytes written here. The pathspec is explicit because the
 *  installed tree carries `node_modules` and a live sqlite file that belong in no commit. */
function commitTree(root: string, pathspec: readonly string[]): string {
  if (!existsSync(join(root, ".git"))) {
    git(root, ["init", "--initial-branch=main", "."]);
    git(root, ["config", "core.autocrlf", "false"]);
  }
  git(root, ["add", "--", ...pathspec]);
  git(root, ["commit", "--no-gpg-sign", "-m", "migrations"]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}
const commitWorkspace = (root: string): string => commitTree(root, ["."]);
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

// UNGATED ON PURPOSE: no docker, no database. The tool check resolves the root specifier BEFORE
// the child reads `migrations` or parses DATABASE_URL, so an empty tree answers on its own. A
// mocked port would prove nothing — the defect lives in a child process's module resolution, and
// only a real tree with no node_modules exercises it.
//
// The tree is a REPOSITORY with a committed `migrations/` because the source extraction runs in
// the PARENT, before the child is spawned: a non-repository root would refuse before reaching the
// tool check this arm exists to prove, and the arm would pass for the wrong reason.
it("names the missing TOOL, not an unknown FILE, when the workspace was never installed", async () => {
  const root = mkdtempSync(join(tmpdir(), "moe-migration-uninstalled-"));
  let store: SqliteEventStore | undefined;
  try {
    mkdirSync(join(root, "migrations"), { recursive: true });
    writeFileSync(join(root, "migrations", initial), "export const up = () => undefined;\n");
    const sha = commitWorkspace(root);
    // Syntactically valid, so the arm cannot pass because the URL was rejected instead.
    const url = "postgres://u:p@127.0.0.1:5432/db";
    const rejection = await nodeMigrationPorts().apply(root, url, sha).then(
      () => null, (error: unknown) => error);
    expect(rejection).toBeInstanceOf(MigrationExecutionError);
    expect(rejection).toMatchObject({ toolMissing: true });
    // The old answer, and the whole reason this arm exists: `file` still defaults to the sentinel,
    // so the sentinel alone can never be the discriminator.
    expect((rejection as MigrationExecutionError).file).toBe("MIGRATION_FILE_UNKNOWN");

    store = SqliteEventStore.openForProject(join(root, "events.sqlite"), "project");
    installTestRecoveryBinding(store);
    const refused = await migrateWithBackup(store, {
      projectRoot: root, workspace: root, projectId: "project", requestId: "uninstalled",
      environment: "production", sha, databaseUrl: url,
      now: new Date("2026-09-06T10:00:00.000Z"),
    }, { ...nodeMigrationPorts(), dump: async (_url, path) => { writeFileSync(path, "-- backup\n"); } });
    expect(refused).toMatchObject({ outcome: "REFUSED", applied: [], refusal: {
      code: "MIGRATION_TOOL_MISSING", layer: "DAEMON_INGRESS", detail: "MIGRATION_TOOL_MISSING",
    } });
    expect(refused.backupRef).not.toBeNull();
    expect(readMigrationReceipt(store, "project", "uninstalled")).toEqual(refused);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);

// UNGATED ON PURPOSE: no docker, no database, no network. The image is built from the approved
// sha, so the schema change that ships with it must come from that same commit. The fixture plants
// all THREE skews a working-tree read would carry into the database — a committed file DIRTIED, an
// UNTRACKED file added, a committed file DELETED — and the fake tool records the directory it was
// actually handed, because the return value alone cannot say which tree it came from.
it("applies the committed migrations of the sha, not the working tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "moe-migration-sha-"));
  try {
    const committed = "export const up = pgm => pgm.createTable('committed', { id: 'integer' });\n";
    mkdirSync(join(root, "migrations"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(root, "migrations", initial), committed);
    writeFileSync(join(root, "migrations", second), "export const up = () => undefined;\n");
    const sha = commitWorkspace(root);
    writeFileSync(join(root, "migrations", initial), "export const up = () => { throw new Error('dirty'); };\n");
    writeFileSync(join(root, "migrations", untracked), "export const up = () => undefined;\n");
    rmSync(join(root, "migrations", second), { force: true });
    mkdirSync(join(root, "node_modules", "node-pg-migrate"), { recursive: true });
    writeFileSync(join(root, "node_modules", "node-pg-migrate", "package.json"),
      JSON.stringify({ name: "node-pg-migrate", type: "module", exports: "./index.mjs" }));
    writeFileSync(join(root, "node_modules", "node-pg-migrate", "index.mjs"), `
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
export async function runner(options) {
  writeFileSync('result.json', JSON.stringify({ dir: options.dir, files: readdirSync(options.dir),
    bytes: readFileSync(join(options.dir, ${JSON.stringify(initial)}), 'utf8'),
    // The metadata directory AS THE CHILD SEES IT, so the "nothing survives" assertion below
    // cannot pass vacuously against an extract that was never created.
    live: readdirSync(dirname(dirname(options.dir))) }));
  return [{ path: join(options.dir, ${JSON.stringify(initial)}) }];
}
`);
    const applied = await nodeMigrationPorts().apply(root, "postgres://u:p@127.0.0.1:5432/db", sha);
    const observed = JSON.parse(readFileSync(join(root, "result.json"), "utf8")) as
      { readonly bytes: string; readonly dir: string; readonly files: readonly string[]; readonly live: readonly string[] };
    expect(applied).toEqual([initial]);
    expect(observed.files).toEqual([initial, second]);
    expect(observed.bytes).toBe(committed);
    // Not the working tree, and still a directory named `migrations`: the child attributes a
    // failing file by that path segment.
    expect(observed.dir).not.toBe(join(root, "migrations"));
    expect(basename(observed.dir)).toBe("migrations");
    // EXACTLY ONE extract existed while the tool ran, and NONE survives the return. The first
    // half is what stops the second from being a vacuous assertion about a directory that was
    // never created at all.
    expect(observed.live.filter(name => name.startsWith("migration-source-"))).toHaveLength(1);
    const metadata = join(root, BACKUP_DIRECTORY);
    expect(existsSync(metadata) ? readdirSync(metadata).filter(name => name.startsWith("migration-source-")) : [])
      .toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);

// UNGATED ON PURPOSE. `--git-path objects` answers for the ENCLOSING repository and a checkout
// pathspec is repository-root relative, so a workspace that is a SUBDIRECTORY of a repository
// would silently be handed the ROOT's `migrations/` -- another product's schema entirely. The
// refusal therefore has to land in the PARENT, before the child is spawned, and the absent
// `result.json` is what proves it: the fake tool is installed and reachable here, so an arm that
// only checked the rejection could pass while the wrong tree had already been read.
it("refuses a workspace that is a subdirectory of the repository, before running the tool", async () => {
  const root = mkdtempSync(join(tmpdir(), "moe-migration-subdir-"));
  const product = join(root, "product");
  try {
    mkdirSync(join(root, "migrations"), { recursive: true });
    writeFileSync(join(root, "migrations", foreign), "export const up = () => undefined;\n");
    mkdirSync(join(product, "migrations"), { recursive: true });
    writeFileSync(join(product, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(product, "migrations", initial), "export const up = () => undefined;\n");
    const sha = commitWorkspace(root);
    mkdirSync(join(product, "node_modules", "node-pg-migrate"), { recursive: true });
    writeFileSync(join(product, "node_modules", "node-pg-migrate", "package.json"),
      JSON.stringify({ name: "node-pg-migrate", type: "module", exports: "./index.mjs" }));
    writeFileSync(join(product, "node_modules", "node-pg-migrate", "index.mjs"), `
import { readdirSync, writeFileSync } from 'node:fs';
export async function runner(options) {
  writeFileSync('result.json', JSON.stringify({ dir: options.dir, files: readdirSync(options.dir) }));
  return [];
}
`);
    const rejection = await nodeMigrationPorts()
      .apply(product, "postgres://u:p@127.0.0.1:5432/db", sha).then(() => null, (error: unknown) => error);
    expect(rejection).toBeInstanceOf(MigrationExecutionError);
    // NOT the tool-missing answer: the tool IS installed in this workspace, and the discriminator
    // between "could not resolve the tool" and "would have read the wrong tree" is the point.
    expect(rejection).toMatchObject({ toolMissing: false, file: "MIGRATION_FILE_UNKNOWN" });
    expect(existsSync(join(product, "result.json"))).toBe(false);
    const metadata = join(product, BACKUP_DIRECTORY);
    expect(existsSync(metadata) ? readdirSync(metadata).filter(name => name.startsWith("migration-source-")) : [])
      .toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 180_000);

// UNGATED ON PURPOSE, and it runs the REAL `migrateWithBackup` and `revertLastBatch` rather than
// re-deriving what they do. Before this row the receipt's `sha` was a label the caller supplied
// while the files came from wherever the working tree happened to be; it is a PROVENANCE claim
// now, so the port has to be handed exactly that commit. The down leg must reach the same commit
// WITHOUT being told: `MigrationDownInput` carries no sha, the SOURCE receipt does, and
// migrate-down-command.ts compares the two. The `seen` array is asserted by exact equality so an
// `undefined` or a stray extra call cannot pass.
it("hands the port the receipt's sha, and reverts from that same commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "moe-migration-receipt-sha-"));
  const store = SqliteEventStore.openForProject(join(root, "events.sqlite"), "project");
  try {
    installTestRecoveryBinding(store);
    const applySha = "a".repeat(40);
    const seen: string[] = [];
    const base = { projectRoot: root, workspace: root, projectId: "project", environment: "production",
      databaseUrl: "postgres://u:p@127.0.0.1:5432/db" };
    const dump = async (_connection: string, path: string): Promise<void> => {
      writeFileSync(path, "fixture backup");
    };
    const applied = await migrateWithBackup(store,
      { ...base, requestId: "up", sha: applySha, now: new Date("2026-09-06T10:00:00.000Z") },
      { dump, apply: async (_workspace, _connection, sha) => { seen.push(`apply:${sha}`); return [initial]; } });
    expect(applied.outcome).toBe("APPLIED");
    expect(applied.sha).toBe(applySha);
    expect(readMigrationReceipt(store, "project", "up")?.sha).toBe(applySha);

    const reverted = await revertLastBatch(store,
      { ...base, requestId: "down", toMigrationRequestId: "up", now: new Date("2026-09-06T11:00:00.000Z") },
      { dump, revert: async (_workspace, _connection, batch, sha) => { seen.push(`revert:${sha}`); return [...batch].reverse(); } });
    expect(reverted.outcome).toBe("REVERTED");
    expect(seen).toEqual([`apply:${applySha}`, `revert:${applySha}`]);
    // What migrate-down-command.ts:61,65 compares: the source receipt's sha and the revert's agree.
    expect(reverted.sha).toBe(applied.sha);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);

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
    // COMMITTED, and the receipt carries THIS sha: the engine extracts `migrations/` at the sha it
    // is given, so an uncommitted migration is no longer something a deploy can apply.
    const first = commitTree(root, ["migrations"]);
    store = SqliteEventStore.openForProject(join(root, "events.sqlite"), "project");
    installTestRecoveryBinding(store);
    const input = { projectRoot: root, workspace: root, projectId: "project", requestId: "first", environment: "production",
      sha: first, databaseUrl: url, now: new Date("2026-09-06T10:00:00.000Z") };
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
    const second = commitTree(root, ["migrations"]);
    const failed = await migrateWithBackup(store, { ...input, requestId: "migration-failed", sha: second, now: new Date(input.now.getTime() + 2) });
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
