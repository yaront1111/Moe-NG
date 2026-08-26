/**
 * The server-only Foundation context prelaunch composition (task-933605a5), driven through a
 * REAL file-backed SqliteEventStore.
 *
 * WHAT IS REAL HERE, and it is nearly everything: the ledger and the strict readback run against
 * a real SQLite file, the mission comes from `produceNodeBrief` over a store whose graph the
 * PRODUCTION activation service made ACTIVE, the capabilities come from the real
 * `resolveCurrentProviderProfile`, and the rendered bytes come from the real `renderContext` over
 * a real `selectContext` admission. Nothing asserts against a re-implementation of the subject.
 *
 * THE ONE STAND-IN, disclosed rather than hidden: `FoundationContextAuthority` is INJECTED. The
 * accepted answer of the production `createFoundationContextAuthority` needs the whole integrated
 * Foundation world — 11 mandatory matrix items across activation, dispatch, capture, journal,
 * review, configuration and provider profile — which `foundation-context-selection.test.ts`
 * already seeds in 913 lines and which is that row's fixture, not this one's. The REFUSAL arms
 * below therefore use the REAL authority over a real store so the upstream code and layer this
 * composition forwards are the production ones; the accepted arms inject an authority whose
 * `selection` is a real `selectContext` admission. The composition's own contract with the
 * authority is the interface, so this is the seam, not a reimplementation of it.
 *
 * WINDOWS HANDLE DISCIPLINE: every store handle is closed before its temp directory is removed.
 * A handle held across the cleanup throws EPERM and kills the vitest worker with no output.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CONTEXT_BYTE_BUDGET, digestContextManifest, renderContext, selectContext,
} from "@moe/context";
import type { AdmittedContextSelection } from "@moe/context";
import { DurableStoreError, SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { hex64 } from "../bootstrap/bootstrap-test-fixtures.js";
import { CODING_TOOLS } from "../orchestrator/agent-spawn-environment.js";
import {
  NODE_KEY, PROJECT_ID, RUNTIME_FACTS, activeGraphStore, capabilities, closeStores, depsFor,
  inactiveGraphStore,
} from "../planning/node-mission-test-fixtures.js";
import { deriveFoundationContextRecordDigest }
  from "./foundation-context-manifest-codec.js";
import {
  commitFoundationContextManifest, deriveFoundationContextAggregateId,
} from "./foundation-context-manifest-ledger.js";
import { FOUNDATION_CONTEXT_MATRIX_VERSION, createFoundationContextAuthority }
  from "./foundation-context-selection.js";
import type {
  FoundationContextAuthority, FoundationContextProvenance,
} from "./foundation-context-selection.js";
import { prepareFoundationContextForLaunch } from "./foundation-context-prelaunch.js";
import type { FoundationPrelaunchServices } from "./foundation-context-prelaunch.js";

const ATTEMPT_REF = "attempt-prelaunch-1";
const SESSION_ID = "session-prelaunch-1";
const DECIDED_AT = "2026-08-26T00:00:00.000Z";
const IDENTITY = Object.freeze({
  attemptRef: ATTEMPT_REF, nodeKey: NODE_KEY, projectId: PROJECT_ID, sessionId: SESSION_ID,
});

/** Written out by hand. Do not replace with a map over the production roster. */
const EXPECTED_RECORD_KEYS = [
  "attemptRef", "configurationDigest", "graphContentHash", "graphEpoch", "graphRevisionRef",
  "inputManifestDigest", "manifest", "nodeKey", "projectId", "recordDigest", "sessionId",
] as const;

const roots: string[] = [];
const ledgers: SqliteEventStore[] = [];

afterAll(() => {
  while (ledgers.length > 0) ledgers.pop()?.close();
  closeStores();
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});

/** A file-backed store bound to this project; the ledger and the readback share it. */
function ledgerStore(label: string): SqliteEventStore {
  const root = mkdtempSync(join(tmpdir(), `moe-prelaunch-${label}-`));
  roots.push(root);
  const store = SqliteEventStore.openForProject(join(root, "project.db"), PROJECT_ID);
  ledgers.push(store);
  return store;
}

function rawCounts(store: SqliteEventStore): { decisions: number; events: number } {
  return {
    decisions: store.readCommandDecisionsAfter(0n, 1_000).items.length,
    events: store.readEventsAfter(0n, 1_000).items.length,
  };
}

function portFor(store: SqliteEventStore): FoundationPrelaunchServices["readPort"] {
  return {
    getCommandDecision: (key) => store.getCommandDecision(key),
    getCommandReceipt: (commandId) => store.getCommandReceipt(commandId),
    readEvents: (aggregateId) => store.readEvents(aggregateId),
  };
}

/** A REAL admission from the REAL selector; the content is this suite's, the admission is not. */
function admitted(content = "the node brief the planner sealed"): AdmittedContextSelection {
  const selected = selectContext({
    byteBudget: DEFAULT_CONTEXT_BYTE_BUDGET,
    exclusions: [{ itemId: "journal-9", reason: "beyond the journal entry limit" }],
    mandatory: [{ content, id: "mission-1", kind: "MANDATORY", section: "mission" }],
    optional: [{ content: "a prior dead end", id: "journal-1", kind: "OPTIONAL", priority: 2,
      section: "journal" }],
  });
  if (selected.kind !== "ADMITTED") throw new Error(`fixture selection refused: ${selected.code}`);
  return selected.selection;
}

function provenanceFor(
  overrides: Partial<FoundationContextProvenance> = {},
): FoundationContextProvenance {
  return {
    attemptRef: ATTEMPT_REF, configurationDigest: hex64("c0f19"), contextLimitBytes: 400_000,
    graphContentHash: hex64("9ea41"), graphEpoch: 3, graphRevisionId: "graph-revision-1",
    inputManifestSha256: hex64("14pu7"), journalDigest: null, journalHorizon: "42",
    matrixVersion: FOUNDATION_CONTEXT_MATRIX_VERSION, nodeKey: NODE_KEY, projectId: PROJECT_ID,
    sessionId: SESSION_ID, ...overrides,
  };
}

function authorityFor(
  provenance: FoundationContextProvenance = provenanceFor(),
  selection: AdmittedContextSelection = admitted(),
): FoundationContextAuthority {
  return {
    assembleFoundationContextSelection: () =>
      Object.freeze({ ok: true as const, provenance, selection }),
  };
}

/**
 * A record whose binding carries a NUL byte, sealed HONESTLY: the inner digest is recomputed by
 * `@moe/context`'s own sealer over the poisoned binding and the outer one by the codec's own
 * derivation, so nothing about this candidate is malformed - only its bytes are unusable.
 */
function poisonedCandidate(provenance: FoundationContextProvenance): Record<string, unknown> {
  const real = renderContext(admitted());
  const binding = {
    ...real.manifest.binding, exactBytes: [...real.manifest.binding.exactBytes, 0],
  };
  const bound = {
    attemptRef: provenance.attemptRef,
    configurationDigest: provenance.configurationDigest,
    graphContentHash: provenance.graphContentHash,
    graphEpoch: provenance.graphEpoch,
    graphRevisionRef: provenance.graphRevisionId,
    inputManifestDigest: provenance.inputManifestSha256,
    manifest: { binding, digest: digestContextManifest(binding), version: real.manifest.version },
    nodeKey: provenance.nodeKey,
    projectId: provenance.projectId,
    sessionId: provenance.sessionId,
  };
  return { ...bound, recordDigest: deriveFoundationContextRecordDigest(bound) };
}

function servicesFor(
  store: SqliteEventStore,
  overrides: Partial<FoundationPrelaunchServices> = {},
): FoundationPrelaunchServices {
  return {
    brief: depsFor(activeGraphStore()),
    capabilities: () => capabilities(),
    context: authorityFor(),
    decidedAt: DECIDED_AT,
    ledger: store,
    observation: () => ({ ...RUNTIME_FACTS }),
    readPort: portFor(store),
    ...overrides,
  };
}

describe("foundation context prelaunch composition (task-933605a5)", () => {
  it("returns a launch template whose context bytes are the durable sealed bytes", () => {
    const store = ledgerStore("accepted");
    const prepared = prepareFoundationContextForLaunch(servicesFor(store), IDENTITY);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.record.manifest.binding.exactBytes.length).toBeGreaterThan(0);
    expect(prepared.template.renderedContext.bytes)
      .toStrictEqual(prepared.record.manifest.binding.exactBytes);
    expect(prepared.bytes).toStrictEqual(prepared.record.manifest.binding.exactBytes);
  });

  it("inserts the durable bytes EXACTLY ONCE, through the typed slot and never into argv", () => {
    const store = ledgerStore("insertion");
    const prepared = prepareFoundationContextForLaunch(servicesFor(store), IDENTITY);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const exact = Uint8Array.from(prepared.record.manifest.binding.exactBytes);
    const encoder = new TextEncoder();
    // No positional guess, no append or spread into argv, no reference hash, no file ref and no
    // base64 substitution: the bytes reach the provider only through the producer's named slot.
    const inArgv = prepared.template.argv.filter((argument) => {
      const encoded = encoder.encode(argument);
      return encoded.length === exact.length && exact.every((byte, i) => encoded[i] === byte);
    });
    expect(inArgv).toStrictEqual([]);
    expect(Uint8Array.from(prepared.template.renderedContext.bytes)).toStrictEqual(exact);
    // The server-derived halves of the same launch, echoed from the DURABLE profile.
    expect(prepared.template.launchSelection.selectedModelId).toBe("claude-opus-5");
    expect(prepared.template.argv).toContain(CODING_TOOLS);
  });

  it("returns a DEEPLY frozen template, not a shallowly frozen one", () => {
    const store = ledgerStore("frozen");
    const prepared = prepareFoundationContextForLaunch(servicesFor(store), IDENTITY);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.template)).toBe(true);
    // NESTED, which is the whole point: a shallow freeze leaves these writable and a caller
    // could mutate the very bytes the manifest digest attests.
    expect(Object.isFrozen(prepared.template.argv)).toBe(true);
    expect(Object.isFrozen(prepared.template.launchSelection)).toBe(true);
    expect(Object.isFrozen(prepared.template.limits)).toBe(true);
    // THE SLOT ITSELF, and it is the one a naive deep-freeze misses: `freezeDeep` stops at an
    // already-frozen object, and the producer freezes its result SHALLOWLY, so a slot the
    // composition built unfrozen would stay writable inside a frozen template.
    expect(Object.isFrozen(prepared.template.renderedContext)).toBe(true);
    expect(Object.isFrozen(prepared.template.renderedContext.manifest.binding)).toBe(true);
    expect(Object.isFrozen(prepared.template.renderedContext.manifest.binding.exactBytes))
      .toBe(true);
    expect(Object.isFrozen(prepared.record.manifest.binding.exactBytes)).toBe(true);
    expect(() => {
      (prepared.record.manifest.binding.exactBytes as number[])[0] = 0;
    }).toThrow(TypeError);
  });

  it("refuses under the BRIEF PRODUCER's own code when the node has no active graph", () => {
    const store = ledgerStore("mission-refused");
    const prepared = prepareFoundationContextForLaunch(
      servicesFor(store, { brief: depsFor(inactiveGraphStore()) }), IDENTITY);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.code).toBe("FOUNDATION_PRELAUNCH_MISSION_REFUSED");
    expect(prepared.upstream).toStrictEqual({
      code: "NODE_MISSION_GRAPH_UNAVAILABLE", layer: "NODE_MISSION_PRODUCER",
    });
  });

  it("refuses under the TEMPLATE PRODUCER's own code when capabilities carry no authority", () => {
    const store = ledgerStore("template-refused");
    const prepared = prepareFoundationContextForLaunch(
      servicesFor(store, { capabilities: () => ({ ok: false, code: "X", layer: "Y" }) }), IDENTITY);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.code).toBe("FOUNDATION_PRELAUNCH_TEMPLATE_REFUSED");
    expect(prepared.upstream).toStrictEqual({
      code: "LAUNCH_TEMPLATE_CAPABILITY_UNKNOWN", layer: "LAUNCH_TEMPLATE_PRODUCER",
    });
  });

  it("seals the 11-key record under the RECORD's own field spelling, not the provenance's", () => {
    const store = ledgerStore("mapping");
    const provenance = provenanceFor();
    const prepared = prepareFoundationContextForLaunch(
      servicesFor(store, { context: authorityFor(provenance) }), IDENTITY);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    // THE MAPPING, asserted rather than assumed: a spread would drop both of these silently.
    expect(prepared.record.graphRevisionRef).toBe(provenance.graphRevisionId);
    expect(prepared.record.inputManifestDigest).toBe(provenance.inputManifestSha256);
    expect(prepared.record.graphEpoch).toBe(provenance.graphEpoch);
    // BOTH DIRECTIONS against a HAND-WRITTEN roster: a map over the production constant would
    // shrink with it, and a subset check cannot see an extra key.
    expect(Object.keys(prepared.record).sort()).toStrictEqual([...EXPECTED_RECORD_KEYS].sort());
  });

  it("refuses under the LEDGER's own code when the durable store will not answer", () => {
    const store = ledgerStore("commit-refused");
    const blind = {
      commitExpectedVersionDecision: (): never => {
        throw new DurableStoreError("PROJECT_SCOPE_MISMATCH", "the handle names another project");
      },
      readEvents: (aggregateId: string) => store.readEvents(aggregateId),
    };
    const prepared = prepareFoundationContextForLaunch(
      servicesFor(store, { ledger: blind }), IDENTITY);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.code).toBe("FOUNDATION_PRELAUNCH_COMMIT_REFUSED");
    expect(prepared.upstream).toStrictEqual({
      code: "FOUNDATION_CONTEXT_LEDGER_STORE_UNAVAILABLE", layer: "FOUNDATION_CONTEXT_LEDGER",
    });
  });

  it("refuses under the READER's own code when the readback cannot find the seal", () => {
    const store = ledgerStore("readback-absent");
    const elsewhere = ledgerStore("readback-elsewhere");
    const prepared = prepareFoundationContextForLaunch(
      servicesFor(store, { readPort: portFor(elsewhere) }), IDENTITY);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.code).toBe("FOUNDATION_PRELAUNCH_READBACK_REFUSED");
    expect(prepared.upstream).toStrictEqual({
      code: "FOUNDATION_CONTEXT_READER_ABSENT", layer: "FOUNDATION_CONTEXT_READER",
    });
  });

  it("REPLAYS from the durable record: same bytes, and no second event or decision row", () => {
    const store = ledgerStore("replay");
    const provenance = provenanceFor();
    const first = prepareFoundationContextForLaunch(
      servicesFor(store, { context: authorityFor(provenance) }), IDENTITY);
    const after = rawCounts(store);

    // A SECOND caller under the SAME durable identity holding a DIFFERENT render. The ledger's
    // replay identity hashes the request bytes, not the proposed events, so this replays — and
    // the composition must answer from the DURABLE record rather than from its own new render.
    const divergent = prepareFoundationContextForLaunch(
      servicesFor(store, {
        context: authorityFor(provenance, admitted("a completely different node brief")),
      }), IDENTITY);

    expect(first.ok).toBe(true);
    expect(divergent.ok, JSON.stringify(divergent)).toBe(true);
    if (!first.ok || !divergent.ok) return;
    expect(divergent.bytes).toStrictEqual(first.bytes);
    expect(divergent.template.renderedContext.bytes).toStrictEqual(first.bytes);
    expect(divergent.record).toStrictEqual(first.record);
    // COUNTS, not just the value: only these can see a second row being appended.
    expect(rawCounts(store)).toStrictEqual(after);
  });

  it("calls the renderer EXACTLY ONCE, on the accepted path", () => {
    const store = ledgerStore("render-once");
    let orderingReads = 0;
    const real = admitted();
    // `renderContext` reads `selection.ordering` exactly once per call and this module never
    // reads it at all, so this counter counts renders and nothing else.
    const counted = {} as AdmittedContextSelection;
    Object.defineProperties(counted, {
      exclusions: { enumerable: true, get: () => real.exclusions },
      mandatory: { enumerable: true, get: () => real.mandatory },
      optional: { enumerable: true, get: () => real.optional },
      ordering: {
        enumerable: true,
        get: (): string => {
          orderingReads += 1;
          return real.ordering;
        },
      },
    });
    const prepared = prepareFoundationContextForLaunch(
      servicesFor(store, { context: authorityFor(provenanceFor(), counted) }), IDENTITY);

    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    expect(orderingReads).toBe(1);
  });

  it("refuses a CONFLICTING selection identity before any template, first record intact", () => {
    const store = ledgerStore("conflict");
    const first = prepareFoundationContextForLaunch(
      servicesFor(store, { context: authorityFor(provenanceFor()) }), IDENTITY);
    const after = rawCounts(store);
    expect(first.ok).toBe(true);

    // A DIFFERENT graph epoch is a different sealing command against an aggregate already at
    // version 1, so the store returns a no-business-effect decision rather than appending.
    const conflicting = prepareFoundationContextForLaunch(
      servicesFor(store, { context: authorityFor(provenanceFor({ graphEpoch: 4 })) }), IDENTITY);

    expect(conflicting.ok).toBe(false);
    if (conflicting.ok || !first.ok) return;
    expect(conflicting.code).toBe("FOUNDATION_PRELAUNCH_COMMIT_REFUSED");
    expect(conflicting.upstream).toStrictEqual({
      code: "FOUNDATION_CONTEXT_LEDGER_EXPECTED_VERSION_CONFLICT",
      layer: "FOUNDATION_CONTEXT_LEDGER",
    });
    // NOT the raw event total: a no-business-effect decision still writes its audit row, so the
    // load-bearing count is the CONTEXT AGGREGATE's own - it must still hold exactly one event.
    expect(store.readEvents(deriveFoundationContextAggregateId(IDENTITY)).length).toBe(1);
    expect(rawCounts(store).events).toStrictEqual(after.events + 1);
    const again = prepareFoundationContextForLaunch(
      servicesFor(store, { context: authorityFor(provenanceFor()) }), IDENTITY);
    expect(again.ok && again.record).toStrictEqual(first.record);
  });

  it("refuses a DIVERGED replay when the same command names other durable facts", () => {
    const store = ledgerStore("diverged");
    const first = prepareFoundationContextForLaunch(
      servicesFor(store, { context: authorityFor(provenanceFor()) }), IDENTITY);
    const after = rawCounts(store);
    expect(first.ok).toBe(true);

    // Same command preimage, DIFFERENT request preimage: the configuration digest is hashed into
    // the request bytes but not into the command id, so this is a redelivery that disagrees.
    const diverged = prepareFoundationContextForLaunch(
      servicesFor(store, {
        context: authorityFor(provenanceFor({ configurationDigest: hex64("d1f2e") })),
      }), IDENTITY);

    expect(diverged.ok).toBe(false);
    if (diverged.ok) return;
    expect(diverged.code).toBe("FOUNDATION_PRELAUNCH_COMMIT_REFUSED");
    expect(diverged.upstream).toStrictEqual({
      code: "FOUNDATION_CONTEXT_LEDGER_REPLAY_DIVERGED", layer: "FOUNDATION_CONTEXT_LEDGER",
    });
    expect(rawCounts(store)).toStrictEqual(after);
  });

  it("refuses DURABLE bytes carrying a NUL, handed back by a replay", () => {
    const store = ledgerStore("nul");
    const provenance = provenanceFor();
    // Sealed by ANOTHER writer under this identity, through the ledger's own production writer.
    // This is where unusable bytes are reachable at all: `renderContext` JSON-escapes control
    // characters, so no selection can make it emit a NUL, while the codec admits any 0-255 array.
    const foreign = commitFoundationContextManifest(store, {
      candidate: poisonedCandidate(provenance), decidedAt: DECIDED_AT,
    });
    expect(foreign.ok, JSON.stringify(foreign)).toBe(true);

    const prepared = prepareFoundationContextForLaunch(
      servicesFor(store, { context: authorityFor(provenance) }), IDENTITY);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.code).toBe("FOUNDATION_PRELAUNCH_BYTES_UNUSABLE");
    expect(prepared.layer).toBe("FOUNDATION_CONTEXT_PRELAUNCH");
    // This module minted it, so nothing upstream is credited with the refusal.
    expect(prepared.upstream).toBeNull();
  });

  it("admits non-ASCII content and seals it byte-identically", () => {
    const store = ledgerStore("unicode");
    const content = "Land node-a. Ship the café 日本語 → receipt.";
    const prepared = prepareFoundationContextForLaunch(
      servicesFor(store, { context: authorityFor(provenanceFor(), admitted(content)) }), IDENTITY);

    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;
    const sealed = new TextDecoder("utf-8", { fatal: true })
      .decode(Uint8Array.from(prepared.bytes));
    expect(sealed).toContain(content);
    expect(prepared.template.renderedContext.bytes).toStrictEqual(prepared.bytes);
  });

  /**
   * THE POSITIVE CONTROL FOR THE ONE UNREACHABLE ASSERT, disclosed rather than faked.
   * `FOUNDATION_PRELAUNCH_MANIFEST_UNSEALED` guards `manifest.digest === digestContextManifest(
   * manifest.binding)`. `renderContext` computes that digest from that binding, so no input to
   * this composition can drive the refusal; what is provable is that the guarded precondition
   * holds for a real render, which is what this arm pins. The guard stays as a fail-closed check
   * across the package boundary, and nobody should read it as covered by a refusal arm.
   */
  it("renders a manifest whose digest covers its own binding", () => {
    const rendered = renderContext(admitted());

    expect(rendered.manifest.digest).toBe(digestContextManifest(rendered.manifest.binding));
    expect(rendered.bytes).toStrictEqual(rendered.manifest.binding.exactBytes);
  });

  it("forwards the PRODUCTION authority's own selection code and layer, unrestamped", () => {
    const store = ledgerStore("selection-refused");
    const real = createFoundationContextAuthority({
      expectedConfigurationDigest: hex64("c0f19"), store,
    });
    const prepared = prepareFoundationContextForLaunch(
      servicesFor(store, { context: real }), { nodeKey: NODE_KEY, projectId: PROJECT_ID });

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.code).toBe("FOUNDATION_PRELAUNCH_SELECTION_REFUSED");
    expect(prepared.layer).toBe("FOUNDATION_CONTEXT_PRELAUNCH");
    expect(prepared.upstream).toStrictEqual({
      code: "FOUNDATION_CONTEXT_REQUEST_INVALID", layer: "FOUNDATION_CONTEXT_SELECTION",
    });
  });
});
