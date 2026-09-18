import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STDIO_TOOL_INDEX, allowlistedToolEntries, createStdioMcpServer, toolLabelForKind,
} from "@moe/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createStoreDependencies } from "./daemon-store-dependencies.js";
import { FOUNDATION_RECEIPT_SCHEMA_VERSION } from "./host/foundation-receipts.js";
import { composeStdioServer, createStdioHost } from "./mcp-main.js";
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
 * `composeStdioServer` in mcp-main.ts hands `wiredMcpToolKinds()` to `createStdioMcpServer`
 * as its `toolAllowlist`, and `createMcpHttpHost` in mcp-http/mcp-http-host.ts does the same
 * INDEPENDENTLY. Closing one entry proves nothing about the other, so each has its own arm and
 * neither stands in for the other.
 *
 * WHY STDIO-1 ASSERTS THE SEAM'S INPUTS AND THE HTTP ARM DRIVES A REAL `tools/call`: the
 * exclusion arm asserts the EXACT production expressions the stdio seam is built from, which
 * is decisive about which refusal branch fires. Named by symbol, not by line, because the line
 * numbers drifted twice; the bindings are in `createStdioMcpServer` and `callTool` of
 * packages/mcp/src/stdio/stdio-server.ts:
 *   createStdioMcpServer  tools   = listedFrom(withPayloadProperties(allowlistedToolEntries(...)))
 *   createStdioMcpServer  allowed = new Set(tools.map((tool) => tool.name))
 *   callTool              entry === undefined            -> INPUT_INVALID
 *   callTool              known label, !allowed.has(...) -> CAPABILITY_DENIED
 * So proving, for each excluded kind, that `STDIO_TOOL_INDEX` DOES hold its generated label
 * while `allowed` does NOT pins the CAPABILITY_DENIED branch specifically and rules out the
 * INPUT_INVALID one. The HTTP arm in mcp-http-host.test.ts drives the identical refusal
 * (`refuseInvalidInput` / `CAPABILITY_DENIED` in http-tool-bridge.ts) all the way through a
 * real request and asserts the code off the wire, so the end-to-end proof exists once, on the
 * entry that can carry it. The typed-payload overlay is different: STDIO-3 below builds the
 * server `composeStdioServer` builds and reads `tools/list` off it over the SDK's in-memory
 * transport, so that wiring line is pinned on the transport the seats actually use.
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
 * MCP_TRANSPORT_ENTRY_COUNT is 2 — `composeStdioServer` (stdio) and `createMcpHttpHost`
 * (http) — each of which passes wiredMcpToolKinds() INDEPENDENTLY. This file covers ONE of
 * them, so the row's total case count is kinds x entries = 26 x 2 = 52, and the arm below
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
  "escalation.decide",
  "product_contract.answer_clarification",
  "cutover.activate",
  // 0b53ccc5 added `goal.cancel` as an operator-only kind, so the DERIVED exclusion grew and
  // this hand transcription did not. Abandoning a product is a human act on the same terms
  // as closing one.
  "goal.cancel",
  "goal.close",
  "graph.approve",
  "graph.supersede",
  "integration.accept_output",
  "preview.decide",
  "environment.set_variable",
  "environment.unset_variable",
  "repository.bootstrap",
  "repository.publish",
  "release.decide", "deployment.deploy", "deployment.migrate_down", "deployment.rollback", "deployment.set_target",
  "product_contract.sync_env_example",
  "preview.start",
  "resource.confirm_released",
  // task-eb37494e: re-timing the production health probe is the operator's act. This literal is
  // the INDEPENDENT side of the comparison, so it is hand-written here even though production
  // derives the exclusion from OPERATOR_PRINCIPAL_KINDS.
  "monitoring.set_probe_interval",
  // task-509f0437: retiring an environment ends its monitoring, so it is the operator's act on
  // the same standing. Hand-written here for the same independence reason as the kind above.
  "monitoring.retire_environment",
]);
const EXCLUSION_CASES: readonly { readonly entry: string; readonly kind: string }[] =
  Object.freeze(MCP_EXCLUDED_COMMAND_KINDS.map((kind) => Object.freeze({ entry: ENTRY, kind })));

describe("task-4c9b1d85 stdio entry excludes every human-only kind", () => {
  /** EXACTLY what `createStdioMcpServer` computes into `allowed` from `toolAllowlist`. */
  function advertisedNames(): readonly string[] {
    return allowlistedToolEntries(wiredMcpToolKinds()).map((entry) => entry.tool.name);
  }

  it("STDIO-1 omits every excluded kind from the capability set, as a KNOWN label", () => {
    const allowed = new Set(advertisedNames());

    // The sweep must have GENERATED cases: a zero-case loop passes vacuously.
    // 29 since `goal.cancel` landed (0b53ccc5): the set is DERIVED from the operator-only
    // kinds, so an operator act joins it automatically. Verified the 29th entry IS goal.cancel.
    expect(EXCLUSION_CASES.length).toBe(29);
    expect(Object.isFrozen(EXCLUSION_CASES)).toBe(true);
    expect(EXCLUSION_CASES.length * MCP_TRANSPORT_ENTRY_COUNT).toBe(58);
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
      // Omitted from `allowed` => CAPABILITY_DENIED in `callTool`.
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

  it("STDIO-3 advertises review.submit round as a JSON integer on the REAL entry's tools/list", async () => {
    // Not a server this arm assembles itself: `composeStdioServer` is what `main` runs, roster
    // and overlay included, over a real provider on a throwaway store. Deleting the
    // `payloadProperties: wiredMcpPayloadProperties()` line from mcp-main.ts reds THIS arm and
    // nothing weaker, which is the pin the stdio entry lacked while only the HTTP entry had one.
    const directory = mkdtempSync(join(tmpdir(), "moe-stdio-overlay-"));
    const provider = createStoreDependencies({
      credential: "stdio-overlay-credential",
      principalId: "principal-stdio-overlay",
      projectId: "proj-stdio-overlay",
      storePath: join(directory, "store.db"),
    });
    const server = composeStdioServer({
      credential: "stdio-overlay-credential",
      onDispatchFault: () => { throw new Error("no tool call is dispatched by a listing"); },
      provider,
    });
    const client = new Client({ name: "stdio-overlay", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let tools: readonly { name: string; inputSchema: { properties?: Record<string, unknown> | undefined } }[];
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      tools = (await client.listTools()).tools;
    } finally {
      await client.close();
      await server.close();
      provider.close();
      rmSync(directory, { force: true, recursive: true });
    }

    // Read off the tool by name, never by substring: a typed member on the WRONG tool must fail.
    const submit = tools.find((tool) => tool.name === toolLabelForKind("review.submit"));
    expect(submit).toBeDefined();
    const payload = submit!.inputSchema.properties!["payload"] as Record<string, unknown>;
    expect(payload).toMatchObject({ additionalProperties: true, type: "object" });
    expect(payload["properties"]).toEqual({ round: {
      description: expect.stringContaining("JSON integer >= 1") as unknown as string,
      maximum: Number.MAX_SAFE_INTEGER, minimum: 1, type: "integer",
    } });
    // Untyped kinds stay opaque: the overlay is per key, not a blanket.
    const create = tools.find((tool) => tool.name === toolLabelForKind("goal.create"));
    expect(Object.hasOwn(create!.inputSchema.properties!["payload"] as object, "properties")).toBe(false);
    // The listing is the wired roster, so STDIO-1's exclusion holds on the real entry too.
    expect(tools.length).toBe(wiredMcpToolKinds().length);
  });
});
