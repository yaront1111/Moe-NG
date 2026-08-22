import { CLAUDE_MODEL_EVIDENCE_KINDS, CLAUDE_REASONING_EFFORTS } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import type { ServiceOutcome } from "../bootstrap/bootstrap-ledger.js";
import {
  PROJECT_ID,
  closeStores,
  decisionCount,
  envelope,
  openStore,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import type { Envelope } from "../bootstrap/bootstrap-test-fixtures.js";
import {
  PROVIDER_PROFILE_CODEC_CODES,
  PROVIDER_PROFILE_LIMIT_BINDINGS,
  PROVIDER_PROFILE_REGISTRATION_CODES,
  PROVIDER_PROFILE_SCHEMA_VERSION,
  PROVIDER_PROFILE_SCHEMA_VERSION_V1,
  admitProviderProfile,
  decodeProviderProfileBytes,
  encodeProviderProfileBytes,
} from "./provider-profile-codec.js";
import type { ProviderProfileRevision } from "./provider-profile-codec.js";

/**
 * The codec is the only place a `moe-provider-profile/1` body becomes durable authority, so
 * every case here asserts the exact refusal CODE and the exact LAYER that produced it. A test
 * that only asserted "refused" would stay green the day a second guard started answering
 * first, which is precisely the drift these cases exist to catch.
 */

const CODEC_LAYER = "PROVIDER_PROFILE_CODEC";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function validDraft(): Record<string, unknown> {
  return {
    capabilitySchemaDigest: "a1".repeat(32),
    concurrencyCeiling: 4,
    limits: { stderrBytes: 65_536, stdoutBytes: 131_072, tailBytes: 4_096, timeoutMs: 900_000 },
    modelSnapshotEvidence: "claude --version -> 2.0.14 (claude-opus-5-20260514)",
    modelSnapshotKind: "DATED_SNAPSHOT",
    profileRevisionId: "profile-revision-1",
    provider: "claude",
    providerMinimumProfileRef: "provider-profile-1",
    reasoningEffort: "high",
    selectedModelId: "claude-opus-5",
    selection: {
      modelRef: "model-ref-1",
      profileRef: "profile-ref-1",
      providerRef: "provider-ref-1",
      reasoningEffortRef: "reasoning-effort-ref-1",
      runtimeRef: "runtime-ref-1",
      snapshotRef: "snapshot-ref-1",
      structuredOutputSchemaRef: "structured-output-schema-ref-1",
    },
  };
}

/** Accepts through production and throws on refusal, so no case silently tests `undefined`. */
function admitOrThrow(draft: Record<string, unknown>): ProviderProfileRevision {
  const admission = admitProviderProfile(draft);
  if (!admission.ok) throw new Error(`fixture rejected: ${admission.issue.code}`);
  return admission.revision;
}

function refusalOf(value: unknown): { code: string; layer: string } {
  const admission = admitProviderProfile(value);
  if (admission.ok) throw new Error("expected refusal, got an admitted revision");
  return { code: admission.issue.code, layer: admission.issue.layer };
}

function isDeeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isDeeplyFrozen);
}

/**
 * The key rosters come from an ADMITTED revision, never from a hand-written list here: a field
 * added to the production record joins these sweeps automatically instead of leaving a hole
 * that a local copy of the roster would hide.
 */
const CONTROL = admitOrThrow(validDraft());
const SERVER_STAMPED = Object.freeze(["profileDigest", "schemaVersion"] as const);
const DRAFT_KEYS = Object.keys(CONTROL).filter(
  (key) => !(SERVER_STAMPED as readonly string[]).includes(key),
);
const LIMIT_KEYS = Object.keys(CONTROL.limits);
const SELECTION_KEYS = Object.keys(CONTROL.selection);

describe("provider profile codec — admission", () => {
  it("admits the canonical body as a deep-frozen, server-stamped revision", () => {
    const revision = admitOrThrow(validDraft());
    expect(revision.schemaVersion).toBe(PROVIDER_PROFILE_SCHEMA_VERSION_V1);
    expect(PROVIDER_PROFILE_SCHEMA_VERSION_V1).toBe("moe-provider-profile/1");
    expect(PROVIDER_PROFILE_SCHEMA_VERSION).toBe("moe-provider-profile/2");
    expect(revision.profileDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(revision.provider).toBe("claude");
    expect(revision.providerMinimumProfileRef).toBe("provider-profile-1");
    expect(revision.profileRevisionId).toBe("profile-revision-1");
    expect(revision.providerMinimumProfileRef).not.toBe(revision.profileRevisionId);
    expect(isDeeplyFrozen(revision)).toBe(true);
  });

  it("detaches the revision from the caller's record", () => {
    const draft = validDraft();
    const revision = admitOrThrow(draft);
    (draft.limits as Record<string, unknown>).stdoutBytes = 1;
    (draft.selection as Record<string, unknown>).modelRef = "mutated";
    draft.selectedModelId = "mutated";
    expect(revision.limits.stdoutBytes).toBe(131_072);
    expect(revision.selection.modelRef).toBe("model-ref-1");
    expect(revision.selectedModelId).toBe("claude-opus-5");
  });

  it("computes the digest itself rather than adopting a caller's", () => {
    const draft = validDraft();
    draft.limits = { ...(draft.limits as Record<string, unknown>), tailBytes: 8_192 };
    const shifted = admitOrThrow(draft);
    expect(shifted.profileDigest).not.toBe(CONTROL.profileDigest);
    expect(admitOrThrow(validDraft()).profileDigest).toBe(CONTROL.profileDigest);
  });

  it.each([
    ["schemaVersion", PROVIDER_PROFILE_SCHEMA_VERSION],
    ["profileDigest", "b2".repeat(32)],
    ["canonicalBytes", "e30="],
  ])("refuses a caller-supplied %s — server authority is never proposed", (key, value) => {
    expect(refusalOf({ ...validDraft(), [key]: value })).toEqual({
      code: "PROVIDER_PROFILE_INPUT_INVALID",
      layer: CODEC_LAYER,
    });
  });
});

interface HostileCase {
  readonly label: string;
  readonly value: unknown;
}

function withoutKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

function missingCases(): readonly HostileCase[] {
  const top = DRAFT_KEYS.map((key) => ({ label: `missing ${key}`, value: withoutKey(validDraft(), key) }));
  const limits = LIMIT_KEYS.map((key) => ({
    label: `missing limits.${key}`,
    value: { ...validDraft(), limits: withoutKey(validDraft().limits as Record<string, unknown>, key) },
  }));
  const selection = SELECTION_KEYS.map((key) => ({
    label: `missing selection.${key}`,
    value: {
      ...validDraft(),
      selection: withoutKey(validDraft().selection as Record<string, unknown>, key),
    },
  }));
  return [...top, ...limits, ...selection];
}

function vocabularyCases(): readonly HostileCase[] {
  const kinds = CLAUDE_MODEL_EVIDENCE_KINDS.map((kind) => ({
    label: `modelSnapshotKind not ${kind}`,
    value: { ...validDraft(), modelSnapshotKind: `${kind}_NOT_A_MEMBER` },
  }));
  const efforts = CLAUDE_REASONING_EFFORTS.map((effort) => ({
    label: `reasoningEffort not ${effort}`,
    value: { ...validDraft(), reasoningEffort: `${effort}-not-a-member` },
  }));
  return [...kinds, ...efforts];
}

const SHAPE_CASES: readonly HostileCase[] = Object.freeze([
  { label: "null", value: null },
  { label: "undefined", value: undefined },
  { label: "string", value: "profile" },
  { label: "number", value: 7 },
  { label: "array", value: [validDraft()] },
  { label: "unknown extra key", value: { ...validDraft(), extra: "x" } },
  { label: "limits unknown extra key", value: { ...validDraft(), limits: { ...(validDraft().limits as object), extra: 1 } } },
  { label: "selection unknown extra key", value: { ...validDraft(), selection: { ...(validDraft().selection as object), extra: "x" } } },
  { label: "provider not claude", value: { ...validDraft(), provider: "codex" } },
  { label: "provider wrong case", value: { ...validDraft(), provider: "Claude" } },
  { label: "empty providerMinimumProfileRef", value: { ...validDraft(), providerMinimumProfileRef: "" } },
  { label: "empty profileRevisionId", value: { ...validDraft(), profileRevisionId: "" } },
  { label: "empty selection.modelRef", value: { ...validDraft(), selection: { ...(validDraft().selection as object), modelRef: "" } } },
  { label: "empty modelSnapshotEvidence", value: { ...validDraft(), modelSnapshotEvidence: "" } },
  { label: "over-long selectedModelId", value: { ...validDraft(), selectedModelId: "m".repeat(257) } },
  { label: "non-string providerMinimumProfileRef", value: { ...validDraft(), providerMinimumProfileRef: 1 } },
  { label: "non-string selection.runtimeRef", value: { ...validDraft(), selection: { ...(validDraft().selection as object), runtimeRef: null } } },
  { label: "selection not a record", value: { ...validDraft(), selection: "selection" } },
  { label: "limits not a record", value: { ...validDraft(), limits: [1, 2, 3, 4] } },
  { label: "capabilitySchemaDigest not hex", value: { ...validDraft(), capabilitySchemaDigest: "z1".repeat(32) } },
  { label: "capabilitySchemaDigest uppercase", value: { ...validDraft(), capabilitySchemaDigest: "A1".repeat(32) } },
  { label: "capabilitySchemaDigest short", value: { ...validDraft(), capabilitySchemaDigest: "a1".repeat(31) } },
  { label: "concurrencyCeiling zero", value: { ...validDraft(), concurrencyCeiling: 0 } },
  { label: "concurrencyCeiling negative", value: { ...validDraft(), concurrencyCeiling: -1 } },
  { label: "concurrencyCeiling float", value: { ...validDraft(), concurrencyCeiling: 1.5 } },
  { label: "concurrencyCeiling unsafe", value: { ...validDraft(), concurrencyCeiling: Number.MAX_SAFE_INTEGER + 2 } },
  { label: "concurrencyCeiling NaN", value: { ...validDraft(), concurrencyCeiling: Number.NaN } },
  { label: "concurrencyCeiling string", value: { ...validDraft(), concurrencyCeiling: "4" } },
  { label: "limits.stdoutBytes zero", value: { ...validDraft(), limits: { ...(validDraft().limits as object), stdoutBytes: 0 } } },
  { label: "limits.timeoutMs negative", value: { ...validDraft(), limits: { ...(validDraft().limits as object), timeoutMs: -1 } } },
  { label: "limits.tailBytes float", value: { ...validDraft(), limits: { ...(validDraft().limits as object), tailBytes: 4.5 } } },
  { label: "limits.stderrBytes infinite", value: { ...validDraft(), limits: { ...(validDraft().limits as object), stderrBytes: Number.POSITIVE_INFINITY } } },
  { label: "modelSnapshotKind lowercase member", value: { ...validDraft(), modelSnapshotKind: "dated_snapshot" } },
  { label: "reasoningEffort uppercase member", value: { ...validDraft(), reasoningEffort: "HIGH" } },
]);

describe("provider profile codec — hostile admission", () => {
  const cases: readonly HostileCase[] = [...SHAPE_CASES, ...missingCases(), ...vocabularyCases()];

  it("generates every hostile case it claims to sweep", () => {
    expect(DRAFT_KEYS.length).toBe(11);
    expect(LIMIT_KEYS.length).toBe(4);
    expect(SELECTION_KEYS.length).toBe(7);
    expect(missingCases().length).toBe(DRAFT_KEYS.length + LIMIT_KEYS.length + SELECTION_KEYS.length);
    expect(vocabularyCases().length).toBe(
      CLAUDE_MODEL_EVIDENCE_KINDS.length + CLAUDE_REASONING_EFFORTS.length,
    );
    expect(vocabularyCases().length).toBeGreaterThan(0);
    expect(cases.length).toBe(SHAPE_CASES.length + 22 + 9);
  });

  it.each(cases.map((entry) => [entry.label, entry.value] as const))(
    "refuses %s as PROVIDER_PROFILE_INPUT_INVALID at the codec layer",
    (_label, value) => {
      expect(refusalOf(value)).toEqual({
        code: "PROVIDER_PROFILE_INPUT_INVALID",
        layer: CODEC_LAYER,
      });
    },
  );

  it("admits every member of both runner vocabularies", () => {
    for (const kind of CLAUDE_MODEL_EVIDENCE_KINDS) {
      expect(admitOrThrow({ ...validDraft(), modelSnapshotKind: kind }).modelSnapshotKind).toBe(kind);
    }
    for (const effort of CLAUDE_REASONING_EFFORTS) {
      expect(admitOrThrow({ ...validDraft(), reasoningEffort: effort }).reasoningEffort).toBe(effort);
    }
    expect(CLAUDE_MODEL_EVIDENCE_KINDS.length).toBeGreaterThan(0);
    expect(CLAUDE_REASONING_EFFORTS.length).toBeGreaterThan(0);
  });
});

function canonicalText(revision: ProviderProfileRevision): string {
  return decoder.decode(encodeProviderProfileBytes(revision));
}

function decodeRefusal(bytes: unknown): { code: string; layer: string } {
  const decoded = decodeProviderProfileBytes(bytes);
  if (decoded.ok) throw new Error("expected refusal, got a decoded revision");
  return { code: decoded.issue.code, layer: decoded.issue.layer };
}

function decodeOrThrow(bytes: Uint8Array): ProviderProfileRevision {
  const decoded = decodeProviderProfileBytes(bytes);
  if (!decoded.ok) throw new Error(`decode rejected: ${decoded.issue.code}`);
  return decoded.revision;
}

describe("provider profile codec — canonical bytes", () => {
  it("encodes deterministically and round-trips through decode", () => {
    const first = encodeProviderProfileBytes(CONTROL);
    const second = encodeProviderProfileBytes(admitOrThrow(validDraft()));
    expect(Array.from(second)).toEqual(Array.from(first));
    expect(decodeOrThrow(first)).toEqual(CONTROL);
    expect(isDeeplyFrozen(decodeOrThrow(first))).toBe(true);
  });

  it("emits sorted-key JSON so two callers holding the same body agree byte for byte", () => {
    const text = canonicalText(CONTROL);
    const keys = Object.keys(JSON.parse(text) as Record<string, unknown>);
    expect(keys).toEqual([...keys].sort());
    expect(text).not.toContain("\n");
  });

  it("refuses an unsupported schema version before anything else it could blame", () => {
    const drifted = canonicalText(CONTROL).replace(
      CONTROL.schemaVersion,
      "moe-provider-profile/3",
    );
    expect(drifted).toContain("moe-provider-profile/3");
    expect(decodeRefusal(encoder.encode(drifted))).toEqual({
      code: "PROVIDER_PROFILE_VERSION_UNSUPPORTED",
      layer: CODEC_LAYER,
    });
  });

  it.each([
    ["extra whitespace", (text: string): string => JSON.stringify(JSON.parse(text), null, 2)],
    [
      "reversed key order",
      (text: string): string => {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const reversed: Record<string, unknown> = {};
        for (const key of Object.keys(parsed).reverse()) reversed[key] = parsed[key];
        return JSON.stringify(reversed);
      },
    ],
  ])("refuses %s as PROVIDER_PROFILE_NONCANONICAL", (_label, mangle) => {
    const mangled = mangle(canonicalText(CONTROL));
    expect(mangled).not.toBe(canonicalText(CONTROL));
    expect(decodeRefusal(encoder.encode(mangled))).toEqual({
      code: "PROVIDER_PROFILE_NONCANONICAL",
      layer: CODEC_LAYER,
    });
  });

  it("refuses canonical bytes whose embedded digest does not recompute", () => {
    const forged = "c3".repeat(32);
    const tampered = canonicalText(CONTROL).replace(CONTROL.profileDigest, forged);
    expect(tampered).toContain(forged);
    expect(tampered.length).toBe(canonicalText(CONTROL).length);
    expect(decodeRefusal(encoder.encode(tampered))).toEqual({
      code: "PROVIDER_PROFILE_DIGEST_MISMATCH",
      layer: CODEC_LAYER,
    });
  });

  it.each([
    ["a non-byte input", { not: "bytes" }],
    ["unparseable bytes", new TextEncoder().encode("{not json")],
    ["a JSON array", new TextEncoder().encode("[]")],
    ["a JSON scalar", new TextEncoder().encode("\"profile\"")],
    ["an empty object", new TextEncoder().encode("{}")],
  ])("refuses %s as PROVIDER_PROFILE_INPUT_INVALID", (_label, bytes) => {
    expect(decodeRefusal(bytes)).toEqual({
      code: "PROVIDER_PROFILE_INPUT_INVALID",
      layer: CODEC_LAYER,
    });
  });
});

describe("provider profile codec — published rosters", () => {
  it("binds every profile limit to its named project-configuration limit key", () => {
    expect(PROVIDER_PROFILE_LIMIT_BINDINGS).toEqual({
      concurrencyCeiling: "activeProviderSessions",
      stderrBytes: "capturedOutputBytes",
      stdoutBytes: "capturedOutputBytes",
      tailBytes: "uiTailBytes",
      timeoutMs: "runnerAuthorizedMsPerAttempt",
    });
    expect(Object.isFrozen(PROVIDER_PROFILE_LIMIT_BINDINGS)).toBe(true);
  });

  it("binds a key for every limit the admitted revision carries", () => {
    expect(Object.keys(PROVIDER_PROFILE_LIMIT_BINDINGS).sort()).toEqual(
      [...LIMIT_KEYS, "concurrencyCeiling"].sort(),
    );
  });

  it("publishes both closed refusal-code rosters", () => {
    expect(PROVIDER_PROFILE_CODEC_CODES).toEqual([
      "PROVIDER_PROFILE_INPUT_INVALID",
      "PROVIDER_PROFILE_VERSION_UNSUPPORTED",
      "PROVIDER_PROFILE_NONCANONICAL",
      "PROVIDER_PROFILE_DIGEST_MISMATCH",
      "PROVIDER_PROFILE_CONTEXT_LIMIT_MALFORMED",
    ]);
    expect(PROVIDER_PROFILE_REGISTRATION_CODES).toEqual([
      "PROVIDER_PROFILE_REF_MISMATCH",
      "PROVIDER_PROFILE_IMMUTABILITY_CONFLICT",
    ]);
    expect(Object.isFrozen(PROVIDER_PROFILE_CODEC_CODES)).toBe(true);
    expect(Object.isFrozen(PROVIDER_PROFILE_REGISTRATION_CODES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Registration: the authenticated ADMIN `provider.probe` seam, driven through the REAL
// bootstrap pipeline over a file-backed SqliteEventStore. Nothing below reimplements a rule;
// `send` is `runBootstrapCommand`, so a green assertion here is an assertion about production.
// ---------------------------------------------------------------------------------------

const PROVIDER_AGGREGATE = `${PROJECT_ID}-provider`;
const REGISTRATION_LAYER = "PROVIDER_PROFILE_REGISTRATION";

afterAll(closeStores);

function registeredStore(): SqliteEventStore {
  const store = openStore();
  const registered = send(store, envelope("project.register", 0, { owner: "owner-1" }));
  if (!registered.ok) throw new Error(`fixture register failed: ${registered.code}`);
  return store;
}

function probeFor(
  profile: Record<string, unknown> | undefined,
  options: {
    commandId?: string;
    expectedVersion?: number;
    ref?: string;
    truthClass?: string;
  } = {},
): Envelope {
  const observation: Record<string, unknown> = {
    providerMinimumProfileRef: options.ref ?? "provider-profile-1",
    truthClass: options.truthClass ?? "DAEMON_VERIFIED",
  };
  if (profile !== undefined) observation.profile = profile;
  return envelope(
    "provider.probe",
    options.expectedVersion ?? 0,
    { observation },
    options.commandId ?? "probe-1",
  );
}

function refusedProbe(outcome: ServiceOutcome): { code: string; refusedBy: string } {
  if (outcome.ok) throw new Error("expected a refusal, got an accepted decision");
  return { code: outcome.code, refusedBy: outcome.refusedBy };
}

function acceptedProbe(outcome: ServiceOutcome): Record<string, unknown> {
  if (!outcome.ok) throw new Error(`expected acceptance, got ${outcome.code}`);
  return JSON.parse(decoder.decode(outcome.decision.resultBytes)) as Record<string, unknown>;
}

function probedEvents(store: SqliteEventStore): readonly Record<string, unknown>[] {
  return store
    .readEvents(PROVIDER_AGGREGATE)
    .map((event) => JSON.parse(decoder.decode(event.payload)) as Record<string, unknown>);
}

/** The bytes as committed. `toEqual` on a parsed value is key-order blind; this is not. */
function probedEventText(store: SqliteEventStore): readonly string[] {
  return store.readEvents(PROVIDER_AGGREGATE).map((event) => decoder.decode(event.payload));
}

/**
 * The durable identity -> content pairs, in commit order, read back off the event stream.
 *
 * The immutability rule is a property of the whole history, so a case about it has to read the
 * whole history: a length assertion alone cannot tell a refused rebind apart from a rebind that
 * was committed over the top of an earlier event.
 */
function probedIdentityContent(store: SqliteEventStore): readonly string[] {
  return probedEvents(store).map((event) => {
    const profile = event.profile as Record<string, unknown>;
    return `${String(profile.profileRevisionId)}:${String(profile.concurrencyCeiling)}`;
  });
}

describe("provider.probe — profile registration", () => {
  it("persists the canonical profile and its digest with the ProviderProbed event", () => {
    const store = registeredStore();
    const result = acceptedProbe(send(store, probeFor(validDraft())));
    expect(result.providerMinimumProfileRef).toBe("provider-profile-1");
    expect(result.truthClass).toBe("DAEMON_VERIFIED");
    expect(result.profileDigest).toBe(CONTROL.profileDigest);
    expect(result.profile).toEqual(JSON.parse(canonicalText(CONTROL)));

    const events = probedEvents(store);
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({
      profile: JSON.parse(canonicalText(CONTROL)),
      profileDigest: CONTROL.profileDigest,
      providerMinimumProfileRef: "provider-profile-1",
      truthClass: "DAEMON_VERIFIED",
    });
  });

  it("commits the CANONICAL profile bytes, not merely an equal value", () => {
    const store = registeredStore();
    send(store, probeFor(validDraft()));
    // A parsed `toEqual` is blind to key order, so the committed bytes are checked as bytes:
    // the canonical encoding must appear verbatim inside the event payload.
    expect(probedEventText(store)[0]).toContain(`"profile":${canonicalText(CONTROL)}`);
  });

  it("refuses the retired two-string payload — a probe without a profile is dead", () => {
    const store = registeredStore();
    expect(refusedProbe(send(store, probeFor(undefined)))).toEqual({
      code: "PROVIDER_PROFILE_INPUT_INVALID",
      refusedBy: CODEC_LAYER,
    });
    expect(probedEvents(store).length).toBe(0);
  });

  it("refuses a profile body the codec will not admit, at the codec layer", () => {
    const store = registeredStore();
    const outcome = send(store, probeFor({ ...validDraft(), concurrencyCeiling: 0 }));
    expect(refusedProbe(outcome)).toEqual({
      code: "PROVIDER_PROFILE_INPUT_INVALID",
      refusedBy: CODEC_LAYER,
    });
  });

  it("refuses an envelope ref that disagrees with the profile body, at registration", () => {
    const store = registeredStore();
    const before = decisionCount(store);
    const outcome = send(store, probeFor(validDraft(), { ref: "provider-profile-2" }));
    expect(refusedProbe(outcome)).toEqual({
      code: "PROVIDER_PROFILE_REF_MISMATCH",
      refusedBy: REGISTRATION_LAYER,
    });
    expect(probedEvents(store).length).toBe(0);
    expect(decisionCount(store)).toBe(before);
  });

  it("lets the existing ingress guard answer a hostile truthClass first", () => {
    const store = registeredStore();
    const outcome = send(store, probeFor(validDraft(), { truthClass: "SELF_ASSERTED" }));
    expect(refusedProbe(outcome)).toEqual({
      code: "BOOTSTRAP_PAYLOAD_INVALID",
      refusedBy: "DAEMON_INGRESS",
    });
  });

  it("keeps an identical re-probe byte-stable, and still short-circuits a true replay", () => {
    const store = registeredStore();
    const first = acceptedProbe(send(store, probeFor(validDraft(), { commandId: "probe-1" })));
    const second = acceptedProbe(
      send(store, probeFor(validDraft(), { commandId: "probe-2", expectedVersion: 1 })),
    );
    expect(second.profileDigest).toBe(first.profileDigest);
    expect(second.profile).toEqual(first.profile);
    expect(probedEvents(store).map((event) => event.profileDigest)).toEqual([
      CONTROL.profileDigest,
      CONTROL.profileDigest,
    ]);

    const replayed = send(store, probeFor(validDraft(), { commandId: "probe-1" }));
    if (!replayed.ok) throw new Error(`expected a replay, got ${replayed.code}`);
    expect(replayed.disposition).toBe("REPLAYED");
    expect(probedEvents(store).length).toBe(2);
  });

  it("refuses the same profileRevisionId carrying different content, at registration", () => {
    const store = registeredStore();
    acceptedProbe(send(store, probeFor(validDraft(), { commandId: "probe-1" })));
    const outcome = send(
      store,
      probeFor(
        { ...validDraft(), concurrencyCeiling: 8 },
        { commandId: "probe-2", expectedVersion: 1 },
      ),
    );
    expect(refusedProbe(outcome)).toEqual({
      code: "PROVIDER_PROFILE_IMMUTABILITY_CONFLICT",
      refusedBy: REGISTRATION_LAYER,
    });
    expect(probedEvents(store).length).toBe(1);
  });

  /**
   * Declaring a context limit on an EXISTING identity is a rebind, not an update.
   *
   * The completion record for this change states that operators mint a NEW profileRevisionId to
   * declare a limit. That is a claim about production behaviour, so it is asserted here rather
   * than left in prose: the same identity carrying a declaration it did not carry before is
   * different content under an unchanged name, which is exactly what the immutability rule
   * refuses.
   */
  it("refuses a context limit declared onto an existing profileRevisionId, at registration", () => {
    const store = registeredStore();
    acceptedProbe(send(store, probeFor(validDraft(), { commandId: "probe-1" })));
    const outcome = send(
      store,
      probeFor(validDraftV2(), { commandId: "probe-2", expectedVersion: 1 }),
    );
    expect(refusedProbe(outcome)).toEqual({
      code: "PROVIDER_PROFILE_IMMUTABILITY_CONFLICT",
      refusedBy: REGISTRATION_LAYER,
    });
    expect(probedEvents(store).length).toBe(1);
  });

  it("registers a declared context limit under a fresh profileRevisionId", () => {
    const store = registeredStore();
    acceptedProbe(send(store, probeFor(validDraft(), { commandId: "probe-1" })));
    const minted = validDraftV2();
    minted.profileRevisionId = "profile-revision-2";
    const accepted = acceptedProbe(
      send(store, probeFor(minted, { commandId: "probe-3", expectedVersion: 1 })),
    );
    const profile = accepted.profile as Record<string, unknown>;
    expect(profile.schemaVersion).toBe("moe-provider-profile/2");
    expect(profile.contextLimit).toEqual(conservativeLimit());
    expect(probedEvents(store).length).toBe(2);
  });

  it("refuses a profileRevisionId rebound after an intervening probe, at registration", () => {
    // Immutability is a rule about the whole durable history, not about the previous probe.
    // Comparing only the last committed decision lets one interleaved probe under a different
    // identity launder a rebind: revision-1 leaves the comparison window and comes back
    // carrying different content, and the operator's earlier decision is rewritten under its
    // own name — precisely what this rule exists to forbid.
    const store = registeredStore();
    acceptedProbe(send(store, probeFor(validDraft(), { commandId: "probe-1" })));
    acceptedProbe(
      send(
        store,
        probeFor(
          { ...validDraft(), concurrencyCeiling: 8, profileRevisionId: "profile-revision-2" },
          { commandId: "probe-2", expectedVersion: 1 },
        ),
      ),
    );

    const outcome = send(
      store,
      probeFor(
        { ...validDraft(), concurrencyCeiling: 16 },
        { commandId: "probe-3", expectedVersion: 2 },
      ),
    );
    expect(refusedProbe(outcome)).toEqual({
      code: "PROVIDER_PROFILE_IMMUTABILITY_CONFLICT",
      refusedBy: REGISTRATION_LAYER,
    });
    expect(probedEvents(store).length).toBe(2);
    // The durable identity -> content map stays single-valued: revision-1 is still the
    // ceiling-4 body it was admitted as, never the ceiling-16 body that was refused.
    expect(probedIdentityContent(store)).toEqual([
      "profile-revision-1:4",
      "profile-revision-2:8",
    ]);
  });

  it("still admits an identical re-probe of an EARLIER revisionId across an intervening one", () => {
    // The positive control for the history scan: scanning every prior probe must refuse a
    // rebind without also refusing idempotence. A check that matched on profileRevisionId
    // alone would pass the case above and fail here.
    const store = registeredStore();
    const first = acceptedProbe(send(store, probeFor(validDraft(), { commandId: "probe-1" })));
    acceptedProbe(
      send(
        store,
        probeFor(
          { ...validDraft(), concurrencyCeiling: 8, profileRevisionId: "profile-revision-2" },
          { commandId: "probe-2", expectedVersion: 1 },
        ),
      ),
    );

    const again = acceptedProbe(
      send(store, probeFor(validDraft(), { commandId: "probe-3", expectedVersion: 2 })),
    );
    expect(again.profileDigest).toBe(first.profileDigest);
    expect(again.profile).toEqual(first.profile);
    expect(probedIdentityContent(store)).toEqual([
      "profile-revision-1:4",
      "profile-revision-2:8",
      "profile-revision-1:4",
    ]);
  });

  it("admits changed content under a new profileRevisionId — immutability binds identity", () => {
    const store = registeredStore();
    acceptedProbe(send(store, probeFor(validDraft(), { commandId: "probe-1" })));
    const next = acceptedProbe(
      send(
        store,
        probeFor(
          { ...validDraft(), concurrencyCeiling: 8, profileRevisionId: "profile-revision-2" },
          { commandId: "probe-2", expectedVersion: 1 },
        ),
      ),
    );
    expect(next.profileDigest).not.toBe(CONTROL.profileDigest);
    expect(probedEvents(store).length).toBe(2);
  });

  it("re-admits every persisted profile through the decoder it was encoded with", () => {
    const store = registeredStore();
    acceptedProbe(send(store, probeFor(validDraft())));
    const [persisted] = probedEvents(store);
    const revision = decodeOrThrow(
      encoder.encode(canonicalJsonOfPersisted(persisted?.profile)),
    );
    expect(revision).toEqual(CONTROL);
  });
});

/** Re-serialises a persisted profile value through the production encoder, never by hand. */
function canonicalJsonOfPersisted(value: unknown): string {
  const admission = admitProviderProfile(strippedSeal(value));
  if (!admission.ok) throw new Error(`persisted profile rejected: ${admission.issue.code}`);
  return decoder.decode(encodeProviderProfileBytes(admission.revision));
}

function strippedSeal(value: unknown): Record<string, unknown> {
  const record = { ...(value as Record<string, unknown>) };
  delete record.profileDigest;
  delete record.schemaVersion;
  return record;
}

/**
 * The pre-bump golden: what THIS body sealed to under the single-schema codec, captured from a
 * throwaway run at HEAD 320cd93 before `contextLimit` existed. It is an independently taken
 * image of the old output, not a value recomputed from the new code, so it can constrain the
 * claim that v1 sealing is byte-identical after the bump. See task-be8d405b step 2.
 */
const GOLDEN_V1_DIGEST = "5be2604c479a043e3cb6e9172f50062ac798c7d71a96cf289800a41af2c5b89d";
const GOLDEN_V1_BYTES = 878;

const V1_DRAFT_NAMES: readonly string[] = Object.freeze([
  "capabilitySchemaDigest", "concurrencyCeiling", "limits", "modelSnapshotEvidence",
  "modelSnapshotKind", "profileRevisionId", "provider", "providerMinimumProfileRef",
  "reasoningEffort", "selectedModelId", "selection",
]);

const DECLARED_SOURCE = "operator declaration: project configuration 2026-08-22";

function conservativeLimit(): Record<string, unknown> {
  return { bytes: 900_000, kind: "CONSERVATIVE_INPUT_BYTES", source: DECLARED_SOURCE };
}

/** The 12-key v2 draft: the v1 body plus exactly one declared context limit. */
function validDraftV2(contextLimit: unknown = conservativeLimit()): Record<string, unknown> {
  return { ...validDraft(), contextLimit };
}

function draftKeysOf(revision: ProviderProfileRevision): readonly string[] {
  return Object.keys(revision).filter(
    (key) => !(SERVER_STAMPED as readonly string[]).includes(key),
  );
}

/** Set-equality in BOTH directions, stated as such rather than inferred from one inclusion. */
function expectSameKeySet(actual: readonly string[], expected: readonly string[]): void {
  expect(new Set(actual).size).toBe(actual.length);
  expect(new Set(expected).size).toBe(expected.length);
  expect(actual.every((key) => expected.includes(key))).toBe(true);
  expect(expected.every((key) => actual.includes(key))).toBe(true);
  expect([...actual].sort()).toEqual([...expected].sort());
}

function malformedLimitCases(): readonly HostileCase[] {
  return [
    { label: "bytes zero", value: { bytes: 0, kind: "CONSERVATIVE_INPUT_BYTES", source: DECLARED_SOURCE } },
    { label: "bytes negative", value: { bytes: -1, kind: "CONSERVATIVE_INPUT_BYTES", source: DECLARED_SOURCE } },
    { label: "bytes float", value: { bytes: 1.5, kind: "CONSERVATIVE_INPUT_BYTES", source: DECLARED_SOURCE } },
    { label: "bytes NaN", value: { bytes: Number.NaN, kind: "CONSERVATIVE_INPUT_BYTES", source: DECLARED_SOURCE } },
    { label: "bytes infinite", value: { bytes: Number.POSITIVE_INFINITY, kind: "CONSERVATIVE_INPUT_BYTES", source: DECLARED_SOURCE } },
    { label: "bytes unsafe", value: { bytes: Number.MAX_SAFE_INTEGER + 2, kind: "CONSERVATIVE_INPUT_BYTES", source: DECLARED_SOURCE } },
    { label: "bytes as string", value: { bytes: "900000", kind: "CONSERVATIVE_INPUT_BYTES", source: DECLARED_SOURCE } },
    { label: "tokens zero", value: { kind: "EXACT_TOKENS", source: DECLARED_SOURCE, tokens: 0 } },
    { label: "tokens negative", value: { kind: "EXACT_TOKENS", source: DECLARED_SOURCE, tokens: -200 } },
    { label: "tokens float", value: { kind: "EXACT_TOKENS", source: DECLARED_SOURCE, tokens: 200_000.5 } },
    { label: "sourceless CONSERVATIVE_INPUT_BYTES", value: { bytes: 900_000, kind: "CONSERVATIVE_INPUT_BYTES" } },
    { label: "sourceless EXACT_TOKENS", value: { kind: "EXACT_TOKENS", tokens: 200_000 } },
    { label: "empty source", value: { bytes: 900_000, kind: "CONSERVATIVE_INPUT_BYTES", source: "" } },
    { label: "over-long source", value: { bytes: 900_000, kind: "CONSERVATIVE_INPUT_BYTES", source: "s".repeat(257) } },
    { label: "non-string source", value: { bytes: 900_000, kind: "CONSERVATIVE_INPUT_BYTES", source: 7 } },
    { label: "unknown kind", value: { bytes: 900_000, kind: "APPROXIMATE_TOKENS", source: DECLARED_SOURCE } },
    { label: "kind wrong case", value: { bytes: 900_000, kind: "conservative_input_bytes", source: DECLARED_SOURCE } },
    { label: "UNKNOWN carrying a source", value: { kind: "UNKNOWN", source: DECLARED_SOURCE } },
    { label: "UNKNOWN carrying bytes", value: { bytes: 900_000, kind: "UNKNOWN" } },
    { label: "CONSERVATIVE_INPUT_BYTES carrying tokens", value: { kind: "CONSERVATIVE_INPUT_BYTES", source: DECLARED_SOURCE, tokens: 200_000 } },
    { label: "EXACT_TOKENS carrying bytes", value: { bytes: 900_000, kind: "EXACT_TOKENS", source: DECLARED_SOURCE } },
    { label: "declared kind with an extra key", value: { bytes: 900_000, extra: "x", kind: "CONSERVATIVE_INPUT_BYTES", source: DECLARED_SOURCE } },
    { label: "null", value: null },
    { label: "string", value: "CONSERVATIVE_INPUT_BYTES" },
    { label: "number", value: 900_000 },
    { label: "array", value: [conservativeLimit()] },
    { label: "empty record", value: {} },
    { label: "kind missing", value: { bytes: 900_000, source: DECLARED_SOURCE } },
  ];
}

/** Drops each v1 key from a v2 draft. `contextLimit` is deliberately NOT in this sweep. */
function v2MissingCases(): readonly HostileCase[] {
  return V1_DRAFT_NAMES.map((key) => ({
    label: `v2 draft missing ${key}`,
    value: withoutKey(validDraftV2(), key),
  }));
}

describe("provider profile codec — v2 context-limit declaration", () => {
  it("pins the v1 roster and derives the v2 roster as v1 + contextLimit from the seam", () => {
    const v1Keys = draftKeysOf(admitOrThrow(validDraft()));
    expectSameKeySet(v1Keys, V1_DRAFT_NAMES);
    expect(v1Keys.length).toBe(11);
    const v2Keys = draftKeysOf(admitOrThrow(validDraftV2()));
    expectSameKeySet(v2Keys, [...V1_DRAFT_NAMES, "contextLimit"]);
    expect(v2Keys.length).toBe(12);
  });

  it("seals a v2 revision whose admitted keys set-equal its encoded keys, both directions", () => {
    const revision = admitOrThrow(validDraftV2());
    const encoded = Object.keys(JSON.parse(canonicalText(revision)) as Record<string, unknown>);
    expectSameKeySet(Object.keys(revision), encoded);
    expect(encoded).toContain("contextLimit");
    expect(revision.schemaVersion).toBe("moe-provider-profile/2");
  });

  it("seals an 11-key draft under v1, byte-identical to the pre-bump codec", () => {
    const revision = admitOrThrow(validDraft());
    expect(revision.schemaVersion).toBe("moe-provider-profile/1");
    expect(revision.profileDigest).toBe(GOLDEN_V1_DIGEST);
    expect(encodeProviderProfileBytes(revision).byteLength).toBe(GOLDEN_V1_BYTES);
    expect(Object.keys(revision)).not.toContain("contextLimit");
    expect("contextLimit" in revision).toBe(false);
  });

  it("treats a dropped contextLimit as a v1 body rather than a refusal", () => {
    const revision = admitOrThrow(withoutKey(validDraftV2(), "contextLimit"));
    expect(revision.schemaVersion).toBe("moe-provider-profile/1");
    expect(revision.profileDigest).toBe(GOLDEN_V1_DIGEST);
  });

  it("carries the declaration onto the revision verbatim", () => {
    const revision = admitOrThrow(validDraftV2());
    expect(revision.contextLimit).toEqual({
      bytes: 900_000,
      kind: "CONSERVATIVE_INPUT_BYTES",
      source: DECLARED_SOURCE,
    });
    expect(isDeeplyFrozen(revision)).toBe(true);
  });

  it.each([
    ["EXACT_TOKENS", { kind: "EXACT_TOKENS", source: "model card: claude-opus-5 200k window", tokens: 200_000 }],
    ["UNKNOWN", { kind: "UNKNOWN" }],
    ["CONSERVATIVE_INPUT_BYTES", { bytes: 900_000, kind: "CONSERVATIVE_INPUT_BYTES", source: DECLARED_SOURCE }],
  ])("admits a %s declaration and echoes it unchanged", (_label, limit) => {
    expect(admitOrThrow(validDraftV2(limit)).contextLimit).toEqual(limit);
  });

  it("covers contextLimit in the profileDigest", () => {
    const first = admitOrThrow(validDraftV2());
    const second = admitOrThrow(
      validDraftV2({ bytes: 900_001, kind: "CONSERVATIVE_INPUT_BYTES", source: DECLARED_SOURCE }),
    );
    const sourceShifted = admitOrThrow(
      validDraftV2({ bytes: 900_000, kind: "CONSERVATIVE_INPUT_BYTES", source: "model card" }),
    );
    expect(second.profileDigest).not.toBe(first.profileDigest);
    expect(sourceShifted.profileDigest).not.toBe(first.profileDigest);
    expect(admitOrThrow(validDraftV2({ kind: "UNKNOWN" })).profileDigest).not.toBe(
      first.profileDigest,
    );
    expect(admitOrThrow(validDraftV2()).profileDigest).toBe(first.profileDigest);
    expect(first.profileDigest).not.toBe(GOLDEN_V1_DIGEST);
  });

  it("generates every context-limit case it claims to sweep", () => {
    expect(malformedLimitCases().length).toBe(28);
    expect(malformedLimitCases().length).toBeGreaterThan(0);
    expect(v2MissingCases().length).toBe(V1_DRAFT_NAMES.length);
    expect(v2MissingCases().length).toBeGreaterThan(0);
  });

  it.each(malformedLimitCases().map((entry) => [entry.label, entry.value] as const))(
    "refuses contextLimit %s as PROVIDER_PROFILE_CONTEXT_LIMIT_MALFORMED at the codec layer",
    (_label, limit) => {
      expect(refusalOf(validDraftV2(limit))).toEqual({
        code: "PROVIDER_PROFILE_CONTEXT_LIMIT_MALFORMED",
        layer: CODEC_LAYER,
      });
    },
  );

  it.each(v2MissingCases().map((entry) => [entry.label, entry.value] as const))(
    "refuses %s as PROVIDER_PROFILE_INPUT_INVALID at the codec layer",
    (_label, value) => {
      expect(refusalOf(value)).toEqual({
        code: "PROVIDER_PROFILE_INPUT_INVALID",
        layer: CODEC_LAYER,
      });
    },
  );

  it.each([
    ["an unknown extra key beside a valid declaration", { ...validDraftV2(), extra: "x" }],
    ["a caller-supplied schemaVersion", { ...validDraftV2(), schemaVersion: "moe-provider-profile/2" }],
    ["a caller-supplied profileDigest", { ...validDraftV2(), profileDigest: "b2".repeat(32) }],
  ])("refuses %s as PROVIDER_PROFILE_INPUT_INVALID, not as a limit fault", (_label, draft) => {
    expect(refusalOf(draft)).toEqual({
      code: "PROVIDER_PROFILE_INPUT_INVALID",
      layer: CODEC_LAYER,
    });
  });

  it("still blames the general body path when a v2 draft breaks a non-limit field", () => {
    expect(refusalOf({ ...validDraftV2(), concurrencyCeiling: 0 })).toEqual({
      code: "PROVIDER_PROFILE_INPUT_INVALID",
      layer: CODEC_LAYER,
    });
  });
});

describe("provider profile codec — v2 canonical bytes", () => {
  it("round-trips v2 bytes with the declaration intact", () => {
    const revision = admitOrThrow(validDraftV2());
    const decoded = decodeOrThrow(encodeProviderProfileBytes(revision));
    expect(decoded).toEqual(revision);
    expect(decoded.contextLimit).toEqual(conservativeLimit());
    expect(isDeeplyFrozen(decoded)).toBe(true);
  });

  it("still decodes v1 bytes under the dual-version codec", () => {
    const decoded = decodeOrThrow(encodeProviderProfileBytes(admitOrThrow(validDraft())));
    expect(decoded.schemaVersion).toBe("moe-provider-profile/1");
    expect(decoded.profileDigest).toBe(GOLDEN_V1_DIGEST);
    expect("contextLimit" in decoded).toBe(false);
  });

  it("answers VERSION_UNSUPPORTED before roster exactness — a deliberate precedence", () => {
    const parsed = JSON.parse(canonicalText(CONTROL)) as Record<string, unknown>;
    parsed.schemaVersion = "moe-provider-profile/3";
    parsed.extra = "x";
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(parsed).sort()) sorted[key] = parsed[key];
    expect(decodeRefusal(encoder.encode(JSON.stringify(sorted)))).toEqual({
      code: "PROVIDER_PROFILE_VERSION_UNSUPPORTED",
      layer: CODEC_LAYER,
    });
  });

  it("refuses v2 bytes carrying a malformed declaration", () => {
    const revision = admitOrThrow(validDraftV2());
    const tampered = canonicalText(revision).replace('"bytes":900000', '"bytes":-1');
    expect(tampered).toContain('"bytes":-1');
    expect(decodeRefusal(encoder.encode(tampered))).toEqual({
      code: "PROVIDER_PROFILE_CONTEXT_LIMIT_MALFORMED",
      layer: CODEC_LAYER,
    });
  });

  it("refuses v1 bytes that smuggle a contextLimit key", () => {
    const parsed = JSON.parse(canonicalText(CONTROL)) as Record<string, unknown>;
    parsed.contextLimit = conservativeLimit();
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(parsed).sort()) sorted[key] = parsed[key];
    expect(decodeRefusal(encoder.encode(JSON.stringify(sorted)))).toEqual({
      code: "PROVIDER_PROFILE_INPUT_INVALID",
      layer: CODEC_LAYER,
    });
  });

  it("refuses v2 bytes whose embedded digest does not recompute", () => {
    const revision = admitOrThrow(validDraftV2());
    const forged = "c3".repeat(32);
    const tampered = canonicalText(revision).replace(revision.profileDigest, forged);
    expect(tampered).toContain(forged);
    expect(decodeRefusal(encoder.encode(tampered))).toEqual({
      code: "PROVIDER_PROFILE_DIGEST_MISMATCH",
      layer: CODEC_LAYER,
    });
  });
});
