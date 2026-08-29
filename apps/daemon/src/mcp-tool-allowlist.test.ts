import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_QUERY_KINDS } from "@moe/contracts";
import { allowlistedToolEntries } from "@moe/mcp";
import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { PAYLOAD_KEYS } from "./daemon-command-vocabulary.js";
import { createStoreDependencies } from "./daemon-store-dependencies.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import { createMcpDispatchPort } from "./mcp-dispatch-port.js";
import { MCP_SERVED_QUERY_KINDS, wiredMcpToolKinds } from "./mcp-tool-allowlist.js";

/**
 * The allowlist is DERIVED, never hand-copied — that is the whole point of the rail.
 *
 * The command half is asserted against the live `PAYLOAD_KEYS` import, so a kind another
 * task adds to the vocabulary flows through with no edit here. The query half cannot be
 * enumerated from the port (its branches are literals), so it is bound BEHAVIOURALLY:
 * every canonical query kind is probed through the PRODUCTION dispatch port and the exact
 * set that survives its generic INPUT_INVALID fallthrough must equal the advertised roster.
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
  it("equals the daemon's wired command vocabulary exactly", () => {
    const commands = wiredMcpToolKinds().filter((kind) => !MCP_SERVED_QUERY_KINDS.includes(kind));

    expect(Object.keys(PAYLOAD_KEYS).length).toBeGreaterThan(0);
    expect([...commands].sort()).toEqual([...Object.keys(PAYLOAD_KEYS)].sort());
  });

  it("advertises events.resume only through the command half", () => {
    const commands = wiredMcpToolKinds().filter((kind) =>
      !MCP_SERVED_QUERY_KINDS.includes(kind));

    expect(commands.filter((kind) => kind === "events.resume")).toHaveLength(1);
    expect(MCP_SERVED_QUERY_KINDS).not.toContain("events.resume");
  });

  it("advertises far fewer kinds than the MCP package generates", () => {
    const wired = wiredMcpToolKinds();

    expect(wired.length).toBe(Object.keys(PAYLOAD_KEYS).length + MCP_SERVED_QUERY_KINDS.length);
    expect(allowlistedToolEntries(wired).length).toBe(wired.length);
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

  it("equals the production port's served canonical query vocabulary in both directions", () => {
    const behaviorallyServed = RUNTIME_QUERY_KINDS.filter((queryKind) =>
      refusalCodeOf(queryKind) !== "INPUT_INVALID");

    expect(behaviorallyServed.length).toBeGreaterThan(0);
    expect([...MCP_SERVED_QUERY_KINDS].sort()).toEqual([...behaviorallyServed].sort());
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
