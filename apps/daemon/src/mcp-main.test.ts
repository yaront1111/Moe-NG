import { describe, expect, it } from "vitest";

import { FOUNDATION_RECEIPT_SCHEMA_VERSION } from "./host/foundation-receipts.js";
import { createStdioHost } from "./mcp-main.js";
import type { StdioHostSeam } from "./mcp-main.js";

/**
 * The stdio host's lifecycle half: the drain that `mcp-main` had none of.
 *
 * The seam here is PROCESS PLUMBING — close the server, hook stdin's end, hook a
 * signal, write a line, exit — and nothing else. No authority is injected: the
 * receipts come from the production builders and the durable path is untouched,
 * which is why the plain-Node smoke can prove the same behaviour end to end.
 *
 * WINDOWS: an externally sent SIGTERM never runs a Node handler, so the
 * transport-close path (stdin EOF) is the PRIMARY drain trigger and the signals
 * are the POSIX bonus. Both must converge on ONE shutdown receipt.
 */

const INSTANT = "2026-08-18T21:00:00.000Z";
const PROJECT = "proj-stdio-host";
const STORE = "D:/store/stdio.sqlite";

interface Harness {
  readonly closed: () => void;
  readonly exits: number[];
  readonly host: ReturnType<typeof createStdioHost>;
  readonly lines: string[];
  readonly signal: (name: "SIGINT" | "SIGTERM") => void;
  readonly stops: number[];
}

function harness(overrides: Partial<StdioHostSeam> = {}): Harness {
  const exits: number[] = [];
  const lines: string[] = [];
  const stops: number[] = [];
  let closedHandler: (() => void) | null = null;
  const signalHandlers = new Map<string, () => void>();
  const host = createStdioHost({
    exit: (code) => exits.push(code),
    instant: () => INSTANT,
    onSignal: (name, handler) => signalHandlers.set(name, handler),
    onTransportClosed: (handler) => { closedHandler = handler; },
    pid: 9182,
    projectId: PROJECT,
    stop: async () => { stops.push(stops.length); },
    storePath: STORE,
    write: (line) => lines.push(line),
    ...overrides,
  });
  return {
    closed: () => {
      if (closedHandler === null) throw new Error("no transport-close handler was installed");
      closedHandler();
    },
    exits,
    host,
    lines,
    signal: (name) => {
      const handler = signalHandlers.get(name);
      if (handler === undefined) throw new Error(`no handler for ${name}`);
      handler();
    },
    stops,
  };
}

function receipts(lines: readonly string[]): readonly Record<string, unknown>[] {
  return lines.flatMap((line) => {
    if (!line.startsWith("{")) return [];
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return parsed["schemaVersion"] === FOUNDATION_RECEIPT_SCHEMA_VERSION ? [parsed] : [];
  });
}

describe("the stdio host lifecycle", () => {
  it("publishes one readiness receipt naming the process, project and store", () => {
    const { host, lines } = harness();
    host.publishReady();
    expect(receipts(lines)).toEqual([{
      entry: "MCP_STDIO",
      instant: INSTANT,
      kind: "READY",
      pid: 9182,
      projectId: PROJECT,
      schemaVersion: FOUNDATION_RECEIPT_SCHEMA_VERSION,
      storePath: STORE,
    }]);
  });

  it("drains on transport close, the trigger Windows actually delivers", async () => {
    const { closed, exits, host, lines, stops } = harness();
    host.publishReady();
    closed();
    await host.drain("TRANSPORT_CLOSED");
    expect(receipts(lines)[1]).toMatchObject({
      entry: "MCP_STDIO", kind: "SHUTDOWN", trigger: "TRANSPORT_CLOSED",
    });
    expect(stops.length).toBe(1);
    expect(exits).toEqual([0]);
  });

  it("drains on a POSIX signal, naming that signal in the receipt", async () => {
    const { exits, host, lines, signal } = harness();
    host.publishReady();
    signal("SIGTERM");
    await host.drain("SIGTERM");
    expect(receipts(lines)[1]).toMatchObject({ kind: "SHUTDOWN", trigger: "SIGTERM" });
    expect(exits).toEqual([0]);
  });

  it("leaves ONE shutdown receipt when two drains race", async () => {
    const { closed, exits, host, lines, signal, stops } = harness();
    host.publishReady();
    closed();
    signal("SIGINT");
    await Promise.all([host.drain("TRANSPORT_CLOSED"), host.drain("SIGINT")]);
    // Counted, not merely "the second call did not throw": a double write looks
    // exactly like a silent second drain from the return value alone.
    expect(receipts(lines).filter((entry) => entry["kind"] === "SHUTDOWN").length).toBe(1);
    expect(stops.length).toBe(1);
    expect(exits).toEqual([0]);
  });

  it("still releases the process when the transport dies before readiness", async () => {
    const { exits, host, lines, stops } = harness();
    await host.drain("TRANSPORT_CLOSED");
    // Fails closed on the RECEIPT — it names no readiness that never happened —
    // while the process still stops: a wedged agent session is worse than a
    // missing line.
    expect(lines).toContain("FOUNDATION_RECEIPT_SHUTDOWN_BEFORE_READY FOUNDATION_RECEIPTS");
    expect(receipts(lines)).toEqual([]);
    expect(stops.length).toBe(1);
    expect(exits).toEqual([0]);
  });

  it("releases the process and discloses the fault when the stop path THROWS", async () => {
    // ADVERSARIAL: the drain awaits . A rejecting stop - an SDK close
    // that throws, a store handle that will not close - would otherwise reject
    // the drain promise, so  never runs and an agent session with a closed
    // stdin wedges forever. The receipt is still published: the process really
    // is stopping, and the fault is disclosed by name beside it rather than
    // swallowed.
    const rig = harness({ stop: async () => { throw new Error("handle busy"); } });
    rig.host.publishReady();
    await rig.host.drain("TRANSPORT_CLOSED");
    expect(rig.exits).toEqual([0]);
    expect(rig.lines.some((line) => line.startsWith("FOUNDATION_HOST_STOP_FAILED"))).toBe(true);
    const shutdown = receipts(rig.lines).filter((row) => row["kind"] === "SHUTDOWN");
    expect(shutdown).toHaveLength(1);
    expect(shutdown[0]).toMatchObject({ trigger: "TRANSPORT_CLOSED" });
  });

  it("discloses a refused readiness by code and layer instead of inventing identity", () => {
    const { host, lines } = harness({ storePath: "" });
    host.publishReady();
    expect(lines).toEqual(["FOUNDATION_RECEIPT_STORE_IDENTITY_ABSENT FOUNDATION_RECEIPTS"]);
    expect(receipts(lines)).toEqual([]);
  });
});
