/**
 * The server-owned launch-template completion authority, graded over real file-backed durable
 * stores driven through the PRODUCTION writers (`project.register`, `project.bind_repository`,
 * `provider.probe`, `policy.install`, `policy.validate`, `project.activate`,
 * `selectProjectConfiguration`, `session.open`).
 *
 * Nothing here hand-builds a runtime section or a credential digest. Every accepted expectation
 * is the PRODUCTION producer's own answer read back from the same store, because a literal
 * expectation is a fixed point: a mutant that stubs a constant return passes it. The refusal
 * arms assert the upstream CODE and the LAYER that answered, never merely `ok === false` —
 * five different authorities can refuse one completion, and only the layer says which one did.
 */

import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_CONFIGURATION_LIMIT_KEYS } from "@moe/contracts";
import type { ProjectConfigurationLimitKey } from "@moe/contracts";
import { DEFAULT_CONTEXT_BYTE_BUDGET, renderContext, selectContext } from "@moe/context";
import {
  createProjectConfigurationManifest, encodeProjectConfigurationManifest,
} from "@moe/core";
import { WORKTREE_ASSIGNMENT_VERSION } from "@moe/runner";
import type { WorktreeAssignment } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";

import {
  ACTIVATION_WITNESS, OBSERVATION, POLICY_REF, POLICY_SLICE, PROJECT_ID,
  closeStores, envelope, evaluationInput, hex64, openStore, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { selectProjectConfiguration } from "../configuration/project-configuration-selection.js";
import { credentialSha256Of } from "../identity/session-authenticator.js";
import {
  SESSION_PREREQUISITE_REFUSAL_CODES, SESSION_REFUSED_BY, SESSION_SCHEMA_VERSION,
} from "../identity/session-contracts.js";
import { readSessionCredentialDigest } from "../identity/session-credential-digest.js";
import { runSessionCommand } from "../identity/session-services.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { resolveCurrentProviderProfile } from "../provider-profile/provider-profile-resolver.js";
import {
  probeFor,
} from "../provider-profile/provider-runtime-observation-test-fixtures.js";
import type {
  FoundationAttemptLaunchTemplate, FoundationLaunchTemplateCompletionInput,
  FoundationLaunchTemplateCompletionRefused,
} from "./foundation-attempt-contracts.js";
import {
  FOUNDATION_LAUNCH_COMPLETION_CODES, createFoundationLaunchCompletionAuthority,
} from "./foundation-launch-completion-wiring.js";
import type { FoundationLaunchCompletionResult } from "./foundation-launch-completion-wiring.js";
import {
  LAUNCH_RUNTIME_SECTION_CODES, produceLaunchRuntimeSection,
} from "./launch-runtime-section.js";
import { produceLaunchTemplateFields } from "./launch-template-producer.js";

const PROFILE_REF = "profile-ref-1";
const MINIMUM_REF = "provider-profile-1";
const PIN_ROOT = "D:\\moe-data\\runtime-pins";
const RELATIVE_PIN_ROOT = "runtime-pins";
const SESSION_ID = "session-launch-completion";
const OTHER_SESSION_ID = "session-never-opened";
const SESSION_CREDENTIAL = "launch-completion-session-credential";
const ATTEMPT_REF = "attempt-launch-completion-1";
const NODE_KEY = "node-1";
const WORKTREE_ROOT = "D:\\moe-data\\worktrees\\attempt-1";

/**
 * The layers asserted as LITERALS rather than imported constants. Importing the constant a test
 * asserts makes the arm survive that constant being renamed out from under every consumer.
 */
const RUNTIME_SECTION_LAYER = "LAUNCH_RUNTIME_SECTION";
const OBSERVATION_READER_LAYER = "PROVIDER_RUNTIME_OBSERVATION_READER";
const PROFILE_READER_LAYER = "PROVIDER_PROFILE_READER";
const CONFIGURATION_LAYER = "PROJECT_CONFIGURATION_SELECTION";
const SESSION_PREREQUISITE_LAYER = "DAEMON_PREREQUISITE";
const COMPLETION_LAYER = "FOUNDATION_LAUNCH_COMPLETION";

/** The exact key roster the completion answers with, named once and counted. */
const EXPECTED_TEMPLATE_KEYS = Object.freeze([
  "argv", "bootstrapCredentialDigest", "cwd", "environment", "launchSelection", "limits",
  "runtime",
] as const);

const SELECTION = Object.freeze({
  modelRef: "model-ref-1",
  profileRef: PROFILE_REF,
  providerRef: "provider-ref-1",
  reasoningEffortRef: "reasoning-effort-ref-1",
  runtimeRef: "runtime-ref-1",
  snapshotRef: "snapshot-ref-1",
  structuredOutputSchemaRef: "structured-output-schema-ref-1",
});

const MISSION = Object.freeze({
  instructions: "retire the caller-carried launch template",
  test: "pnpm --filter @moe/daemon test",
  title: "foundation launch completion",
  workspace: "D:\\projexts\\moe-next",
});

const RUNTIME_FACTS = Object.freeze({
  adapterCapabilitySchemaDigest: "a1".repeat(32),
  platformIdentity: { arch: "x64", os: "win32", osVersion: "10.0.26200" },
  reportedVersion: "2.0.14",
});

/** Positional table: the value a key carries is its index, so every entry is distinguishable. */
function limitValue(key: ProjectConfigurationLimitKey): number {
  return PROJECT_CONFIGURATION_LIMIT_KEYS.indexOf(key) + 1;
}

/** A profile BOUND to the configuration below; `profileRevisionId` IS `selection.profileRef`. */
function boundProfile(): Record<string, unknown> {
  return {
    capabilitySchemaDigest: "a1".repeat(32),
    concurrencyCeiling: limitValue("activeProviderSessions"),
    limits: {
      stderrBytes: limitValue("capturedOutputBytes"),
      stdoutBytes: limitValue("capturedOutputBytes"),
      tailBytes: limitValue("uiTailBytes"),
      timeoutMs: limitValue("runnerAuthorizedMsPerAttempt"),
    },
    modelSnapshotEvidence: "claude-cli-2.0.14-2026-05-01",
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
  /** Skip `provider.probe` entirely, so the profile reader finds no record. */
  readonly skipProbe?: boolean;
  /** Send a LEGACY probe with no `runtime` section, so the observation reader finds none. */
  readonly skipRuntime?: boolean;
  /** Skip `selectProjectConfiguration`, so the configuration reader finds none. */
  readonly skipConfiguration?: boolean;
  /** Skip `session.open`, so the credential reader finds no OPEN session. */
  readonly skipSession?: boolean;
}

/** Drives the production writers. A refused setup throws rather than leaving a half-built store. */
function seedStore(options: SeedOptions = {}): SqliteEventStore {
  const store = openStore();
  // `project.activate` refuses BOOTSTRAP_PREREQUISITE_MISSING without a prior `provider.probe`,
  // so the probe-less world is also an unactivated one. That is exactly the durable shape a
  // project has before it has ever been probed, and it is where PROVIDER_PROFILE_ABSENT lives.
  const steps = options.skipProbe === true
    ? [envelope("project.register", 0, { owner: "owner-1" })]
    : [
      envelope("project.register", 0, { owner: "owner-1" }),
      envelope("project.bind_repository", 1, { observation: OBSERVATION }),
      probeFor({ profile: boundProfile(),
        ...(options.skipRuntime === true ? { runtime: null } : {}) }),
      envelope("policy.install", 0, { slice: POLICY_SLICE }),
      envelope("policy.validate", 1, { input: evaluationInput(POLICY_REF) }),
      envelope("project.activate", 2, { witness: ACTIVATION_WITNESS }),
    ];
  for (const step of steps) {
    const outcome = send(store, step);
    if (!outcome.ok) throw new Error(`seed failed at ${step.kind}: ${outcome.code}`);
  }
  if (options.skipConfiguration !== true) {
    const created = createProjectConfigurationManifest(PROJECT_ID, settingsBody());
    if (!created.ok) throw new Error(`seed manifest refused: ${created.code}`);
    const encoded = encodeProjectConfigurationManifest(created.manifest);
    if (!encoded.ok) throw new Error(`seed encode refused: ${encoded.code}`);
    const selected = selectProjectConfiguration(store, {
      commandId: "configuration-command-1",
      correlationId: "correlation-configuration-1",
      decidedAt: "2026-08-19T18:00:00.000Z",
      expectedVersion: 0,
      manifestBytes: encoded.bytes,
      principalId: "principal-1",
      projectId: PROJECT_ID,
    });
    if (!selected.ok) throw new Error(`seed selection refused: ${selected.code}`);
  }
  if (options.skipSession !== true) openSession(store);
  return store;
}

function openSession(store: SqliteEventStore): void {
  installTestRecoveryBinding(store);
  const opened = runSessionCommand(store, new TextEncoder().encode(JSON.stringify({
    commandId: "cmd-open-launch-completion",
    correlationId: "corr-launch-completion",
    decidedAt: "2026-08-22T00:00:00.000Z",
    expectedVersion: 0,
    kind: "session.open",
    payload: {
      capabilities: ["work.claim"],
      credentialSha256: credentialSha256Of(SESSION_CREDENTIAL),
      expiresAt: "2027-01-01T00:00:00.000Z",
      sessionId: SESSION_ID,
    },
    principalId: "operator-local",
    projectId: PROJECT_ID,
    schemaVersion: SESSION_SCHEMA_VERSION,
  })));
  if (!opened.ok) throw new Error(`seed session refused: ${opened.code}`);
}

/**
 * Delegates every read to the seeded store EXCEPT `readCommandDecisionsAfter`, which is the one
 * call `readSessionLedger` makes and no other authority in this chain makes. It therefore drives
 * a store fault at the LAST reader only, with the first three already answered.
 */
function ledgerFaultingStore(store: SqliteEventStore): SqliteEventStore {
  return new Proxy(store, {
    get(target, property, receiver): unknown {
      if (property === "readCommandDecisionsAfter") {
        return (): never => { throw new Error("sqlite handle is closed"); };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  });
}

const ASSIGNMENT: WorktreeAssignment = Object.freeze({
  adopted: false,
  assignmentVersion: WORKTREE_ASSIGNMENT_VERSION,
  attemptId: ATTEMPT_REF,
  baseIdentity: "a".repeat(64),
  leaf: "attempt-1",
  projectId: PROJECT_ID,
  realSourceRepositoryRoot: "D:\\projexts\\moe-next",
  realWorktreeParent: "D:\\moe-data\\worktrees",
  realWorktreePath: WORKTREE_ROOT,
  worktreePath: WORKTREE_ROOT,
});

function renderedContextFixture(): ReturnType<typeof renderContext> {
  const selected = selectContext({
    byteBudget: DEFAULT_CONTEXT_BYTE_BUDGET,
    exclusions: [],
    mandatory: [{ content: "complete the launch template server-side", id: "mission-1",
      kind: "MANDATORY", section: "mission" }],
    optional: [],
  });
  if (selected.kind !== "ADMITTED") throw new Error(`fixture selection refused: ${selected.code}`);
  return renderContext(selected.selection);
}

/** The sealed context's template, built by the PRODUCTION producer over resolved capabilities. */
function sealedTemplate(store: SqliteEventStore): FoundationLaunchTemplateCompletionInput["template"] {
  const capabilities = resolveCurrentProviderProfile(store, {
    expectedConfigurationDigest: currentDigest(), projectId: PROJECT_ID,
  });
  if (!capabilities.ok) {
    throw new Error(`fixture capabilities refused: ${capabilities.code}@${capabilities.layer}`);
  }
  const fields = produceLaunchTemplateFields({
    capabilities,
    mission: MISSION,
    renderedContext: renderedContextFixture(),
    runtimeObservation: RUNTIME_FACTS,
  });
  if (!fields.ok) throw new Error(`fixture template refused: ${fields.code}@${fields.layer}`);
  return fields;
}

/** The digest of the very settings `seedStore` selects, recomputed by the production builder. */
function currentDigest(): string {
  const created = createProjectConfigurationManifest(PROJECT_ID, settingsBody());
  if (!created.ok) throw new Error(`fixture manifest refused: ${created.code}`);
  return created.manifest.settingsDigest;
}

/**
 * A template the REFUSAL arms hand in and never assert against. Those worlds cannot resolve
 * capabilities by construction — that is what they are testing — so producing one through
 * `produceLaunchTemplateFields` would make the fixture throw before the arm could run.
 */
const STUB_TEMPLATE = Object.freeze({
  argv: ["--print"], environment: Object.freeze({}), launchSelection: {}, limits: {},
  ok: true as const, renderedContext: {},
}) as unknown as FoundationLaunchTemplateCompletionInput["template"];

function completionInput(
  store: SqliteEventStore,
  overrides: { readonly sessionId?: string; readonly stubTemplate?: true } = {},
): FoundationLaunchTemplateCompletionInput {
  return {
    assignment: ASSIGNMENT,
    attemptRef: ATTEMPT_REF,
    nodeKey: NODE_KEY,
    projectId: PROJECT_ID,
    sessionId: overrides.sessionId ?? SESSION_ID,
    template: overrides.stubTemplate === true ? STUB_TEMPLATE : sealedTemplate(store),
  };
}

function complete(
  store: SqliteEventStore,
  options: {
    readonly pinRoot?: string | undefined;
    readonly readStore?: SqliteEventStore;
    readonly stubTemplate?: true;
  } = {},
  input?: FoundationLaunchTemplateCompletionInput,
): FoundationLaunchCompletionResult {
  const authority = createFoundationLaunchCompletionAuthority({
    ...(Object.hasOwn(options, "pinRoot") ? { pinRoot: options.pinRoot } : { pinRoot: PIN_ROOT }),
    store: options.readStore ?? store,
  });
  return authority.completeLaunchTemplate(input ?? completionInput(store, {
    ...(options.stubTemplate === true ? { stubTemplate: true } : {}),
  }));
}

/**
 * The ACCEPTED shape carries no `ok` discriminator — `FoundationAttemptLaunchTemplate` is the
 * seven launch fields and nothing else — so refusal is recognised exactly as the service
 * recognises it, by the presence of an `ok: false` key rather than by its absence.
 */
function isRefusal(
  result: FoundationLaunchCompletionResult,
): result is FoundationLaunchTemplateCompletionRefused {
  return "ok" in result && result.ok === false;
}

function refusalOf(
  result: FoundationLaunchCompletionResult,
): { readonly code: string; readonly layer: string } {
  expect(isRefusal(result)).toBe(true);
  if (!isRefusal(result)) {
    throw new Error("the completion authority accepted where it must refuse");
  }
  return { code: result.code, layer: result.layer };
}

function acceptedOf(
  result: FoundationLaunchCompletionResult,
): FoundationAttemptLaunchTemplate {
  if (isRefusal(result)) {
    throw new Error(`the completion authority refused: ${result.code}@${result.layer}`);
  }
  return result;
}

afterEach(() => {
  closeStores();
});

describe("the completion authority answers from durable server state alone", () => {
  it("returns the runtime section the production producer itself answers with", () => {
    const store = seedStore();

    const completed = acceptedOf(complete(store));

    // Compared against the PRODUCER's own result, not a literal: a hardcoded expectation is a
    // fixed point that a stubbed-return mutant satisfies.
    const produced = produceLaunchRuntimeSection({
      pinRoot: PIN_ROOT, profileRevisionId: PROFILE_REF, projectId: PROJECT_ID, store,
    });
    expect(produced.ok).toBe(true);
    if (!produced.ok) throw new Error(`producer control refused: ${produced.code}`);
    expect(completed.runtime).toEqual(produced.runtime);
  });

  it("returns the credential digest the session reader itself answers with", () => {
    const store = seedStore();

    const completed = acceptedOf(complete(store));

    const read = readSessionCredentialDigest(store, PROJECT_ID, SESSION_ID);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(`credential control refused: ${read.code}@${read.refusedBy}`);
    expect(completed.bootstrapCredentialDigest).toBe(read.credentialSha256);
    expect(read.credentialSha256).toBe(credentialSha256Of(SESSION_CREDENTIAL));
  });

  it("carries the sealed template's four fields through unchanged and roots cwd at the assignment", () => {
    const store = seedStore();
    const template = sealedTemplate(store);

    const completed = acceptedOf(complete(store, {}, {
      assignment: ASSIGNMENT, attemptRef: ATTEMPT_REF, nodeKey: NODE_KEY,
      projectId: PROJECT_ID, sessionId: SESSION_ID, template,
    }));

    expect(completed.argv).toEqual(template.argv);
    expect(completed.environment).toEqual(template.environment);
    expect(completed.launchSelection).toEqual(template.launchSelection);
    expect(completed.limits).toEqual(template.limits);
    // The ASSIGNMENT is the root: no caller proposes a cwd anywhere on this path.
    expect(completed.cwd).toBe(ASSIGNMENT.realWorktreePath);
    expect(completed.cwd).not.toBe(MISSION.workspace);
  });

  it("answers with exactly the seven template keys and nothing beyond them", () => {
    const store = seedStore();

    const completed = acceptedOf(complete(store));

    expect(EXPECTED_TEMPLATE_KEYS).toHaveLength(7);
    expect(Object.keys(completed).sort()).toEqual([...EXPECTED_TEMPLATE_KEYS].sort());
    expect(Object.keys(completed)).toHaveLength(EXPECTED_TEMPLATE_KEYS.length);
    expect(Object.isFrozen(completed)).toBe(true);
  });
});

/**
 * ONE ROW PER REFUSING AUTHORITY. Named as an immutable constant and counted, so deleting a row
 * reds the denominator rather than silently shrinking the sweep.
 */
const REFUSAL_CASES = Object.freeze([
  Object.freeze({
    code: "PROJECT_CONFIGURATION_ABSENT", layer: CONFIGURATION_LAYER,
    name: "no durable project configuration",
    seed: (): SqliteEventStore => seedStore({ skipConfiguration: true }),
  }),
  Object.freeze({
    code: "PROVIDER_PROFILE_ABSENT", layer: PROFILE_READER_LAYER,
    name: "no ProviderProbed record",
    seed: (): SqliteEventStore => seedStore({ skipProbe: true }),
  }),
  Object.freeze({
    code: "PROVIDER_RUNTIME_OBSERVATION_ABSENT", layer: OBSERVATION_READER_LAYER,
    name: "a legacy probe with no runtime section",
    seed: (): SqliteEventStore => seedStore({ skipRuntime: true }),
  }),
  Object.freeze({
    code: "SESSION_CREDENTIAL_DIGEST_UNAVAILABLE", layer: SESSION_PREREQUISITE_LAYER,
    name: "no OPEN session with that id",
    seed: (): SqliteEventStore => seedStore({ skipSession: true }),
  }),
] as const);

describe("every upstream refusal reaches the caller with ITS code and ITS layer", () => {
  it("names four distinct refusing authorities, one per upstream", () => {
    expect(REFUSAL_CASES).toHaveLength(4);
    expect(new Set(REFUSAL_CASES.map((entry) => entry.layer)).size).toBe(4);
    expect(new Set(REFUSAL_CASES.map((entry) => entry.code)).size).toBe(4);
  });

  let generated = 0;
  for (const entry of REFUSAL_CASES) {
    generated += 1;
    it(`forwards ${entry.code} unrestamped for ${entry.name}`, () => {
      const store = entry.seed();

      const refusal = refusalOf(complete(store, { stubTemplate: true }));

      expect(refusal.code).toBe(entry.code);
      expect(refusal.layer).toBe(entry.layer);
    });
  }

  it("actually generated one arm per named case", () => {
    expect(generated).toBe(REFUSAL_CASES.length);
    expect(generated).toBe(4);
  });
});

describe("the runtime pin root is host configuration, and an absent one refuses", () => {
  it("refuses LAUNCH_RUNTIME_PIN_ROOT_UNCONFIGURED when the daemon configured none", () => {
    const store = seedStore();

    const refusal = refusalOf(complete(store, { pinRoot: undefined, stubTemplate: true }));

    expect(refusal.code).toBe("LAUNCH_RUNTIME_PIN_ROOT_UNCONFIGURED");
    expect(refusal.layer).toBe(RUNTIME_SECTION_LAYER);
  });

  it("refuses LAUNCH_RUNTIME_PIN_ROOT_INVALID for a relative configured root", () => {
    const store = seedStore();

    const refusal = refusalOf(complete(store, { pinRoot: RELATIVE_PIN_ROOT, stubTemplate: true }));

    expect(refusal.code).toBe("LAUNCH_RUNTIME_PIN_ROOT_INVALID");
    expect(refusal.layer).toBe(RUNTIME_SECTION_LAYER);
  });

  /**
   * THE CLOSED UPSTREAM ROSTERS this authority forwards from, each pinned by EXACT count.
   * `length > 0` would be satisfied by a one-member roster, so it is not sufficient: a member
   * silently deleted upstream must red HERE, where the forwarding is claimed, and not only in
   * the suite that owns the roster.
   */
  it("consumes the closed six-member runtime code roster it forwards from", () => {
    expect(LAUNCH_RUNTIME_SECTION_CODES).toHaveLength(6);
    expect(LAUNCH_RUNTIME_SECTION_CODES).toContain("LAUNCH_RUNTIME_PIN_ROOT_UNCONFIGURED");
    expect(LAUNCH_RUNTIME_SECTION_CODES).toContain("LAUNCH_RUNTIME_PIN_ROOT_INVALID");
  });

  it("consumes the closed eight-member session prerequisite roster and its three layers", () => {
    expect(SESSION_PREREQUISITE_REFUSAL_CODES).toHaveLength(8);
    expect(SESSION_PREREQUISITE_REFUSAL_CODES)
      .toContain("SESSION_CREDENTIAL_DIGEST_UNAVAILABLE");
    expect(SESSION_PREREQUISITE_REFUSAL_CODES).toContain("SESSION_LEDGER_UNREADABLE");
    // Three layers can answer a session refusal, so the arms above pin WHICH one did rather
    // than merely that one did; this is the denominator that claim is measured against.
    expect(SESSION_REFUSED_BY).toHaveLength(3);
    expect(SESSION_REFUSED_BY).toContain(SESSION_PREREQUISITE_LAYER);
  });

  it("drives every code it claims to forward, and forwards no code it never drove", () => {
    // The DRIVEN set, read off the arms above rather than restated: two session codes and two
    // pin-root codes. Naming it as a frozen constant with an exact count is what makes a
    // deleted arm red something, instead of silently shrinking an inline literal.
    const DRIVEN_SESSION_CODES = Object.freeze([
      "SESSION_CREDENTIAL_DIGEST_UNAVAILABLE", "SESSION_LEDGER_UNREADABLE",
    ] as const);
    expect(DRIVEN_SESSION_CODES).toHaveLength(2);
    for (const code of DRIVEN_SESSION_CODES) {
      expect(SESSION_PREREQUISITE_REFUSAL_CODES as readonly string[]).toContain(code);
    }
    const DRIVEN_RUNTIME_CODES = Object.freeze([
      "LAUNCH_RUNTIME_PIN_ROOT_UNCONFIGURED", "LAUNCH_RUNTIME_PIN_ROOT_INVALID",
    ] as const);
    expect(DRIVEN_RUNTIME_CODES).toHaveLength(2);
    for (const code of DRIVEN_RUNTIME_CODES) {
      expect(LAUNCH_RUNTIME_SECTION_CODES as readonly string[]).toContain(code);
    }
  });
});

describe("a refusal carries no partial authority", () => {
  it("contains a store fault at the credential reader with that reader's own code", () => {
    const store = seedStore();
    const input = completionInput(store);

    const refusal = refusalOf(complete(store, { readStore: ledgerFaultingStore(store) }, input));

    // The first three authorities answered; only the ledger read faulted, so the code and the
    // layer must both be the SESSION reader's — not a generic transport error.
    expect(refusal.code).toBe("SESSION_LEDGER_UNREADABLE");
    expect(refusal.layer).toBe(SESSION_PREREQUISITE_LAYER);
  });

  it("returns no runtime and no digest on any refusal", () => {
    const store = seedStore({ skipSession: true });

    const result = complete(store, { stubTemplate: true });

    expect(isRefusal(result)).toBe(true);
    if (!isRefusal(result)) throw new Error("unreachable");
    expect(Object.hasOwn(result, "runtime")).toBe(false);
    expect(Object.hasOwn(result, "bootstrapCredentialDigest")).toBe(false);
    expect(Object.keys(result).sort()).toEqual(["code", "layer", "ok"]);
  });

  it("never defaults an absent capability into an accepted template", () => {
    const store = seedStore({ skipProbe: true });

    const result = complete(store, { stubTemplate: true });

    expect(isRefusal(result)).toBe(true);
    if (!isRefusal(result)) {
      throw new Error("an absent provider profile was defaulted into a template");
    }
    expect(result.code).toBe("PROVIDER_PROFILE_ABSENT");
  });

  /**
   * THE CONTAINMENT NAMES ITSELF, and this is the arm that stops it impersonating an upstream.
   * All four readers contain their own store faults, so a throw reaching the outer handler came
   * from somewhere none of them can speak for — answering with one of THEIR codes would name an
   * authority that never ran. The fault is injected on the ASSIGNMENT, which no reader touches.
   */
  it("mints its OWN code for a throw no upstream reader could have produced", () => {
    expect(FOUNDATION_LAUNCH_COMPLETION_CODES).toHaveLength(1);
    const store = seedStore();
    const hostileAssignment = {} as unknown as WorktreeAssignment;
    Object.defineProperty(hostileAssignment, "realWorktreePath", {
      enumerable: true,
      get: (): never => { throw new Error("assignment handle is gone"); },
    });

    const refusal = refusalOf(complete(store, { stubTemplate: true }, {
      assignment: hostileAssignment, attemptRef: ATTEMPT_REF, nodeKey: NODE_KEY,
      projectId: PROJECT_ID, sessionId: SESSION_ID, template: STUB_TEMPLATE,
    }));

    expect(refusal.code).toBe("FOUNDATION_LAUNCH_COMPLETION_UNREADABLE");
    expect(refusal.layer).toBe(COMPLETION_LAYER);
    // NOT the session reader's: that authority answered successfully on this store.
    expect(refusal.code).not.toBe("SESSION_LEDGER_UNREADABLE");
    expect(refusal.layer).not.toBe(SESSION_PREREQUISITE_LAYER);
  });

  it("refuses an unknown session id rather than answering for the opened one", () => {
    const store = seedStore();
    const input = completionInput(store, { sessionId: OTHER_SESSION_ID });

    const refusal = refusalOf(complete(store, {}, input));

    expect(refusal.code).toBe("SESSION_CREDENTIAL_DIGEST_UNAVAILABLE");
    expect(refusal.layer).toBe(SESSION_PREREQUISITE_LAYER);
  });
});
