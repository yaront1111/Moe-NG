import {
  STDIO_TOOL_INDEX, allowlistedToolEntries, createStdioMcpServer, toolLabelForKind,
} from "@moe/mcp";
import { describe, expect, it } from "vitest";

import { FOUNDATION_RECEIPT_SCHEMA_VERSION } from "./host/foundation-receipts.js";
import { createStdioHost } from "./mcp-main.js";
import type { StdioHostSeam } from "./mcp-main.js";
import { MCP_EXCLUDED_COMMAND_KINDS, wiredMcpToolKinds } from "./mcp-tool-allowlist.js";

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

/**
 * task-4c9b1d85 — the STDIO half of the transport closure.
 *
 * `mcp-main.ts:131` hands `wiredMcpToolKinds()` to `createStdioMcpServer` as its
 * `toolAllowlist`, and `mcp-http/mcp-http-host.ts:142` does the same INDEPENDENTLY. Closing
 * one entry proves nothing about the other, so each has its own arm and neither stands in
 * for the other.
 *
 * WHY THIS ARM ASSERTS THE SEAM'S INPUTS AND THE HTTP ARM DRIVES A REAL `tools/call`:
 * exercising stdio end to end needs an MCP client and an in-memory transport, and
 * `@modelcontextprotocol/sdk` is a dependency of `@moe/mcp` ONLY — it is NOT declared by
 * `@moe/daemon` and does not resolve here. Rather than deep-import an undeclared package,
 * this arm asserts the EXACT production expressions the stdio seam is built from, which is
 * decisive about which refusal branch fires:
 *   stdio-server.ts:233-235  tools = listedFrom(allowlistedToolEntries(options.toolAllowlist))
 *   stdio-server.ts:236      allowed = new Set(tools.map((tool) => tool.name))
 *   stdio-server.ts:167      entry === undefined            -> INPUT_INVALID
 *   stdio-server.ts:168      known label, !allowed.has(...) -> CAPABILITY_DENIED
 * So proving, for each excluded kind, that `STDIO_TOOL_INDEX` DOES hold its generated label
 * while `allowed` does NOT pins the CAPABILITY_DENIED branch specifically and rules out the
 * INPUT_INVALID one. The HTTP arm in mcp-http-host.test.ts drives the identical refusal
 * (http-tool-bridge.ts:193/:195) all the way through a real request and asserts the code off
 * the wire, so the end-to-end proof exists once, on the entry that can carry it.
 *
 * Every label is derived through the production helper `toolLabelForKind`, never hand-spelled:
 * a hand spelling that drifted from the generator would be an UNKNOWN label, would take the
 * INPUT_INVALID branch, and would green these arms for the wrong reason.
 */
const ENTRY = "stdio";

/**
 * The transport-exclusion SWEEP ROSTER for this entry, named as a frozen constant so its
 * denominator can be pinned (epic rail 7) and drilled by deletion (step 7 D4). A sweep that
 * silently generates zero cases passes while testing nothing.
 *
 * MCP_TRANSPORT_ENTRY_COUNT is 2 — mcp-main.ts:131 (stdio) and mcp-http/mcp-http-host.ts:142
 * (http) — each of which passes wiredMcpToolKinds() INDEPENDENTLY. This file covers ONE of
 * them, so the row's total case count is kinds x entries = 21 x 2 = 42, and the arm below
 * asserts both this file's share and that documented total.
 *
 * HAND-WRITTEN: the operator-only kinds of `OPERATOR_PRINCIPAL_KINDS` less `session.open` (the
 * operator's own scoped-session mint over the bearer-authorized MCP HTTP path). Production
 * derives its exclusion from that set, so this literal is the independent side of the comparison.
 */
const MCP_TRANSPORT_ENTRY_COUNT = 2;
const EXPECTED_EXCLUDED_COMMAND_KINDS: readonly string[] = Object.freeze([
  "project.set_agent_provider",
  "criterion_check.approve", "criterion_check.verify", "repository.recover",
  "approval.decide",
  "approval.decide_intent",
  "product_contract.answer_clarification",
  "cutover.activate",
  "goal.close",
  "graph.approve",
  "graph.supersede",
  "integration.accept_output",
  "preview.decide",
  "environment.set_variable",
  "environment.unset_variable",
  "repository.bootstrap",
  "repository.publish",
  "release.decide", "deployment.deploy", "deployment.rollback", "deployment.set_target",
  "product_contract.sync_env_example",
  "preview.start",
  "resource.confirm_released",
]);
const EXCLUSION_CASES: readonly { readonly entry: string; readonly kind: string }[] =
  Object.freeze(MCP_EXCLUDED_COMMAND_KINDS.map((kind) => Object.freeze({ entry: ENTRY, kind })));

describe("task-4c9b1d85 stdio entry excludes every human-only kind", () => {
  /** EXACTLY what stdio-server.ts:233-236 computes from `toolAllowlist`. */
  function advertisedNames(): readonly string[] {
    return allowlistedToolEntries(wiredMcpToolKinds()).map((entry) => entry.tool.name);
  }

  it("STDIO-1 omits every excluded kind from the capability set, as a KNOWN label", () => {
    const allowed = new Set(advertisedNames());

    // The sweep must have GENERATED cases: a zero-case loop passes vacuously.
    expect(EXCLUSION_CASES.length).toBe(24);
    expect(Object.isFrozen(EXCLUSION_CASES)).toBe(true);
    expect(EXCLUSION_CASES.length * MCP_TRANSPORT_ENTRY_COUNT).toBe(48);
    const expected = [...EXPECTED_EXCLUDED_COMMAND_KINDS].sort();
    const production = [...MCP_EXCLUDED_COMMAND_KINDS].sort();
    expect(production).toEqual(expected);
    expect(expected).toEqual(production);
    expect(EXPECTED_EXCLUDED_COMMAND_KINDS)
      .toContain("product_contract.answer_clarification");
    expect(MCP_EXCLUDED_COMMAND_KINDS)
      .toContain("product_contract.answer_clarification");
    for (const { kind } of EXCLUSION_CASES) {
      const label = toolLabelForKind(kind);
      // Branch discriminator, both halves required. Generated => not INPUT_INVALID.
      expect({ generated: STDIO_TOOL_INDEX.get(label) !== undefined, kind })
        .toEqual({ generated: true, kind });
      // Omitted from `allowed` => CAPABILITY_DENIED at stdio-server.ts:168.
      expect({ allowed: allowed.has(label), kind }).toEqual({ allowed: false, kind });
    }
    // A surviving control, so "advertises nothing" cannot pass this arm.
    expect(allowed.has(toolLabelForKind("goal.create"))).toBe(true);
    expect(allowed.size).toBeGreaterThan(0);
  });

  it("STDIO-2 still builds the real server the daemon builds, with the real roster", () => {
    // A roster the generator cannot resolve throws MCP_TOOL_ALLOWLIST_UNKNOWN_KIND at
    // construction, so this also proves the subtraction left a VALID roster behind rather
    // than one the stdio entry would refuse to start on.
    const server = createStdioMcpServer({
      credential: "stdio-exclusion-credential",
      port: {
        // Every seam throws. The arm asserts the excluded kinds never REACH the port, so a
        // port that could answer would weaken it: if the roster ever re-admitted a kind, this
        // throws loudly instead of quietly returning a plausible frame.
        authenticate: () => {
          throw new Error("authenticate must never be reached for an excluded kind");
        },
        dispatchCommandBytes: () => {
          throw new Error("dispatch must never be reached for an excluded kind");
        },
        dispatchQueryBytes: () => {
          throw new Error("dispatch must never be reached for an excluded kind");
        },
      },
      // THE REAL ROSTER. A hand-passed array would be a fixed point that cannot detect a
      // regression in the very module under test.
      toolAllowlist: wiredMcpToolKinds(),
    });

    expect(server).toBeDefined();
    expect(advertisedNames().length).toBe(wiredMcpToolKinds().length);
  });
});
