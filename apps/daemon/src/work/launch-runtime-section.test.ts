/**
 * The server-produced runtime section, exercised over a real file-backed durable store.
 *
 * Every observation reaches the store through project.register -> provider.probe. No case
 * plants an event or hand-builds the quoted observation: the production reader is the oracle
 * for the exact evidence bytes this producer must carry.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { DEFAULT_CONTEXT_BYTE_BUDGET, renderContext, selectContext } from "@moe/context";
import {
  CLAUDE_RUNTIME_PIN_LAYER, buildProviderRuntimeObservation, createClaudeRuntimePinRequest,
} from "@moe/runner";
import { afterEach, describe, expect, it } from "vitest";

import {
  PROJECT_ID,
  envelope,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { readSessionCredentialDigest } from "../identity/session-credential-digest.js";
import { credentialSha256Of } from "../identity/session-authenticator.js";
import { SESSION_SCHEMA_VERSION } from "../identity/session-contracts.js";
import { runSessionCommand } from "../identity/session-services.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { readCurrentRuntimeObservation } from
  "../provider-profile/provider-runtime-observation-reader.js";
import {
  READER_LAYER,
  REVISION_ID,
  accepted,
  probeFor,
  runtimeSection,
  sizedRuntimeSection,
  unknownTruthSection,
  validDraft,
} from "../provider-profile/provider-runtime-observation-test-fixtures.js";
import {
  DAEMON_FOUNDATION_ATTEMPT,
  FOUNDATION_ATTEMPT_TEMPLATE_KEYS,
  decodeFoundationAttemptRequest,
} from "./foundation-attempt-contracts.js";
import {
  produceLaunchRuntimeSection,
} from "./launch-runtime-section.js";
import type {
  LaunchRuntimeSection,
  LaunchRuntimeSectionResult,
} from "./launch-runtime-section.js";
import { produceLaunchTemplateFields } from "./launch-template-producer.js";

const PRODUCER_LAYER = "LAUNCH_RUNTIME_SECTION";
const PIN_ROOT = "D:\\moe-data\\runtime-pins";
const SESSION_ID = "session-launch-runtime";
const SESSION_CREDENTIAL = "launch-runtime-session-credential";
const INVALID_PIN_ROOTS = Object.freeze([
  ["drive-unspecified", "\\runtime-pins"],
  ["NUL-bearing", "C:\\runtime-pins\u0000escape"],
] as const);
const INVALID_EXECUTABLE_PATHS = Object.freeze([
  ["drive-unspecified", "\\Claude\\claude.exe"],
  ["NUL-bearing", "C:\\Claude\u0000escape\\claude.exe"],
] as const);

interface World {
  readonly directory: string;
  readonly store: SqliteEventStore;
}

const worlds: World[] = [];

function openWorld(runtime?: Record<string, unknown> | null): World {
  const directory = mkdtempSync(join(tmpdir(), "moe-launch-runtime-"));
  const store = SqliteEventStore.openForProject(join(directory, "store.sqlite"), PROJECT_ID);
  const world = { directory, store };
  worlds.push(world);
  accepted(send(store, envelope("project.register", 0, { owner: "owner-1" })));
  if (runtime !== null) {
    accepted(send(store, runtime === undefined ? probeFor() : probeFor({ runtime })));
  }
  return world;
}

afterEach(() => {
  while (worlds.length > 0) {
    const world = worlds.pop();
    world?.store.close();
    if (world !== undefined) rmSync(world.directory, { force: true, recursive: true });
  }
});

function inputFor(
  store: SqliteEventStore,
  options: {
    readonly pinRoot?: string | undefined;
    readonly profileRevisionId?: string;
  } = {},
): Record<string, unknown> {
  const pinRoot = Object.hasOwn(options, "pinRoot") ? options.pinRoot : PIN_ROOT;
  return {
    pinRoot,
    profileRevisionId: options.profileRevisionId ?? REVISION_ID,
    projectId: PROJECT_ID,
    store,
  };
}

async function produced(input: Record<string, unknown>): Promise<LaunchRuntimeSectionResult> {
  return produceLaunchRuntimeSection(input);
}

function acceptedRuntime(result: LaunchRuntimeSectionResult): LaunchRuntimeSection {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected runtime section, got ${result.code}@${result.layer}`);
  return result.runtime;
}

function expectOwnRefusal(result: LaunchRuntimeSectionResult, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected the runtime producer to refuse");
  expect(result.code).toBe(code);
  expect(result.layer).toBe(PRODUCER_LAYER);
  expect(result.authority).toBe("NONE");
  expect(result.outcome).toBe("UNKNOWN");
  expect(result.upstream).toBeNull();
  expect(Object.hasOwn(result, "runtime")).toBe(false);
  expect(Object.hasOwn(result, "pinRoot")).toBe(false);
}

function durableObservation(store: SqliteEventStore) {
  const read = readCurrentRuntimeObservation(store, PROJECT_ID, REVISION_ID);
  if (!read.ok) throw new Error(`fixture observation refused: ${read.code}@${read.layer}`);
  return read.observation;
}

type ClosureKind = "EXECUTABLE" | "LAUNCHER" | "PACKAGE";

function observedRuntimeSection(
  resolvedRuntimeClosure: readonly {
    readonly kind: ClosureKind; readonly path: string; readonly sha256: string;
  }[],
): Record<string, unknown> {
  const built = buildProviderRuntimeObservation({
    adapterCapabilitySchemaDigest: "a1".repeat(32),
    clock: { observedAt: () => "2026-08-20T00:00:00.000Z" },
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { arch: "x64", os: "win32", osVersion: "10.0.26200" },
    reportedVersion: "2.0.14",
    resolvedRuntimeClosure,
  });
  if (!built.ok) throw new Error(`observation fixture refused: ${built.code}`);
  return JSON.parse(JSON.stringify(built.observation)) as Record<string, unknown>;
}

function mixedRuntimeSection(): Record<string, unknown> {
  return observedRuntimeSection([
      { kind: "EXECUTABLE", path: "C:\\Claude\\bin\\claude.exe", sha256: "b2".repeat(32) },
      { kind: "LAUNCHER", path: "D:\\launchers\\claude.cmd", sha256: "c3".repeat(32) },
  ]);
}

describe("produceLaunchRuntimeSection accepted evidence", () => {
  it("answers exactly installedRoot, pinRoot, and quotedObservation", async () => {
    const { store } = openWorld(runtimeSection());
    const runtime = acceptedRuntime(await produced(inputFor(store)));

    expect(Object.keys(runtime).sort()).toEqual([
      "installedRoot", "pinRoot", "quotedObservation",
    ]);
    expect(Object.keys(runtime)).toHaveLength(3);
  });

  it("quotes the production reader's observation from the same store byte-for-byte", async () => {
    const { store } = openWorld(runtimeSection());
    const read = readCurrentRuntimeObservation(store, PROJECT_ID, REVISION_ID);
    if (!read.ok) throw new Error(`reader control refused: ${read.code}@${read.layer}`);

    const runtime = acceptedRuntime(await produced(inputFor(store)));

    expect(runtime.quotedObservation).toEqual(read.observation);
    expect(JSON.stringify(runtime.quotedObservation)).toBe(JSON.stringify(read.observation));
  });

  it("derives the canonical installed root with the runner's win32.dirname rule", async () => {
    const { store } = openWorld(mixedRuntimeSection());
    const observation = durableObservation(store);
    const executable = observation.resolvedRuntimeClosure.find(
      (entry) => entry.kind === "EXECUTABLE",
    );
    expect(observation.resolvedRuntimeClosure.map((entry) => entry.kind))
      .toEqual(["EXECUTABLE", "LAUNCHER"]);
    expect(executable, "the production fixture must generate one executable").toBeDefined();
    if (executable === undefined) throw new Error("fixture generated no executable");

    const runtime = acceptedRuntime(await produced(inputFor(store)));

    expect(runtime.installedRoot).toBe(win32.dirname(executable.path));
  });

  it("refuses a bare executable whose derived root would be relative dot", async () => {
    const section = observedRuntimeSection([
      { kind: "EXECUTABLE", path: "claude.exe", sha256: "b2".repeat(32) },
    ]);
    const { store } = openWorld(section);

    expectOwnRefusal(
      await produced(inputFor(store)),
      "LAUNCH_RUNTIME_INSTALLED_ROOT_INVALID",
    );
  });

  it("refuses a configured relative pin root rather than resolving it against cwd", async () => {
    const { store } = openWorld(runtimeSection());

    expectOwnRefusal(
      await produced(inputFor(store, { pinRoot: "runtime-pins" })),
      "LAUNCH_RUNTIME_PIN_ROOT_INVALID",
    );
  });

  it("generates both hostile path tables", () => {
    expect(INVALID_PIN_ROOTS).toHaveLength(2);
    expect(INVALID_EXECUTABLE_PATHS).toHaveLength(2);
  });

  it.each(INVALID_PIN_ROOTS)("refuses a %s configured pin root", async (_label, pinRoot) => {
    const { store } = openWorld(runtimeSection());

    expectOwnRefusal(
      await produced(inputFor(store, { pinRoot })),
      "LAUNCH_RUNTIME_PIN_ROOT_INVALID",
    );
  });

  it.each(INVALID_EXECUTABLE_PATHS)(
    "refuses a %s observed executable root", async (_label, executablePath) => {
    const section = observedRuntimeSection([
      { kind: "EXECUTABLE", path: executablePath, sha256: "b2".repeat(32) },
    ]);
    const { store } = openWorld(section);

    expectOwnRefusal(
      await produced(inputFor(store)),
      "LAUNCH_RUNTIME_INSTALLED_ROOT_INVALID",
    );
    });

  it("freezes every quoted closure entry so its root cannot drift after derivation", async () => {
    const { store } = openWorld(runtimeSection());
    const runtime = acceptedRuntime(await produced(inputFor(store)));
    const entry = runtime.quotedObservation.resolvedRuntimeClosure[0];
    if (entry === undefined) throw new Error("fixture generated no closure entry");
    const originalPath = entry.path;

    expect(Object.isFrozen(runtime.quotedObservation)).toBe(true);
    expect(Object.isFrozen(runtime.quotedObservation.resolvedRuntimeClosure)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Reflect.set(entry as object, "path", "D:\\attacker\\claude.exe")).toBe(false);
    expect(entry.path).toBe(originalPath);
    expect(runtime.installedRoot).toBe(win32.dirname(originalPath));
  });
});

describe("produceLaunchRuntimeSection refuses incomplete root evidence", () => {
  it("refuses zero EXECUTABLE entries with its absent-evidence code and layer", async () => {
    const section = unknownTruthSection();
    expect(section.resolvedRuntimeClosure).toEqual([]);
    const { store } = openWorld(section);

    expectOwnRefusal(
      await produced(inputFor(store)),
      "LAUNCH_RUNTIME_INSTALLED_ROOT_ABSENT",
    );
  });

  it("refuses a non-empty closure made only of LAUNCHER evidence as executable-absent", async () => {
    const section = observedRuntimeSection([
      { kind: "LAUNCHER", path: "D:\\launchers\\claude.cmd", sha256: "c3".repeat(32) },
    ]);
    const closure = section.resolvedRuntimeClosure as readonly { readonly kind: string }[];
    expect(closure.map((entry) => entry.kind)).toEqual(["LAUNCHER"]);
    const { store } = openWorld(section);

    expectOwnRefusal(
      await produced(inputFor(store)),
      "LAUNCH_RUNTIME_INSTALLED_ROOT_ABSENT",
    );
  });

  it("refuses multiple EXECUTABLE entries with a distinct ambiguity code", async () => {
    const section = sizedRuntimeSection(2, 64);
    const closure = section.resolvedRuntimeClosure as readonly { readonly kind: string }[];
    expect(closure).toHaveLength(2);
    expect(closure.every((entry) => entry.kind === "EXECUTABLE")).toBe(true);
    const { store } = openWorld(section);

    expectOwnRefusal(
      await produced(inputFor(store)),
      "LAUNCH_RUNTIME_INSTALLED_ROOT_AMBIGUOUS",
    );
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
  ] as const)("refuses an %s configured pin root without echoing it", async (_label, pinRoot) => {
    const { store } = openWorld(runtimeSection());

    expectOwnRefusal(
      await produced(inputFor(store, { pinRoot })),
      "LAUNCH_RUNTIME_PIN_ROOT_UNCONFIGURED",
    );
  });
});

describe("produceLaunchRuntimeSection preserves reader authority", () => {
  it("passes PROVIDER_RUNTIME_OBSERVATION_ABSENT through at the reader layer", async () => {
    const { store } = openWorld(null);
    const result = await produced(inputFor(store));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("an absent observation unexpectedly produced a runtime");
    expect(result.code).toBe("PROVIDER_RUNTIME_OBSERVATION_ABSENT");
    expect(result.layer).toBe(READER_LAYER);
    expect(result.layer).not.toBe(PRODUCER_LAYER);
  });

  it("passes PROVIDER_RUNTIME_OBSERVATION_IDENTITY_MISMATCH through at the reader layer", async () => {
    const { store } = openWorld(runtimeSection());
    const result = await produced(inputFor(store, { profileRevisionId: "profile-revision-9" }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a mismatched identity unexpectedly produced a runtime");
    expect(result.code).toBe("PROVIDER_RUNTIME_OBSERVATION_IDENTITY_MISMATCH");
    expect(result.layer).toBe(READER_LAYER);
    expect(result.layer).not.toBe(PRODUCER_LAYER);
  });

  it("lets the reader answer when a newer probe carries another profile identity", async () => {
    const { store } = openWorld(runtimeSection());
    accepted(send(store, probeFor({
      commandId: "probe-2",
      expectedVersion: 1,
      profile: validDraft("profile-revision-2"),
      runtime: runtimeSection({ closureSha: "d4".repeat(32) }),
    })));

    const result = await produced(inputFor(store));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("the producer overrode the latest reader identity");
    expect(result.code).toBe("PROVIDER_RUNTIME_OBSERVATION_IDENTITY_MISMATCH");
    expect(result.layer).toBe(READER_LAYER);
  });
});

describe("produceLaunchRuntimeSection input fence", () => {
  it("refuses an extra caller-proposed root instead of ignoring it", async () => {
    const { store } = openWorld(runtimeSection());
    const configuredInput = inputFor(store);
    expect(Object.keys(configuredInput).sort()).toEqual([
      "pinRoot", "profileRevisionId", "projectId", "store",
    ]);
    expect(Object.hasOwn(configuredInput, "dispatchRequest")).toBe(false);
    expect(Object.hasOwn(configuredInput, "installedRoot")).toBe(false);

    expectOwnRefusal(
      await produced({ ...configuredInput, installedRoot: "D:\\caller-proposed" }),
      "LAUNCH_RUNTIME_INPUT_INEXACT",
    );
  });

  it("contains a hostile exact-input probe under the stable input code and layer", async () => {
    const { store } = openWorld(runtimeSection());
    const hostile = Proxy.revocable(inputFor(store), {});
    hostile.revoke();

    expectOwnRefusal(
      await produced(hostile.proxy),
      "LAUNCH_RUNTIME_INPUT_INEXACT",
    );
  });

  it("refuses a non-enumerable extra key at the exact input fence", async () => {
    const { store } = openWorld(runtimeSection());
    const input = inputFor(store);
    Object.defineProperty(input, "installedRoot", {
      enumerable: false, value: "D:\\caller-proposed",
    });

    expectOwnRefusal(await produced(input), "LAUNCH_RUNTIME_INPUT_INEXACT");
  });

  it("refuses a symbol extra key at the exact input fence", async () => {
    const { store } = openWorld(runtimeSection());
    const input = inputFor(store);
    Object.defineProperty(input, Symbol("installedRoot"), {
      enumerable: true, value: "D:\\caller-proposed",
    });

    expectOwnRefusal(await produced(input), "LAUNCH_RUNTIME_INPUT_INEXACT");
  });

  it("refuses an accessor-backed required key without executing its getter", async () => {
    const { store } = openWorld(runtimeSection());
    const input = inputFor(store);
    let reads = 0;
    Object.defineProperty(input, "pinRoot", {
      enumerable: true,
      get: () => {
        reads += 1;
        return PIN_ROOT;
      },
    });

    expectOwnRefusal(await produced(input), "LAUNCH_RUNTIME_INPUT_INEXACT");
    expect(reads).toBe(0);
  });
});

/**
 * Forced by task-ee5a385b: `renderedContext` is now a named key on the producer's frozen
 * INPUT_KEYS, so a three-key input refuses LAUNCH_TEMPLATE_INPUT_INEXACT and this file's
 * arithmetic proof could not run at all. Built through the PRODUCTION `selectContext` and
 * `renderContext` rather than as a literal, because the producer recomputes the manifest
 * digest and a hand-built value is refused by design.
 *
 * It does NOT enter the composed launchTemplate below: `composedTemplate` names each of the
 * seven keys individually and never spreads `fields`, so the producer's fifth field stays out
 * of the template and FOUNDATION_ATTEMPT_TEMPLATE_KEYS arithmetic is unchanged.
 */
function renderedContextFixture(): ReturnType<typeof renderContext> {
  const selected = selectContext({
    byteBudget: DEFAULT_CONTEXT_BYTE_BUDGET,
    exclusions: [],
    mandatory: [{ content: "prove the launch template arithmetic", id: "mission-1",
      kind: "MANDATORY", section: "mission" }],
    optional: [],
  });
  if (selected.kind !== "ADMITTED") {
    throw new Error(`fixture selection refused: ${selected.code}`);
  }
  return renderContext(selected.selection);
}

function launchFields(observation: ReturnType<typeof durableObservation>) {
  return produceLaunchTemplateFields({
    renderedContext: renderedContextFixture(),
    capabilities: {
      authority: "DAEMON_VERIFIED",
      capabilitySchemaDigest: observation.adapterCapabilitySchemaDigest,
      concurrencyCeiling: 1,
      configurationDigest: "configuration-digest-1",
      evidence: "DURABLE",
      limits: { stderrBytes: 65_536, stdoutBytes: 131_072, tailBytes: 4_096,
        timeoutMs: 600_000 },
      modelSnapshotEvidence: "claude-cli-2.0.14-2026-05-01",
      modelSnapshotKind: "DATED_SNAPSHOT",
      ok: true,
      orchestrationDigest: "orchestration-digest-1",
      outcome: "CURRENT",
      policyDigest: "policy-digest-1",
      profileRevisionId: REVISION_ID,
      reasoningEffort: "high",
      selectedModelId: "claude-opus-5",
    },
    mission: {
      instructions: "prove the launch template arithmetic",
      test: "pnpm --filter @moe/daemon test",
      title: "launch runtime section",
      workspace: "D:\\projexts\\moe-next",
    },
    runtimeObservation: {
      adapterCapabilitySchemaDigest: observation.adapterCapabilitySchemaDigest,
      platformIdentity: observation.platformIdentity,
      reportedVersion: observation.reportedVersion,
    },
  });
}

function sessionCredential(store: SqliteEventStore): string {
  installTestRecoveryBinding(store);
  const opened = runSessionCommand(store, new TextEncoder().encode(JSON.stringify({
    commandId: "cmd-open-launch-runtime",
    correlationId: "corr-launch-runtime",
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
  expect(opened.ok).toBe(true);
  const read = readSessionCredentialDigest(store, PROJECT_ID, SESSION_ID);
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error(`credential read refused: ${read.code}@${read.refusedBy}`);
  expect(read.credentialSha256).toBe(credentialSha256Of(SESSION_CREDENTIAL));
  return read.credentialSha256;
}

async function composedTemplate(store: SqliteEventStore) {
  const observation = durableObservation(store);
  const runtime = acceptedRuntime(await produced(inputFor(store)));
  const fields = launchFields(observation);
  expect(fields.ok).toBe(true);
  if (!fields.ok) throw new Error(`launch fields refused: ${fields.code}@${fields.layer}`);
  return {
    argv: fields.argv,
    bootstrapCredentialDigest: sessionCredential(store),
    cwd: "D:\\projexts\\moe-next",
    environment: fields.environment,
    launchSelection: fields.launchSelection,
    limits: fields.limits,
    runtime,
  };
}

/**
 * An ADMISSION request, which is now the four admitted keys and nothing else.
 *
 * task-fcdc272d split admission from launch-template completion: the template is no longer
 * caller payload, so it cannot be a parameter here. The arms below pass a composed template
 * through `extra` only to prove admission REFUSES it.
 */
function attemptRequest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activationRequestBytes: new TextEncoder().encode("{\"activate\":true}"),
    binding: { attemptAggregateId: "foundation-attempt-1", nodeKey: "node-1",
      sessionId: SESSION_ID },
    graphSnapshot: {},
    inputManifest: { baseIdentity: "a".repeat(64), entries: [] },
    ...extra,
  };
}

describe("the produced runtime section reaches the launch template, not admission", () => {
  it("composes exactly the seven template keys while admission takes only its four", async () => {
    const { store } = openWorld(runtimeSection());
    const launchTemplate = await composedTemplate(store);
    expect(Object.keys(launchTemplate).sort())
      .toEqual([...FOUNDATION_ATTEMPT_TEMPLATE_KEYS].sort());
    expect(Object.keys(launchTemplate)).toHaveLength(FOUNDATION_ATTEMPT_TEMPLATE_KEYS.length);

    // The admission request is admitted WITHOUT the template, and carries none afterwards.
    const decoded = decodeFoundationAttemptRequest(attemptRequest());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(`admission refused: ${decoded.code}`);
    expect(Object.hasOwn(decoded.request, "launchTemplate")).toBe(false);
  });

  it("refuses admission that re-attaches the composed template, naming code and layer", async () => {
    const { store } = openWorld(runtimeSection());
    const launchTemplate = await composedTemplate(store);

    const decoded = decodeFoundationAttemptRequest(attemptRequest({ launchTemplate }));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("admission accepted a caller-supplied launch template");
    expect(decoded.code).toBe("FOUNDATION_ATTEMPT_REQUEST_MALFORMED");
    expect(decoded.refusedBy).toBe(DAEMON_FOUNDATION_ATTEMPT);
  });

  /**
   * The runtime section's absence is now refused by the RUNTIME pin, not by admission: the
   * service hands `completed.runtime` to `createClaudeRuntimePinRequest` (foundation-attempt-
   * service.ts) after completion, so that is the production surface this arm binds. Asserting
   * the layer as well as the code is what separates it from the admission refusal above — both
   * are refusals, and only the layer says which authority answered.
   */
  it("refuses the composed template without its runtime section at the runtime pin", async () => {
    const { store } = openWorld(runtimeSection());
    const launchTemplate = await composedTemplate(store);
    const { runtime: removed, ...withoutRuntime } = launchTemplate;
    expect(removed).toBeDefined();
    expect(Object.hasOwn(withoutRuntime, "runtime")).toBe(false);

    const pinned = createClaudeRuntimePinRequest(
      (withoutRuntime as Record<string, unknown>)["runtime"],
    );
    expect("ok" in pinned && pinned.ok).toBe(false);
    if (!("ok" in pinned)) throw new Error("the runtime pin admitted a missing runtime section");
    expect(pinned.code).toBe("CLAUDE_RUNTIME_OBSERVATION_INVALID");
    expect(pinned.layer).toBe(CLAUDE_RUNTIME_PIN_LAYER);
  });
});
