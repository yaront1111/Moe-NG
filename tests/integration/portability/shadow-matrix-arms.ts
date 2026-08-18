/**
 * The arms behind the shadow matrix. Every row this module emits is built from a
 * value a SHIPPED production surface returned, reached through a bare package
 * root; nothing here decides an outcome for a provider.
 *
 * Two rules the arms exist to keep honest:
 *  - a fixture may supply CALLER data (a probe report, a platform declaration, a
 *    request record) because the production surface validates it, but it may
 *    never assemble the surface's own answer;
 *  - a reason code is always LIFTED from that answer, never written down here,
 *    so making a hostile fixture valid reddens the arm instead of silently
 *    agreeing with it.
 *
 * NOTHING IS LAUNCHED. There is no `node:child_process` import in this suite and
 * no arm reaches a launcher: the Claude side stops at construction, at a request
 * refusal raised before the store is touched, and at the durable reader.
 */
import { createFoundationAttemptService, readFoundationAttemptRecord } from "@moe/daemon";
import {
  CODEX_ACCEPTED_SCHEMA_VERSIONS, CODEX_MIRRORED_SKILL_RENDERER_INPUT_VERSION,
  buildCodexRuntimeObservation, buildProviderRuntimeObservation, probeCodexRuntime,
  recordCodexStream, reconcileCodexRun, renderCodexContext,
} from "@moe/runner";
import type {
  CodexCapabilityProfile, CodexMirroredSkillRendererInput, PlatformIdentity,
} from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";

import {
  CAPABILITY_ROSTERS, HOSTILE_PLATFORM, PLATFORM_CASES, PLATFORM_NEUTRAL,
} from "./shadow-matrix-cases.js";
import type { PlatformCase, ProviderId, RowSubject, Verdict } from "./shadow-matrix-cases.js";

const FIXED_CLOCK = { observedAt: (): string => "2026-08-18T00:00:00.000Z" };
const CLOSURE_SHA = "a".repeat(64);
const OVERLONG = "v".repeat(500);

/** A probe report with a provable observation behind every capability. */
function acceptedCodexReport(): Record<string, unknown> {
  return {
    cancelObservation: { requestedAtSequence: 1, terminatedAtSequence: 2 },
    cwdObservation: { observedCwd: "/work/moe", requestedCwd: "/work/moe" },
    declaredContextLimit: { kind: "EXACT_TOKENS", tokens: 272_000 },
    helpText: "codex --help",
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    processTreeObservation: { childrenAfter: 0, childrenBefore: 2 },
    rawSampleBase64: Buffer.from("raw codex bytes", "utf8").toString("base64"),
    reportedVersion: "codex-cli 1.4.2",
    resolvedRuntimeClosure: [{ kind: "EXECUTABLE", path: "/opt/codex/bin/codex", sha256: CLOSURE_SHA }],
    resumeClaim: "documents --resume",
    runEnumeration: { enumeratedRunIds: ["run-1"], provenAbsentRunId: "run-2" },
    schemaVersion: "codex-stream-json/1",
    structuredSample: { jsonLines: ['{"type":"item.completed"}'] },
    tokenizer: { sampleText: "hello", sampleTokenCount: 1, tokenizerId: "o200k" },
  };
}

type ReportPatch = Record<string, unknown>;
const portFor = (report: ReportPatch): { report: () => never } =>
  ({ report: () => report as never });
const throwingPort = { report: (): never => { throw new Error("probe port is unreachable"); } };

function probe(
  port: { readonly report: () => never }, identity: PlatformIdentity,
): ReturnType<typeof probeCodexRuntime> {
  return probeCodexRuntime({ clock: FIXED_CLOCK, platformIdentity: identity, port });
}

interface RowInput {
  readonly family: RowSubject["family"];
  readonly platform: string;
  readonly provenance: RowSubject["provenance"];
  readonly provider: ProviderId;
  readonly reasonCode?: string;
  readonly reasonVocabulary?: RowSubject["reasonVocabulary"];
  readonly refusedBy?: string;
  readonly subject: string;
  readonly unknownBecause?: RowSubject["unknownBecause"];
  readonly verdict: Verdict;
}

const row = (sourceCommit: string, input: RowInput): RowSubject => Object.freeze({
  family: input.family, platform: input.platform, provenance: input.provenance,
  provider: input.provider, reasonCode: input.reasonCode ?? null,
  reasonVocabulary: input.reasonVocabulary ?? null, refusedBy: input.refusedBy ?? null,
  sourceCommit, subject: input.subject, unknownBecause: input.unknownBecause ?? null,
  verdict: input.verdict,
});

const withheld = (
  commit: string, provider: ProviderId, subject: string,
  unknownBecause: NonNullable<RowSubject["unknownBecause"]>,
  provenance: RowSubject["provenance"] = "ABSENT_CALL_SITE",
): RowSubject => row(commit, {
  family: "SURFACE", platform: PLATFORM_NEUTRAL, provenance, provider, subject,
  unknownBecause, verdict: "UNKNOWN",
});

/** Codex capability rows, one per roster member per platform, lifted from the profile. */
export function codexCapabilityRows(commit: string): readonly RowSubject[] {
  const rows: RowSubject[] = [];
  for (const platform of PLATFORM_CASES) {
    const result = probe(portFor(acceptedCodexReport()), platform.identity);
    if (!result.ok) throw new Error(`accepted codex control refused: ${result.code}`);
    for (const record of (result.profile satisfies CodexCapabilityProfile).capabilities) {
      rows.push(row(commit, {
        family: "CAPABILITY", platform: platform.id, provenance: "PROBE", provider: "codex",
        reasonCode: record.proofMethod, reasonVocabulary: "CODEX_PROOF_METHODS",
        subject: record.capability, verdict: record.status === "SUPPORTED" ? "PASS" : "FAIL",
      }));
    }
  }
  return rows;
}

/**
 * Claude capability rows. `probeClaudeRuntime` is on the withheld list, so no
 * published surface can assess a Claude capability: every row is UNKNOWN rather
 * than assessed by a reimplementation of the internal assessor.
 */
export function claudeCapabilityRows(commit: string): readonly RowSubject[] {
  return PLATFORM_CASES.flatMap((platform) =>
    CAPABILITY_ROSTERS.claude.map((capability) => row(commit, {
      family: "CAPABILITY", platform: platform.id, provenance: "ABSENT_CALL_SITE",
      provider: "claude", subject: capability, unknownBecause: "PROVIDER_ASSESSOR_WITHHELD",
      verdict: "UNKNOWN",
    })));
}

function advisorySnapshot(authority: "NONE" | "OWNER"): CodexMirroredSkillRendererInput {
  return {
    advisoryOnly: true, authority: authority as "NONE",
    rendererInputVersion: CODEX_MIRRORED_SKILL_RENDERER_INPUT_VERSION, skills: [],
  };
}

const renderInput = (
  snapshot: CodexMirroredSkillRendererInput, limit: { kind: "UNKNOWN" } | {
    kind: "CONSERVATIVE_INPUT_BYTES"; bytes: number;
  },
): Parameters<typeof renderCodexContext>[0] => ({
  agentsContractBytes: Buffer.from("AGENTS", "utf8"),
  contextLimit: limit, skillSnapshot: snapshot,
  taskContext: { bodyBytes: Buffer.from("task body", "utf8"), taskRef: "task-shadow" },
  tokenizer: null,
});

function codexRenderRows(commit: string): readonly RowSubject[] {
  const accepted = renderCodexContext(
    renderInput(advisorySnapshot("NONE"), { bytes: 65_536, kind: "CONSERVATIVE_INPUT_BYTES" }));
  if (!accepted.ok) throw new Error(`accepted codex render control refused: ${accepted.code}`);
  const noBound = renderCodexContext(renderInput(advisorySnapshot("NONE"), { kind: "UNKNOWN" }));
  const authorityBearing = renderCodexContext(renderInput(
    advisorySnapshot("OWNER"), { bytes: 65_536, kind: "CONSERVATIVE_INPUT_BYTES" }));
  const failure = (subject: string, result: typeof noBound): RowSubject => row(commit, {
    family: "SURFACE", platform: PLATFORM_NEUTRAL, provenance: "RENDER", provider: "codex",
    reasonCode: result.ok ? "RENDER_ACCEPTED_A_HOSTILE_INPUT" : result.code,
    reasonVocabulary: "CODEX_RENDER_ERROR_CODES", subject, verdict: "FAIL",
  });
  return [
    row(commit, {
      family: "SURFACE", platform: PLATFORM_NEUTRAL, provenance: "RENDER", provider: "codex",
      reasonCode: accepted.rendered.rendererEnvelopeVersion,
      reasonVocabulary: "CODEX_RENDERER_ENVELOPE_VERSION", subject: "render-accepted-control",
      verdict: "PASS",
    }),
    failure("render-context-bound-absent", noBound),
    failure("render-authority-bearing-snapshot", authorityBearing),
  ];
}

function codexReconcileRow(commit: string): RowSubject {
  const stream = recordCodexStream({
    acceptedSchemaVersions: CODEX_ACCEPTED_SCHEMA_VERSIONS,
    effect: { attemptRef: "attempt-shadow", effectIntentId: "intent-shadow", epoch: 1 },
    rawBytes: Buffer.from(
      '{"seq":1,"type":"result","subtype":"success","schemaVersion":"codex-stream-json/1"}\n',
      "utf8"),
  });
  if (!stream.ok) throw new Error(`accepted codex stream control refused: ${stream.code}`);
  const reconciled = reconcileCodexRun({
    cancelRequested: false, processExit: { code: 0, kind: "EXITED" }, stream: stream.record,
  });
  return row(commit, {
    family: "SURFACE", platform: PLATFORM_NEUTRAL, provenance: "RECONCILE", provider: "codex",
    reasonCode: reconciled.outcome, reasonVocabulary: "CODEX_RECONCILED_OUTCOMES",
    subject: "reconcile-accepted-control", verdict: "PASS",
  });
}

/** Codex surface rows: one accepted control per surface, then the hostile arms. */
export function codexSurfaceRows(commit: string): readonly RowSubject[] {
  const rows: RowSubject[] = [];
  for (const platform of PLATFORM_CASES) {
    const accepted = probe(portFor(acceptedCodexReport()), platform.identity);
    if (!accepted.ok) throw new Error(`accepted codex probe refused: ${accepted.code}`);
    rows.push(row(commit, {
      family: "SURFACE", platform: platform.id, provenance: "PROBE", provider: "codex",
      reasonCode: accepted.profile.profileVersion,
      reasonVocabulary: "CODEX_CAPABILITY_PROFILE_VERSION", subject: "probe-accepted-control",
      verdict: "PASS",
    }));
  }
  const hostilePlatform = probe(portFor(acceptedCodexReport()), HOSTILE_PLATFORM);
  const hostileVersion = buildCodexRuntimeObservation({
    adapterCapabilitySchemaDigest: CLOSURE_SHA, clock: FIXED_CLOCK,
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: firstPlatform().identity, reportedVersion: OVERLONG,
    resolvedRuntimeClosure: [{ kind: "EXECUTABLE", path: "/opt/codex/bin/codex", sha256: CLOSURE_SHA }],
  });
  const unverifiable = probe(throwingPort, firstPlatform().identity);
  const missingRuntime = probe(
    portFor({ ...acceptedCodexReport(), pinningMethod: "UNSUPPORTED", resolvedRuntimeClosure: [] }),
    firstPlatform().identity);
  const disagreeing = probe(
    portFor({
      ...acceptedCodexReport(),
      cwdObservation: { observedCwd: "/somewhere/else", requestedCwd: "/work/moe" },
    }), firstPlatform().identity);
  rows.push(
    observationRefusal(commit, "codex", "probe-unsupported-platform", hostilePlatform, "PROBE",
      "CODEX_OBSERVATION_ERROR_CODES"),
    observationRefusal(commit, "codex", "observation-hostile-version", hostileVersion,
      "OBSERVATION", "CODEX_OBSERVATION_ERROR_CODES"),
    proofRow(commit, "probe-unverifiable-observation", unverifiable, "VERSION_REPORT"),
    pinningRow(commit, "probe-missing-runtime", missingRuntime),
    proofRow(commit, "probe-surface-disagreement", disagreeing, "CWD_OBSERVATION"),
    ...codexRenderRows(commit), codexReconcileRow(commit),
    withheld(commit, "codex", "execution-portability", "NO_PRODUCTION_EXECUTION_CALL_SITE"),
    withheld(commit, "codex", "daemon-attempt-construction", "NO_PROVIDER_DAEMON_SERVICE"),
    withheld(commit, "codex", "daemon-attempt-durable-read", "NO_PROVIDER_DAEMON_SERVICE"),
  );
  return rows;
}

function firstPlatform(): PlatformCase {
  const platform = PLATFORM_CASES[0];
  if (platform === undefined) throw new Error("platform axis is empty");
  return platform;
}

type ObservationLike = { readonly ok: true } | { readonly ok: false; readonly code: string };

function observationRefusal(
  commit: string, provider: ProviderId, subject: string, result: ObservationLike,
  provenance: RowSubject["provenance"], vocabulary: RowSubject["reasonVocabulary"],
): RowSubject {
  return row(commit, {
    family: "SURFACE", platform: PLATFORM_NEUTRAL, provenance, provider,
    reasonCode: result.ok ? "OBSERVATION_ACCEPTED_A_HOSTILE_INPUT" : result.code,
    reasonVocabulary: vocabulary, subject, verdict: "FAIL",
  });
}

/** Lifts one capability's proof method out of the profile the probe actually built. */
function proofRow(
  commit: string, subject: string, result: ReturnType<typeof probeCodexRuntime>,
  capability: string,
): RowSubject {
  if (!result.ok) throw new Error(`${subject} refused before assessment: ${result.code}`);
  const record = result.profile.capabilities.find((entry) => entry.capability === capability);
  if (record === undefined) throw new Error(`${capability} is absent from the codex profile`);
  return row(commit, {
    family: "SURFACE", platform: firstPlatform().id, provenance: "PROBE", provider: "codex",
    reasonCode: record.proofMethod, reasonVocabulary: "CODEX_PROOF_METHODS", subject,
    verdict: record.status === "SUPPORTED" ? "PASS" : "FAIL",
  });
}

function pinningRow(
  commit: string, subject: string, result: ReturnType<typeof probeCodexRuntime>,
): RowSubject {
  if (!result.ok) throw new Error(`${subject} refused before observation: ${result.code}`);
  return row(commit, {
    family: "SURFACE", platform: firstPlatform().id, provenance: "PROBE", provider: "codex",
    reasonCode: result.observation.pinningMethod,
    reasonVocabulary: "CODEX_RUNTIME_PINNING_METHODS", subject, verdict: "FAIL",
  });
}

const CAPTURE_PORT = {
  captureResult: (): never => { throw new Error("capture port must never be reached"); },
};

/** Claude observation rows through the published builder, one control per platform. */
function claudeObservationRows(commit: string): readonly RowSubject[] {
  const closure = [{ kind: "EXECUTABLE" as const, path: "/usr/local/bin/claude", sha256: CLOSURE_SHA }];
  const base = {
    adapterCapabilitySchemaDigest: CLOSURE_SHA, clock: FIXED_CLOCK,
    pinningMethod: "CONTENT_ADDRESSED_COPY" as const, reportedVersion: "claude-code 2.1.0",
    resolvedRuntimeClosure: closure,
  };
  const rows: RowSubject[] = [];
  for (const platform of PLATFORM_CASES) {
    const built = buildProviderRuntimeObservation({ ...base, platformIdentity: platform.identity });
    if (!built.ok) throw new Error(`accepted claude observation refused: ${built.code}`);
    rows.push(row(commit, {
      family: "SURFACE", platform: platform.id, provenance: "OBSERVATION", provider: "claude",
      reasonCode: built.observation.observationVersion,
      reasonVocabulary: "CLAUDE_OBSERVATION_VERSION", subject: "observation-accepted-control",
      verdict: "PASS",
    }));
  }
  const hostilePlatform =
    buildProviderRuntimeObservation({ ...base, platformIdentity: HOSTILE_PLATFORM });
  const hostileVersion = buildProviderRuntimeObservation({
    ...base, platformIdentity: firstPlatform().identity, reportedVersion: OVERLONG,
  });
  const missingRuntime = buildProviderRuntimeObservation({
    ...base, platformIdentity: firstPlatform().identity, reportedVersion: null,
    resolvedRuntimeClosure: [],
  });
  if (!missingRuntime.ok) throw new Error(`missing-runtime arm refused: ${missingRuntime.code}`);
  rows.push(
    observationRefusal(commit, "claude", "observation-unsupported-platform", hostilePlatform,
      "OBSERVATION", "CLAUDE_OBSERVATION_ERROR_CODES"),
    observationRefusal(commit, "claude", "observation-hostile-version", hostileVersion,
      "OBSERVATION", "CLAUDE_OBSERVATION_ERROR_CODES"),
    row(commit, {
      family: "SURFACE", platform: firstPlatform().id, provenance: "OBSERVATION",
      provider: "claude", reasonCode: missingRuntime.observation.truthClass,
      reasonVocabulary: "OBSERVATION_TRUTH_CLASSES", subject: "observation-missing-runtime",
      verdict: "FAIL",
    }));
  return rows;
}

type AttemptAnswer = { readonly ok: true } | {
  readonly ok: false; readonly code: string; readonly refusedBy: string;
};

function attemptRefusal(
  commit: string, subject: string, answer: AttemptAnswer, provenance: RowSubject["provenance"],
): RowSubject {
  return row(commit, {
    family: "SURFACE", platform: PLATFORM_NEUTRAL, provenance, provider: "claude",
    reasonCode: answer.ok ? "DAEMON_ACCEPTED_A_HOSTILE_INPUT" : answer.code,
    reasonVocabulary: "FOUNDATION_ATTEMPT_CODES",
    refusedBy: answer.ok ? "NONE" : answer.refusedBy, subject, verdict: "FAIL",
  });
}

/**
 * Claude daemon rows. Construction is evidence of CONSTRUCTION and nothing more;
 * the request refusal is raised by `dispatch` before the store is read and long
 * before any launcher is prepared, which is why it carries its own provenance.
 */
export async function claudeDaemonRows(
  commit: string, store: SqliteEventStore, closedStore: SqliteEventStore,
  afterArm: () => void = () => undefined,
): Promise<readonly RowSubject[]> {
  const service = createFoundationAttemptService({ ...CAPTURE_PORT, store });
  const constructed = typeof service.dispatch === "function";
  afterArm();
  const refused = await service.dispatch({ notA: "foundation request" });
  afterArm();
  const absent = readFoundationAttemptRecord(store, "attempt-that-was-never-dispatched");
  afterArm();
  const malformed = readFoundationAttemptRecord(store, "");
  afterArm();
  const unreadable = readFoundationAttemptRecord(closedStore, "attempt-shadow");
  afterArm();
  return [
    row(commit, {
      family: "SURFACE", platform: PLATFORM_NEUTRAL, provenance: "CONSTRUCTION",
      provider: "claude", reasonCode: constructed ? "DAEMON_FOUNDATION_ATTEMPT" : "NOT_CONSTRUCTED",
      reasonVocabulary: "DAEMON_FOUNDATION_LAYERS", subject: "attempt-service-construction",
      verdict: constructed ? "PASS" : "FAIL",
    }),
    attemptRefusal(commit, "dispatch-request-malformed", refused, "REQUEST_REFUSAL"),
    attemptRefusal(commit, "durable-read-record-absent", absent, "DURABLE_READ"),
    attemptRefusal(commit, "durable-read-identity-malformed", malformed, "DURABLE_READ"),
    attemptRefusal(commit, "durable-read-store-unreadable", unreadable, "DURABLE_READ"),
    withheld(commit, "claude", "durable-read-accepted-control", "NO_PUBLISHED_RECORD_CODEC",
      "DURABLE_READ"),
  ];
}

export function claudeSurfaceRows(commit: string): readonly RowSubject[] {
  return [
    ...claudeObservationRows(commit),
    withheld(commit, "claude", "capability-probe", "PROVIDER_ASSESSOR_WITHHELD"),
    withheld(commit, "claude", "context-render", "PROVIDER_RENDERER_WITHHELD"),
    withheld(commit, "claude", "run-reconciliation", "PROVIDER_STREAM_RECORDER_WITHHELD"),
    withheld(commit, "claude", "execution-portability", "DISPATCH_WRITES_AUTHORITY",
      "NOT_EXERCISED"),
  ];
}

export async function buildShadowMatrix(
  commit: string, store: SqliteEventStore, closedStore: SqliteEventStore,
  afterArm: () => void = () => undefined,
): Promise<readonly RowSubject[]> {
  const rows = [
    ...codexCapabilityRows(commit), ...claudeCapabilityRows(commit),
    ...codexSurfaceRows(commit), ...claudeSurfaceRows(commit),
  ];
  afterArm();
  return [...rows, ...(await claudeDaemonRows(commit, store, closedStore, afterArm))];
}
