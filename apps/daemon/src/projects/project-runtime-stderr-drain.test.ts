import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  MAX_HOST_STDERR_LINE_BYTES, drainProjectRuntimeStderr,
} from "./project-runtime-session.js";

/**
 * THE CHANNEL THAT CARRIED EVERY REASON `moe start` COULD FAIL FOR, AND DISCARDED IT.
 *
 * The drain existed to stop the stack host blocking on a full stderr pipe, and it consumed the
 * bytes into nothing. That stream is the only channel carrying the host's config refusals, its
 * uncaught exceptions and stack traces, and `STORE_DEPENDENCIES_ENV_MISSING: <the exact missing
 * variables>` — a sentence formatted precisely for the operator and then destroyed two frames
 * later. `moe start` printed two banner lines and, ten seconds on, a bare
 * PROJECT_RUNTIME_START_TIMEOUT with the cause already gone.
 *
 * The drain's first duty is unchanged and asserted here: it still consumes every byte, because
 * back-pressure on that pipe hangs the host. Observing is additive and optional.
 */

const stream = (...chunks: readonly (string | Buffer)[]): Readable =>
  Readable.from(chunks.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk)));

describe("drainProjectRuntimeStderr", () => {
  it("still consumes the whole stream when nobody is observing", async () => {
    await expect(drainProjectRuntimeStderr(stream("noise\n", "more\n"))).resolves.toBeUndefined();
  });

  it("offers each whole line to the observer", async () => {
    const seen: string[] = [];

    await drainProjectRuntimeStderr(
      stream("STORE_DEPENDENCIES_ENV_MISSING: MOE_STORE_PATH\n", "second line\n"),
      (line) => { seen.push(line); },
    );

    expect(seen).toEqual(["STORE_DEPENDENCIES_ENV_MISSING: MOE_STORE_PATH", "second line"]);
  });

  it("reassembles a line split across chunks, which is the ordinary pipe case", async () => {
    const seen: string[] = [];

    await drainProjectRuntimeStderr(stream("STORE_DEPEND", "ENCIES_ENV_MIS", "SING\n"),
      (line) => { seen.push(line); });

    expect(seen).toEqual(["STORE_DEPENDENCIES_ENV_MISSING"]);
  });

  it("flushes a trailing line the host never terminated", async () => {
    const seen: string[] = [];

    await drainProjectRuntimeStderr(stream("died mid-sentence"), (line) => { seen.push(line); });

    expect(seen).toEqual(["died mid-sentence"]);
  });

  it("strips the carriage return, which on Windows is on every line", async () => {
    const seen: string[] = [];

    await drainProjectRuntimeStderr(stream("windows line\r\n"), (line) => { seen.push(line); });

    expect(seen).toEqual(["windows line"]);
  });

  it("drops empty lines rather than reporting blank events", async () => {
    const seen: string[] = [];

    await drainProjectRuntimeStderr(stream("\n\nreal\n\n"), (line) => { seen.push(line); });

    expect(seen).toEqual(["real"]);
  });

  it("cuts one enormous line into bounded pieces rather than buffering it whole", async () => {
    const seen: string[] = [];

    await drainProjectRuntimeStderr(
      stream("x".repeat(MAX_HOST_STDERR_LINE_BYTES * 4), "\n"),
      (line) => { seen.push(line); },
    );

    // Cut, not truncated: a stack trace on one line is still readable in order, and the memory
    // held at any instant is one bound rather than however much the host chose to print.
    for (const line of seen) expect(line.length).toBeLessThanOrEqual(MAX_HOST_STDERR_LINE_BYTES);
    expect(seen.join("")).toBe("x".repeat(MAX_HOST_STDERR_LINE_BYTES * 4));
  });

  it("bounds a stream that never sends a newline at all", async () => {
    const seen: string[] = [];
    const chunks = Array.from({ length: 40 }, () => "y".repeat(4_096));

    await drainProjectRuntimeStderr(stream(...chunks), (line) => { seen.push(line); });

    for (const line of seen) expect(line.length).toBeLessThanOrEqual(MAX_HOST_STDERR_LINE_BYTES);
  });

  it("keeps draining when the observer throws, because back-pressure hangs the host", async () => {
    let consumed = 0;
    const source = stream("one\n", "two\n", "three\n");
    source.on("data", () => { consumed += 1; });

    await expect(drainProjectRuntimeStderr(source, () => { throw new Error("sink is gone"); }))
      .resolves.toBeUndefined();
    expect(consumed).toBeGreaterThan(0);
  });

  it("still swallows a stream error, exactly as before", async () => {
    const source = new Readable({
      read(): void { this.destroy(new Error("pipe broke")); },
    });

    await expect(drainProjectRuntimeStderr(source, () => undefined)).resolves.toBeUndefined();
  });
});
