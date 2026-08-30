import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import type { StoredEvent } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  FOUNDATION_VERIFICATION_COMMAND_KIND, FOUNDATION_VERIFICATION_EVENT_TYPES,
} from "../evidence/foundation-verification-contracts.js";
import { deriveVerificationAggregateId } from "../evidence/foundation-verification-store.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { handleAsyncCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import {
  FINAL_ACTIVATION_AGGREGATE, FINAL_ATTEMPT_REF, PROJECT_ID, PRINCIPAL_ID,
  finalizationWorld, seedReceipt, seedSealedRecipe, withStoreOverride,
} from "./attempt-finalization-test-harness.js";
import {
  ATTEMPT_RELEASE_EVENT_TYPE, deriveAttemptReleaseAggregateId,
} from "./attempt-release-store.js";
import { readCurrentSafeBoundaryObservation } from "./attempt-safe-boundary-lookup.js";
import { EFFECT_TERMINAL_EVENT_TYPE } from "./effect-terminal-contracts.js";
import {
  EXPANSION_RELEASE_AUTHORITY_CODES, readCurrentExpansionRelease,
} from "./expansion-release-authority.js";
import {
  decodeFoundationPayload, encodeFoundationPayload,
} from "./foundation-attempt-codec.js";
import {
  RELEASE_HANDOFF_BINDING_CODES, RELEASE_HANDOFF_BINDING_EVENT_TYPE,
  deriveReleaseHandoffAggregateId,
} from "./release-handoff-binding.js";
import { SAFE_BOUNDARY_OBSERVATION_EVENT_TYPE } from "./safe-boundary-observation.js";
import {
  FOUNDATION_ACTIVATION_BINDING_LAYER,
} from "../activation/foundation-activation-transition.js";

/**
 * CURRENT EXPANSION SAFE-RELEASE EVIDENCE (task-e62e3828df234c66969a99b8223487f4).
 *
 * THE ACCEPTED CONTROL TRAVERSES THE REGISTERED PRODUCTION HANDLER. A BOUND answer
 * is only ever built here over a world the served `foundation.verification` entry
 * created — never a hand-seeded release row — so an authority unreachable from
 * anything the daemon serves cannot pass.
 */

const LAYER = "DAEMON_EXPANSION_RELEASE_AUTHORITY";
const CREDENTIAL = "expansion-release-operator-credential";
const VERIFICATION_ID = "verification-expansion-release-1";
const RECIPE_AGGREGATE = "recipe-expansion-release-1";
const DECIDED_AT = "2026-08-15T00:00:00.000Z";

const roots: string[] = [];
afterEach(() => {
  cleanupRestoreHarnesses();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const query = (): Record<string, unknown> =>
  ({ attemptRef: FINAL_ATTEMPT_REF, projectId: PROJECT_ID });

/**
 * A released world built by the SERVED verification command, then handed back as a
 * store path. The seeding handle is CLOSED before the shipped provider reopens the
 * same file, and the provider is closed before the reader opens it: Windows will
 * not share the lock.
 */
async function servedReleaseWorld(label: string): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), `moe-expansion-${label}-`));
  roots.push(directory);
  const world = finalizationWorld(label);
  const { recordDigest, storePath } = world;
  const recipeSha256 = seedSealedRecipe(world.store, RECIPE_AGGREGATE);
  seedReceipt(world.store, {
    attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, candidateRoot: directory,
    recipeAggregateId: RECIPE_AGGREGATE, recipeSha256, recordDigest,
    verificationId: VERIFICATION_ID,
  });
  installTestRecoveryBinding(world.store);
  world.store.close();

  const provider = createStoreDependencies({
    clock: (): string => DECIDED_AT, credential: CREDENTIAL, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, storePath,
  });
  const envelope: RuntimeCommandEnvelope = {
    commandId: `cmd-served-${label}`, commandKind: FOUNDATION_VERIFICATION_COMMAND_KIND,
    correlationId: `corr-served-${label}`, expectedVersion: 0,
    payload: {
      attemptAggregateId: FINAL_ACTIVATION_AGGREGATE, candidateRoot: directory,
      expectedRecordDigest: recordDigest, recipeAggregateId: RECIPE_AGGREGATE,
      verificationId: VERIFICATION_ID,
    } as RuntimeCommandEnvelope["payload"],
    requestDigest: "a".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: CREDENTIAL, targetAggregateId: FINAL_ACTIVATION_AGGREGATE,
  };
  try {
    const answered = await handleAsyncCommandRequest(provider.provide(), {
      body: new TextEncoder().encode(JSON.stringify(envelope)),
      credential: CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION,
    }, "MCP_STDIO");
    expect(answered).toMatchObject({ httpStatus: 200, ok: true });
  } finally {
    provider.close();
  }
  return storePath;
}

/** Reopen the served database, ask the reader once, close before returning. */
function ask(storePath: string, request: unknown): unknown {
  const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  try { return readCurrentExpansionRelease(store, request); } finally { store.close(); }
}

describe("expansion release authority (task-e62e3828) — the query selects and nothing else", () => {
  it("declares nine codes, all under one prefix", () => {
    expect([...EXPANSION_RELEASE_AUTHORITY_CODES]).toHaveLength(9);
    expect(new Set(EXPANSION_RELEASE_AUTHORITY_CODES).size).toBe(9);
    for (const code of EXPANSION_RELEASE_AUTHORITY_CODES) {
      expect(code.startsWith("EXPANSION_RELEASE_")).toBe(true);
    }
  });

  it("refuses a hostile query before any store read, with no release evidence", async () => {
    const storePath = await servedReleaseWorld("hostile-query");
    const hostile: readonly [string, unknown][] = [
      ["extra key", { ...query(), attemptState: "RELEASED" }],
      ["missing key", { attemptRef: FINAL_ATTEMPT_REF }],
      ["empty attempt", { attemptRef: "", projectId: PROJECT_ID }],
      ["not an object", "attempt-1"],
      ["array", [FINAL_ATTEMPT_REF, PROJECT_ID]],
      ["getter", Object.defineProperty({ projectId: PROJECT_ID }, "attemptRef", {
        enumerable: true, get: (): string => FINAL_ATTEMPT_REF,
      })],
      // TWO own DATA keys, both the wrong names, with the real ones served by a
      // PROTOTYPE accessor: arity alone would admit this.
      ["prototype accessor", Object.create(
        { get attemptRef(): string { return FINAL_ATTEMPT_REF; },
          get projectId(): string { return PROJECT_ID; } },
        { decoy: { enumerable: true, value: 1 }, other: { enumerable: true, value: 2 } })],
    ];
    let swept = 0;
    for (const [label, request] of hostile) {
      swept += 1;
      const answer = ask(storePath, request) as Record<string, unknown>;
      expect(answer["status"], label).toBe("UNKNOWN");
      expect(answer["code"], label).toBe("EXPANSION_RELEASE_REQUEST_INVALID");
      expect(answer["layer"], label).toBe(LAYER);
      expect(answer["release"], label).toBeUndefined();
      expect(answer["workerHandoff"], label).toBeUndefined();
    }
    expect(swept).toBe(hostile.length);
    expect(swept).toBeGreaterThan(0);
  });
});

describe("expansion release authority (task-e62e3828) — the accepted production world", () => {
  it("binds one frozen release evidence and handoff from the served release", async () => {
    const storePath = await servedReleaseWorld("accepted");
    const answer = ask(storePath, query()) as Record<string, unknown>;
    expect(answer["status"]).toBe("BOUND");
    const release = answer["release"] as Record<string, unknown>;
    const workerHandoff = answer["workerHandoff"] as Record<string, unknown>;

    // EVERY CONJUNCT core's `safeRelease` demands, asserted by value.
    expect(release["truthClass"]).toBe("DAEMON_VERIFIED");
    expect(release["reason"]).toBe("WORK_RELEASE_OR_PAUSE");
    expect(release["attemptState"]).toBe("RELEASED");
    expect(release["leaseState"]).toBe("RELEASED");
    expect(release["providerSlotState"]).toBe("RELEASED");
    expect(release["safeBoundaryObserved"]).toBe(true);
    expect(release["effectsTerminal"]).toBe(true);
    expect(release["resourcesTerminal"]).toBe(true);
    expect(release["disposition"]).toEqual({
      resumable: true, strongestReason: "WORK_RELEASE_OR_PAUSE", terminalTarget: "RELEASED",
    });
    expect(release["attemptRef"]).toBe(FINAL_ATTEMPT_REF);
    expect(release["observationRef"]).toMatch(/^[0-9a-f]{64}$/u);
    expect(release["receiptRef"]).toBe(VERIFICATION_ID);
    expect((release["terminalEffectRefs"] as readonly string[]).length).toBeGreaterThan(0);
    expect((release["terminalResourceRefs"] as readonly string[]).length).toBeGreaterThan(0);

    // TWO KEYS, and the SAME immutable value on both sides: `safeRelease` compares
    // `release.handoff` with `workerHandoff` by value.
    expect(Object.keys(workerHandoff).sort()).toEqual(["digest", "ref"]);
    expect(release["handoff"]).toBe(workerHandoff);
    expect(workerHandoff["digest"]).toMatch(/^[0-9a-f]{64}$/u);
    expect(workerHandoff["ref"]).not.toBe(workerHandoff["digest"]);
  });
});

/**
 * THE TWO IMMUTABLE ROSTERS (step 4). Both case tables are GENERATED FROM the
 * production tuples rather than retyped, and both counts are asserted before any
 * arm runs: a member added or dropped upstream changes the denominator here, and
 * a silently empty sweep cannot pass for coverage.
 *
 * Every refusing world starts from the SAME served BOUND control and applies one
 * clearly named hostile READ FAULT. Nothing here manufactures a BOUND answer.
 */

const RELEASE_AGGREGATE = deriveAttemptReleaseAggregateId(FINAL_ACTIVATION_AGGREGATE);
const BINDING_AGGREGATE = deriveReleaseHandoffAggregateId(FINAL_ACTIVATION_AGGREGATE);
const HANDOFF_LAYER = "DAEMON_RELEASE_HANDOFF";
/** DELIBERATELY not `a`-`e`: the shared harness already seeds those repeats as
 *  digests, and a mutation equal to the value it replaces is a silent no-op. */
const FOREIGN_SHA = "7".repeat(64);
type Body = Record<string, unknown>;
type Fault = (store: SqliteEventStore, storePath: string) => Partial<Record<string, unknown>>;

/** Re-encodes through the row's OWN production codec, so the reader's byte
 *  compare still passes and the arm exercises the guard, not the drift check. */
function rewrite(event: StoredEvent, type: string, patch: (body: Body) => Body): StoredEvent {
  if (event.eventType !== type) return event;
  const decoded = decodeFoundationPayload(event.payload);
  if (!decoded.ok) throw new Error(`fixture cannot decode ${type}`);
  const encoded = encodeFoundationPayload(patch({ ...decoded.value }));
  if (!encoded.ok) throw new Error(`fixture cannot re-encode ${type}`);
  return { ...event, payload: encoded.bytes };
}

/** The observation row is byte-compared against `JSON.stringify`, not the
 *  canonical codec: patching a value in place preserves the key order. */
function rewriteJson(event: StoredEvent, type: string, patch: (body: Body) => Body): StoredEvent {
  if (event.eventType !== type) return event;
  const body = JSON.parse(new TextDecoder().decode(event.payload)) as Body;
  return { ...event, payload: new TextEncoder().encode(JSON.stringify(patch(body))) };
}

const patchRows = (
  aggregate: string | null, type: string, patch: (body: Body) => Body,
  encode = rewrite,
): Fault => (store) => ({
  readEvents: (id: string): readonly StoredEvent[] => {
    const events = store.readEvents(id);
    return aggregate !== null && id !== aggregate
      ? events : events.map((event) => encode(event, type, patch));
  },
});

const patchRelease = (patch: (body: Body) => Body): Fault =>
  patchRows(RELEASE_AGGREGATE, ATTEMPT_RELEASE_EVENT_TYPE, patch);
const patchBinding = (patch: (body: Body) => Body): Fault =>
  patchRows(BINDING_AGGREGATE, RELEASE_HANDOFF_BINDING_EVENT_TYPE, patch);
const nested = (body: Body, key: string, patch: Body): Body =>
  ({ ...body, [key]: { ...(body[key] as Body), ...patch } });
/** Hides one durable ROW TYPE from every aggregate read. The type index is left
 *  intact on purpose: the effect is still ENUMERATED and merely stops reading as
 *  terminal, which is the nonterminal shape rather than an empty denominator. */
const hideRowType = (hidden: string): Fault => (store) => ({
  readEvents: (id: string): readonly StoredEvent[] =>
    store.readEvents(id).filter((event) => event.eventType !== hidden),
});

/** Asks the reader over a store whose named methods carry exactly one fault. */
function askFaulted(storePath: string, fault: Fault, request: unknown): Body {
  const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  try {
    return readCurrentExpansionRelease(
      withStoreOverride(store, fault(store, storePath)), request) as unknown as Body;
  } finally { store.close(); }
}

const NO_FAULT: Fault = () => ({});

interface RosterCase {
  readonly code: string;
  readonly fault: Fault;
  readonly label: string;
  readonly layer: string;
  readonly request: unknown;
  readonly status: "ABSENT" | "UNKNOWN";
}

const LOCAL_FAULTS: Readonly<Record<string, Fault>> = {
  EXPANSION_RELEASE_BOUNDARY_UNSAFE: patchRows(
    null, SAFE_BOUNDARY_OBSERVATION_EVENT_TYPE,
    (body) => ({ ...body, safeBoundaryObserved: false }), rewriteJson),
  EXPANSION_RELEASE_CAUSE_MISMATCH: patchRelease((body) => ({ ...body, reason: "WORK_ABANDONED" })),
  EXPANSION_RELEASE_CURRENTNESS_MOVED: (store, storePath) => {
    let moved = false;
    return { readEvents: (id: string): readonly StoredEvent[] => {
      const events = store.readEvents(id);
      if (id !== RELEASE_AGGREGATE || moved) return events;
      // A SECOND FILE-BACKED CONNECTION appends one IRRELEVANT row to the
      // selected release aggregate between the captured version and the final
      // check. A second RELEASE row would refuse upstream as AMBIGUOUS and never
      // reach this module's own currentness guard; activation, terminal,
      // boundary, receipt and handoff all stay valid.
      moved = true;
      appendUnrelated(storePath, events.length);
      return events;
    } };
  },
  EXPANSION_RELEASE_EVIDENCE_CONFLICT: patchRelease(
    (body) => nested(body, "handoff", { journalDigest: FOREIGN_SHA })),
  EXPANSION_RELEASE_EVIDENCE_MALFORMED: patchRelease(
    ({ leaseRef: _dropped, ...rest }) => rest),
  EXPANSION_RELEASE_NOT_RELEASED: patchRelease((body) => ({ ...body, attemptState: "DRAINING" })),
  EXPANSION_RELEASE_RECEIPT_ABSENT: patchBinding((body) => ({ ...body, receipt: null })),
  EXPANSION_RELEASE_REQUEST_INVALID: NO_FAULT,
  EXPANSION_RELEASE_TERMINAL_INCOMPLETE: hideRowType(EFFECT_TERMINAL_EVENT_TYPE),
};

const LOCAL_CASES: readonly RosterCase[] = EXPANSION_RELEASE_AUTHORITY_CODES.map((code) => {
  const fault = LOCAL_FAULTS[code];
  if (fault === undefined) throw new Error(`no arm generated for ${code}`);
  return {
    code, fault, label: code, layer: LAYER, status: "UNKNOWN" as const,
    request: code === "EXPANSION_RELEASE_REQUEST_INVALID" ? { attemptRef: "" } : query(),
  };
});

/** Six of the eight binding codes can leave the READ path. `COMMIT_UNAVAILABLE`
 *  and `RECEIPT_AMBIGUOUS` are the WRITER's half of the same shared tuple
 *  (`release-handoff-binding.ts:176`, `release-receipt-scan.ts:79`), so the
 *  partition is asserted rather than the arms faked. */
const BINDING_WRITER_ONLY: readonly string[] = [
  "RELEASE_HANDOFF_BINDING_COMMIT_UNAVAILABLE", "RELEASE_HANDOFF_BINDING_RECEIPT_AMBIGUOUS",
];
const BINDING_FAULTS: Readonly<Record<string, Fault>> = {
  RELEASE_HANDOFF_BINDING_ABSENT: (store) => ({
    readEvents: (id: string): readonly StoredEvent[] =>
      id === BINDING_AGGREGATE ? [] : store.readEvents(id),
  }),
  RELEASE_HANDOFF_BINDING_AMBIGUOUS: (store) => ({
    readEvents: (id: string): readonly StoredEvent[] => {
      const events = store.readEvents(id);
      const last = events[events.length - 1];
      return id === BINDING_AGGREGATE && last !== undefined ? [...events, last] : events;
    },
  }),
  RELEASE_HANDOFF_BINDING_DIGEST_MISMATCH: patchBinding(
    (body) => nested(body, "handoff", { digest: FOREIGN_SHA })),
  RELEASE_HANDOFF_BINDING_PROJECT_MISMATCH: patchBinding(
    (body) => ({ ...body, projectId: "project-elsewhere" })),
  RELEASE_HANDOFF_BINDING_RECEIPT_DRIFT: patchBinding(
    (body) => nested(body, "receipt", { receiptSha256: FOREIGN_SHA })),
  RELEASE_HANDOFF_BINDING_UNREADABLE: patchBinding(
    ({ derivedAt: _dropped, ...rest }) => rest),
};

const BINDING_CASES: readonly RosterCase[] = RELEASE_HANDOFF_BINDING_CODES
  .filter((code) => !BINDING_WRITER_ONLY.includes(code))
  .map((code) => {
    const fault = BINDING_FAULTS[code];
    if (fault === undefined) throw new Error(`no arm generated for ${code}`);
    return {
      code, fault, label: code, layer: HANDOFF_LAYER, request: query(),
      status: code === "RELEASE_HANDOFF_BINDING_ABSENT"
        ? ("ABSENT" as const) : ("UNKNOWN" as const),
    };
  });

/** One irrelevant row on the release aggregate, committed over its OWN handle so
 *  the reader's connection is not the writer. Closed before the reader continues:
 *  Windows will not share the file lock. */
function appendUnrelated(storePath: string, expectedVersion: number): void {
  const second = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  try {
    second.commit({
      aggregateId: RELEASE_AGGREGATE, commandBytes: encode("race-note"),
      commandId: "cmd-race-note", committedAt: DECIDED_AT,
      events: [{ eventId: "evt-race-note", eventType: "UnrelatedAggregateNote",
        payload: encode("{}") }],
      expectedVersion,
    });
  } finally { second.close(); }
}

/** A stream that cannot be read at all — never an empty one: absent and
 *  unreadable demand opposite repairs and must not share a code. */
const failStream = (aggregate: string): Fault => (store) => ({
  readEvents: (id: string): readonly StoredEvent[] => {
    if (id === aggregate) throw new Error("durable read failed");
    return store.readEvents(id);
  },
});

const hideIndex = (hidden: string): Fault => (store) => ({
  readEventsByTypeAfter: (type: string, cursor: bigint, limit: number): unknown =>
    type === hidden
      ? { hasMore: false, items: [], nextCursor: null }
      : store.readEventsByTypeAfter(type, cursor, limit),
});

/** DIVERGENCE, upstream half: each world disturbs ONE source, and the refusal
 *  must arrive under the OWNING authority's code and layer rather than be
 *  restamped as this module's own. */
const UPSTREAM_CASES: readonly RosterCase[] = [
  {
    code: "FOUNDATION_BINDING_NOT_FOUND", fault: NO_FAULT,
    label: "an attempt this project never activated", layer: FOUNDATION_ACTIVATION_BINDING_LAYER,
    request: { attemptRef: "attempt-elsewhere", projectId: PROJECT_ID }, status: "ABSENT",
  },
  {
    code: "ATTEMPT_RELEASE_RECORD_ABSENT", fault: hideRowType(ATTEMPT_RELEASE_EVENT_TYPE),
    label: "an attempt with no release row at all", layer: "DAEMON_ATTEMPT_RELEASE",
    request: query(), status: "ABSENT",
  },
  {
    code: "ATTEMPT_RELEASE_RECORD_UNREADABLE", fault: failStream(RELEASE_AGGREGATE),
    label: "a release stream that cannot be read", layer: "DAEMON_ATTEMPT_RELEASE",
    request: query(), status: "UNKNOWN",
  },
  {
    code: "SAFE_BOUNDARY_LOOKUP_ABSENT", fault: hideIndex(SAFE_BOUNDARY_OBSERVATION_EVENT_TYPE),
    label: "a release with no discoverable producer-owned boundary ref",
    layer: "DAEMON_SAFE_BOUNDARY_LOOKUP", request: query(), status: "ABSENT",
  },
  {
    code: "FOUNDATION_VERIFICATION_RECEIPT_ABSENT",
    fault: hideRowType(FOUNDATION_VERIFICATION_EVENT_TYPES.RECEIPTED),
    label: "a receipt the verification layer cannot re-read",
    layer: "DAEMON_VERIFICATION_RECEIPT", request: query(), status: "UNKNOWN",
  },
  {
    // The IDENTITY cross-check, isolated from the digest comparison: the row is
    // well formed, released for the right cause, and names another attempt.
    code: "EXPANSION_RELEASE_EVIDENCE_CONFLICT",
    fault: patchRelease((body) => ({ ...body, attemptRef: "attempt-elsewhere" })),
    label: "a release row naming a different attempt", layer: LAYER,
    request: query(), status: "UNKNOWN",
  },
];

const ALL_CASES: readonly RosterCase[] = [...LOCAL_CASES, ...BINDING_CASES, ...UPSTREAM_CASES];

describe("expansion release authority (task-e62e3828) — one fault, one refusal", () => {
  it("generates one arm per declared member and no more", () => {
    expect(EXPANSION_RELEASE_AUTHORITY_CODES).toHaveLength(9);
    expect(LOCAL_CASES).toHaveLength(9);
    expect(Object.isFrozen(EXPANSION_RELEASE_AUTHORITY_CODES)).toBe(true);
    expect(LOCAL_CASES.map((entry) => entry.code)).toEqual([...EXPANSION_RELEASE_AUTHORITY_CODES]);
    // The upstream tuple is SHARED with its writer: only six of its eight members
    // can leave the read path, so the partition is asserted, not the arms faked.
    expect(RELEASE_HANDOFF_BINDING_CODES).toHaveLength(8);
    expect(BINDING_CASES).toHaveLength(6);
    expect(BINDING_CASES.length + BINDING_WRITER_ONLY.length)
      .toBe(RELEASE_HANDOFF_BINDING_CODES.length);
    for (const code of BINDING_WRITER_ONLY) expect(RELEASE_HANDOFF_BINDING_CODES).toContain(code);
    expect(ALL_CASES).toHaveLength(21);
  });

  it.each(ALL_CASES)("answers $label with the deciding layer and no evidence", async (entry) => {
    // The world label is a SLUG of the code: the harness threads it into durable
    // command ids, where a sentence-shaped label collides across arms.
    const storePath = await servedReleaseWorld(
      `${entry.code.toLowerCase()}-${ALL_CASES.indexOf(entry)}`);
    // DIVERGENCE: the SAME served world binds once the fault is lifted, so this
    // arm's named guard is the only mechanism that refused.
    expect(askFaulted(storePath, NO_FAULT, query())["status"]).toBe("BOUND");
    const answer = askFaulted(storePath, entry.fault, entry.request);
    expect(answer["code"]).toBe(entry.code);
    expect(answer["layer"]).toBe(entry.layer);
    expect(answer["status"]).toBe(entry.status);
    expect(answer["release"]).toBeUndefined();
    expect(answer["workerHandoff"]).toBeUndefined();
  });

  it("keeps a measured receipt:null apart from a receipt it could not read", async () => {
    const storePath = await servedReleaseWorld("receipt-split");
    const measured = askFaulted(
      storePath, LOCAL_FAULTS["EXPANSION_RELEASE_RECEIPT_ABSENT"] as Fault, query());
    const unreadable = askFaulted(storePath, hideRowType(FOUNDATION_VERIFICATION_EVENT_TYPES.RECEIPTED), query());
    // A FACT and a FAILURE. Same missing receipt, two different repairs, so the
    // two answers must not collapse into one code or one layer.
    expect(measured["code"]).toBe("EXPANSION_RELEASE_RECEIPT_ABSENT");
    expect(measured["layer"]).toBe(LAYER);
    expect(unreadable["code"]).not.toBe(measured["code"]);
    expect(unreadable["layer"]).not.toBe(measured["layer"]);
    expect(unreadable["layer"]).toBe("DAEMON_VERIFICATION_RECEIPT");
  });
});

describe("expansion release authority (task-e62e3828) — the durable rows behind one BOUND", () => {
  it("stands on exactly one release, binding, receipt and boundary row", async () => {
    const storePath = await servedReleaseWorld("row-counts");
    const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
    try {
      const rows = (aggregate: string, type: string): number =>
        store.readEvents(aggregate).filter((event) => event.eventType === type).length;
      expect(rows(RELEASE_AGGREGATE, ATTEMPT_RELEASE_EVENT_TYPE)).toBe(1);
      expect(rows(BINDING_AGGREGATE, RELEASE_HANDOFF_BINDING_EVENT_TYPE)).toBe(1);
      expect(rows(deriveVerificationAggregateId(VERIFICATION_ID),
        FOUNDATION_VERIFICATION_EVENT_TYPES.RECEIPTED)).toBe(1);
      // The boundary rows are found through the TYPE INDEX, which is how the
      // lookup itself discovers them; one observation stands for this attempt.
      const observed = store.readEventsByTypeAfter(
        SAFE_BOUNDARY_OBSERVATION_EVENT_TYPE, 0n, 200).items;
      expect(observed).toHaveLength(1);
    } finally { store.close(); }
  });

  it("names the ref its producer minted, never one this module could recompute", async () => {
    const storePath = await servedReleaseWorld("observation-attribution");
    const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
    let produced: string;
    try {
      const found = readCurrentSafeBoundaryObservation(store, {
        attemptRef: FINAL_ATTEMPT_REF, projectId: PROJECT_ID });
      if (!found.ok) throw new Error(`boundary lookup refused: ${found.code}`);
      produced = found.observationRef;
    } finally { store.close(); }
    const answer = ask(storePath, query()) as Record<string, unknown>;
    const release = answer["release"] as Record<string, unknown>;
    expect(release["observationRef"]).toBe(produced);
    expect(produced).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("hands back a DEEPLY frozen answer no consumer can edit", async () => {
    const storePath = await servedReleaseWorld("frozen");
    const answer = ask(storePath, query()) as Record<string, unknown>;
    const release = answer["release"] as Record<string, unknown>;
    for (const value of [answer, release, release["disposition"], release["handoff"],
      release["terminalEffectRefs"], release["terminalResourceRefs"]]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    // FROZEN IN A STRICT MODULE THROWS, so each of these is a live attempt that
    // was refused rather than a property that merely failed to change.
    expect(() => { (release as { truthClass: string }).truthClass = "AGENT"; }).toThrow(TypeError);
    expect(() => { (release["disposition"] as { resumable: boolean }).resumable = false; })
      .toThrow(TypeError);
    expect(() => { (release["handoff"] as { ref: string }).ref = "forged"; }).toThrow(TypeError);
    expect(() => (release["terminalEffectRefs"] as string[]).push("forged")).toThrow(TypeError);
    expect(() => (release["terminalResourceRefs"] as string[]).push("forged")).toThrow(TypeError);
  });
});
