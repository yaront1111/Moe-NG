import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), execFileSync: execute,
}));
import { nodeBackupPorts } from "./backup-ports.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  execute.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(neverReady = false) {
  const root = mkdtempSync(join(tmpdir(), "moe-backup-readiness-")); roots.push(root);
  const source = join(root, "source.sql");
  writeFileSync(source, "\\restrict TestRestrictKey\nSELECT 1;\n", "utf8");
  let probes = 0;
  let ready = false;
  const commands: string[][] = [];
  execute.mockImplementation((_file: string, args: string[], options: { stdio: unknown[] }) => {
    commands.push([...args]);
    if (args.includes("pg_isready")) {
      probes++;
      // Docker's temporary initialization server accepts Unix sockets, but not TCP.
      if (!args.includes("-h")) return Buffer.alloc(0);
      if (neverReady || probes === 1) throw new Error("the final TCP server is not ready");
      ready = true;
    }
    if (args.includes("psql") && !ready) throw new Error("restore reached the temporary server");
    if (args.includes("pg_dump")) writeSync(options.stdio[1] as number, readFileSync(source));
    if (args[0] === "ps") return Buffer.from(commands.some((row) => row[0] === "rm") ? "" : "container-id\n");
    return Buffer.alloc(0);
  });
  return { source, commands };
}

const restoreDirectories = () => readdirSync(tmpdir()).filter((name) => name.startsWith("moe-backup-restore-")).sort();

describe("restore-container readiness", () => {
  it("waits for the final TCP server, not the temporary socket-only initialization server", async () => {
    const before = restoreDirectories();
    const { source, commands } = fixture();
    const proof = await nodeBackupPorts().restoreDatabase(source);
    expect(proof.restoredSha256).toBe(proof.sha256);
    const probes = commands.filter((args) => args.includes("pg_isready"));
    expect(probes).toHaveLength(2);
    expect(probes.map((args) => args.slice(2)))
      .toEqual(Array.from({ length: 2 }, () => ["pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres"]));
    expect(commands.findIndex((args) => args.includes("psql"))).toBeGreaterThan(commands.lastIndexOf(probes[1]!));
    expect(commands.filter((args) => args[0] === "rm")).toHaveLength(1);
    expect(restoreDirectories()).toEqual(before);
  });

  it("refuses an unready TCP server with the stable code and tears down without applying the dump", async () => {
    vi.useFakeTimers();
    const before = restoreDirectories();
    const { source, commands } = fixture(true);
    const result = nodeBackupPorts().restoreDatabase(source).then(() => null, (error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ code: "BACKUP_FAILED", layer: "DAEMON_ACTIVATION_RECEIPTS" });
    expect(commands.filter((args) => args.includes("pg_isready"))).toHaveLength(60);
    expect(commands.some((args) => args.includes("psql") || args.includes("pg_dump"))).toBe(false);
    expect(commands.filter((args) => args[0] === "rm")).toHaveLength(1);
    expect(restoreDirectories()).toEqual(before);
  });
});
