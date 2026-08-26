/**
 * The graph MUTATION family and the graph QUERY, driven END TO END through the PRODUCTION
 * TRANSPORT over a real file-backed `SqliteEventStore` and the real `Authenticator`
 * (task-efc2ef63).
 *
 * WHY THIS FILE EXISTS BESIDE THE EDGE SUITE. `daemon-command-graph-edges.test.ts` proves replay
 * and refusal attribution by calling `runGraphEdge` DIRECTLY, and
 * `daemon-command-graph-authority.test.ts` proves the guard ORDER — but every graph arm in that
 * file is a refusal, so a transport that refused every graph mutation would satisfy both. Nothing
 * anywhere sent a graph mutation through `handleCommandRequest` and reached ACCEPTED. These arms
 * do, so the wiring itself — registry entry, real `CommandDecisionPort`, durable service — is
 * what is under test rather than the edge in isolation.
 *
 * REPLAY IS ASSERTED BY COUNTS, NOT BY THE RETURNED VALUE. A duplicate graph event or a second
 * decision row is invisible to a test that only compares what came back, so each replay and
 * conflict arm pins the graph-revision event count, the goal event count and the decision-row
 * count across the call.
 *
 * THE CLOCK MOVES ON THE REPLAY. `assembleGraphRequest` spreads `decidedAt` INTO the payload and
 * `replayOf` hashes `{kind, payload}`, so a fresh clock read would change the request bytes and
 * answer an honest resubmit with `BOOTSTRAP_COMMAND_BYTES_CONFLICT` — a refusal for a command
 * that SUCCEEDED. A replay arm that reuses one provider cannot see that: both reads return the
 * same string. The second provider below is composed with a LATER clock for exactly that reason.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import {
  GOAL_ID, GRAPH_REVISION_REF, PROJECT_ID, RUN_ID, SEALED_SUBMISSION_HASH,
  approvalCommand, approvalRecord, driveThrough,
} from "./bootstrap/bootstrap-test-fixtures.js";
import { createStoreDependencies } from "./daemon-store-dependencies.js";
import type { CommandAdapterDeps } from "./http/http-contract.js";
import { handleCommandRequest } from "./http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import { createMcpDispatchPort } from "./mcp-dispatch-port.js";
import { graphRevisionAggregateId } from "./planning/active-graph-projection.js";
import { activationWitness } from "./planning/graph-activation-test-fixtures.js";

/** The approval record's own actor, so the operator principal IS the human it names. */
const PRINCIPAL = "principal-1";
const CREDENTIAL = "graph-transport-operator-credential";
const DECIDED_AT = "2026-08-09T12:00:00.000Z";
/** Strictly later, so an unstable `decidedAt` would change the replay preimage. */
const LATER = "2027-03-04T05:06:07.000Z";
const COMMAND_ID = "cmd-graph-transport-approve";

/** The aggregate the activation writes its revision to, from the PRODUCTION id function. */
const GRAPH_AGGREGATE = graphRevisionAggregateId(PROJECT_ID, GRAPH_REVISION_REF);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Counts {
  readonly decisions: number;
  readonly goalEvents: number;
  readonly graphEvents: number;
}

/**
 * A world driven by the SHIPPED bootstrap sequence to the point where the next durable move is
 * the approval itself. Nothing here hand-commits a graph revision: an initial activation IS its
 * whole history, so the revision aggregate must be empty when the transport is called.
 */
function seedProject(prefix: string, approvable: boolean): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  const storePath = join(directory, "store.db");
  const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  try {
    installTestRecoveryBinding(store);
    if (approvable) driveThrough(store, "approval.decide");
  } finally {
    store.close();
  }
  return storePath;
}

const directories: string[] = [];
const closers: Array<() => void> = [];

function providerFor(storePath: string, at: string): ReturnType<typeof createStoreDependencies> {
  const provider = createStoreDependencies({
    clock: () => at,
    credential: CREDENTIAL,
    principalId: PRINCIPAL,
    projectId: PROJECT_ID,
    storePath,
  });
  closers.push(() => { provider.close(); });
  return provider;
}

const activeStorePath = seedProject("moe-graph-transport-", true);
const emptyStorePath = seedProject("moe-graph-transport-empty-", false);

const provider = providerFor(activeStorePath, DECIDED_AT);
const laterProvider = providerFor(activeStorePath, LATER);
const emptyProvider = providerFor(emptyStorePath, DECIDED_AT);

afterAll(() => {
  for (const close of closers) close();
  for (const directory of directories) {
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      // A held handle on Windows must not redden a suite that already answered.
    }
  }
});

/** The caller's INTENT, and nothing else: every server fact is re-attached by the assembly. */
function approvePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activation: activationWitness(),
    command: approvalCommand(),
    graphRevisionRef: GRAPH_REVISION_REF,
    record: approvalRecord(SEALED_SUBMISSION_HASH),
    runId: RUN_ID,
    ...overrides,
  };
}

/** The production HTTP command seam, byte for byte: no harness reassembles the envelope. */
function send(
  deps: CommandAdapterDeps, commandId: string, payload: Record<string, unknown>,
): ReturnType<typeof handleCommandRequest> {
  return handleCommandRequest(deps, {
    body: encoder.encode(JSON.stringify({
      commandId, commandKind: "graph.approve", correlationId: "corr-graph-transport",
      expectedVersion: 0, payload, requestDigest: "a".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: CREDENTIAL,
      targetAggregateId: GOAL_ID,
    })),
    credential: CREDENTIAL,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  });
}

function countsOf(storePath: string): Counts {
  const reader = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  try {
    return {
      decisions: reader.readCommandDecisionsAfter(0n, 1_000).items.length,
      goalEvents: reader.readEvents(GOAL_ID).length,
      graphEvents: reader.readEvents(GRAPH_AGGREGATE).length,
    };
  } finally {
    reader.close();
  }
}

/** The production MCP dispatch port, composed exactly as `mcp-main` composes it. */
function queryPortFor(
  source: ReturnType<typeof createStoreDependencies>,
): ReturnType<typeof createMcpDispatchPort> {
  const subscriptions = source.subscriptions?.();
  if (subscriptions === undefined) throw new Error("provider serves no subscription port");
  return createMcpDispatchPort({
    deps: source.provide(),
    fallbackCredential: CREDENTIAL,
    graph: source.graph?.(),
    subscriptions,
  });
}

function readGraph(
  source: ReturnType<typeof createStoreDependencies>,
): Record<string, unknown> {
  const bytes = queryPortFor(source).dispatchQueryBytes(encoder.encode(JSON.stringify({
    payload: { projectId: PROJECT_ID }, queryKind: "graph.get",
  })));
  return JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
}

describe("graph.approve reaches its durable service through the production transport", () => {
  it("ACCEPTED CONTROL: the operator's dispatch activates the approved graph in one decision", () => {
    const before = countsOf(activeStorePath);
    expect(before.graphEvents).toBe(0);

    const accepted = send(provider.provide(), COMMAND_ID, approvePayload());

    expect(accepted).toMatchObject({
      decision: { commandId: COMMAND_ID, disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED" },
      httpStatus: 200,
      ok: true,
      outcome: "ACCEPTED",
    });
    const after = countsOf(activeStorePath);
    expect(after.decisions).toBe(before.decisions + 1);
    // The core's own atomic event set for an initial activation, pinned EXACTLY rather than as
    // "more than nothing": the replay arm below proves this number does not grow, which is the
    // whole of "no duplicate graph events", and a loose `toBeGreaterThan` could not see a set
    // that silently gained a fifth leg.
    expect(after.graphEvents).toBe(4);
    expect(after.goalEvents).toBe(before.goalEvents + 1);
  });

  it("REPLAYS the same bytes to the ORIGINAL decision with unchanged counts, clock moved", () => {
    // The baseline is taken AFTER the first dispatch, so this arm measures the REPLAY and
    // nothing else — and it holds whether or not the accepted control ran first, which a
    // baseline taken before a possibly-committing call would not.
    const first = send(provider.provide(), COMMAND_ID, approvePayload());
    const before = countsOf(activeStorePath);

    const replayed = send(laterProvider.provide(), COMMAND_ID, approvePayload());

    expect(replayed).toMatchObject({
      decision: { commandId: COMMAND_ID, disposition: "REPLAYED", resultCode: "EFFECTS_COMMITTED" },
      ok: true,
      outcome: "ACCEPTED",
    });
    // The EFFECT, not merely the value: a second commit would mint a new decision id.
    expect(replayed.ok && replayed.outcome === "ACCEPTED" ? replayed.decision.effectId : null)
      .toBe(first.ok && first.outcome === "ACCEPTED" ? first.decision.effectId : undefined);
    expect(countsOf(activeStorePath)).toEqual(before);
  });

  it("refuses CONFLICTING bytes under the SAME decision identity and preserves the original", () => {
    const before = countsOf(activeStorePath);

    const refused = send(provider.provide(), COMMAND_ID, approvePayload({
      activation: activationWitness({ activationRef: "activation-conflicting" }),
    }));

    expect(refused).toMatchObject({
      httpStatus: 422,
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: { code: "BOOTSTRAP_COMMAND_BYTES_CONFLICT", layer: "DAEMON_PREREQUISITE" },
      stage: "DISPATCH",
    });
    // The refusal alone does not prove the FIRST decision survived unmodified.
    expect(countsOf(activeStorePath)).toEqual(before);
    expect(send(laterProvider.provide(), COMMAND_ID, approvePayload())).toMatchObject({
      decision: { disposition: "REPLAYED", resultCode: "EFFECTS_COMMITTED" }, outcome: "ACCEPTED",
    });
  });
});

describe("graph.get answers from the durable projection on the same production surface", () => {
  it("CONTROL: serves the revision the accepted mutation committed", () => {
    // The aggregate id is pinned as a LITERAL beside the derived one. Asserting only that the
    // projection's provenance equals `graphRevisionAggregateId(...)` is invariant to that
    // function: a change to the id shape would move both sides and stay green.
    expect(GRAPH_AGGREGATE).toBe("graph-revision:project-1:graph-revision-1");
    // Self-sufficient: an idempotent resubmit, so this arm answers the same whether it runs
    // after the control above or alone under a `-t` filter. It never commits a second time.
    expect(send(provider.provide(), COMMAND_ID, approvePayload())).toMatchObject({ ok: true });
    expect(readGraph(provider)).toMatchObject({
      graphEpoch: 1,
      ok: true,
      provenance: { aggregateId: GRAPH_AGGREGATE, goalRef: GOAL_ID },
      revisionId: GRAPH_REVISION_REF,
    });
  });

  it("keeps an unactivated project UNKNOWN with an exact code and layer", () => {
    // Not "it refused": the projection's OWN code and layer, so a caller can tell an absent
    // graph from a corrupt one rather than reading one blanket transport error for both.
    expect(readGraph(emptyProvider)).toEqual({
      code: "ACTIVE_GRAPH_ABSENT",
      layer: "ACTIVE_GRAPH_PROJECTION",
      ok: false,
      sourceCode: null,
      sourceLayer: null,
    });
  });
});
