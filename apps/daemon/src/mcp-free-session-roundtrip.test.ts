/**
 * THE FREE-SESSION ROUND TRIP: what `moe mcp` actually buys.
 *
 * A headless session — an agent, a CLI, a script — cannot drive the browser
 * command route: it is walled by Host + Origin + CSRF and that token is minted
 * at pairing. The MCP transport authenticates by credential instead. These arms
 * prove the three things that makes possible, over a REAL store and the SAME
 * port and roster `mcp-main.ts` composes:
 *
 *   1. it can CREATE a goal and bind a PRD to it (goal.create_with_source),
 *   2. it can READ that state back over the MCP query kinds,
 *   3. it CANNOT take an operator-only act, and the refusal is the transport's.
 *
 * Arm 3 is the load-bearing one. The dispatch port is composed with
 * `fallbackCredential`, so an MCP caller authenticates AS the operator and a
 * capability check alone would PASS. The roster exclusion is the only fence,
 * which is why the arm proves WHICH LAYER refused rather than merely that
 * something did.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { createStdioMcpServer } from "@moe/mcp";
import type { StdioDispatchPort } from "@moe/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, driveThrough } from "./bootstrap/bootstrap-test-fixtures.js";
import { createStoreDependencies } from "./daemon-store-dependencies.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import { createMcpDispatchPort } from "./mcp-dispatch-port.js";
import { wiredMcpToolKinds } from "./mcp-tool-allowlist.js";

/** The operator secret. `moe mcp` hands this to the stdio entry as BOTH credentials. */
const CREDENTIAL = "free-session-operator-credential";
const GOAL_COMMAND_ID = "cmd-free-session-goal";
/** Production derives the goal aggregate from the authenticated command identity. */
const GOAL_REF = `goal-${GOAL_COMMAND_ID}`;

const PRD = "# Headless goal\n\nWhat the free session asked for, in its own words.\n";
const SOURCE = Object.freeze({
  displayPath: "docs/headless-prd.md",
  mediaType: "text/markdown",
  text: PRD,
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const directory = mkdtempSync(join(tmpdir(), "moe-free-session-"));
const storePath = join(directory, "store.db");

// The bootstrap prerequisites `goal.create_with_source` declares (project.activate
// and everything before it) are seeded through the production bootstrap pipeline,
// then the store is closed and reopened by the provider. Only the goal creation
// itself crosses the MCP boundary — that is the claim under test.
const setup = SqliteEventStore.openForProject(storePath, PROJECT_ID);
installTestRecoveryBinding(setup);
driveThrough(setup, "goal.create");
setup.close();

const provider = createStoreDependencies({
  clock: () => "2026-09-18T09:00:00.000Z",
  credential: CREDENTIAL,
  principalId: "principal-1",
  projectId: PROJECT_ID,
  storePath,
});
const subscriptions = provider.subscriptions?.();
if (subscriptions === undefined) throw new Error("provider serves no subscription port");

/**
 * Composed exactly as `mcp-main.ts` composes it, INCLUDING `documents` — the
 * neighbouring harness omits that seam, and both `goal.create_with_source` and
 * `documents.source_read` need it.
 */
const port = createMcpDispatchPort({
  affordances: provider.affordances?.(),
  commandAuthorityPlane: provider.commandAuthorityPlane?.(),
  deps: provider.provide(),
  design: provider.designReads?.(),
  documents: provider.goalSource?.(),
  fallbackCredential: CREDENTIAL,
  graph: provider.graph?.(),
  subscriptions,
  v2Deps: provider.provideV2?.(),
});

afterAll(() => {
  provider.close();
  closeStores();
  rmSync(directory, { force: true, recursive: true });
});

function decode(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
}

function commandBytes(
  commandKind: string, commandId: string, targetAggregateId: string,
  expectedVersion: number, payload: Record<string, unknown>,
): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId,
    commandKind,
    correlationId: "corr-free-session",
    expectedVersion,
    payload,
    requestDigest: createHash("sha256")
      .update(encoder.encode(JSON.stringify(payload))).digest("hex"),
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: CREDENTIAL,
    targetAggregateId,
  }));
}

describe("a free session over MCP", () => {
  it("creates a goal and binds its PRD, committing GoalCreated to the durable store", async () => {
    const answer = decode(await port.dispatchCommandBytes(commandBytes(
      "goal.create_with_source", GOAL_COMMAND_ID, GOAL_REF, 0,
      // The EXACT payload keys the seam admits (daemon-command-payload-keys.ts:149).
      // Naming any other key is refused INPUT_INVALID at PAYLOAD_SHAPE.
      { instructions: "Ship the headless access path.", source: SOURCE, title: "Headless goal" },
    )));

    expect(answer).toMatchObject({
      decision: { disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED" },
      ok: true,
      outcome: "ACCEPTED",
    });

    // The wire answer is a claim; the store is the truth.
    const reader = SqliteEventStore.openForProject(storePath, PROJECT_ID);
    try {
      expect(reader.readEvents(GOAL_REF).map((event) => event.eventType))
        .toContain("GoalCreated");
    } finally {
      reader.close();
    }
  });

  it("reads the bound PRD back over the MCP query kinds", () => {
    const answer = decode(port.dispatchQueryBytes(encoder.encode(JSON.stringify({
      correlationId: "corr-free-session-read",
      payload: { goalRef: GOAL_REF },
      queryKind: "documents.source_read",
      schemaVersion: "moe-runtime-query/1",
      sessionCredential: CREDENTIAL,
    }))));

    // Not "it answered something": the exact three fields the session supplied.
    expect(answer).toMatchObject({
      displayPath: SOURCE.displayPath,
      mediaType: SOURCE.mediaType,
      ok: true,
      text: SOURCE.text,
    });
    expect(answer["contentSha256"])
      .toBe(createHash("sha256").update(PRD, "utf8").digest("hex"));
  });

  it("refuses an operator-only kind AT THE TRANSPORT, before the port is ever asked", async () => {
    // A spy standing where the real port stands. If ANY layer below the roster
    // answered this call, `dispatched` would be non-empty — which is how this
    // arm proves the LAYER instead of asserting it in a comment.
    const dispatched: string[] = [];
    const spy: StdioDispatchPort = {
      authenticate: (_credential, kind) => {
        dispatched.push(`authenticate:${kind}`);
        return { ok: true };
      },
      dispatchCommandBytes: (bytes) => {
        dispatched.push("dispatchCommandBytes");
        return Promise.resolve(bytes);
      },
      dispatchQueryBytes: (bytes) => {
        dispatched.push("dispatchQueryBytes");
        return bytes;
      },
    };
    const server = createStdioMcpServer({
      credential: CREDENTIAL,
      port: spy,
      serverName: "moe-next",
      // The PRODUCTION roster, not a hand-written one: this is the same value
      // mcp-main.ts passes, so the fence under test is the shipped fence.
      toolAllowlist: wiredMcpToolKinds(),
    });
    const client = new Client({ name: "free-session", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    let thrown: unknown;
    try {
      // `goal.close` is a REAL kind with a real tool schema — the refusal below
      // is the roster's, not "no such tool".
      await client.callTool({ arguments: { goalId: GOAL_REF }, name: "goal_close" });
    } catch (error) {
      thrown = error;
    } finally {
      await client.close();
      await server.close();
    }

    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).data).toMatchObject({ code: "CAPABILITY_DENIED" });
    // THE LAYER, PROVEN. The port authenticates with the operator credential as
    // fallback, so a capability check would have let this through; the transport
    // refused before envelope construction, authentication or dispatch.
    expect(dispatched).toEqual([]);
  });

  it("advertises goal creation and the read kinds a free session needs", () => {
    const wired = wiredMcpToolKinds();
    for (const kind of ["goal.create", "goal.create_with_source", "documents.source_read"]) {
      expect(wired, kind).toContain(kind);
    }
    // The fence arm above is only meaningful while these stay OFF the roster.
    for (const kind of ["goal.close", "goal.cancel"]) {
      expect(wired, kind).not.toContain(kind);
    }
  });
});
