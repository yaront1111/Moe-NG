/**
 * The server-owned launch-template fields, graded against durable records and the real gate.
 *
 * Capabilities are never hand-built here: every case seeds a real file-backed store through the
 * PRODUCTION writers (`project.register`, `provider.probe`, `selectProjectConfiguration`,
 * `project.activate`) and then reads them back through `resolveCurrentProviderProfile`. A
 * capabilities literal shaped by this file would prove only that the producer can copy a fixture
 * — the claim under test is that these fields come from records the system actually wrote.
 *
 * Refusal assertions pin the layer as the LITERAL "LAUNCH_TEMPLATE_PRODUCER" rather than an
 * imported constant: a test that imports the constant it asserts still passes after that
 * constant is renamed out from under every consumer.
 */

import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_CONFIGURATION_LIMIT_KEYS } from "@moe/contracts";
import type { ProjectConfigurationLimitKey } from "@moe/contracts";
// The BARE specifier, deliberately: the rendered value this suite passes must be the one the
// package's own renderer produced, and a relative import into packages/ would prove nothing
// about what `@moe/context` resolves to from inside apps/daemon.
import {
  CONTEXT_MANIFEST_VERSION,
  DEFAULT_CONTEXT_BYTE_BUDGET,
  renderContext,
  selectContext,
} from "@moe/context";
import type { RenderedContext } from "@moe/context";
import {
  createProjectConfigurationManifest,
  encodeProjectConfigurationManifest,
} from "@moe/core";
import { CLAUDE_LAUNCH_RESUME_FLAGS, launchClaude } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";

import {
  OBSERVATION,
  POLICY_REF,
  POLICY_SLICE,
  PROJECT_ID,
  activatePayload,
  closeStores,
  decisionCount,
  envelope,
  evaluationInput,
  hex64,
  openStore,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { selectProjectConfiguration } from "../configuration/project-configuration-selection.js";
import { resolveCurrentProviderProfile } from "../provider-profile/provider-profile-resolver.js";
import { produceLaunchTemplateFields } from "./launch-template-producer.js";

const PRODUCER_LAYER = "LAUNCH_TEMPLATE_PRODUCER";
const PROFILE_REF = "profile-ref-1";
const MINIMUM_REF = "provider-profile-1";
const RUNTIME_FACTS = Object.freeze({
  adapterCapabilitySchemaDigest: hex64("ca9ab111"),
  platformIdentity: "win32-x64",
  reportedVersion: "2.0.30",
});
const MISSION = Object.freeze({
  instructions: "land the producer",
  test: "pnpm --filter @moe/daemon test",
  title: "launch template",
  workspace: "D:\\projexts\\moe-next",
});

/**
 * A rendered context the REAL renderer produced, never a literal.
 *
 * `renderContext` is the only thing that can mint one: it derives `binding.exactBytes` from the
 * same wire encoding it returns as `bytes`, and seals the pair under `digestContextManifest`. A
 * fixture shaped by this file would satisfy every structural check and prove nothing, which is
 * exactly what DoD-3 forbids — so the selection goes through the production `selectContext` and
 * the render through the production `renderContext`, and this suite only ever reads the result.
 *
 * `note` varies the mandatory item's content so two calls give genuinely different bytes; the
 * byte-substitution arm needs a second rendered value that is real rather than hand-edited.
 */
function rendered(note = "the attempt brief"): RenderedContext {
  const selected = selectContext({
    byteBudget: DEFAULT_CONTEXT_BYTE_BUDGET,
    exclusions: [{ itemId: "journal-9", reason: "beyond the journal entry limit" }],
    mandatory: [{ content: note, id: "mission-1", kind: "MANDATORY", section: "mission" }],
    optional: [
      { content: "a prior dead end", id: "journal-1", kind: "OPTIONAL", priority: 2,
        section: "journal" },
    ],
  });
  if (selected.kind !== "ADMITTED") {
    throw new Error(`fixture selection refused: ${selected.code}`);
  }
  return renderContext(selected.selection);
}

const RENDERED = rendered();

/** A structural copy the tests may edit; the renderer's own answer is deep-frozen. */
function thawed(value: RenderedContext): Record<string, unknown> {
  return {
    bytes: [...value.bytes],
    manifest: {
      binding: { ...value.manifest.binding, exactBytes: [...value.manifest.binding.exactBytes] },
      digest: value.manifest.digest,
      version: value.manifest.version,
    },
  };
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

/** Positional table: the value a key carries is its index, so every entry is distinguishable. */
function limitValue(key: ProjectConfigurationLimitKey): number {
  return PROJECT_CONFIGURATION_LIMIT_KEYS.indexOf(key) + 1;
}

type Overrides = Readonly<Record<string, unknown>>;

/** A profile BOUND to the configuration below; the four limits bind their named entries. */
function profileBody(overrides: Overrides = {}, limits: Overrides = {}): Record<string, unknown> {
  return {
    capabilitySchemaDigest: hex64("ca9ab111"),
    concurrencyCeiling: limitValue("activeProviderSessions"),
    limits: {
      stderrBytes: limitValue("capturedOutputBytes"),
      stdoutBytes: limitValue("capturedOutputBytes"),
      tailBytes: limitValue("uiTailBytes"),
      timeoutMs: limitValue("runnerAuthorizedMsPerAttempt"),
      ...limits,
    },
    modelSnapshotEvidence: "claude-cli-2.0.30-2026-05-01",
    modelSnapshotKind: "DATED_SNAPSHOT",
    profileRevisionId: PROFILE_REF,
    provider: "claude",
    providerMinimumProfileRef: MINIMUM_REF,
    reasoningEffort: "high",
    selectedModelId: "claude-opus-5",
    selection: SELECTION,
    ...overrides,
  };
}

function settingsBody(
  limits: Partial<Record<string, number>> = {}, profileRef?: string,
): Record<string, unknown> {
  return {
    isolation: { hostContainment: "NOT_CLAIMED", workspace: "PER_ATTEMPT_WORKTREE" },
    limits: PROJECT_CONFIGURATION_LIMIT_KEYS.map((key) => ({
      key,
      value: limits[key] ?? limitValue(key),
    })),
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
    selection: profileRef === undefined ? SELECTION : { ...SELECTION, profileRef },
  };
}

interface SeedOptions {
  readonly limits?: Overrides;
  readonly profile?: Overrides;
  readonly settingsLimits?: Partial<Record<string, number>>;
  readonly settingsProfileRef?: string;
  readonly skipProbe?: boolean;
  readonly truthClass?: string;
  readonly wrongDigest?: boolean;
}

/** Drives the production writers. A refused setup throws rather than leaving an empty store. */
function capabilities(options: SeedOptions = {}): unknown {
  const store: SqliteEventStore = openStore();
  const observation = {
    profile: profileBody(options.profile, options.limits),
    providerMinimumProfileRef: MINIMUM_REF,
    truthClass: options.truthClass ?? "DAEMON_VERIFIED",
  };
  const steps = options.skipProbe
    ? [envelope("project.register", 0, { owner: "owner-1" })]
    : [
        envelope("project.register", 0, { owner: "owner-1" }),
        envelope("project.bind_repository", 1, { observation: OBSERVATION }),
        envelope("provider.probe", 0, { observation }),
        envelope("policy.install", 0, { slice: POLICY_SLICE }),
        envelope("policy.validate", 1, { input: evaluationInput(POLICY_REF) }),
        envelope("project.activate", 2, activatePayload()),
      ];
  for (const step of steps) {
    const outcome = send(store, step);
    if (!outcome.ok) throw new Error(`seed failed at ${step.kind}: ${outcome.code}`);
  }
  const settings = settingsBody(options.settingsLimits, options.settingsProfileRef);
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
  return resolveCurrentProviderProfile(store, {
    projectId: PROJECT_ID,
    expectedConfigurationDigest: options.wrongDigest === true
      ? hex64("d15a9ree")
      : created.manifest.settingsDigest,
  });
}

function produced(options: SeedOptions = {}): Record<string, unknown> {
  const result = produceLaunchTemplateFields({
    capabilities: capabilities(options),
    mission: MISSION,
    renderedContext: RENDERED,
    runtimeObservation: RUNTIME_FACTS,
  });
  return result as unknown as Record<string, unknown>;
}

function expectRefusal(value: Record<string, unknown>, code: string): Record<string, unknown> {
  expect(value.ok).toBe(false);
  expect(value.code).toBe(code);
  expect(value.layer).toBe(PRODUCER_LAYER);
  expect(Object.isFrozen(value)).toBe(true);
  return value;
}

/** Every port refuses by returning nothing decodable, so the launch dies AFTER the gate. */
function launcherPorts(): Record<string, () => unknown> {
  const dead = (): unknown => null;
  return {
    acquireLock: dead, consumeGrant: dead, delay: dead, now: dead, observeProcess: dead,
    openBoundary: dead, prepareRuntime: dead, registerLock: dead, resolveDuplicate: dead,
    validateCommit: dead,
  };
}

async function launchWith(fields: Record<string, unknown>, argv: readonly string[]): Promise<
  Record<string, unknown>
> {
  const renderedContext = fields.renderedContext as RenderedContext;
  const result = await launchClaude({
    argv,
    attempt: { aggregateId: "attempt-1" },
    bootstrapCredentialDigest: hex64("b007"),
    claim: { lockIdentity: "lock-1" },
    contextManifestDigest: renderedContext.manifest.digest,
    cwd: MISSION.workspace,
    duplicateDelivery: null,
    effect: { intent: "launch" },
    environment: fields.environment,
    grant: { grantId: "grant-1" },
    launchSelection: fields.launchSelection,
    limits: fields.limits,
    priorRegistration: null,
    reconciliation: null,
    renderedContext: new TextDecoder("utf-8", { fatal: true })
      .decode(Uint8Array.from(renderedContext.bytes)),
    runtime: {
      clock: {}, facts: {}, fs: {},
      installedRoot: MISSION.workspace, pinRoot: MISSION.workspace, quotedObservation: {},
    },
    wrapperIdentity: "wrapper-1",
  }, { deps: launcherPorts() as never, platform: "win32" });
  return result as unknown as Record<string, unknown>;
}

afterEach(() => {
  closeStores();
});

describe("produceLaunchTemplateFields — accepted control", () => {
  it("fills all ten selection fields from the durable capability read", () => {
    const read = capabilities() as Record<string, unknown>;
    expect(read.ok).toBe(true);
    const fields = produced();
    expect(fields.ok).toBe(true);
    expect(fields.launchSelection).toEqual({
      concurrencyCeiling: read.concurrencyCeiling,
      configurationDigest: read.configurationDigest,
      modelSnapshotEvidence: read.modelSnapshotEvidence,
      modelSnapshotKind: read.modelSnapshotKind,
      orchestrationDigest: read.orchestrationDigest,
      policyDigest: read.policyDigest,
      profileRevisionId: read.profileRevisionId,
      provider: "claude",
      reasoningEffort: read.reasoningEffort,
      selectedModelId: read.selectedModelId,
    });
  });

  it("names the selected model and effort in argv and carries the durable limits", () => {
    const fields = produced();
    const argv = fields.argv as readonly string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-5");
    expect(argv[argv.indexOf("--effort") + 1]).toBe("high");
    expect(fields.limits).toEqual({
      stderrBytes: limitValue("capturedOutputBytes"),
      stdoutBytes: limitValue("capturedOutputBytes"),
      tailBytes: limitValue("uiTailBytes"),
      timeoutMs: limitValue("runnerAuthorizedMsPerAttempt"),
    });
  });

  it("agrees with itself across argv and the child environment", () => {
    const fields = produced();
    const argv = fields.argv as readonly string[];
    const environment = fields.environment as Record<string, string>;
    expect(environment.ANTHROPIC_MODEL).toBe(argv[argv.indexOf("--model") + 1]);
    expect(environment.CLAUDE_CODE_EFFORT_LEVEL).toBe(argv[argv.indexOf("--effort") + 1]);
  });
});

describe("produceLaunchTemplateFields — the caller cannot reach a produced field", () => {
  for (const field of ["argv", "launchSelection", "limits"] as const) {
    it(`refuses a caller-proposed ${field} instead of preferring it`, () => {
      const contradiction: Record<string, unknown> = {
        argv: ["--model", "claude-sonnet-5", "--effort", "low"],
        launchSelection: { provider: "claude", selectedModelId: "claude-sonnet-5" },
        limits: { stderrBytes: 1, stdoutBytes: 1, tailBytes: 1, timeoutMs: 900_000 },
      };
      const refusal = produceLaunchTemplateFields({
        capabilities: capabilities(),
        mission: MISSION,
        renderedContext: RENDERED,
        runtimeObservation: RUNTIME_FACTS,
        [field]: contradiction[field],
      } as never) as unknown as Record<string, unknown>;
      expectRefusal(refusal, "LAUNCH_TEMPLATE_INPUT_INEXACT");
      expect(refusal.detail).toContain(field);
    });
  }

  it("lands the server model and effort, never the contradicting caller pair", () => {
    const fields = produced();
    const argv = fields.argv as readonly string[];
    const selection = fields.launchSelection as Record<string, unknown>;
    expect(argv).not.toContain("claude-sonnet-5");
    expect(argv).not.toContain("low");
    expect(selection.selectedModelId).toBe("claude-opus-5");
    expect(selection.reasoningEffort).toBe("high");
  });
});

describe("produceLaunchTemplateFields — the launcher's own gate", () => {
  it("passes the production selection gate and dies later, at the runtime port", async () => {
    const fields = produced();
    const result = await launchWith(fields, fields.argv as readonly string[]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("CLAUDE_LAUNCH_RUNTIME_THROWN");
  });

  it("is refused by that same gate once argv names a different model", async () => {
    const fields = produced();
    const argv = (fields.argv as readonly string[]).map(
      (item) => (item === "claude-opus-5" ? "claude-sonnet-5" : item),
    );
    const result = await launchWith(fields, argv);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("CLAUDE_LAUNCH_MODEL_MISMATCH");
    expect(result.layer).toBe("TELEMETRY_CONFIGURATION");
  });

  it("emits no resume flag, so the launch cannot inherit a prior transcript's model", () => {
    const argv = produced().argv as readonly string[];
    for (const flag of CLAUDE_LAUNCH_RESUME_FLAGS) expect(argv).not.toContain(flag);
  });

  it("refuses a durable model id carrying whitespace, which win32 would shred", () => {
    expectRefusal(produced({ profile: { selectedModelId: "claude opus 5" } }),
      "LAUNCH_TEMPLATE_ARGV_UNSAFE");
  });

  it("refuses when a durable model id would itself spell a resume flag", () => {
    const refusal = produced({ profile: { selectedModelId: "--continue" } });
    expectRefusal(refusal, "LAUNCH_TEMPLATE_ARGV_RESUMES");
  });
});

describe("produceLaunchTemplateFields — fails closed", () => {
  it("carries the reader's refusal instead of defaulting a capability", () => {
    const refusal = produced({ skipProbe: true });
    expectRefusal(refusal, "LAUNCH_TEMPLATE_CAPABILITY_UNKNOWN");
    expect(refusal.upstream).toEqual({
      code: "PROVIDER_PROFILE_ABSENT",
      layer: "PROVIDER_PROFILE_READER",
    });
  });

  it("refuses an UNKNOWN reasoning effort rather than spelling it into argv", () => {
    expectRefusal(produced({ profile: { reasoningEffort: "UNKNOWN" } }),
      "LAUNCH_TEMPLATE_SELECTION_UNPROVEN");
  });

  it("refuses UNKNOWN model snapshot evidence rather than promoting it to a known model", () => {
    expectRefusal(produced({ profile: { modelSnapshotKind: "UNKNOWN" } }),
      "LAUNCH_TEMPLATE_SELECTION_UNPROVEN");
  });

  it("refuses a durable limit above the launcher's own ceiling", () => {
    const refusal = produced({
      limits: { timeoutMs: 900_000 },
      settingsLimits: { runnerAuthorizedMsPerAttempt: 900_000 },
    });
    expectRefusal(refusal, "LAUNCH_TEMPLATE_LIMITS_INADMISSIBLE");
    expect(refusal.upstream).toEqual({
      code: "CLAUDE_LAUNCH_LIMIT_EXCEEDED",
      layer: "LAUNCH_LIMITS",
    });
  });

  it("refuses a mission that is not the exact node brief", () => {
    const refusal = produceLaunchTemplateFields({
      capabilities: capabilities(),
      mission: { instructions: "x", title: "t", workspace: "w" },
      renderedContext: RENDERED,
      runtimeObservation: RUNTIME_FACTS,
    }) as unknown as Record<string, unknown>;
    expectRefusal(refusal, "LAUNCH_TEMPLATE_MISSION_INVALID");
  });

  it("refuses when the runtime was never observed", () => {
    const refusal = produceLaunchTemplateFields({
      capabilities: capabilities(),
      mission: MISSION,
      renderedContext: RENDERED,
      runtimeObservation: { platformIdentity: "win32-x64", reportedVersion: "2.0.30" },
    }) as unknown as Record<string, unknown>;
    expectRefusal(refusal, "LAUNCH_TEMPLATE_RUNTIME_UNOBSERVED");
  });

  it("refuses an observed runtime answering to another capability schema", () => {
    const refusal = produceLaunchTemplateFields({
      capabilities: capabilities(),
      mission: MISSION,
      renderedContext: RENDERED,
      runtimeObservation: { ...RUNTIME_FACTS, adapterCapabilitySchemaDigest: hex64("d1ff") },
    }) as unknown as Record<string, unknown>;
    expectRefusal(refusal, "LAUNCH_TEMPLATE_RUNTIME_UNBOUND");
  });
});

describe("produceLaunchTemplateFields — byte stability", () => {
  it("produces the same bytes twice from the same durable identity", () => {
    const read = capabilities();
    const first = produceLaunchTemplateFields({
      capabilities: read, mission: MISSION, renderedContext: RENDERED,
    runtimeObservation: RUNTIME_FACTS,
    });
    const second = produceLaunchTemplateFields({
      capabilities: read, mission: MISSION, renderedContext: RENDERED,
    runtimeObservation: RUNTIME_FACTS,
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("orders argv positionally, not by any record's key iteration", () => {
    const argv = produced().argv as readonly string[];
    expect(argv.indexOf("--model")).toBeLessThan(argv.indexOf("--effort"));
    expect(argv.filter((item) => item === "--model")).toHaveLength(1);
  });
});

/**
 * A capabilities record the DURABLE writers would never produce, planted on top of a REAL read.
 *
 * Only the named field is invented; everything else is the resolver's own answer, so a case here
 * cannot pass on a shape no reader ever returns. The arms below need it because the durable path
 * refuses these values EARLIER — `admittedLimits` takes only positive safe integers and profile
 * text is bounded — so without planting, the producer's own guards would be unreachable code
 * rather than tested code.
 */
function tampered(overrides: Record<string, unknown>): Record<string, unknown> {
  const read = capabilities() as Record<string, unknown>;
  expect(read.ok).toBe(true);
  return { ...read, ...overrides };
}

function producedFrom(read: unknown): Record<string, unknown> {
  return produceLaunchTemplateFields({
    capabilities: read, mission: MISSION, renderedContext: RENDERED,
    runtimeObservation: RUNTIME_FACTS,
  }) as unknown as Record<string, unknown>;
}

const CEILINGS = Object.freeze({
  stderrBytes: 1_048_576, stdoutBytes: 1_048_576, tailBytes: 65_536, timeoutMs: 600_000,
});

describe("produceLaunchTemplateFields — the capability side, through the real resolver", () => {
  const arms: readonly (readonly [string, SeedOptions, string])[] = [
    ["an unprobed project", { skipProbe: true }, "PROVIDER_PROFILE_ABSENT"],
    ["an agent-reported probe", { truthClass: "AGENT_REPORTED" },
      "PROVIDER_PROFILE_TRUTH_UNVERIFIED"],
    ["a configuration digest naming another revision", { wrongDigest: true },
      "PROVIDER_PROFILE_UNREADABLE"],
    ["a configuration selecting another profile", { settingsProfileRef: "profile-ref-2" },
      "PROVIDER_PROFILE_BINDING_MISMATCH"],
  ];

  it("has capability arms to run", () => {
    expect(arms.length).toBeGreaterThan(0);
  });

  for (const [name, options, upstreamCode] of arms) {
    it(`carries the reader's refusal for ${name} instead of defaulting`, () => {
      const refusal = produced(options);
      expectRefusal(refusal, "LAUNCH_TEMPLATE_CAPABILITY_UNKNOWN");
      expect(refusal.upstream).toEqual({ code: upstreamCode, layer: "PROVIDER_PROFILE_READER" });
      expect(refusal).not.toHaveProperty("launchSelection");
      expect(refusal).not.toHaveProperty("limits");
    });
  }

  it("refuses a capability record whose authority, evidence or currentness was downgraded", () => {
    expectRefusal(producedFrom(tampered({ authority: "AGENT_REPORTED" })),
      "LAUNCH_TEMPLATE_CAPABILITY_UNKNOWN");
    expectRefusal(producedFrom(tampered({ evidence: "OBSERVED" })),
      "LAUNCH_TEMPLATE_CAPABILITY_UNKNOWN");
    expectRefusal(producedFrom(tampered({ outcome: "STALE" })),
      "LAUNCH_TEMPLATE_CAPABILITY_UNKNOWN");
  });

  it("refuses a capability answer that is not a reader record at all", () => {
    for (const value of [null, undefined, "capabilities", 7, []]) {
      expectRefusal(producedFrom(value), "LAUNCH_TEMPLATE_CAPABILITY_UNKNOWN");
    }
  });
});

describe("produceLaunchTemplateFields — the limits side, at every ceiling", () => {
  it("accepts durable limits sitting exactly on all four launcher ceilings", () => {
    const fields = produced({
      limits: {
        stderrBytes: CEILINGS.stderrBytes, stdoutBytes: CEILINGS.stdoutBytes,
        tailBytes: CEILINGS.tailBytes, timeoutMs: CEILINGS.timeoutMs,
      },
      settingsLimits: {
        capturedOutputBytes: CEILINGS.stdoutBytes,
        runnerAuthorizedMsPerAttempt: CEILINGS.timeoutMs,
        uiTailBytes: CEILINGS.tailBytes,
      },
    });
    expect(fields.ok).toBe(true);
    expect(fields.limits).toEqual(CEILINGS);
  });

  /**
   * `stdoutBytes` and `stderrBytes` bind the SAME configuration entry, so one entry over the
   * ceiling puts both over it and the validator names the first in ITS declaration order.
   */
  const overCeiling: readonly (readonly [string, Overrides, Record<string, number>, string])[] = [
    ["captured output", { stderrBytes: 1_048_577, stdoutBytes: 1_048_577 },
      { capturedOutputBytes: 1_048_577 }, "stdoutBytes"],
    ["ui tail", { tailBytes: 65_537 }, { uiTailBytes: 65_537 }, "tailBytes"],
    ["authorized runtime", { timeoutMs: 600_001 },
      { runnerAuthorizedMsPerAttempt: 600_001 }, "timeoutMs"],
  ];

  it("has boundary arms to run", () => {
    expect(overCeiling.length).toBeGreaterThan(0);
  });

  for (const [name, limits, settingsLimits, field] of overCeiling) {
    it(`refuses ${name} one over its ceiling, naming ${field}`, () => {
      const refusal = produced({ limits, settingsLimits });
      expectRefusal(refusal, "LAUNCH_TEMPLATE_LIMITS_INADMISSIBLE");
      expect(refusal.detail).toContain(field);
      expect(refusal.upstream).toEqual({
        code: "CLAUDE_LAUNCH_LIMIT_EXCEEDED", layer: "LAUNCH_LIMITS",
      });
    });
  }

  const unusable: readonly (readonly [string, unknown])[] = [
    ["zero", 0], ["negative", -1], ["fractional", 1.5], ["NaN", Number.NaN], ["textual", "600000"],
  ];

  it("has unusable-value arms to run", () => {
    expect(unusable.length).toBeGreaterThan(0);
  });

  for (const [name, value] of unusable) {
    it(`refuses a ${name} timeout through the public validator, never a local ceiling`, () => {
      const read = tampered({});
      const limits = { ...(read.limits as Record<string, unknown>), timeoutMs: value };
      const refusal = producedFrom({ ...read, limits });
      expectRefusal(refusal, "LAUNCH_TEMPLATE_LIMITS_INADMISSIBLE");
      expect(refusal.detail).toContain("timeoutMs");
      expect(refusal.upstream).toEqual({
        code: "CLAUDE_LAUNCH_LIMIT_INVALID", layer: "LAUNCH_LIMITS",
      });
    });
  }

  it("refuses a limits record with the wrong key set rather than filling a bound", () => {
    const refusal = producedFrom(tampered({ limits: { timeoutMs: 1_000 } }));
    expectRefusal(refusal, "LAUNCH_TEMPLATE_LIMITS_INADMISSIBLE");
    expect(refusal.upstream).toEqual({
      code: "CLAUDE_LAUNCH_LIMITS_MALFORMED", layer: "LAUNCH_LIMITS",
    });
  });
});

describe("produceLaunchTemplateFields — the argv side", () => {
  const hostile: readonly (readonly [string, string, string])[] = [
    ["a NUL", "claude-opus\u00005", "LAUNCH_TEMPLATE_SELECTION_UNPROVEN"],
    ["a control character", "claude-opus\u00075", "LAUNCH_TEMPLATE_SELECTION_UNPROVEN"],
    ["a zero-width joiner", "claude-opus\u200d5", "LAUNCH_TEMPLATE_SELECTION_UNPROVEN"],
    ["an over-long element", `claude-${"o".repeat(2_000)}`, "LAUNCH_TEMPLATE_SELECTION_UNPROVEN"],
    ["an empty model id", "", "LAUNCH_TEMPLATE_SELECTION_UNPROVEN"],
    // A tab is a CONTROL character, so the selection guard answers before the argv guard does.
    ["a tab", "claude\topus-5", "LAUNCH_TEMPLATE_SELECTION_UNPROVEN"],
    ["a space", "claude opus 5", "LAUNCH_TEMPLATE_ARGV_UNSAFE"],
    ["a resume flag", "--resume", "LAUNCH_TEMPLATE_ARGV_RESUMES"],
  ];

  it("has hostile model ids to run", () => {
    expect(hostile.length).toBeGreaterThan(0);
  });

  for (const [name, selectedModelId, code] of hostile) {
    it(`refuses ${name} in the durable model id, and refuses rather than throwing`, () => {
      let refusal: Record<string, unknown> = { ok: true };
      expect(() => {
        refusal = producedFrom(tampered({ selectedModelId }));
      }).not.toThrow();
      expectRefusal(refusal, code);
    });
  }

  it("composes a CLOSED vector, so an over-long argv is not constructible", () => {
    const argv = produced().argv as readonly string[];
    expect(argv.length).toBeLessThanOrEqual(9);
    expect(Object.isFrozen(argv)).toBe(true);
  });

  it("leaves a non-token model id to the launcher, which refuses the whole selection", async () => {
    const fields = producedFrom(tampered({ selectedModelId: "café-model" }));
    expect(fields.ok).toBe(true);
    const result = await launchWith(fields, fields.argv as readonly string[]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("CLAUDE_LAUNCH_SELECTION_MALFORMED");
  });
});

describe("produceLaunchTemplateFields — a refusal writes nothing", () => {
  it("commits no decision on any refusing arm", () => {
    const store = openStore();
    for (const step of [
      envelope("project.register", 0, { owner: "owner-1" }),
      envelope("project.bind_repository", 1, { observation: OBSERVATION }),
    ]) {
      const outcome = send(store, step);
      if (!outcome.ok) throw new Error(`seed failed at ${step.kind}: ${outcome.code}`);
    }
    const before = decisionCount(store);
    for (const arm of [
      producedFrom(tampered({ selectedModelId: "claude opus 5" })),
      producedFrom(tampered({ reasoningEffort: "UNKNOWN" })),
      produced({ skipProbe: true }),
    ]) {
      expect(arm.ok).toBe(false);
    }
    expect(decisionCount(store)).toBe(before);
  });
});

describe("produceLaunchTemplateFields — stability that is not vacuous", () => {
  it("serializes identically across two INDEPENDENT durable seeds of the same identity", () => {
    const first = produced();
    const second = produced();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("changes when the durable identity changes, so the stability above says something", () => {
    const base = JSON.stringify(produced());
    const otherModel = JSON.stringify(produced({ profile: { selectedModelId: "claude-sonnet-5" } }));
    const otherEffort = JSON.stringify(produced({ profile: { reasoningEffort: "max" } }));
    const otherRevision = JSON.stringify(produced({
      profile: { profileRevisionId: "profile-ref-1-b" },
      settingsProfileRef: "profile-ref-1-b",
    }));
    expect(otherModel).not.toBe(base);
    expect(otherEffort).not.toBe(base);
    expect(otherRevision).not.toBe(base);
  });

  /**
   * The capability record is spread into a fresh object in REVERSE key order. If any part of the
   * composition iterated that record, the argv or the serialized selection would move with it.
   */
  it("does not inherit the capability record's key iteration order", () => {
    const read = capabilities() as Record<string, unknown>;
    const reversed: Record<string, unknown> = {};
    for (const key of Object.keys(read).reverse()) reversed[key] = read[key];
    expect(Object.keys(reversed)).not.toEqual(Object.keys(read));
    expect(JSON.stringify(producedFrom(reversed))).toBe(JSON.stringify(producedFrom(read)));
  });

  it("emits argv in one derived positional order, model before effort", () => {
    const argv = produced().argv as readonly string[];
    expect(argv).toEqual([
      "-p", "--allowedTools", argv[2], "--tools", argv[4],
      "--model", "claude-opus-5", "--effort", "high",
    ]);
  });

  it("keeps the environment stable and in agreement with argv across runs", () => {
    const first = produced().environment as Record<string, string>;
    const second = produced().environment as Record<string, string>;
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual({ ANTHROPIC_MODEL: "claude-opus-5", CLAUDE_CODE_EFFORT_LEVEL: "high" });
    const argv = produced().argv as readonly string[];
    expect(first.ANTHROPIC_MODEL).toBe(argv[argv.indexOf("--model") + 1]);
    expect(first.CLAUDE_CODE_EFFORT_LEVEL).toBe(argv[argv.indexOf("--effort") + 1]);
  });

  it("moves the environment with the durable model, never leaving it pinned to a literal", () => {
    const environment = produced({ profile: { selectedModelId: "claude-sonnet-5" } })
      .environment as Record<string, string>;
    expect(environment.ANTHROPIC_MODEL).toBe("claude-sonnet-5");
  });
});

describe("produceLaunchTemplateFields — hostile operands answer, never crash", () => {
  it("refuses a revoked proxy rather than letting Object.keys throw out of the producer", () => {
    const revocable = Proxy.revocable({ ok: true }, {});
    revocable.revoke();
    let result: Record<string, unknown> = { ok: true };
    expect(() => {
      result = producedFrom(revocable.proxy);
    }).not.toThrow();
    expectRefusal(result, "LAUNCH_TEMPLATE_INPUT_HOSTILE");
  });

  it("refuses a capability record whose getter throws on read", () => {
    const read = capabilities() as Record<string, unknown>;
    const trapped = {
      ...read,
      get selectedModelId(): string {
        throw new Error("trap");
      },
    };
    let result: Record<string, unknown> = { ok: true };
    expect(() => {
      result = producedFrom(trapped);
    }).not.toThrow();
    expectRefusal(result, "LAUNCH_TEMPLATE_INPUT_HOSTILE");
  });

  it("refuses an input that is not a record at all", () => {
    for (const value of [null, undefined, "input", 3]) {
      const result = produceLaunchTemplateFields(value as never) as unknown as
        Record<string, unknown>;
      expectRefusal(result, "LAUNCH_TEMPLATE_INPUT_INEXACT");
    }
  });

  it("refuses a mission whose fields are the right names but the wrong type", () => {
    const refusal = produceLaunchTemplateFields({
      capabilities: capabilities(),
      mission: { instructions: "x", test: "t", title: "t", workspace: 7 },
      renderedContext: RENDERED,
      runtimeObservation: RUNTIME_FACTS,
    }) as unknown as Record<string, unknown>;
    expectRefusal(refusal, "LAUNCH_TEMPLATE_MISSION_INVALID");
    expect(refusal.detail).toContain("workspace");
  });

  it("ignores an argv planted ON the capability record instead of copying it", () => {
    const planted = tampered({ argv: ["--model", "claude-sonnet-5"] });
    const fields = producedFrom(planted);
    expect(fields.ok).toBe(true);
    expect(fields.argv).not.toContain("claude-sonnet-5");
    expect(fields.argv).toEqual(produced().argv);
  });
});

/**
 * The typed context-insertion slot (task-ee5a385b).
 *
 * The task id is in every title deliberately: on a shared branch a failing line then attributes
 * itself to this row rather than to whoever else is mid-TDD in this file.
 *
 * The ACCEPTED arm is first and is load-bearing. A suite of refusals alone is answerable by a
 * guard that rejects everything, so without a proof that a REAL rendered context reaches the
 * produced fields, every arm below would still pass against a bare `return refuse(...)`.
 */
describe("produceLaunchTemplateFields - the context slot (task-ee5a385b)", () => {
  function withContext(value: unknown): Record<string, unknown> {
    return produceLaunchTemplateFields({
      capabilities: capabilities(),
      mission: MISSION,
      renderedContext: value,
      runtimeObservation: RUNTIME_FACTS,
    }) as unknown as Record<string, unknown>;
  }

  it("ACCEPTS a context the real renderer produced and carries it through verbatim", () => {
    const fields = withContext(RENDERED);
    expect(fields.ok).toBe(true);
    // Deep-equal against the RENDERER'S OWN OUTPUT OBJECT, never against a literal: a literal
    // here would be this file re-deriving what the package is supposed to be the authority on.
    expect(fields.renderedContext).toEqual(RENDERED);
    expect(Object.isFrozen(fields)).toBe(true);
  });

  it("carries the renderer's exact bytes, not a re-encoding of the same selection", () => {
    const fields = withContext(RENDERED);
    const carried = fields.renderedContext as RenderedContext;
    expect([...carried.bytes]).toEqual([...RENDERED.bytes]);
    expect(carried.manifest.digest).toBe(RENDERED.manifest.digest);
  });

  it("still refuses an unknown extra key rather than widening to tolerate it", () => {
    const refusal = produceLaunchTemplateFields({
      capabilities: capabilities(),
      mission: MISSION,
      renderedContext: RENDERED,
      runtimeObservation: RUNTIME_FACTS,
      contextDigest: RENDERED.manifest.digest,
    } as never) as unknown as Record<string, unknown>;
    expectRefusal(refusal, "LAUNCH_TEMPLATE_INPUT_INEXACT");
    expect(refusal.detail).toContain("contextDigest");
  });

  // The two "absent" shapes refuse with DIFFERENT codes, and that difference IS the assertion:
  // omitting the key never reaches the context admission at all, so an arm that only tested the
  // omitted case would be graded by the exact-keys gate and would stay green with
  // `admitRenderedContext` deleted outright.
  it("refuses an input that OMITS the slot at the exact-keys gate, not at the admission", () => {
    const refusal = produceLaunchTemplateFields({
      capabilities: capabilities(),
      mission: MISSION,
      runtimeObservation: RUNTIME_FACTS,
    } as never) as unknown as Record<string, unknown>;
    expectRefusal(refusal, "LAUNCH_TEMPLATE_INPUT_INEXACT");
    expect(refusal.detail).toContain("renderedContext");
  });

  it("refuses a slot that is present but carries nothing, at the context admission", () => {
    for (const empty of [undefined, null, "", 0]) {
      expectRefusal(withContext(empty), "LAUNCH_TEMPLATE_CONTEXT_INVALID");
    }
  });

  it("refuses a slot that is not the exact {bytes, manifest} record", () => {
    const full = thawed(RENDERED);
    expectRefusal(withContext({ bytes: full.bytes }), "LAUNCH_TEMPLATE_CONTEXT_INVALID");
    expectRefusal(withContext({ manifest: full.manifest }), "LAUNCH_TEMPLATE_CONTEXT_INVALID");
    expectRefusal(
      withContext({ ...full, ordering: RENDERED.manifest.binding.ordering }),
      "LAUNCH_TEMPLATE_CONTEXT_INVALID",
    );
  });

  it("refuses a manifest that is not the exact {version, binding, digest} record", () => {
    const value = thawed(RENDERED);
    const manifest = value.manifest as Record<string, unknown>;
    delete manifest.digest;
    expectRefusal(withContext(value), "LAUNCH_TEMPLATE_CONTEXT_INVALID");
  });

  it("refuses a binding that is not the renderer's exact seven bound fields", () => {
    const value = thawed(RENDERED);
    const manifest = value.manifest as Record<string, unknown>;
    const binding = manifest.binding as Record<string, unknown>;
    delete binding.exclusions;
    expectRefusal(withContext(value), "LAUNCH_TEMPLATE_CONTEXT_INVALID");
  });

  it("refuses a manifest version this daemon does not know", () => {
    const value = thawed(RENDERED);
    const manifest = value.manifest as Record<string, unknown>;
    // Derived FROM the constant so the arm keeps meaning "not the admitted version" after a
    // version bump, instead of pinning a spelling that quietly becomes a second unknown one.
    manifest.version = `${CONTEXT_MANIFEST_VERSION}-unknown`;
    // Not an UNVERIFIED: `digestContextManifest` seals the CONSTANT version, not the manifest's
    // own field, so a bumped version still recomputes to the stored digest. The version gate is
    // the only thing that can answer here, which is why it has to be its own check.
    expect(manifest.digest).toBe(RENDERED.manifest.digest);
    expectRefusal(withContext(value), "LAUNCH_TEMPLATE_CONTEXT_INVALID");
  });

  it("refuses a binding edited under a digest that was not recomputed", () => {
    const value = thawed(RENDERED);
    const manifest = value.manifest as Record<string, unknown>;
    const binding = manifest.binding as Record<string, unknown>;
    binding.journalTextLimit = (binding.journalTextLimit as number) + 1;
    expectRefusal(withContext(value), "LAUNCH_TEMPLATE_CONTEXT_UNVERIFIED");
  });

  it("refuses bytes swapped under an untouched manifest", () => {
    // The anti-forgery pair. `binding` is left ENTIRELY intact, so the digest recompute still
    // matches and only the bytes/exactBytes comparison can answer. The substituted bytes come
    // from a second REAL render, so this is a genuine payload pointing at another selection.
    const value = thawed(RENDERED);
    const other = rendered("a different attempt brief");
    expect([...other.bytes]).not.toEqual([...RENDERED.bytes]);
    value.bytes = [...other.bytes];
    expect((value.manifest as Record<string, unknown>).digest).toBe(RENDERED.manifest.digest);
    expectRefusal(withContext(value), "LAUNCH_TEMPLATE_CONTEXT_UNVERIFIED");
  });

  it("ADMITS an empty render: a selection with nothing in it is still a real render", () => {
    // The decision, made here rather than left to the first caller who renders an empty
    // selection: emptiness is the RENDERER's verdict, not this seam's. If `renderContext`
    // sealed it and the digest recomputes, the producer carries it. Refusing would invent a
    // policy the context package does not have, and would break a launch whose attempt
    // legitimately has no optional context to send.
    const selected = selectContext({
      byteBudget: DEFAULT_CONTEXT_BYTE_BUDGET,
      exclusions: [],
      mandatory: [],
      optional: [],
    });
    if (selected.kind !== "ADMITTED") {
      throw new Error(`fixture selection refused: ${selected.code}`);
    }
    const empty = renderContext(selected.selection);
    expect(empty.manifest.binding.optionalSelection).toEqual([]);
    expect(empty.manifest.binding.exclusions).toEqual([]);

    const fields = withContext(empty);
    expect(fields.ok).toBe(true);
    expect(fields.renderedContext).toEqual(empty);
  });

  it("admits a foreign attempt's context as ITS OWN value, never as this one's", () => {
    // Self-consistent and real, but a different render: the carried value must be the one that
    // was supplied, so the acceptance arm cannot be satisfied by just any rendered context.
    const foreign = rendered("a foreign attempt brief");
    const fields = withContext(foreign);
    expect(fields.ok).toBe(true);
    expect(fields.renderedContext).not.toEqual(RENDERED);
    expect(fields.renderedContext).toEqual(foreign);
  });

  it("does not read context out of mission.instructions, and mission stays the exact brief", () => {
    const smuggled = { ...MISSION, instructions: JSON.stringify(thawed(RENDERED)) };
    const fields = produceLaunchTemplateFields({
      capabilities: capabilities(),
      mission: smuggled,
      renderedContext: RENDERED,
      runtimeObservation: RUNTIME_FACTS,
    }) as unknown as Record<string, unknown>;
    expect(fields.ok).toBe(true);
    // The slot is the ONLY route: the produced value is the slot's, and the smuggled text
    // reaches neither argv nor the environment.
    expect(fields.renderedContext).toEqual(RENDERED);
    expect(JSON.stringify(fields.argv)).not.toContain("exactBytes");
    expect(JSON.stringify(fields.environment)).not.toContain("exactBytes");
  });

  it("refuses a mission carrying context as a FIFTH key rather than admitting it", () => {
    const refusal = produceLaunchTemplateFields({
      capabilities: capabilities(),
      mission: { ...MISSION, renderedContext: RENDERED },
      renderedContext: RENDERED,
      runtimeObservation: RUNTIME_FACTS,
    }) as unknown as Record<string, unknown>;
    expectRefusal(refusal, "LAUNCH_TEMPLATE_MISSION_INVALID");
  });

  it("answers a hostile slot at the TOTAL boundary, not at the exact-keys gate", () => {
    // The code is pinned, not merely `ok: false`. The outer input here is exactly the four
    // named keys, so the exact-keys gate has nothing to say and the throwing getter must be
    // what answers; asserting only "refused" would let this arm be graded by INPUT_INEXACT
    // and stay green with the slot never read at all.
    const hostile = {
      get bytes(): never { throw new Error("hostile read"); },
      manifest: RENDERED.manifest,
    };
    let result: Record<string, unknown> = {};
    expect(() => {
      result = withContext(hostile);
    }).not.toThrow();
    expectRefusal(result, "LAUNCH_TEMPLATE_INPUT_HOSTILE");
  });
});

/**
 * The prototype-planted refusal marker (task-ee5a385b, found in adversarial review).
 *
 * `hasExactKeys` reads `Object.keys`, which reports OWN ENUMERABLE keys only, so a record whose
 * `ok` lives on its PROTOTYPE is admitted with the exact key set intact. If the composer then
 * discriminates with `"ok" in value`, which walks the prototype chain, it reads the admitted
 * value as a refusal and RETURNS IT — handing the caller its own object back as the result,
 * `ok: true` and an `argv` of its choosing, with argv composition, limits validation and the
 * durable selection all skipped. That is exactly the caller-proposed field this module exists
 * to refuse, reached without ever failing a check.
 */
describe("produceLaunchTemplateFields - a planted prototype cannot forge a result", () => {
  function plantedOn(base: object): object {
    const forged = Object.create({ argv: ["--pwned"], limits: {}, ok: true });
    return Object.assign(forged, base);
  }

  it("does not return a CONTEXT whose `ok` is inherited, as if it were the produced fields", () => {
    // Everything the admission checks is genuine — the bytes and the digest are the real
    // renderer's — so the value passes every gate and only the discriminator can stop it.
    const forged = plantedOn(thawed(RENDERED));
    expect(Object.keys(forged).sort()).toEqual(["bytes", "manifest"]);
    expect("ok" in forged).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(forged, "ok")).toBe(false);

    const fields = produceLaunchTemplateFields({
      capabilities: capabilities(),
      mission: MISSION,
      renderedContext: forged,
      runtimeObservation: RUNTIME_FACTS,
    }) as unknown as Record<string, unknown>;

    // The produced argv is the SERVER's, never the planted one, and the result is this
    // module's frozen record rather than the caller's object.
    expect(fields.ok).toBe(true);
    expect(fields.argv).not.toContain("--pwned");
    expect(fields.argv).toEqual(produced().argv);
    expect(fields).not.toBe(forged);
    expect(fields.launchSelection).toBeDefined();
    expect(fields.limits).toBeDefined();
  });

  it("does not return a MISSION whose `ok` is inherited, as if it were the produced fields", () => {
    // The same hole one admission earlier: `admitMission` also returns the caller's object.
    const forged = plantedOn({ ...MISSION });
    expect(Object.keys(forged).sort())
      .toEqual(["instructions", "test", "title", "workspace"]);
    expect("ok" in forged).toBe(true);

    const fields = produceLaunchTemplateFields({
      capabilities: capabilities(),
      mission: forged,
      renderedContext: RENDERED,
      runtimeObservation: RUNTIME_FACTS,
    }) as unknown as Record<string, unknown>;

    expect(fields.ok).toBe(true);
    expect(fields.argv).not.toContain("--pwned");
    expect(fields.argv).toEqual(produced().argv);
    expect(fields).not.toBe(forged);
    expect(fields.renderedContext).toEqual(RENDERED);
  });
});

/**
 * PROVIDER-SHAPED ARGV. The template is composed from the DURABLE capability answer, so the
 * provider is read off that same server-derived record — never proposed by a caller, which this
 * module refuses on every path.
 */
describe("shapes argv for the seat's provider", () => {
  /**
   * BYTE FOR BYTE, captured from a real run before this row's edit rather than transcribed.
   * foundation-context-prelaunch.test.ts:274 only checks that CODING_TOOLS is PRESENT, so it
   * would stay green through a reorder or a reshape; this pin would not.
   */
  it("leaves the claude argv exactly as it was", () => {
    expect(produced()["argv"]).toEqual([
      "-p",
      "--allowedTools", "mcp__moe-next,mcp__moe-next__*,Edit,Write,Read,Glob,Grep,Bash",
      "--tools", "Edit,Write,Read,Glob,Grep,Bash",
      "--model", "claude-opus-5",
      "--effort", "high",
    ]);
  });

  const codexFields = (): Record<string, unknown> => produceLaunchTemplateFields({
    capabilities: { ...capabilities() as Record<string, unknown>, provider: "codex" },
    mission: MISSION,
    renderedContext: RENDERED,
    runtimeObservation: RUNTIME_FACTS,
  }) as unknown as Record<string, unknown>;

  /**
   * The codex form of the same three facts. Measured on codex-cli 0.153.4:
   * - `exec` is the non-interactive subcommand, standing where claude's `-p` stands;
   * - `--model` is accepted on `exec`;
   * - effort has no flag, so it travels as `--config model_reasoning_effort=<effort>`, which
   *   `--strict-config` accepts.
   * `--config` is the LONG form on purpose: `-c` is a member of CLAUDE_LAUNCH_RESUME_FLAGS, and
   * this producer refuses any argv carrying one (LAUNCH_TEMPLATE_ARGV_RESUMES).
   */
  it("gives a codex seat the exec form with its config overrides", () => {
    expect(codexFields()["argv"]).toEqual([
      "exec",
      "--model", "claude-opus-5",
      "--config", "model_reasoning_effort=high",
    ]);
  });

  /**
   * NO ROSTER HERE, and the reason is measured rather than an omission. A roster override names
   * a server, and codex rejects a server with no transport:
   *   `codex exec --strict-config --config mcp_servers.moe-next.disabled_tools=[]`
   *   -> `Error loading config.toml: invalid transport in mcp_servers.moe-next`
   * The template holds no MCP origin and no bearer — the spawner does, and it passes the roster
   * together with the `.url` that makes it loadable. A roster emitted here would produce an argv
   * codex refuses to start on.
   */
  it("carries no MCP server override, which needs a transport this template does not hold", () => {
    for (const argument of codexFields()["argv"] as readonly string[]) {
      expect(argument).not.toContain("mcp_servers.");
    }
  });

  it("still refuses an argv that would attach to a prior session", () => {
    // `-c` is a resume flag; the codex branch must reach for `--config` or die on this gate.
    expect((codexFields()["argv"] as readonly string[])).not.toContain("-c");
  });

  it("refuses a provider it does not know rather than launching claude flags", () => {
    const refused = produceLaunchTemplateFields({
      capabilities: { ...capabilities() as Record<string, unknown>, provider: "gemini" },
      mission: MISSION,
      renderedContext: RENDERED,
      runtimeObservation: RUNTIME_FACTS,
    }) as unknown as Record<string, unknown>;
    expectRefusal(refused, "LAUNCH_TEMPLATE_SELECTION_UNPROVEN");
  });
});
