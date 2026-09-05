/**
 * The pure half of the wrapper lane, proven without a daemon, a browser or a wrapper.
 *
 * WHAT IS WORTH PROVING HERE. The journey in `provider-pause.spec.ts` reads a wrapper log line
 * and a health field; both are only meaningful if the seat double really printed the provider's
 * OWN bytes and really failed. A double that exits 0, or that prints a line one byte off, would
 * leave that journey asserting nothing while staying green for the wrong reason. So this file
 * runs the double for real, once, and compares its stderr byte for byte - and compares the copied
 * line against the fixture file it was copied from, so a fixture edit cannot leave a stale copy
 * behind.
 *
 * `.test.ts`, not `.spec.ts`: the browser lane matches `*.spec.ts` only, and the root vitest
 * include already carries every `.test.ts` under `tests/`, so these arms run in the node lane
 * with no config change on either side.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLaneScratch, daemonEnv, repoRoot } from "./daemon-ports.js";
import type { LaneScratch } from "./daemon-ports.js";
import {
  LIMIT_LINE,
  LIMIT_LINE_SOURCE,
  WRAPPER_INTERVAL_MS,
  readFixtureLimitLine,
  seatDoubleFiles,
  wrapperEnv,
} from "./wrapper-lane.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(HERE, "..", "..", "..");

/** Keys a seat double must never be handed: it has no provider call to make with them. */
const PROVIDER_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "CODEX_", "OPENAI_"] as const;

let dir = "";
let scratch: LaneScratch;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "moe-seat-double-"));
  scratch = createLaneScratch();
});

afterAll(() => {
  for (const path of [dir, scratch.root]) {
    try {
      rmSync(path, { force: true, recursive: true });
    } catch {
      // A few kilobytes left in TEMP is never a reason to red a green run.
    }
  }
});

describe("the copied provider line", () => {
  it("is byte-identical to the fixture it names as its source", () => {
    expect(repoRoot(), "the repo root must anchor").toBe(ROOT);
    const fixture = readFixtureLimitLine(ROOT);
    expect(fixture, `${LIMIT_LINE_SOURCE} must still declare CLAUDE_SESSION_LIMIT`).not.toBeNull();
    expect(fixture).toBe(LIMIT_LINE);
    // The one character a console can silently eat: the MIDDLE DOT (U+00B7) the claude CLI
    // composes with. Named by code point, so this file stays ASCII and cannot itself be mangled.
    expect(LIMIT_LINE.split("").map((c) => c.charCodeAt(0)).filter((c) => c > 127)).toEqual([0xB7]);
  });

  it("is carried into the double's source as an ASCII escape, never as a raw byte", () => {
    const { files } = seatDoubleFiles(dir, LIMIT_LINE);
    const js = files.find((file) => file.path.endsWith("seat-double.js"));
    expect(js, "the double must write a .js").not.toBeUndefined();
    const bytes = readFileSync(js?.path ?? "", "utf8");
    expect(bytes).toContain("\\u00b7");
    expect(bytes).toContain("process.exit(1)");
    const nonAscii = bytes.split("").filter((c) => c.charCodeAt(0) > 127);
    expect(nonAscii, "the generated .js must be ASCII-only").toEqual([]);
  });
});

describe("the seat double as a process", () => {
  it("prints the line to stderr byte for byte and exits 1", () => {
    const { files } = seatDoubleFiles(dir, LIMIT_LINE);
    const jsPath = files.find((file) => file.path.endsWith("seat-double.js"))?.path ?? "";
    // The ONE process this file spawns. The double's bytes are the whole point of the module,
    // and no assertion over its SOURCE can prove what the stream actually carried.
    const run = spawnSync(process.execPath, [jsPath], { encoding: "buffer" });
    expect(run.status, "a provider limit is a FAILED seat").toBe(1);
    expect(run.stderr.equals(Buffer.concat([Buffer.from(LIMIT_LINE, "utf8"), Buffer.from("\n")])))
      .toBe(true);
    expect(run.stdout.length, "the double must say nothing on stdout").toBe(0);
  });

  it("ignores every argument the spawner appends", () => {
    const { files } = seatDoubleFiles(dir, LIMIT_LINE);
    const jsPath = files.find((file) => file.path.endsWith("seat-double.js"))?.path ?? "";
    const run = spawnSync(
      process.execPath,
      [jsPath, "-p", "--setting-sources", "", "--mcp-config", join(dir, "absent.json")],
      { encoding: "buffer" },
    );
    expect(run.status).toBe(1);
    expect(run.stderr.toString("utf8")).toBe(`${LIMIT_LINE}\n`);
  });
});

describe("the executable form this platform runs", () => {
  it("is the .cmd on win32 and the .sh everywhere else, and each delegates to the .js", () => {
    const { command, files } = seatDoubleFiles(dir, LIMIT_LINE);
    expect(files.map((file) => basename(file.path)).sort())
      .toEqual(["seat-double.cmd", "seat-double.js", "seat-double.sh"]);
    const cmd = readFileSync(join(dir, "seat-double.cmd"), "utf8");
    const sh = readFileSync(join(dir, "seat-double.sh"), "utf8");
    expect(cmd).toContain("%~dp0seat-double.js");
    expect(cmd.startsWith("@echo off\r\n"), "cmd.exe reads CRLF").toBe(true);
    expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh).toContain('"$(dirname "$0")/seat-double.js"');
    if (process.platform === "win32") {
      expect(command).toBe(join(dir, "seat-double.cmd"));
    } else {
      expect(command).toBe(join(dir, "seat-double.sh"));
      // Named as a command, so the bit that makes it one is part of the contract.
      expect(statSync(command).mode & 0o111).not.toBe(0);
    }
  });
});

describe("the wrapper's environment", () => {
  it("adds exactly the four wrapper knobs on top of the lane's daemon environment", () => {
    const command = join(dir, "seat-double.cmd");
    const env = wrapperEnv(scratch, command);
    expect(env["MOE_AGENT_COMMAND"]).toBe(command);
    expect(env["MOE_WRAPPER_INTERVAL_MS"]).toBe("500");
    expect(WRAPPER_INTERVAL_MS).toBe(500);
    expect(env["MOE_WRAPPER_MAX_AGENTS"]).toBe("1");
    expect(env["MOE_NODE_LANDING"]).toBe("0");
    // Inherited, not restated: the wrapper and the daemon must read one store and one spec dir.
    expect(env["MOE_STORE_PATH"]).toBe(scratch.storePath);
    expect(env["MOE_NODE_SPECS_DIR"]).toBe(scratch.nodeSpecsDir);
    expect(env["MOE_PROJECT_ID"]).toBe(scratch.projectId);
    const base = new Set(Object.keys(daemonEnv(scratch)));
    const added = Object.keys(env).filter((key) => !base.has(key)).sort();
    expect(added).toEqual(
      ["MOE_AGENT_COMMAND", "MOE_NODE_LANDING", "MOE_WRAPPER_INTERVAL_MS", "MOE_WRAPPER_MAX_AGENTS"]
        .filter((key) => !base.has(key)),
    );
  });

  it("mints no provider credential of its own", () => {
    const env = wrapperEnv(scratch, join(dir, "seat-double.cmd"));
    const base = new Set(Object.keys(daemonEnv(scratch)));
    const minted = Object.keys(env).filter((key) => !base.has(key));
    for (const key of minted) {
      for (const prefix of PROVIDER_PREFIXES) {
        expect(key.toUpperCase().startsWith(prefix), `${key} must not be minted here`).toBe(false);
      }
    }
    // The host's own credentials still ride through `daemonEnv`'s process.env spread; this arm
    // says only that THIS function invents none, which is the part it owns.
    expect(minted).not.toContain("ANTHROPIC_API_KEY");
  });

  it("honours an explicit interval", () => {
    expect(wrapperEnv(scratch, "c", 1_200)["MOE_WRAPPER_INTERVAL_MS"]).toBe("1200");
  });
});
