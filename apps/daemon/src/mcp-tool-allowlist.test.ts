import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { allowlistedToolEntries } from "@moe/mcp";
import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { PAYLOAD_KEYS } from "./daemon-command-vocabulary.js";
import { createStoreDependencies } from "./daemon-store-dependencies.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import { createMcpDispatchPort, servedMcpQueryKinds } from "./mcp-dispatch-port.js";
import {
  MCP_EXCLUDED_COMMAND_KINDS, MCP_SERVED_QUERY_KINDS, wiredMcpToolKinds,
} from "./mcp-tool-allowlist.js";

/**
 * The allowlist is DERIVED, never hand-copied — that is the whole point of the rail.
 *
 * The command half is asserted against the live `PAYLOAD_KEYS` import, so a kind another
 * task adds to the vocabulary flows through with no edit here. The query half cannot be
 * enumerated from the port (its branches are literals), so it is bound BEHAVIOURALLY:
 * every kind this module claims is served must survive the PRODUCTION dispatch port, and
 * a kind it does not claim must hit the port's generic INPUT_INVALID refusal.
 */

const CREDENTIAL = "allowlist-operator-credential";
const PROJECT = "proj-mcp-allowlist";

const directory = mkdtempSync(join(tmpdir(), "moe-mcp-allowlist-"));
const storePath = join(directory, "store.db");
const provider = createStoreDependencies({
  clock: () => "2026-08-09T12:00:00.000Z",
  credential: CREDENTIAL,
  principalId: "operator-local",
  projectId: PROJECT,
  storePath,
});
const setupStore = SqliteEventStore.openForProject(storePath, PROJECT);
installTestRecoveryBinding(setupStore);
setupStore.close();
const subscriptions = provider.subscriptions?.();
if (subscriptions === undefined) throw new Error("provider serves no subscription port");

const port = createMcpDispatchPort({
  affordances: provider.affordances?.(),
  deps: provider.provide(),
  fallbackCredential: CREDENTIAL,
  graph: provider.graph?.(),
  subscriptions,
});

afterAll(() => {
  provider.close();
  try {
    rmSync(directory, { force: true, recursive: true });
  } catch {
    // A held handle on Windows must not redden a suite that already answered.
  }
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PAYLOAD_FOR: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  "events.read": { limit: 5, projection: "moe.board", subscriberId: "control-room-1" },
  "graph.get": { projectId: PROJECT },
  "work.get_context": { projectId: PROJECT },
});

/** The port's generic "this is not a query I serve" answer, by its exact code. */
function refusalCodeOf(queryKind: string): string | null {
  const bytes = port.dispatchQueryBytes(
    encoder.encode(JSON.stringify({ payload: PAYLOAD_FOR[queryKind] ?? {}, queryKind })),
  );
  const frame = JSON.parse(decoder.decode(bytes as Uint8Array)) as Record<string, unknown>;
  const error = frame["error"] as { code?: string } | undefined;
  return typeof error?.code === "string" ? error.code : null;
}

describe("wiredMcpToolKinds command half", () => {
  it("equals the daemon's wired command vocabulary MINUS the excluded kinds", () => {
    const commands = wiredMcpToolKinds().filter((kind) => !MCP_SERVED_QUERY_KINDS.includes(kind));
    const expected = [...Object.keys(PAYLOAD_KEYS)]
      .filter((kind) => !MCP_EXCLUDED_COMMAND_KINDS.includes(kind))
      .sort();

    expect(Object.keys(PAYLOAD_KEYS).length).toBeGreaterThan(0);
    // Both directions spelled out: advertised-not-expected AND expected-not-advertised.
    expect([...commands].sort()).toEqual(expected);
    expect(expected).toEqual([...commands].sort());
  });

  it("excludes kinds that are REAL vocabulary keys, and excludes them from the roster", () => {
    const wired = wiredMcpToolKinds();
    const vocabulary = Object.keys(PAYLOAD_KEYS);

    for (const kind of MCP_EXCLUDED_COMMAND_KINDS) {
      // A MISSPELLED member would exclude nothing and leave every other arm green, so the
      // roster is pinned against the vocabulary it claims to subtract from — by exact
      // string equality, never a prefix test: "approval.decide" is a prefix of the
      // unrelated kind "approval.decide_intent".
      expect({ kind, real: vocabulary.includes(kind) }).toEqual({ kind, real: true });
      expect({ advertised: wired.includes(kind), kind }).toEqual({ advertised: false, kind });
    }
  });

  it("advertises events.resume only through the command half", () => {
    const commands = wiredMcpToolKinds().filter((kind) =>
      !MCP_SERVED_QUERY_KINDS.includes(kind));

    expect(commands.filter((kind) => kind === "events.resume")).toHaveLength(1);
    expect(MCP_SERVED_QUERY_KINDS).not.toContain("events.resume");
  });

  it("advertises far fewer kinds than the MCP package generates", () => {
    const wired = wiredMcpToolKinds();

    expect(wired.length).toBe(
      Object.keys(PAYLOAD_KEYS).length
      - MCP_EXCLUDED_COMMAND_KINDS.length
      + MCP_SERVED_QUERY_KINDS.length,
    );
    expect(allowlistedToolEntries(wired).length).toBe(wired.length);
  });

  /**
   * ROSTER DENOMINATORS (epic rail 7). These pin the SIZE of the exclusion, not its members,
   * so a silent shrink is visible even when every membership arm above still passes.
   */
  it("pins an EXACT, frozen exclusion denominator and the derived roster size", () => {
    // EXACT, not `> 0`: a ONE-member roster satisfies `length > 0` while silently
    // re-admitting one approval kind to MCP, which is the precise regression this row exists
    // to prevent. Drilled by deletion in step 7 D3.
    expect(MCP_EXCLUDED_COMMAND_KINDS.length).toBe(2);
    expect(Object.isFrozen(MCP_EXCLUDED_COMMAND_KINDS)).toBe(true);

    // The DERIVED denominator, from live imports on both sides, so it stays true as the
    // vocabulary grows and reds the moment the subtraction stops happening.
    expect(wiredMcpToolKinds().length).toBe(
      Object.keys(PAYLOAD_KEYS).length
      - MCP_EXCLUDED_COMMAND_KINDS.length
      + MCP_SERVED_QUERY_KINDS.length,
    );
    // The measured values behind that identity at delivery: 40 - 2 + 4 = 42. Pinned as a
    // second, INDEPENDENT witness: the identity above would still hold if both sides moved
    // together, and these literals would not.
    expect({
      excluded: MCP_EXCLUDED_COMMAND_KINDS.length,
      queries: MCP_SERVED_QUERY_KINDS.length,
      vocabulary: Object.keys(PAYLOAD_KEYS).length,
      wired: wiredMcpToolKinds().length,
    }).toEqual({ excluded: 2, queries: 4, vocabulary: 40, wired: 42 });
  });

  it("is deterministic and frozen", () => {
    expect(wiredMcpToolKinds()).toEqual(wiredMcpToolKinds());
    expect(Object.isFrozen(wiredMcpToolKinds())).toBe(true);
  });
});

describe("wiredMcpToolKinds query half, bound to the production port", () => {
  it("claims a nonempty query roster", () => {
    expect(MCP_SERVED_QUERY_KINDS.length).toBeGreaterThan(0);
  });

  it("names only query kinds the production port actually serves", () => {
    for (const queryKind of MCP_SERVED_QUERY_KINDS) {
      // A served kind may still refuse for its own reasons; what it must never do is
      // fall through to the port's generic unknown-query refusal.
      expect({ code: refusalCodeOf(queryKind), queryKind })
        .not.toEqual({ code: "INPUT_INVALID", queryKind });
    }
  });

  it("leaves an unserved query kind refused with the port's own stable code", () => {
    expect(MCP_SERVED_QUERY_KINDS).not.toContain("documents.dossier_read");

    expect(refusalCodeOf("documents.dossier_read")).toBe("INPUT_INVALID");
  });

  it("puts every claimed query kind into the derived allowlist", () => {
    const wired = wiredMcpToolKinds();

    for (const queryKind of MCP_SERVED_QUERY_KINDS) {
      expect({ kind: queryKind, listed: wired.includes(queryKind) })
        .toEqual({ kind: queryKind, listed: true });
    }
  });
});

/**
 * task-4dd05f0c: the roster rail wants BIDIRECTIONAL set-equality against the IMPLEMENTATION
 * SEAM, not a subset check computed by iterating the roster itself. Two independent
 * enumerations exist on purpose — the advertised roster (`wiredMcpToolKinds`) and the served
 * sets read out of production (`registry.keys()` for commands, `servedMcpQueryKinds()` for
 * queries) — so deleting an entry from either side reddens, which a self-iterating test
 * cannot see.
 */

const decisionsIn = (): readonly { readonly commandKind: string }[] => {
  const store = SqliteEventStore.openForProject(storePath, PROJECT);
  try {
    const items: { readonly commandKind: string }[] = [];
    let cursor = 0n;
    for (;;) {
      const page = store.readCommandDecisionsAfter(cursor, 100);
      items.push(...page.items);
      if (page.nextCursor === null || page.items.length === 0) return items;
      cursor = page.nextCursor;
    }
  } finally {
    store.close();
  }
};

describe("task-4dd05f0c served/advertised parity", () => {
  it("C1 advertises exactly the commands the registry serves, MINUS the excluded kinds", () => {
    const served = [...provider.provide().registry.keys()].sort();
    const advertised = wiredMcpToolKinds()
      .filter((kind) => !(MCP_SERVED_QUERY_KINDS as readonly string[]).includes(kind))
      .sort();
    const expected = served
      .filter((kind) => !MCP_EXCLUDED_COMMAND_KINDS.includes(kind));

    expect(served.length).toBeGreaterThan(0);
    expect(new Set(served).size).toBe(served.length);
    // Both directions spelled out: advertised-not-expected AND expected-not-advertised.
    expect(advertised).toEqual(expected);
    expect(expected).toEqual(advertised);
  });

  it("C2 keeps every excluded kind SERVED by the registry — this closes ONE transport", () => {
    // Widened to string[] deliberately: `registry.keys()` is typed as the closed command-kind
    // union, and MCP_EXCLUDED_COMMAND_KINDS is `readonly string[]` so the roster can name a
    // kind the union does not yet carry. Comparing as strings is what makes the misspelling
    // arm above meaningful — a union-typed compare would be a compile error, not a red test.
    const served: readonly string[] = [...provider.provide().registry.keys()];

    // The point of the row, stated as an assertion: the kinds leave the MCP ADVERTISEMENT
    // and stay fully wired in the daemon, so the browser/HTTP approval path is untouched.
    // Without this arm, deleting them from PAYLOAD_KEYS outright would also pass C1.
    for (const kind of MCP_EXCLUDED_COMMAND_KINDS) {
      expect({ kind, served: served.includes(kind) }).toEqual({ kind, served: true });
    }
  });

  it("Q1 advertises exactly the queries the production port serves", () => {
    const served = [...servedMcpQueryKinds()].sort();
    const advertised = [...MCP_SERVED_QUERY_KINDS].sort();

    expect(served.length).toBeGreaterThan(0);
    expect(new Set(served).size).toBe(served.length);
    expect(advertised).toEqual(served);
    expect(served).toEqual(advertised);
  });

  it("Q2 routes every query through the enumerable table, with no literal branch left", () => {
    const source = readFileSync(new URL("./mcp-dispatch-port.ts", import.meta.url), "utf8");
    const pattern = /envelope\["queryKind"\]\s*[!=]==\s*"([^"]+)"/gu;
    // Positive control: the regex still matches the shape it was written for, so an
    // empty match set means "no literal branches", never "the anchor silently rotted".
    const control = [...'if (envelope["queryKind"] === "graph.get") {'.matchAll(pattern)]
      .map((match) => match[1]);
    expect(control).toEqual(["graph.get"]);

    expect([...source.matchAll(pattern)].map((match) => match[1])).toEqual([]);
    expect(servedMcpQueryKinds().length).toBeGreaterThanOrEqual(4);
  });

  it("S1 generates events_resume once, on the command surface", () => {
    const entries = allowlistedToolEntries(wiredMcpToolKinds())
      .filter((entry) => entry.tool.name === "events_resume");

    expect(entries).toHaveLength(1);
    expect(entries[0]?.surface).toBe("command");
    expect(entries[0]?.kind).toBe("events.resume");
  });

  it("P1 refuses an inherited Object.prototype key as a query kind", () => {
    // The table lookup is on ATTACKER-CONTROLLED wire input. A plain object literal still
    // inherits from Object.prototype, so "toString" and friends resolve to real functions
    // and would be CALLED as handlers. Each must reach the port's generic refusal instead.
    for (const queryKind of [
      "toString", "constructor", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf",
    ]) {
      const bytes = port.dispatchQueryBytes(
        encoder.encode(JSON.stringify({ payload: {}, queryKind })),
      );
      const frame = JSON.parse(decoder.decode(bytes as Uint8Array)) as Record<string, unknown>;

      expect({ code: (frame["error"] as { code?: string } | undefined)?.code, queryKind })
        .toEqual({ code: "INPUT_INVALID", queryKind });
      expect({ ok: frame["ok"], queryKind }).toEqual({ ok: false, queryKind });
    }
    expect(servedMcpQueryKinds()).not.toContain("toString");
  });

  it("D2 refuses events.resume on the query seam and writes no durable decision", () => {
    const before = decisionsIn();
    const bytes = port.dispatchQueryBytes(encoder.encode(JSON.stringify({
      payload: {
        presentedCursor: { generation: 0, position: "0" },
        projection: "moe.board",
        subscriberId: "control-room-1",
      },
      queryKind: "events.resume",
    })));
    const frame = JSON.parse(decoder.decode(bytes as Uint8Array)) as Record<string, unknown>;

    expect((frame["error"] as { code?: string } | undefined)?.code).toBe("INPUT_INVALID");
    expect(frame["ok"]).toBe(false);
    const after = decisionsIn();
    expect(after.filter((item) => item.commandKind === "events.resume")).toEqual([]);
    expect(after.length).toBe(before.length);
  });
});
