/**
 * REAL BYTES, from a REAL headless Chromium, against a REAL http server.
 *
 * The arms DECODE what was written: the PNG signature and the width and height out of the IHDR
 * chunk. A `existsSync(path)` assertion would pass on the ZERO-BYTE file a failed capture
 * leaves behind, which is precisely the failure worth catching — so the file is never merely
 * stat'd, it is parsed.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PNG_MAGIC, capturePreviewJourneys } from "./preview-capture.js";
import { previewCaptureDirectory } from "./preview-receipt-contracts.js";
import {
  LISTENING_SERVER, cleanupFixtureWorkspaces, fixtureWorkspace,
} from "./preview-test-fixtures.js";

const GOAL = "goal-capture";
const SHA = "abc1234567890abc1234567890abc1234567890a";

const children: ChildProcess[] = [];

afterEach(() => {
  while (children.length > 0) {
    const child = children.pop();
    try { child?.kill("SIGKILL"); } catch { /* already gone */ }
  }
  cleanupFixtureWorkspaces();
});

/**
 * A PNG's real dimensions, read out of the IHDR chunk: bytes 16-19 are the width and 20-23 the
 * height, both big-endian. Reading them is what makes "non-zero dimensions" a claim about the
 * image rather than about the file's length.
 */
function decodePng(bytes: Buffer): { height: number; magic: readonly number[]; width: number } {
  return {
    height: bytes.readUInt32BE(20),
    magic: [...bytes.subarray(0, 8)],
    width: bytes.readUInt32BE(16),
  };
}

/** Starts the fixture product and resolves its origin once it prints one. */
async function startFixtureServer(workspace: string): Promise<string> {
  const child = spawn(process.execPath, [join(workspace, "server.mjs")], {
    cwd: workspace, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { reject(new Error(`fixture never listened: ${output}`)); }, 20_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const found = /http:\/\/127\.0\.0\.1:(\d+)/u.exec(output);
      if (found !== null) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${String(found[1])}`);
      }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function serverWorkspace(): string {
  return fixtureWorkspace({
    files: { "server.mjs": LISTENING_SERVER },
    scripts: { preview: "node server.mjs" },
  });
}

describe("capturing a preview journey", () => {
  it("writes a PNG whose BYTES decode, with non-zero dimensions", async () => {
    const workspace = serverWorkspace();
    const origin = await startFixtureServer(workspace);

    const written = await capturePreviewJourneys({
      directory: workspace,
      goalId: GOAL,
      journeys: [{ journeyRef: "journey-home", path: "/" }],
      origin,
      sha: SHA,
    });

    expect(written).toHaveLength(1);
    const entry = written[0];
    if (entry === undefined) throw new Error("no capture");
    const bytes = readFileSync(join(workspace, ...entry.path.split("/")));
    const png = decodePng(bytes);
    expect(png.magic).toStrictEqual([...PNG_MAGIC]);
    expect(png.width).toBeGreaterThan(0);
    expect(png.height).toBeGreaterThan(0);
    // A zero-byte file has no dimensions to read; a real capture of a 1280x720 viewport does.
    expect(bytes.byteLength).toBeGreaterThan(1000);
  }, 120_000);

  it("writes ONE png per journey, under this run's own directory", async () => {
    const workspace = serverWorkspace();
    const origin = await startFixtureServer(workspace);

    const written = await capturePreviewJourneys({
      directory: workspace,
      goalId: GOAL,
      journeys: [
        { journeyRef: "journey-home", path: "/" },
        { journeyRef: "journey-checkout", path: "/checkout" },
      ],
      origin,
      sha: SHA,
    });

    const prefix = `${previewCaptureDirectory(GOAL, SHA)}/`;
    expect(written.map((entry) => entry.path)).toStrictEqual([
      `${prefix}journey-home.png`,
      `${prefix}journey-checkout.png`,
    ]);
    // EVERY advertised entry is really on disk and really decodes: a roster is not evidence.
    for (const entry of written) {
      const bytes = readFileSync(join(workspace, ...entry.path.split("/")));
      expect(decodePng(bytes).magic).toStrictEqual([...PNG_MAGIC]);
      expect(decodePng(bytes).width).toBeGreaterThan(0);
    }
    // The two journeys render different documents, so identical bytes would mean the second
    // navigation never happened and both shots are of the same page.
    const [first, second] = written.map((entry) =>
      readFileSync(join(workspace, ...entry.path.split("/"))).toString("base64"));
    expect(first).not.toBe(second);
  }, 120_000);

  it("REFUSES a journey ref that would escape the run's directory, rather than sanitising it", async () => {
    const workspace = serverWorkspace();
    const origin = await startFixtureServer(workspace);

    const written = await capturePreviewJourneys({
      directory: workspace,
      goalId: GOAL,
      journeys: [
        { journeyRef: "../../escaped", path: "/" },
        { journeyRef: "sub/dir", path: "/" },
        { journeyRef: "journey-ok", path: "/" },
      ],
      origin,
      sha: SHA,
    });

    expect(written.map((entry) => entry.journeyRef)).toStrictEqual(["journey-ok"]);
    expect(existsSync(join(workspace, "escaped.png"))).toBe(false);
    expect(existsSync(join(workspace, "..", "escaped.png"))).toBe(false);
  }, 120_000);

  it("advertises NOTHING for a journey it could not reach", async () => {
    // Nothing is listening on this port, so the navigation fails. The roster must be empty
    // rather than naming a file the browser never wrote — a receipt cannot advertise a capture
    // that is not on disk.
    const workspace = serverWorkspace();

    const written = await capturePreviewJourneys({
      directory: workspace,
      goalId: GOAL,
      journeys: [{ journeyRef: "journey-home", path: "/" }],
      origin: "http://127.0.0.1:1",
      sha: SHA,
    }, { navigationTimeoutMs: 2_000 });

    expect(written).toStrictEqual([]);
    expect(existsSync(join(workspace, ...previewCaptureDirectory(GOAL, SHA).split("/"), "journey-home.png")))
      .toBe(false);
  }, 120_000);

  it("proves the decode arm is not vacuous: a zero-byte file fails the same assertion", () => {
    // The control for the arms above. This is the exact file a failed capture leaves behind,
    // and `existsSync` is true for it — which is why the arms decode instead of stat.
    const workspace = fixtureWorkspace({ scripts: {} });
    const path = join(workspace, "empty.png");
    writeFileSync(path, Buffer.alloc(0));

    expect(existsSync(path)).toBe(true);
    expect(() => decodePng(readFileSync(path))).toThrow();
  });
});
