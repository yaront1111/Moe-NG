import {
  appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DIAGNOSTIC_LOG_FILENAME, createDiagnosticFileSink } from "./diagnostic-file-sink.js";
import type { DiagnosticFileSystem } from "./diagnostic-file-sink.js";
import type { DiagnosticRecord } from "@moe/contracts";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "moe-diag-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { force: true, recursive: true });
});

function record(event: string, level: DiagnosticRecord["level"] = "error"): DiagnosticRecord {
  return { at: "2026-09-17T22:00:00.000Z", component: "store", event, level };
}

describe("createDiagnosticFileSink", () => {
  it("appends one JSON line per record", () => {
    const dir = scratch();
    const sink = createDiagnosticFileSink({ directory: dir });

    sink.emit(record("STORE_READ_FAILED"));
    sink.emit(record("STORE_WRITE_FAILED"));
    sink.close();

    const lines = readFileSync(join(dir, DIAGNOSTIC_LOG_FILENAME), "utf8")
      .split("\n").filter((line) => line !== "");

    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ event: "STORE_READ_FAILED" });
  });

  it("creates the directory when it does not exist yet", () => {
    const dir = join(scratch(), "nested", "logs");
    const sink = createDiagnosticFileSink({ directory: dir });

    sink.emit(record("STORE_READ_FAILED"));
    sink.close();

    expect(readdirSync(dir)).toContain(DIAGNOSTIC_LOG_FILENAME);
  });

  it("redacts a declared secret before it reaches disk", () => {
    const dir = scratch();
    const sink = createDiagnosticFileSink({ directory: dir, secrets: ["sk-live-abc"] });

    sink.emit({ ...record("SEAT_SPAWN_FAILED"), fields: { detail: "token sk-live-abc denied" } });
    sink.close();

    expect(readFileSync(join(dir, DIAGNOSTIC_LOG_FILENAME), "utf8")).not.toContain("sk-live-abc");
  });

  it("rotates past the byte bound and keeps a bounded number of generations", () => {
    const dir = scratch();
    const sink = createDiagnosticFileSink({ directory: dir, generations: 2, maxBytes: 200 });

    for (let at = 0; at < 40; at += 1) sink.emit(record(`STORE_READ_FAILED_${String(at)}`));
    sink.close();

    const files = readdirSync(dir).filter((name) => name.startsWith(DIAGNOSTIC_LOG_FILENAME));

    expect(files).toContain(DIAGNOSTIC_LOG_FILENAME);
    expect(files.length).toBeLessThanOrEqual(3);
    expect(files).not.toContain(`${DIAGNOSTIC_LOG_FILENAME}.3`);
  });

  it("keeps the newest records in the live file after a rotation", () => {
    const dir = scratch();
    const sink = createDiagnosticFileSink({ directory: dir, generations: 2, maxBytes: 200 });

    for (let at = 0; at < 40; at += 1) sink.emit(record(`STORE_READ_FAILED_${String(at)}`));
    sink.close();

    expect(readFileSync(join(dir, DIAGNOSTIC_LOG_FILENAME), "utf8"))
      .toContain("STORE_READ_FAILED_39");
  });

  it("NEVER throws when the filesystem refuses every write", () => {
    const hostile: DiagnosticFileSystem = {
      appendFileSync: () => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); },
      mkdirSync: () => undefined,
      renameSync: () => undefined,
      rmSync: () => undefined,
      statSync: () => ({ size: 0 }),
    };
    const sink = createDiagnosticFileSink({ directory: "/nowhere", fs: hostile });

    expect(() => { sink.emit(record("STORE_READ_FAILED")); }).not.toThrow();
    expect(() => { sink.close(); }).not.toThrow();
  });

  it("NEVER throws when the directory cannot be created", () => {
    const hostile: DiagnosticFileSystem = {
      appendFileSync: () => undefined,
      mkdirSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
      renameSync: () => undefined,
      rmSync: () => undefined,
      statSync: () => ({ size: 0 }),
    };

    expect(() => { createDiagnosticFileSink({ directory: "/nowhere", fs: hostile })
      .emit(record("STORE_READ_FAILED")); }).not.toThrow();
  });

  it("reports its own failure once, by code, instead of failing silently", () => {
    const seen: { reason: string; code: string | null }[] = [];
    const hostile: DiagnosticFileSystem = {
      appendFileSync: () => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); },
      mkdirSync: () => undefined,
      renameSync: () => undefined,
      rmSync: () => undefined,
      statSync: () => ({ size: 0 }),
    };
    const sink = createDiagnosticFileSink({
      directory: "/nowhere",
      fs: hostile,
      onFailure: (reason, thrown) => { seen.push({ code: thrown.code, reason }); },
    });

    for (let at = 0; at < 20; at += 1) sink.emit(record("STORE_READ_FAILED"));

    expect(seen.length).toBe(1);
    expect(seen[0]).toEqual({ code: "ENOSPC", reason: "DIAGNOSTIC_SINK_WRITE_FAILED" });
  });

  it("gives up after repeated failures rather than retrying on every record", () => {
    let attempts = 0;
    const hostile: DiagnosticFileSystem = {
      appendFileSync: () => { attempts += 1; throw new Error("no space"); },
      mkdirSync: () => undefined,
      renameSync: () => undefined,
      rmSync: () => undefined,
      statSync: () => ({ size: 0 }),
    };
    const sink = createDiagnosticFileSink({ directory: "/nowhere", fs: hostile });

    for (let at = 0; at < 50; at += 1) sink.emit(record("STORE_READ_FAILED"));

    expect(attempts).toBeLessThan(50);
    expect(sink.disabled()).toBe(true);
  });

  it("survives a rotation that the filesystem refuses, and keeps writing", () => {
    const dir = scratch();
    // Real writes, refused renames: the live file stays observable while rotation is impossible,
    // which is the ordinary Windows shape when another process holds the rotated generation open.
    const sink = createDiagnosticFileSink({
      directory: dir,
      fs: {
        appendFileSync: (path, data) => { appendFileSync(path, data, "utf8"); },
        mkdirSync: (path) => { mkdirSync(path, { recursive: true }); },
        renameSync: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); },
        rmSync: () => undefined,
        statSync: (path) => ({ size: statSync(path).size }),
      },
      maxBytes: 100,
    });

    for (let at = 0; at < 10; at += 1) sink.emit(record(`STORE_READ_FAILED_${String(at)}`));
    sink.close();

    expect(readFileSync(join(dir, DIAGNOSTIC_LOG_FILENAME), "utf8"))
      .toContain("STORE_READ_FAILED_9");
  });
});
