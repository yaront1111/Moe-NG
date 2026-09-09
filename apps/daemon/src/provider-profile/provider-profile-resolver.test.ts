/**
 * The current-profile reader, graded against durable records only.
 *
 * Every case here drives PRODUCTION paths — `project.register`, `provider.probe`,
 * `selectProjectConfiguration`, `project.activate` — against a real file-backed store. A
 * fixture that hand-built the durable rows could satisfy a binding the production writers
 * would never have produced, and the whole point of this reader is that the bindings hold on
 * records the system actually wrote.
 *
 * The refusal assertions pin the layer as the LITERAL "PROVIDER_PROFILE_READER" rather than an
 * imported constant: a test that imports the constant it asserts still passes after the
 * constant is renamed out from under every consumer.
 */

import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_CONFIGURATION_LIMIT_KEYS } from "@moe/contracts";
import type { ProjectConfigurationLimitKey } from "@moe/contracts";
import {
  createProjectConfigurationManifest,
  encodeProjectConfigurationManifest,
} from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { selectProjectConfiguration } from "../configuration/project-configuration-selection.js";
import {
  admitProviderProfile,
  encodeProviderProfileBytes,
} from "./provider-profile-codec.js";
import {
  ACTIVATION_WITNESS,
  OBSERVATION,
  POLICY_REF,
  POLICY_SLICE,
  PROJECT_ID,
  activatePayload,
  receiptsWithProviderRef,
  closeStores,
  envelope,
  evaluationInput,
  hex64,
  openStore,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { resolveCurrentProviderProfile } from "./provider-profile-resolver.js";

const READER_LAYER = "PROVIDER_PROFILE_READER";
const PROFILE_REF = "profile-ref-1";
const MINIMUM_REF = "provider-profile-1";

/** Positional table: the value a key carries is its index, so every entry is distinguishable. */
function limitValue(key: ProjectConfigurationLimitKey): number {
  return PROJECT_CONFIGURATION_LIMIT_KEYS.indexOf(key) + 1;
}

const SELECTION = Object.freeze({
  modelRef: "model-ref-1",
  profileRef: PROFILE_REF,
  providerRef: "provider-ref-1",
  reasoningEffortRef: "reasoning-effort-ref-1",
  runtimeRef: "runtime-ref-1",
  snapshotRef: "snapshot-ref-1",
  structuredOutputSchemaRef: "structured-output-schema-ref-1",
});

/**
 * A profile BOUND to the configuration below.
 *
 * The shared `CLAUDE_PROFILE` fixture cannot be reused here: it sets `stdoutBytes` and
 * `stderrBytes` to different values while both bind the SAME `capturedOutputBytes` entry, so it
 * is admissible at probe registration and unbindable at this reader by construction.
 */
function profileBody(): Record<string, unknown> {
  return {
    capabilitySchemaDigest: hex64("ca9ab111"),
    concurrencyCeiling: limitValue("activeProviderSessions"),
    limits: {
      stderrBytes: limitValue("capturedOutputBytes"),
      stdoutBytes: limitValue("capturedOutputBytes"),
      tailBytes: limitValue("uiTailBytes"),
      timeoutMs: limitValue("runnerAuthorizedMsPerAttempt"),
    },
    modelSnapshotEvidence: "claude --version reported a dated snapshot",
    modelSnapshotKind: "DATED_SNAPSHOT",
    profileRevisionId: PROFILE_REF,
    provider: "claude",
    providerMinimumProfileRef: MINIMUM_REF,
    reasoningEffort: "high",
    selectedModelId: "claude-opus-5",
    selection: SELECTION,
  };
}

function settingsBody(): Record<string, unknown> {
  return {
    isolation: { hostContainment: "NOT_CLAIMED", workspace: "PER_ATTEMPT_WORKTREE" },
    limits: PROJECT_CONFIGURATION_LIMIT_KEYS.map((key) => ({ key, value: limitValue(key) })),
    network: { daemonExposure: "LOOPBACK_ONLY", providerEgress: "EGRESS_ALLOWLISTED" },
    orchestrationSource: { objectFormat: "sha256", sourceSha: hex64("0c5") },
    policy: {
      acceptanceGate: "MANUAL_HUMAN_APPROVAL",
      autoApprovalOptInDigest: null,
      evaluatorVersion: "policy-evaluator-v1",
      expansionGate: "MANUAL_HUMAN_APPROVAL",
      planningGate: "MANUAL_HUMAN_APPROVAL",
      policyRevisionId: "policy-revision-1",
      revision: 1,
    },
    schemaVersions: {
      commandSchemaVersion: "moe-command-1",
      errorSchemaVersion: "moe-error-1",
      querySchemaVersion: "moe-query-1",
    },
    selection: SELECTION,
  };
}

interface SeedOptions {
  readonly envelopeRef?: string;
  readonly profile?: Record<string, unknown>;
  readonly settings?: Record<string, unknown>;
  readonly skipProbe?: boolean;
  readonly truthClass?: string;
  /**
   * Drives the MINTED witness's `providerMinimumProfileRef` apart from the committed probe.
   * Replaced `witness?` (task-4b9c394d): a caller can no longer supply a witness at all, so a
   * planted payload is refused at the ingress and never reaches the record this seeds.
   */
  readonly activationProviderRef?: string;
}

interface Seeded {
  readonly settingsDigest: string;
  readonly store: SqliteEventStore;
}

function configure(store: SqliteEventStore, settings: Record<string, unknown>): string {
  const created = createProjectConfigurationManifest(PROJECT_ID, settings);
  if (!created.ok) throw new Error(`seed manifest refused: ${created.code}`);
  const encoded = encodeProjectConfigurationManifest(created.manifest);
  if (!encoded.ok) throw new Error(`seed encode refused: ${encoded.code}`);
  const selected = selectProjectConfiguration(store, {
    projectId: PROJECT_ID,
    commandId: "configuration-command-1",
    correlationId: "correlation-configuration-1",
    decidedAt: "2026-08-19T18:00:00.000Z",
    principalId: "principal-1",
    expectedVersion: 0,
    manifestBytes: encoded.bytes,
  });
  if (!selected.ok) throw new Error(`seed selection refused: ${selected.code}`);
  return created.manifest.settingsDigest;
}

/** Drives the production writers. A refused setup throws rather than leaving an empty store. */
function seed(options: SeedOptions = {}): Seeded {
  const store = openStore();
  const observation = {
    profile: options.profile ?? profileBody(),
    providerMinimumProfileRef: options.envelopeRef ?? MINIMUM_REF,
    truthClass: options.truthClass ?? "DAEMON_VERIFIED",
  };
  // Activation is unreachable without a probe (`project.activate` refuses ILLEGAL_TRANSITION),
  // so an unprobed project is durably registered and configured but never activated.
  const steps = options.skipProbe
    ? [
        envelope("project.register", 0, { owner: "owner-1" }),
        envelope("project.bind_repository", 1, { observation: OBSERVATION }),
      ]
    : [
        envelope("project.register", 0, { owner: "owner-1" }),
        envelope("project.bind_repository", 1, { observation: OBSERVATION }),
        envelope("provider.probe", 0, { observation }),
        envelope("policy.install", 0, { slice: POLICY_SLICE }),
        envelope("policy.validate", 1, { input: evaluationInput(POLICY_REF) }),
        envelope("project.activate", 2, activatePayload()),
      ];
  for (const step of steps) {
    // Only the activation carries receipts, and only when this seed is deliberately severing the
    // provider binding; every other command ignores the argument.
    const outcome = send(store, step, step.kind === "project.activate"
      && options.activationProviderRef !== undefined
      ? receiptsWithProviderRef(options.activationProviderRef)
      : undefined);
    if (!outcome.ok) throw new Error(`seed failed at ${step.kind}: ${outcome.code}`);
  }
  return { settingsDigest: configure(store, options.settings ?? settingsBody()), store };
}

function expectRefusal(value: unknown, code: string): Record<string, unknown> {
  const refusal = value as Record<string, unknown>;
  expect(refusal.ok).toBe(false);
  expect(refusal.outcome).toBe("UNKNOWN");
  expect(refusal.authority).toBe("NONE");
  expect(refusal.code).toBe(code);
  expect(refusal.layer).toBe(READER_LAYER);
  expect(Object.isFrozen(refusal)).toBe(true);
  return refusal;
}

afterEach(() => {
  closeStores();
});

describe("resolveCurrentProviderProfile — accepted authority", () => {
  it("returns frozen capabilities whose digests are DERIVED from the durable records", () => {
    const { settingsDigest, store } = seed();

    const result = resolveCurrentProviderProfile(store, {
      projectId: PROJECT_ID,
      expectedConfigurationDigest: settingsDigest,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({
      authority: "DAEMON_VERIFIED",
      concurrencyCeiling: limitValue("activeProviderSessions"),
      evidence: "DURABLE",
      modelSnapshotEvidence: "claude --version reported a dated snapshot",
      modelSnapshotKind: "DATED_SNAPSHOT",
      outcome: "CURRENT",
      profileRevisionId: PROFILE_REF,
      provider: "claude",
      providerMinimumProfileRef: MINIMUM_REF,
      reasoningEffort: "high",
      selectedModelId: "claude-opus-5",
    });
    // The three derived digests echo durable records rather than being re-hashed here.
    expect(result.configurationDigest).toBe(settingsDigest);
    expect(result.policyDigest).toBe(ACTIVATION_WITNESS.policyRevisionHash);
    expect(result.orchestrationDigest).toBe(hex64("0c5"));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.limits)).toBe(true);
  });

  it("is READ-ONLY: two calls append nothing and return deep-equal results", () => {
    const { settingsDigest, store } = seed();
    const request = { projectId: PROJECT_ID, expectedConfigurationDigest: settingsDigest };
    const horizonBefore = store.readEventHorizon();

    const first = resolveCurrentProviderProfile(store, request);
    const second = resolveCurrentProviderProfile(store, request);

    expect(first.ok).toBe(true);
    expect(first).toEqual(second);
    expect(store.readEventHorizon()).toBe(horizonBefore);
  });

  it("refuses an extra field rather than letting a dispatch override in", () => {
    const { settingsDigest, store } = seed();

    const result = resolveCurrentProviderProfile(store, {
      projectId: PROJECT_ID,
      expectedConfigurationDigest: settingsDigest,
      concurrencyCeiling: 999,
    });

    expectRefusal(result, "PROVIDER_PROFILE_UNREADABLE");
  });
});

describe("resolveCurrentProviderProfile — missing and unreadable evidence", () => {
  it("refuses PROVIDER_PROFILE_ABSENT when the project was never probed", () => {
    const { settingsDigest, store } = seed({ skipProbe: true });

    expectRefusal(
      resolveCurrentProviderProfile(store, {
        projectId: PROJECT_ID,
        expectedConfigurationDigest: settingsDigest,
      }),
      "PROVIDER_PROFILE_ABSENT",
    );
  });

  it("preserves the CONFIG reader's own code and layer on a stale configuration digest", () => {
    const { store } = seed();

    const refusal = expectRefusal(
      resolveCurrentProviderProfile(store, {
        projectId: PROJECT_ID,
        expectedConfigurationDigest: hex64("5ta1e"),
      }),
      "PROVIDER_PROFILE_UNREADABLE",
    );

    // Upstream is forwarded verbatim: restamping it would erase which layer actually refused.
    expect(refusal.upstream).toEqual({
      code: "PROJECT_CONFIGURATION_STALE",
      layer: "PROJECT_CONFIGURATION_SELECTION",
    });
  });
});

const SELECTION_KEYS = Object.freeze([
  "modelRef", "profileRef", "providerRef", "reasoningEffortRef",
  "runtimeRef", "snapshotRef", "structuredOutputSchemaRef",
] as const);

function withProfile(patch: Record<string, unknown>): SeedOptions {
  return { profile: { ...profileBody(), ...patch } };
}

function withLimit(key: string, value: number): SeedOptions {
  const base = profileBody();
  return {
    profile: { ...base, limits: { ...(base.limits as Record<string, number>), [key]: value } },
  };
}

/**
 * One row per severed binding. The cardinality is asserted BEFORE the table runs: a generated
 * table that silently produced zero rows would otherwise pass while testing nothing.
 */
const BINDING_ROWS: readonly { readonly binding: string; readonly options: SeedOptions }[] =
  Object.freeze([
    ...SELECTION_KEYS.map((key) => ({
      binding: `selection.${key}`,
      options: {
        profile: { ...profileBody(), selection: { ...SELECTION, [key]: `${key}-drifted` } },
      },
    })),
    { binding: "profileRevisionId", options: withProfile({ profileRevisionId: "profile-ref-2" }) },
    {
      binding: "providerMinimumProfileRef",
      options: { activationProviderRef: "provider-profile-2" },
    },
    {
      binding: "limits.stdoutBytes",
      options: withLimit("stdoutBytes", limitValue("capturedOutputBytes") + 1),
    },
    {
      binding: "limits.stderrBytes",
      options: withLimit("stderrBytes", limitValue("capturedOutputBytes") + 1),
    },
    { binding: "limits.tailBytes", options: withLimit("tailBytes", limitValue("uiTailBytes") + 1) },
    {
      binding: "limits.timeoutMs",
      options: withLimit("timeoutMs", limitValue("runnerAuthorizedMsPerAttempt") + 1),
    },
    {
      binding: "concurrencyCeiling",
      options: withProfile({ concurrencyCeiling: limitValue("activeProviderSessions") + 1 }),
    },
  ]);

describe("resolveCurrentProviderProfile — binding table", () => {
  it("covers every binding the resolver claims to authenticate", () => {
    expect(BINDING_ROWS).toHaveLength(14);
    expect(new Set(BINDING_ROWS.map((row) => row.binding)).size).toBe(14);
  });

  /**
   * The third leg of the minimum-ref triangle, proven separately BECAUSE it cannot be seeded.
   *
   * `provider.probe` refuses when the envelope ref and the profile body's ref disagree, so this
   * state exists only in a corrupted or hand-written durable row — which is precisely the row
   * the triangle exists to refuse. Planted through the store's own commit API, with the same
   * stated limit as the weak-witness case: it proves the leg fires, not that a writer can
   * produce it. This is why the seeded table above is 14 rows and the triangle is 3 legs.
   */
  it("refuses BINDING_MISMATCH when a planted probe row's envelope ref left its body behind", () => {
    const { settingsDigest, store } = seed();
    const probeAggregate = `${PROJECT_ID}-provider`;
    // Sealed through the codec's OWN encoder, so the planted body decodes cleanly and the read
    // actually reaches the triangle. A hand-forged digest would be refused by the codec first
    // and this row would prove ordering instead of the leg it is here to prove.
    const admitted = admitProviderProfile(profileBody());
    if (!admitted.ok) throw new Error(`fixture profile refused: ${admitted.issue.code}`);
    const sealed = JSON.parse(
      new TextDecoder().decode(encodeProviderProfileBytes(admitted.revision)),
    ) as Record<string, unknown>;
    const planted = {
      profile: sealed,
      profileDigest: admitted.revision.profileDigest,
      providerMinimumProfileRef: "provider-profile-drifted",
      truthClass: "DAEMON_VERIFIED",
    };
    store.commit({
      aggregateId: probeAggregate,
      commandBytes: new TextEncoder().encode("plant-envelope-drift"),
      commandId: "cmd-plant-envelope-drift",
      committedAt: "2026-08-19T21:00:00.000Z",
      events: [{
        eventId: "provider-probed-envelope-drift",
        eventType: "ProviderProbed",
        payload: new TextEncoder().encode(JSON.stringify(planted)),
      }],
      expectedVersion: store.getAggregateVersion(probeAggregate),
    });

    const refusal = expectRefusal(
      resolveCurrentProviderProfile(store, {
        projectId: PROJECT_ID,
        expectedConfigurationDigest: settingsDigest,
      }),
      "PROVIDER_PROFILE_BINDING_MISMATCH",
    );

    expect(refusal.detail).toContain("probeEnvelopeRef");
  });

  it.each(BINDING_ROWS)("refuses BINDING_MISMATCH when $binding is severed", ({ binding, options }) => {
    const { settingsDigest, store } = seed(options);

    const refusal = expectRefusal(
      resolveCurrentProviderProfile(store, {
        projectId: PROJECT_ID,
        expectedConfigurationDigest: settingsDigest,
      }),
      "PROVIDER_PROFILE_BINDING_MISMATCH",
    );

    // Naming the severed binding is what makes each row kill its own mutation.
    expect(refusal.detail).toContain(binding);
  });
});

describe("resolveCurrentProviderProfile — truth and scope", () => {
  it.each(["OBSERVED", "AGENT_REPORTED"])(
    "refuses TRUTH_UNVERIFIED and names the PROBE when its truth is %s",
    (truthClass) => {
      const { settingsDigest, store } = seed({ truthClass });

      const refusal = expectRefusal(
        resolveCurrentProviderProfile(store, {
          projectId: PROJECT_ID,
          expectedConfigurationDigest: settingsDigest,
        }),
        "PROVIDER_PROFILE_TRUTH_UNVERIFIED",
      );

      expect(refusal.detail).toContain("probe");
      expect(refusal.detail).not.toContain("witness");
    },
  );

  /**
   * STATED LIMIT, so this is not read as an ordinary end-to-end case.
   *
   * `project.activate` refuses a caller-supplied witness outright at DAEMON_INGRESS and mints
   * its own with `truthClass: "DAEMON_VERIFIED"` (see the negative control below), so no
   * production writer can leave a durable ProjectActivated carrying a weak one.
   * The reader's witness-truth gate is therefore defence in depth against a record that only a
   * corrupted or hand-written store could hold — and the only way to exercise it is to plant
   * that record through the store's own commit API. What this proves is that the gate fires on
   * such a record; it does NOT prove the honest path can reach it, because it cannot.
   */
  it("refuses TRUTH_UNVERIFIED and names the WITNESS on a planted weak-truth activation", () => {
    const { settingsDigest, store } = seed();
    const planted = { witness: { ...ACTIVATION_WITNESS, truthClass: "OBSERVED" } };
    store.commit({
      aggregateId: PROJECT_ID,
      commandBytes: new TextEncoder().encode("plant-weak-activation"),
      commandId: "cmd-plant-weak-activation",
      committedAt: "2026-08-19T20:00:00.000Z",
      events: [{
        eventId: "project-activated-weak",
        eventType: "ProjectActivated",
        payload: new TextEncoder().encode(JSON.stringify(planted)),
      }],
      expectedVersion: store.getAggregateVersion(PROJECT_ID),
    });

    const refusal = expectRefusal(
      resolveCurrentProviderProfile(store, {
        projectId: PROJECT_ID,
        expectedConfigurationDigest: settingsDigest,
      }),
      "PROVIDER_PROFILE_TRUTH_UNVERIFIED",
    );

    expect(refusal.detail).toContain("witness");
    expect(refusal.detail).not.toContain("probe");
  });

  /**
   * The layer that actually owns the weak-witness refusal on every honest path.
   *
   * RE-POINTED, NOT DELETED, by task-4b9c394d. This arm used to send a witness with
   * `truthClass: "OBSERVED"` and assert CORE_REDUCER. That mechanism is gone: a caller cannot
   * supply a witness at all, so core's truth check is unreachable from here and an arm still
   * asserting CORE_REDUCER would have been asserting a layer that no longer answers. Deleting it
   * was the alternative, but the STATED-LIMIT comment above depends on naming the layer that
   * owns this refusal on the honest path — that layer is now DAEMON_INGRESS, and the guarantee
   * is STRONGER than before (a weak witness is refused before its truthClass is even read).
   */
  it("project.activate refuses a caller's weak-truth witness at the INGRESS, before any reader", () => {
    const store = openStore();
    for (const step of [
      envelope("project.register", 0, { owner: "owner-1" }),
      envelope("project.bind_repository", 1, { observation: OBSERVATION }),
      envelope("provider.probe", 0, {
        observation: {
          profile: profileBody(),
          providerMinimumProfileRef: MINIMUM_REF,
          truthClass: "DAEMON_VERIFIED",
        },
      }),
      envelope("policy.install", 0, { slice: POLICY_SLICE }),
      envelope("policy.validate", 1, { input: evaluationInput(POLICY_REF) }),
    ]) {
      expect(send(store, step).ok).toBe(true);
    }

    const outcome = send(store, envelope(
      "project.activate", 2, activatePayload({ truthClass: "OBSERVED" }),
    ));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("ACTIVATION_WITNESS_CALLER_SUPPLIED");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
  });


  it("does not answer a foreign project from another project's durable records", () => {
    const { settingsDigest, store } = seed();

    const refusal = expectRefusal(
      resolveCurrentProviderProfile(store, {
        projectId: "project-2",
        expectedConfigurationDigest: settingsDigest,
      }),
      "PROVIDER_PROFILE_ABSENT",
    );

    // The foreign project has no configuration of its own; the config layer's code survives.
    expect(refusal.upstream).toEqual({
      code: "PROJECT_CONFIGURATION_ABSENT",
      layer: "PROJECT_CONFIGURATION_SELECTION",
    });
  });
});

describe("resolveCurrentProviderProfile — tampered durable bytes", () => {
  it("preserves the CODEC's own code and layer when the persisted profile no longer decodes", () => {
    const { settingsDigest, store } = seed();
    const probeAggregate = `${PROJECT_ID}-provider`;
    const tampered = {
      profile: { ...profileBody(), profileDigest: hex64("bad"), schemaVersion: "moe-provider-profile/1" },
      profileDigest: hex64("bad"),
      providerMinimumProfileRef: MINIMUM_REF,
      truthClass: "DAEMON_VERIFIED",
    };
    // Written through the store's OWN commit API, so the row is durable rather than mocked.
    store.commit({
      aggregateId: probeAggregate,
      commandBytes: new TextEncoder().encode("tamper"),
      commandId: "cmd-tamper-probe",
      committedAt: "2026-08-19T19:00:00.000Z",
      events: [{
        eventId: "provider-probed-tampered",
        eventType: "ProviderProbed",
        payload: new TextEncoder().encode(JSON.stringify(tampered)),
      }],
      expectedVersion: store.getAggregateVersion(probeAggregate),
    });

    const refusal = expectRefusal(
      resolveCurrentProviderProfile(store, {
        projectId: PROJECT_ID,
        expectedConfigurationDigest: settingsDigest,
      }),
      "PROVIDER_PROFILE_UNREADABLE",
    );

    expect(refusal.upstream).toEqual({
      code: "PROVIDER_PROFILE_DIGEST_MISMATCH",
      layer: "PROVIDER_PROFILE_CODEC",
    });
  });
});

/**
 * NEGATIVE CONTROL for a binding this reader deliberately does NOT own.
 *
 * `provider.probe` already refuses when the envelope ref and the profile body's ref disagree,
 * so that state is unreachable in any durable record the production writers can produce. A
 * reader-side row for it would be answered by the registration layer and never by this reader —
 * the exact shape that makes a refusal test vacuous. The clause stays covered where it is
 * actually enforced, and this test pins WHICH layer that is.
 */
describe("provider.probe owns the envelope-versus-body ref check", () => {
  it("refuses PROVIDER_PROFILE_REF_MISMATCH at PROVIDER_PROFILE_REGISTRATION, before any reader", () => {
    const store = openStore();
    expect(send(store, envelope("project.register", 0, { owner: "owner-1" })).ok).toBe(true);

    const outcome = send(store, envelope("provider.probe", 0, {
      observation: {
        profile: profileBody(),
        providerMinimumProfileRef: "provider-profile-2",
        truthClass: "DAEMON_VERIFIED",
      },
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("PROVIDER_PROFILE_REF_MISMATCH");
    expect(outcome.refusedBy).toBe("PROVIDER_PROFILE_REGISTRATION");
  });
});

const DECLARED_SOURCE = "operator declaration: project configuration 2026-08-22";
const DECLARED_LIMIT = Object.freeze({
  bytes: 900_000,
  kind: "CONSERVATIVE_INPUT_BYTES" as const,
  source: DECLARED_SOURCE,
});

function expectCapabilities(value: unknown): Record<string, unknown> {
  const result = value as Record<string, unknown>;
  if (result.ok !== true) throw new Error(`expected capabilities, got ${String(result.code)}`);
  return result;
}

function resolved(store: SqliteEventStore, settingsDigest: string): Record<string, unknown> {
  return expectCapabilities(
    resolveCurrentProviderProfile(store, {
      projectId: PROJECT_ID,
      expectedConfigurationDigest: settingsDigest,
    }),
  );
}

/** The profile as the production writer actually committed it, read back off the event stream. */
function storedProfile(store: SqliteEventStore): Record<string, unknown> {
  const [event] = store.readEvents(`${PROJECT_ID}-provider`);
  if (event === undefined) throw new Error("no ProviderProbed event was committed");
  const payload = JSON.parse(new TextDecoder().decode(event.payload)) as Record<string, unknown>;
  return payload.profile as Record<string, unknown>;
}

describe("resolveCurrentProviderProfile — declared context limit", () => {
  it("serves a declared limit verbatim, never a ceiling or a default", () => {
    const { settingsDigest, store } = seed(withProfile({ contextLimit: { ...DECLARED_LIMIT } }));

    const result = resolved(store, settingsDigest);

    expect(result.contextLimit).toEqual({
      bytes: 900_000,
      kind: "CONSERVATIVE_INPUT_BYTES",
      source: DECLARED_SOURCE,
    });
    // The four capture ceilings and the shared context default are all DIFFERENT numbers from
    // the declared one, so a mapping to any of them reddens this arm rather than coinciding.
    const limits = result.limits as Record<string, number>;
    for (const ceiling of Object.values(limits)) {
      expect((result.contextLimit as { bytes: number }).bytes).not.toBe(ceiling);
    }
    expect((result.contextLimit as { bytes: number }).bytes).not.toBe(64 * 1024);
  });

  it("serves an EXACT_TOKENS declaration verbatim", () => {
    const declared = {
      kind: "EXACT_TOKENS",
      source: "model card: claude-opus-5 200k window, output reserved",
      tokens: 200_000,
    };
    const { settingsDigest, store } = seed(withProfile({ contextLimit: { ...declared } }));

    expect(resolved(store, settingsDigest).contextLimit).toEqual(declared);
  });

  it("serves an explicitly declared UNKNOWN as exactly one key", () => {
    const { settingsDigest, store } = seed(withProfile({ contextLimit: { kind: "UNKNOWN" } }));

    const contextLimit = resolved(store, settingsDigest).contextLimit as Record<string, unknown>;
    expect(contextLimit).toEqual({ kind: "UNKNOWN" });
    expect(Object.keys(contextLimit)).toEqual(["kind"]);
  });

  /**
   * DoD-4: a revision written BEFORE this field existed.
   *
   * The eleven-key body is what the old codec admitted, and the stored record proves it — the
   * writer stamped `moe-provider-profile/1` and committed no `contextLimit` key at all. Serving
   * that as UNKNOWN is a STATED DECISION: a revision that predates the question has no answer to
   * it, and manufacturing one would give an invented number the authority of a durable record.
   */
  it("serves a pre-bump v1 revision as UNKNOWN, by decision rather than by default", () => {
    const { settingsDigest, store } = seed();

    const stored = storedProfile(store);
    expect(stored.schemaVersion).toBe("moe-provider-profile/1");
    expect(Object.keys(stored)).not.toContain("contextLimit");

    const contextLimit = resolved(store, settingsDigest).contextLimit as Record<string, unknown>;
    expect(contextLimit).toEqual({ kind: "UNKNOWN" });
    expect(Object.keys(contextLimit)).toEqual(["kind"]);
  });

  it("changes the served profileDigest when only the declaration changes", () => {
    const withoutDeclaration = seed();
    const withDeclaration = seed(withProfile({ contextLimit: { ...DECLARED_LIMIT } }));

    const bare = resolved(withoutDeclaration.store, withoutDeclaration.settingsDigest);
    const declared = resolved(withDeclaration.store, withDeclaration.settingsDigest);

    expect(declared.profileDigest).not.toBe(bare.profileDigest);
    expect(declared.profileRevisionId).toBe(bare.profileRevisionId);
  });

  it.each([
    ["sourceless", { bytes: 900_000, kind: "CONSERVATIVE_INPUT_BYTES" }],
    ["negative bytes", { bytes: -1, kind: "CONSERVATIVE_INPUT_BYTES", source: DECLARED_SOURCE }],
    ["unknown kind", { bytes: 900_000, kind: "APPROXIMATE", source: DECLARED_SOURCE }],
  ])(
    "refuses a %s declaration at the writer and serves no profile at all",
    (_label, contextLimit) => {
      const store = openStore();
      const steps = [
        envelope("project.register", 0, { owner: "owner-1" }),
        envelope("project.bind_repository", 1, { observation: OBSERVATION }),
      ];
      for (const step of steps) {
        const outcome = send(store, step);
        if (!outcome.ok) throw new Error(`seed failed at ${step.kind}: ${outcome.code}`);
      }

      const refused = send(
        store,
        envelope("provider.probe", 0, {
          observation: {
            profile: { ...profileBody(), contextLimit },
            providerMinimumProfileRef: MINIMUM_REF,
            truthClass: "DAEMON_VERIFIED",
          },
        }),
      );

      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.code).toBe("PROVIDER_PROFILE_CONTEXT_LIMIT_MALFORMED");
      expect(refused.refusedBy).toBe("PROVIDER_PROFILE_CODEC");
      expect(store.readEvents(`${PROJECT_ID}-provider`)).toHaveLength(0);
    },
  );
});
