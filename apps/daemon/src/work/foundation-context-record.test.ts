/**
 * The production pre-launch context SEAL and its strict readback (task-203a5ca7), driven
 * through a REAL file-backed SqliteEventStore.
 *
 * WHAT IS REAL HERE, and it is nearly everything: the ledger and the strict readback run
 * against a real SQLite file, the mission comes from `produceNodeBrief` over a store whose
 * graph the PRODUCTION activation service made ACTIVE, the capabilities come from the real
 * `resolveCurrentProviderProfile`, and the sealed bytes come from the real `renderContext` over
 * a real `selectContext` admission. Every digest compared below is recomputed with the PUBLIC
 * `@moe/context` root, never with a local reimplementation of it.
 *
 * THE ONE STAND-IN, disclosed rather than hidden and inherited from task-933605a5's suite:
 * `FoundationContextAuthority` is INJECTED on the accepted arms. The accepted answer of the
 * production `createFoundationContextAuthority` needs the whole integrated Foundation world —
 * 11 mandatory matrix items across activation, dispatch, capture, journal, review,
 * configuration and provider profile — which `foundation-context-selection.test.ts` seeds in
 * 913 lines and which is that row's fixture, not this one's. The REFUSAL arms use the REAL
 * authority over a real store, so the upstream code and layer this seam forwards are the
 * production ones. The PRODUCTION PRE-LAUNCH CALL SITE itself is driven in
 * `foundation-attempt-service.test.ts` under "pre-launch context seal (task-203a5ca7)".
 *
 * WINDOWS HANDLE DISCIPLINE: every store handle is closed before its temp directory is
 * removed. A handle held across the cleanup throws EPERM and kills the vitest worker with no
 * output.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CONTEXT_BYTE_BUDGET, digestContextManifest, selectContext,
} from "@moe/context";
import type { AdmittedContextSelection } from "@moe/context";
import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it, vi } from "vitest";

const prelaunchProbe = vi.hoisted(() => ({
  results: [] as unknown[],
  reset(): void { this.results.length = 0; },
}));

vi.mock("./foundation-context-prelaunch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./foundation-context-prelaunch.js")>();
  return {
    ...actual,
    prepareFoundationContextForLaunch: (
      ...args: Parameters<typeof actual.prepareFoundationContextForLaunch>
    ) => {
      const result = actual.prepareFoundationContextForLaunch(...args);
      prelaunchProbe.results.push(result);
      return result;
    },
  };
});

import { hex64 } from "../bootstrap/bootstrap-test-fixtures.js";
import { readCurrentActiveGraph } from "../planning/active-graph-projection.js";
import {
  NODE_KEY, PROJECT_ID, RUNTIME_FACTS, activeGraphStore, capabilities, closeStores, depsFor,
} from "../planning/node-mission-test-fixtures.js";
import { FOUNDATION_CONTEXT_RECORD_VERSION }
  from "./foundation-context-manifest-codec.js";
import { deriveFoundationContextAggregateId }
  from "./foundation-context-manifest-ledger.js";
import type { FoundationContextExpectedBinding }
  from "./foundation-context-manifest-proofs.js";
import type { FoundationContextReadPort }
  from "./foundation-context-manifest-reader.js";
import {
  FOUNDATION_CONTEXT_MATRIX_VERSION, createFoundationContextAuthority,
} from "./foundation-context-selection.js";
import type {
  FoundationContextAuthority, FoundationContextProvenance,
} from "./foundation-context-selection.js";
import type { FoundationPrelaunchResult } from "./foundation-context-prelaunch.js";
import {
  createDurableFoundationContextSealPort, createFoundationContextSealPort,
  readSealedFoundationContext, unconfiguredFoundationContextSealPort,
} from "./foundation-context-record.js";
import type { FoundationContextSealServices } from "./foundation-context-record.js";

const ATTEMPT_REF = "attempt-seal-1";
const SESSION_ID = "session-seal-1";
const DECIDED_AT = "2026-08-26T00:00:00.000Z";
const SEAL_LAYER = "FOUNDATION_CONTEXT_SEAL";
const READER_LAYER = "FOUNDATION_CONTEXT_READER";
const FOUNDATION_CONTEXT_SEALED_KEYS = Object.freeze([
  "bytes", "contextManifestDigest", "ok", "template",
] as const);
const IDENTITY = Object.freeze({
  attemptRef: ATTEMPT_REF, nodeKey: NODE_KEY, projectId: PROJECT_ID, sessionId: SESSION_ID,
});
const SLOT = Object.freeze({
  attemptRef: ATTEMPT_REF, projectId: PROJECT_ID, sessionId: SESSION_ID,
});

const roots: string[] = [];
const ledgers: SqliteEventStore[] = [];

afterAll(() => {
  while (ledgers.length > 0) ledgers.pop()?.close();
  closeStores();
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});

function ledgerStore(label: string): SqliteEventStore {
  const root = mkdtempSync(join(tmpdir(), `moe-seal-${label}-`));
  roots.push(root);
  const store = SqliteEventStore.openForProject(join(root, "project.db"), PROJECT_ID);
  ledgers.push(store);
  return store;
}

function portFor(store: SqliteEventStore): FoundationContextReadPort {
  return {
    getCommandDecision: (key) => store.getCommandDecision(key),
    getCommandReceipt: (commandId) => store.getCommandReceipt(commandId),
    readEvents: (aggregateId) => store.readEvents(aggregateId),
  };
}

function rawCounts(store: SqliteEventStore): { decisions: number; events: number } {
  return {
    decisions: store.readCommandDecisionsAfter(0n, 1_000).items.length,
    events: store.readEventsAfter(0n, 1_000).items.length,
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

/**
 * The REAL active graph the brief deps below read, taken through the PRODUCTION reader. The
 * prelaunch composition binds the mission brief to the graph the record was sealed under, so a
 * provenance naming a placeholder graph refuses under MISSION_GRAPH_MISMATCH before any seal.
 */
const ACTIVE_GRAPH = (() => {
  const active = readCurrentActiveGraph(activeGraphStore(), PROJECT_ID);
  if (!active.ok) throw new Error(`fixture active graph unavailable: ${active.code}`);
  return Object.freeze({
    graphContentHash: active.graphContentHash, revisionId: active.revisionId,
  });
})();

function provenanceFor(
  overrides: Partial<FoundationContextProvenance> = {},
): FoundationContextProvenance {
  return {
    attemptRef: ATTEMPT_REF, configurationDigest: hex64("c0f19"), contextLimitBytes: 400_000,
    graphContentHash: ACTIVE_GRAPH.graphContentHash, graphEpoch: 3,
    graphRevisionId: ACTIVE_GRAPH.revisionId,
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

function servicesFor(
  store: SqliteEventStore, overrides: Partial<FoundationContextSealServices> = {},
): FoundationContextSealServices {
  return {
    brief: depsFor(activeGraphStore()),
    capabilities: () => capabilities(),
    context: authorityFor(),
    ledger: store,
    observation: () => ({ ...RUNTIME_FACTS }),
    readPort: portFor(store),
    ...overrides,
  };
}

/** The six binding facts the strict reader COMPARES, derived from the same provenance. */
function bindingFor(
  provenance: FoundationContextProvenance = provenanceFor(),
): FoundationContextExpectedBinding {
  return {
    configurationDigest: provenance.configurationDigest,
    graphContentHash: provenance.graphContentHash,
    graphEpoch: provenance.graphEpoch,
    graphRevisionRef: provenance.graphRevisionId,
    inputManifestDigest: provenance.inputManifestSha256,
    nodeKey: provenance.nodeKey,
  };
}

/**
 * A raw append onto ONE aggregate, used only to plant the hostile durable rows the reader must
 * tell apart. Nothing here builds a record: the interesting cases are DERIVED from a genuinely
 * sealed payload, so the only thing that differs from the accepted control is the exact fault.
 */
function plant(
  store: SqliteEventStore, aggregateId: string,
  eventType: string, payload: Uint8Array, expectedVersion: number, label: string,
): void {
  const response = store.commitExpectedVersionDecision({
    commandKind: "foundation.context-manifest.plant",
    committedResultBytes: payload,
    correlationId: `correlation-plant-${label}`,
    decidedAt: DECIDED_AT,
    events: [{ domainSchemaVersion: FOUNDATION_CONTEXT_RECORD_VERSION, eventId: `plant-${label}`, eventType, payload }],
    expectedVersion,
    key: {
      commandId: `cmd-plant-${label}`, principalId: `principal-plant-${label}`,
      projectId: PROJECT_ID,
    },
    requestBytes: new TextEncoder().encode(`plant ${label}`),
    targetAggregateId: aggregateId,
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`fixture plant refused: ${response.decision.resultCode}`);
  }
}

/** The durable payload of the ONE sealed event on this aggregate. */
function sealedPayload(store: SqliteEventStore, aggregateId: string): Uint8Array {
  const event = store.readEvents(aggregateId)[0];
  if (event === undefined) throw new Error("fixture has no sealed event");
  return event.payload;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

function expectNoSealedAuthority(result: object): void {
  expect("bytes" in result).toBe(false);
  expect("contextManifestDigest" in result).toBe(false);
  expect("template" in result).toBe(false);
}

describe("foundation pre-launch context seal (task-203a5ca7)", () => {
  it("answers the DURABLE record's digest, taken over the delivered bytes", () => {
    prelaunchProbe.reset();
    const store = ledgerStore("accepted");
    const sealed = createFoundationContextSealPort(servicesFor(store))
      .sealFoundationContext(IDENTITY, DECIDED_AT);

    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(prelaunchProbe.results).toHaveLength(1);
    const prepared = prelaunchProbe.results[0] as FoundationPrelaunchResult | undefined;
    if (prepared === undefined || !prepared.ok) {
      throw new Error("expected the real prelaunch call to prepare a launch template");
    }
    expect(sealed.template).toBe(prepared.template);
    expect(sealed.template.argv).toStrictEqual(prepared.template.argv);
    expect(sealed.template.environment).toStrictEqual(prepared.template.environment);
    expect(sealed.template.launchSelection).toStrictEqual(prepared.template.launchSelection);
    expect(sealed.template.limits).toStrictEqual(prepared.template.limits);
    expect(sealed.template.renderedContext).toStrictEqual(prepared.template.renderedContext);
    expect(sealed.template.renderedContext.bytes).toBe(sealed.bytes);
    expect(FOUNDATION_CONTEXT_SEALED_KEYS.length).toBe(4);
    const sealedKeys = new Set(Object.keys(sealed));
    const expectedKeys = new Set(FOUNDATION_CONTEXT_SEALED_KEYS);
    expect(sealedKeys).toStrictEqual(expectedKeys);
    expect(expectedKeys).toStrictEqual(sealedKeys);
    const read = readSealedFoundationContext(portFor(store), SLOT, bindingFor());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // THE NAMED ASSERTION this row's central mutation targets: the digest the seal answers is
    // the DURABLE record's own, and it recomputes — with the PUBLIC root — over the binding
    // that carries the exact bytes delivered. An implementation that hashed a reference would
    // still produce a stable digest and would still read back; only this comparison sees it.
    expect(sealed.contextManifestDigest).toBe(read.record.manifest.digest);
    expect(sealed.contextManifestDigest)
      .toBe(digestContextManifest(read.record.manifest.binding));
    expect(sealed.bytes).toStrictEqual(read.record.manifest.binding.exactBytes);
    expect(sealed.bytes.length).toBeGreaterThan(0);
  });

  it("does not answer a hash of any REFERENCE it was handed", () => {
    const store = ledgerStore("not-a-reference");
    const sealed = createFoundationContextSealPort(servicesFor(store))
      .sealFoundationContext(IDENTITY, DECIDED_AT);

    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    // Every reference in scope at the call site, spelled out. A sweep that generated nothing
    // would pass while proving nothing, so the case count is asserted against the table.
    const references = [
      ATTEMPT_REF, SESSION_ID, NODE_KEY, PROJECT_ID, DECIDED_AT,
      deriveFoundationContextAggregateId(SLOT),
      [PROJECT_ID, SESSION_ID, ATTEMPT_REF, NODE_KEY].join(" "),
    ];
    expect(references.length).toBe(7);
    let generated = 0;
    for (const reference of references) {
      generated += 1;
      expect(sealed.contextManifestDigest).not.toBe(sha256(reference));
    }
    expect(generated).toBe(references.length);
  });

  it("returns the ORIGINAL durable bytes on an exact replay and appends nothing", () => {
    const store = ledgerStore("replay");
    const port = createFoundationContextSealPort(servicesFor(store));
    const first = port.sealFoundationContext(IDENTITY, DECIDED_AT);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const after = rawCounts(store);
    const aggregateId = deriveFoundationContextAggregateId(SLOT);
    expect(store.readEvents(aggregateId)).toHaveLength(1);

    const second = port.sealFoundationContext(IDENTITY, DECIDED_AT);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.bytes).toStrictEqual(first.bytes);
    expect(second.contextManifestDigest).toBe(first.contextManifestDigest);
    // COUNTS, not just the returned value: a test comparing only the answer cannot see a
    // second row appear behind it.
    expect(rawCounts(store)).toStrictEqual(after);
    expect(store.readEvents(aggregateId)).toHaveLength(1);
  });

  it("answers a SECOND caller's differing render from the FIRST durable commit", () => {
    const store = ledgerStore("divergent-render");
    const first = createFoundationContextSealPort(servicesFor(store))
      .sealFoundationContext(IDENTITY, DECIDED_AT);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const after = rawCounts(store);

    // Same identity and same binding, DIFFERENT context bytes. The ledger's replay identity
    // hashes the request, not the proposed events, so the durable commit answers - and the
    // caller's own bytes never become authority.
    const second = createFoundationContextSealPort(servicesFor(store, {
      context: authorityFor(provenanceFor(), admitted("a wholly different rendered context")),
    })).sealFoundationContext(IDENTITY, DECIDED_AT);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.bytes).toStrictEqual(first.bytes);
    expect(rawCounts(store)).toStrictEqual(after);
    expect(store.readEvents(deriveFoundationContextAggregateId(SLOT))).toHaveLength(1);
  });

  it("refuses a conflicting BINDING under one identity, carrying the ledger's own code", () => {
    const store = ledgerStore("binding-conflict");
    const first = createFoundationContextSealPort(servicesFor(store))
      .sealFoundationContext(IDENTITY, DECIDED_AT);
    expect(first.ok).toBe(true);
    const aggregateId = deriveFoundationContextAggregateId(SLOT);

    // A different graph epoch is a DIFFERENT sealing command against an aggregate already at
    // version 1, so the store answers EXPECTED_VERSION_CONFLICT rather than replaying.
    const second = createFoundationContextSealPort(servicesFor(store, {
      context: authorityFor(provenanceFor({ graphEpoch: 4 })),
    })).sealFoundationContext(IDENTITY, DECIDED_AT);

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("FOUNDATION_CONTEXT_SEAL_REFUSED");
    expect(second.layer).toBe(SEAL_LAYER);
    // The REFUSING authority, not this seam restamped as it.
    expect(second.upstream).toStrictEqual({
      code: "FOUNDATION_PRELAUNCH_COMMIT_REFUSED", layer: "FOUNDATION_CONTEXT_PRELAUNCH",
    });
    // ZERO RECORD RESIDUE: the refusal left the first commit alone and added nothing.
    expect(store.readEvents(aggregateId)).toHaveLength(1);
  });
});

describe("foundation sealed context readback (task-203a5ca7)", () => {
  it("refuses EVERY cross-binding mismatch independently, with one exact code and layer", () => {
    const store = ledgerStore("cross-binding");
    expect(createFoundationContextSealPort(servicesFor(store))
      .sealFoundationContext(IDENTITY, DECIDED_AT).ok).toBe(true);
    const port = portFor(store);
    // One mutation PER MEMBER. A single combined comparison can pass while one member is
    // silently unbound, so each is driven alone and the generated count is asserted.
    //
    // THE TWO CODES ARE NOT INTERCHANGEABLE, and which one answers says which repair applies.
    // A disagreement anywhere in the GRAPH triple - revision ref, content hash, epoch - means
    // the graph this record was sealed against has MOVED, so the reader answers STALE and the
    // repair is to re-seal. A disagreement in the node key, the configuration digest or the
    // input-manifest digest means the record describes SOMETHING ELSE, so it answers
    // BINDING_MISMATCH and the repair is to stop trusting it. Pinning one code for all six
    // would hide a member that quietly stopped being compared at all.
    const mutations: readonly (readonly [string, FoundationContextExpectedBinding, string])[] = [
      ["configurationDigest", { ...bindingFor(), configurationDigest: hex64("dead1") },
        "FOUNDATION_CONTEXT_READER_BINDING_MISMATCH"],
      ["graphContentHash", { ...bindingFor(), graphContentHash: hex64("dead2") },
        "FOUNDATION_CONTEXT_READER_STALE"],
      ["graphEpoch", { ...bindingFor(), graphEpoch: 99 },
        "FOUNDATION_CONTEXT_READER_STALE"],
      ["graphRevisionRef", { ...bindingFor(), graphRevisionRef: "graph-revision-elsewhere" },
        "FOUNDATION_CONTEXT_READER_STALE"],
      ["inputManifestDigest", { ...bindingFor(), inputManifestDigest: hex64("dead3") },
        "FOUNDATION_CONTEXT_READER_BINDING_MISMATCH"],
      ["nodeKey", { ...bindingFor(), nodeKey: "node-elsewhere" },
        "FOUNDATION_CONTEXT_READER_BINDING_MISMATCH"],
    ];
    expect(mutations.length).toBe(6);
    let generated = 0;
    for (const [member, expected, code] of mutations) {
      const read = readSealedFoundationContext(port, SLOT, expected);
      generated += 1;
      expect(read.ok, member).toBe(false);
      if (read.ok) continue;
      expect(read.code, member).toBe(code);
      expect(read.layer, member).toBe(READER_LAYER);
    }
    expect(generated).toBe(mutations.length);
    // BOTH codes are actually exercised: a table that drifted to one of them would still
    // satisfy every assertion above while leaving the other refusal path ungraded.
    expect(new Set(mutations.map(([, , code]) => code)).size).toBe(2);
    // THE ACCEPTED CONTROL beside the six refusals: the unmutated binding still reads back.
    const accepted = readSealedFoundationContext(port, SLOT, bindingFor());
    expect(accepted.ok).toBe(true);
  });

  it("keeps ABSENT, AMBIGUOUS, FOREIGN, MALFORMED, NONCANONICAL and UNREADABLE apart", () => {
    // SIX FAULTS, SIX ANSWERS, and none of them collapses into another. Each names a different
    // operator repair: write the record / two writers reached one slot / another producer owns
    // this stream / the bytes will not decode / the bytes decode but were not stored
    // canonically / the durable history cannot be consulted at all.
    const answers = new Map<string, { code: string; codecCode: string | null }>();
    const aggregateId = deriveFoundationContextAggregateId(SLOT);

    const absentStore = ledgerStore("roster-absent");
    const absent = readSealedFoundationContext(
      portFor(absentStore), { ...SLOT, attemptRef: "attempt-never" }, bindingFor());
    expect(absent.ok).toBe(false);
    if (absent.ok) return;
    answers.set("ABSENT", { code: absent.code, codecCode: absent.codecCode });

    const ambiguousStore = ledgerStore("roster-ambiguous");
    expect(createFoundationContextSealPort(servicesFor(ambiguousStore))
      .sealFoundationContext(IDENTITY, DECIDED_AT).ok).toBe(true);
    plant(ambiguousStore, aggregateId, "foundation.context-manifest.sealed.v1",
      sealedPayload(ambiguousStore, aggregateId), 1, "ambiguous");
    const ambiguous = readSealedFoundationContext(portFor(ambiguousStore), SLOT, bindingFor());
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) return;
    answers.set("AMBIGUOUS", { code: ambiguous.code, codecCode: ambiguous.codecCode });

    const foreignStore = ledgerStore("roster-foreign");
    plant(foreignStore, aggregateId, "some.other.producer.v1",
      new TextEncoder().encode("{}"), 0, "foreign");
    const foreign = readSealedFoundationContext(portFor(foreignStore), SLOT, bindingFor());
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    answers.set("FOREIGN", { code: foreign.code, codecCode: foreign.codecCode });

    const malformedStore = ledgerStore("roster-malformed");
    plant(malformedStore, aggregateId, "foundation.context-manifest.sealed.v1",
      new TextEncoder().encode("not json at all"), 0, "malformed");
    const malformed = readSealedFoundationContext(portFor(malformedStore), SLOT, bindingFor());
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    answers.set("MALFORMED", { code: malformed.code, codecCode: malformed.codecCode });

    // DECODES CLEANLY, STORED OUT OF CANONICAL ORDER. Built by re-serialising a genuinely
    // sealed payload with its top-level keys reversed: every value is identical and every
    // digest still checks, so only a decode + RE-ENCODE + byte-compare can see it.
    const sealedStore = ledgerStore("roster-canonical-source");
    expect(createFoundationContextSealPort(servicesFor(sealedStore))
      .sealFoundationContext(IDENTITY, DECIDED_AT).ok).toBe(true);
    const decoded = JSON.parse(new TextDecoder().decode(
      sealedPayload(sealedStore, aggregateId))) as Record<string, unknown>;
    const reversed: Record<string, unknown> = {};
    for (const key of Object.keys(decoded).reverse()) reversed[key] = decoded[key];
    const noncanonicalStore = ledgerStore("roster-noncanonical");
    plant(noncanonicalStore, aggregateId, "foundation.context-manifest.sealed.v1",
      new TextEncoder().encode(JSON.stringify(reversed)), 0, "noncanonical");
    const noncanonical = readSealedFoundationContext(
      portFor(noncanonicalStore), SLOT, bindingFor());
    expect(noncanonical.ok).toBe(false);
    if (noncanonical.ok) return;
    answers.set("NONCANONICAL", { code: noncanonical.code, codecCode: noncanonical.codecCode });

    const unreadable = readSealedFoundationContext({
      getCommandDecision: () => null, getCommandReceipt: () => null,
      readEvents: () => { throw new Error("the durable history cannot be consulted"); },
    }, SLOT, bindingFor());
    expect(unreadable.ok).toBe(false);
    if (unreadable.ok) return;
    answers.set("UNREADABLE", { code: unreadable.code, codecCode: unreadable.codecCode });

    // A SWEEP THAT GENERATED NOTHING WOULD PASS: the case count is asserted first.
    expect(answers.size).toBe(6);
    expect(answers.get("ABSENT")?.code).toBe("FOUNDATION_CONTEXT_READER_ABSENT");
    expect(answers.get("AMBIGUOUS")?.code).toBe("FOUNDATION_CONTEXT_READER_AMBIGUOUS");
    expect(answers.get("FOREIGN")?.code)
      .toBe("FOUNDATION_CONTEXT_READER_EVENT_TYPE_UNEXPECTED");
    expect(answers.get("UNREADABLE")?.code).toBe("FOUNDATION_CONTEXT_READER_UNREADABLE");
    // MALFORMED AND NONCANONICAL ARE THE PAIR MOST LIKELY TO BE FOLDED TOGETHER. Both arrive
    // under the reader's UNREADABLE, and what keeps them apart is the CODEC's own verbatim
    // code - so that is what is asserted, and it is asserted to DIFFER.
    expect(answers.get("MALFORMED")?.codecCode).toBe("FOUNDATION_CONTEXT_MALFORMED");
    expect(answers.get("NONCANONICAL")?.codecCode).toBe("FOUNDATION_CONTEXT_NONCANONICAL");
    expect(answers.get("MALFORMED")?.codecCode)
      .not.toBe(answers.get("NONCANONICAL")?.codecCode);
    // SIX DISTINCT (code, codecCode) PAIRS: no two faults answer the same thing.
    expect(new Set([...answers.values()].map((a) => `${a.code}/${a.codecCode}`)).size).toBe(6);
  });

  it("reports an ABSENT record rather than fabricating one", () => {
    const store = ledgerStore("absent");
    const read = readSealedFoundationContext(
      portFor(store), { ...SLOT, attemptRef: "attempt-never-sealed" }, bindingFor());

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe("FOUNDATION_CONTEXT_READER_ABSENT");
    expect(read.layer).toBe(READER_LAYER);
    // No record and no bytes: nothing partial, and nothing computed to stand in for them.
    expect("record" in read).toBe(false);
    expect("bytes" in read).toBe(false);
  });
});

describe("foundation context seal composition (task-203a5ca7)", () => {
  it("refuses every seal when no authority is composed for this daemon", () => {
    const sealed = unconfiguredFoundationContextSealPort()
      .sealFoundationContext(IDENTITY, DECIDED_AT);

    expect(sealed.ok).toBe(false);
    if (sealed.ok) return;
    expect(sealed.code).toBe("FOUNDATION_CONTEXT_SEAL_UNCONFIGURED");
    expect(sealed.layer).toBe(SEAL_LAYER);
    expect(sealed.upstream).toBeNull();
    expectNoSealedAuthority(sealed);
  });

  it("refuses when the server is bound to no accepted configuration digest", () => {
    const store = ledgerStore("unbound-configuration");
    const sealed = createDurableFoundationContextSealPort({
      brief: depsFor(activeGraphStore()), expectedConfigurationDigest: "not-a-digest",
      profileRevisionId: "profile-ref-1", projectId: PROJECT_ID, store,
    }).sealFoundationContext(IDENTITY, DECIDED_AT);

    expect(sealed.ok).toBe(false);
    if (sealed.ok) return;
    expect(sealed.code).toBe("FOUNDATION_CONTEXT_SEAL_CONFIGURATION_UNBOUND");
    expect(sealed.layer).toBe(SEAL_LAYER);
    expect(sealed.upstream).toBeNull();
    expectNoSealedAuthority(sealed);
  });

  it("refuses when no durable provider profile answers for this project", () => {
    const store = ledgerStore("no-profile");
    const sealed = createDurableFoundationContextSealPort({
      brief: depsFor(activeGraphStore()), expectedConfigurationDigest: hex64("c0f19"),
      profileRevisionId: "profile-ref-1", projectId: PROJECT_ID, store,
    }).sealFoundationContext(IDENTITY, DECIDED_AT);

    expect(sealed.ok).toBe(false);
    if (sealed.ok) return;
    expect(sealed.code).toBe("FOUNDATION_CONTEXT_SEAL_PROFILE_UNREADABLE");
    expect(sealed.layer).toBe(SEAL_LAYER);
    expect(sealed.upstream).toStrictEqual({
      code: "PROVIDER_PROFILE_ABSENT", layer: "PROVIDER_PROFILE_READER",
    });
    expectNoSealedAuthority(sealed);
  });

  it("reads the profile and the observation PER SEAL, never once at construction", () => {
    const store = ledgerStore("per-seal-read");
    let reads = 0;
    // A counting view of the real store. Construction must touch it ZERO times: a port that
    // resolved the provider profile at construction would hold a daemon that started before the
    // probe landed in a permanent refusal, long after the durable fact it needed arrived.
    const counting = new Proxy(store, {
      get: (target, key, receiver): unknown => {
        const value = Reflect.get(target, key, receiver) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]): unknown => {
          reads += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });

    const port = createDurableFoundationContextSealPort({
      brief: depsFor(activeGraphStore()), expectedConfigurationDigest: hex64("c0f19"),
      profileRevisionId: "profile-ref-1", projectId: PROJECT_ID, store: counting,
    });

    expect(reads).toBe(0);
    const sealed = port.sealFoundationContext(IDENTITY, DECIDED_AT);
    // The seal still fails closed on this bare store, and the point is WHEN it looked: after
    // construction, on the call, so a later durable probe would be seen.
    expect(sealed.ok).toBe(false);
    expect(reads).toBeGreaterThan(0);
  });

  it("forwards the REAL selection authority's refusal with its own code and layer", () => {
    const store = ledgerStore("real-selection");
    const sealed = createFoundationContextSealPort(servicesFor(store, {
      context: createFoundationContextAuthority({
        expectedConfigurationDigest: hex64("c0f19"), store,
      }),
    })).sealFoundationContext(IDENTITY, DECIDED_AT);

    expect(sealed.ok).toBe(false);
    if (sealed.ok) return;
    expect(sealed.code).toBe("FOUNDATION_CONTEXT_SEAL_REFUSED");
    expect(sealed.layer).toBe(SEAL_LAYER);
    expect(sealed.upstream).toStrictEqual({
      code: "FOUNDATION_PRELAUNCH_SELECTION_REFUSED", layer: "FOUNDATION_CONTEXT_PRELAUNCH",
    });
    expectNoSealedAuthority(sealed);
    // Nothing was committed on a refused selection: no record, and so no readback either.
    const read = readSealedFoundationContext(portFor(store), SLOT, bindingFor());
    expect(read.ok).toBe(false);
  });
});
