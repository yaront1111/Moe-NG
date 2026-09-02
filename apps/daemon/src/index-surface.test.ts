/** Package-root publication contract for the daemon command surface. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, expectTypeOf, it } from "vitest";

import * as daemon from "@moe/daemon";
import { SqliteEventStore } from "@moe/store";
import type { ProjectConfigurationManifest } from "@moe/contracts";
import type { RecoveryCompletionWitness } from "@moe/core";
// Imported through the PUBLIC package roots, so these assertions also prove the
// daemon's published closure is expressible without a deep import.
import type { EffectIntent } from "@moe/runner";
import type {
  BudgetAvailableView,
  LeaseRecord,
  ProviderSlotReservation,
  ReservationRecord,
} from "@moe/scheduler";
import type {
  AuthenticatedPrincipal,
  AuthenticationResult,
  Authenticator,
  AuthVerdict,
  BoundaryCodesAreRuntimeCodes,
  BootstrapCommandKind,
  BootstrapDecodeRefusal,
  BootstrapDecodeResult,
  BootstrapInputRejected,
  BootstrapRefusalCode,
  BootstrapRefusedBy,
  BootstrapRequest,
  BootstrapRequestAccepted,
  BootstrapRequestRefused,
  ClaimLeg,
  ClaimSuccessors,
  CommandAdapterDeps,
  CommandDecisionPort,
  CommandHandler,
  CommandHandlerInput,
  CommandRegistry,
  CommandRegistryEntry,
  ControlRoomListener,
  DaemonCommandPortOptions,
  DaemonCommandPorts,
  DaemonDependencyProvider,
  DaemonEntryRefusalCode,
  BootReconciliationRefused,
  DaemonEntryRefused,
  DaemonStartOptions,
  DaemonStartResult,
  DeltaClassification,
  DeltaNodeClassification,
  DecisionKey,
  DecisionPortResult,
  DoctorAuthorityStale,
  DoctorCommandKind,
  DoctorCommandResult,
  DoctorErrorCode,
  DoctorInputRejected,
  DoctorProposed,
  DoctorReported,
  DoctorRequestInvalid,
  DoctorVersionReport,
  DoctorVersionReportAbsent,
  DoctorVersionsReported,
  DurableDecision,
  DurableAggregate,
  DurableLedger,
  EventAcknowledgeFrame,
  EventAcknowledgeRequest,
  EventAcknowledgedFrame,
  EventGapFrame,
  EventPageFrame,
  EventReadFrame,
  EventReadRequest,
  EventRefusedFrame,
  EventReseatedFrame,
  EventResumeFrame,
  EventResumeRequest,
  EventStreamClock,
  EventStreamObserver,
  EventStreamRefusalCode,
  EventStreamUnknownCode,
  GenesisIncarnationBinding,
  GraphPreviewInputRejected,
  GraphPreviewRequestError,
  GraphPreviewRequestEvaluated,
  GraphPreviewRequestInvalid,
  GraphPreviewRequestResult,
  HandlerContext,
  HandlerTable,
  HttpAccepted,
  HttpBoundaryErrorCode,
  HttpCommandHandler,
  HttpCommandRequest,
  HttpCommandResult,
  HttpPortRefused,
  HttpRefusalStage,
  HttpRefused,
  ListenerRefusalCode,
  ListenerRefused,
  PortRefusal,
  PrerequisiteRefusalCode,
  CurrentProjectConfiguration,
  ProjectConfigurationSelectionCode,
  ProjectConfigurationSelectionUnknown,
  ProjectConfigurationSelectionUpstream,
  ProjectConfigurationStore,
  ReadCurrentProjectConfigurationResult,
  RecoveryIncarnationBinding,
  RecoveryIncarnationCryptoPort,
  RecoveryIncarnationErrorCode,
  RecoveryIncarnationKeyPair,
  RecoveryIncarnationMinted,
  RecoveryIncarnationProof,
  RecoveryIncarnationRefused,
  RecoveryIncarnationRequest,
  RecoveryIncarnationResult,
  RecoveryIncarnationService,
  RecoverySuccessionChain,
  RecoverySuccessionChainResult,
  RecoverySuccessionErrorCode,
  RecoverySuccessionRecord,
  RecoverySuccessionRecorded,
  RecoverySuccessionRefused,
  RecoverySuccessionRequest,
  RecoverySuccessionResult,
  RecoverySuccessionService,
  RestoreIncarnationBinding,
  ReviewAccepted,
  ReviewCommandHandler,
  ReviewCommandKind,
  ReviewDaemonLayer,
  ReviewDaemonRefusalCode,
  ReviewDecodeRefusal,
  ReviewDecodeResult,
  ReviewHandlerContext,
  ReviewHandlerTable,
  ReviewIngressRefusalCode,
  ReviewInputRejected,
  ReviewLedger,
  ReviewOutcome,
  ReviewPrerequisiteRefusalCode,
  ReviewRefused,
  ReviewRefusedBy,
  ReviewRequest,
  ReviewRequestAccepted,
  ReviewRequestRefused,
  ReviewRoundRecord,
  ServiceAccepted,
  ServiceOutcome,
  ServiceRefused,
  ServiceRefusedBy,
  SelectedProjectConfiguration,
  SelectProjectConfigurationResult,
  ShutdownResult,
  StartedDaemon,
  StartListenerOptions,
  StartListenerResult,
  SeamObserver,
  StreamCursor,
  StreamAcknowledgeRequest,
  StreamAcknowledgeResult,
  StreamAcknowledged,
  StreamEvent,
  StreamGap,
  StreamPage,
  StreamPageRequest,
  StreamReadResult,
  StreamRefused,
  StreamReseatRequest,
  StreamSeatResult,
  StreamSeated,
  StreamSnapshot,
  SubscriptionPort,
  WireCursor,
  WireEvent,
  WireEventIdentity,
  WireKnownValue,
  WireObservation,
  WireUnknownValue,
  WireValue,
  WireProtocolVersion,
  WireSnapshot,
  WorkApplied,
  WorkAuthorityLabel,
  WorkCommand,
  WorkContextView,
  WorkErrorCode,
  WorkFailure,
  WorkGranted,
  WorkInputRejected,
  WorkLayer,
  WorkLeg,
  WorkRefused,
  WorkRequestEnvelope,
  WorkRequestParse,
  WorkResult,
  V2Compiler,
  V2CompilerFactoryDependencies,
  V2CompilerResolutionRequest,
  V2CompilerResolutionToken,
  V2CompilerResolutionTokenMintResult,
} from "@moe/daemon";
import type {
  RecoveryCompleteRequest,
  RecoveryCompletionAccepted,
  RecoveryCompletionApprovalSubject,
  RecoveryCompletionCode,
  RecoveryCompletionEvidence,
  RecoveryCompletionEvidenceFound,
  RecoveryCompletionEvidenceResult,
  RecoveryCompletionItemEvidence,
  RecoveryCompletionOutcome,
  RecoveryCompletionProofEvidence,
  RecoveryCompletionRefused,
  RecoveryCompletionUpstream,
  RecoveryDurableReconcileRequest,
  RecoveryInventoryRefusal,
  RecoveryReconciliationExternalFacts,
  RecoveryReconciliationFound,
  RecoveryReconciliationItem,
  RecoveryReconciliationProof,
  RecoveryReconciliationReadResult,
  RecoveryReconciliationRecord,
  RecoveryReconciliationRecorded,
  RecoveryReconciliationWriteResult,
} from "@moe/daemon";
// The Foundation ingress closure. Every branch a caller must narrow on is named
// here, so an entrypoint whose refusal union stopped being published stops
// compiling rather than merely losing an assertion.
import type {
  AcceptanceRecord,
  ContinuationCommandInput,
  ContinuationCommandOutcome,
  CoordinationAdapter,
  CoordinationAdapterOptions,
  CoordinationAuthRefused,
  CoordinationPresentationFields,
  DeltaRecord,
  FoundationAttemptCode,
  FoundationAttemptDeps,
  FoundationAttemptOutcome,
  FoundationAttemptRecordAnswer,
  FoundationAttemptRefused,
  FoundationRecipeOutcome,
  FoundationRecipeRegistration,
  FoundationVerificationAnswer,
  FoundationVerificationCode,
  FoundationVerificationDeps,
  FoundationVerificationLayer,
  FoundationVerificationOutcome,
  FoundationVerificationRefusalSource,
  FoundationVerificationRefused,
  FoundationVerificationVerdict,
  GoalClosureQualification,
  GoalClosureQualified,
  GoalClosureRefused,
  GoalPrerequisiteRefusalCode,
  InFlightAttempt,
  ProviderCapabilities,
  ProviderProfileIssue,
  ProviderProfileReaderLayer,
  ProviderProfileRevision,
  ReconciliationRecord,
  RestartReconciliationRequest,
  RestartReconciliationResult,
  RestartRecordClassification,
  RestartTruthClass,
} from "@moe/daemon";
// Deliberately NOT re-exported by @moe/daemon: the coordination request/result
// vocabulary belongs to @moe/coordination and is already reachable from its own
// public root. Importing it here is what proves the daemon's published closure
// is expressible without a deep import, the same way the @moe/runner and
// @moe/scheduler imports above do.
import type {
  CoordinationAckResult, CoordinationReadResult, CoordinationSendResult,
} from "@moe/coordination";

type ExportKind = "function" | "number" | "object" | "string";

/** Hand-transcribed from the reviewed command-driving modules. */
const EXPECTED_EXPORTS: readonly (readonly [string, ExportKind])[] = [
  ["BOOTSTRAP_COMMAND_KINDS", "object"],
  ["BOOTSTRAP_HANDLERS", "object"],
  ["BOOTSTRAP_REFUSAL_CODES", "object"],
  ["BOOTSTRAP_REQUEST_KEYS", "object"],
  ["BOOTSTRAP_SCHEMA_VERSION", "string"],
  ["CLAIM_LEGS", "object"],
  ["CONTINUATION_COMMAND_KIND", "string"],
  ["CONTINUATION_PAYLOAD_KEYS", "object"],
  ["CONTROL_ROOM_LISTENER_LAYER", "string"],
  ["DAEMON_ENTRY_LAYER", "string"],
  ["DAEMON_ENTRY_REFUSAL_CODES", "object"],
  ["DAEMON_FOUNDATION_ATTEMPT", "string"],
  ["DELTA_CLASSIFICATIONS", "object"],
  ["DOCTOR_COMMAND_KINDS", "object"],
  ["DOCTOR_ERROR_CODES", "object"],
  ["DOCTOR_RECOVERY_SCHEMA_VERSION", "string"],
  ["EVENT_STREAM_CLOCKS", "object"],
  ["EVENT_STREAM_LAYER", "string"],
  ["EVENT_STREAM_OBSERVERS", "object"],
  ["EVENT_STREAM_REFUSAL_CODES", "object"],
  ["EVENT_STREAM_UNKNOWN_CODES", "object"],
  ["EXPANSION_RELEASE_SELECTOR_CODES", "object"],
  ["EXPANSION_RELEASE_SELECTOR_LAYER_ROSTER", "object"],
  ["EXPANSION_RELEASE_SELECTOR_QUERY_KEYS", "object"],
  ["FOUNDATION_ATTEMPT_CODES", "object"],
  ["FOUNDATION_ATTEMPT_RECORD_VERSION", "string"],
  ["FOUNDATION_ATTEMPT_REQUEST_KEYS", "object"],
  ["FOUNDATION_ATTEMPT_SCHEMA_VERSION", "string"],
  ["FOUNDATION_DISPATCH_COMMAND_KIND", "string"],
  ["FOUNDATION_RESERVATION_VERSION", "string"],
  ["FOUNDATION_VERIFICATION_CODES", "object"],
  ["FOUNDATION_VERIFICATION_COMMAND_KIND", "string"],
  ["FOUNDATION_VERIFICATION_LAYERS", "object"],
  ["FOUNDATION_VERIFICATION_RECEIPT_VERSION", "string"],
  ["FOUNDATION_VERIFICATION_RECIPE_VERSION", "string"],
  ["FOUNDATION_VERIFICATION_REFUSAL_SOURCES", "object"],
  ["FOUNDATION_VERIFICATION_REQUEST_KEYS", "object"],
  ["FOUNDATION_VERIFICATION_SCHEMA_VERSION", "string"],
  ["FOUNDATION_VERIFICATION_VERDICTS", "object"],
  ["GOAL_CLOSURE_WITNESS_VERSION", "string"],
  ["GOAL_HANDLERS", "object"],
  ["GOAL_PREREQUISITE_LAYER", "string"],
  ["GOAL_PREREQUISITE_REFUSAL_CODES", "object"],
  ["HTTP_BOUNDARY_ERROR_CODES", "object"],
  ["HTTP_INPUT_BOUNDS", "object"],
  ["HTTP_REFUSAL_STAGES", "object"],
  ["IMPORT_SHADOW_READ_LAYER", "string"],
  ["IMPORT_SHADOW_REFUSAL_CODES", "object"],
  ["LISTENER_REFUSAL_CODES", "object"],
  ["MAX_COMMAND_PAYLOAD_FIELDS", "number"],
  ["MAX_EVENT_PAGE_SIZE", "number"],
  ["OPERATOR_CAPABILITIES", "object"],
  ["PLANNING_HANDLERS", "object"],
  ["PREREQUISITE_REFUSAL_CODES", "object"],
  ["PROJECT_CONFIGURATION_SELECTION_CODES", "object"],
  ["PROJECT_CONFIGURATION_SELECTION_LAYER", "string"],
  ["PROVIDER_PROFILE_READER_CODES", "object"],
  ["RECOVERY_COMPLETE_PAYLOAD_KEYS", "object"],
  ["RECOVERY_COMPLETION_APPROVAL_DOMAIN", "string"],
  ["RECOVERY_COMPLETION_CODES", "object"],
  ["RECOVERY_COMPLETION_COMMAND_KIND", "string"],
  ["RECOVERY_COMPLETION_HUMAN_GATE_ID", "string"],
  ["RECOVERY_COMPLETION_LAYER", "string"],
  ["RECOVERY_COMPLETION_SCHEMA_VERSION", "string"],
  ["RECOVERY_INCARNATION_ERROR_CODES", "object"],
  ["RECOVERY_INCARNATION_SCHEMA_VERSION", "string"],
  ["RECOVERY_STEP_UP_REF_PREFIX", "string"],
  ["RECOVERY_STEP_UP_WINDOW_SECONDS", "number"],
  ["RECOVERY_SUCCESSION_ERROR_CODES", "object"],
  ["RECOVERY_SUCCESSION_LAYER", "string"],
  ["RECOVERY_SUCCESSION_SCHEMA_VERSION", "string"],
  ["RESTART_RECONCILIATION_COMMAND_KIND", "string"],
  ["RESTART_RECONCILIATION_SCHEMA_VERSION", "string"],
  ["RESTART_RECORD_CLASSIFICATIONS", "object"],
  ["REVIEW_COMMAND_KINDS", "object"],
  ["REVIEW_HANDLERS", "object"],
  ["REVIEW_INGRESS_REFUSAL_CODES", "object"],
  ["REVIEW_PREREQUISITE_REFUSAL_CODES", "object"],
  ["REVIEW_REFUSED_BY", "object"],
  ["REVIEW_REQUEST_KEYS", "object"],
  ["REVIEW_SCHEMA_VERSION", "string"],
  ["RUNNER_WORKSPACE_LAYER", "string"],
  ["SCHEDULER_GRAPH_LAYER", "string"],
  ["SERVICE_REFUSED_BY", "object"],
  ["SLOT_CEILING_LEG", "string"],
  ["WIRE_PROTOCOL_VERSION", "string"],
  ["WORK_AUTHORITY_LABELS", "object"],
  ["WORK_COMMANDS", "object"],
  ["WORK_ERROR_CODES", "object"],
  ["WORK_LAYERS", "object"],
  ["WORK_LEGS", "object"],
  ["WORK_SCHEMA_VERSION", "string"],
  ["acknowledgeEventPage", "function"],
  ["admitCutoverActivateApproval", "function"],
  ["anchorIncarnation", "function"],
  ["buildCommandRegistry", "function"],
  ["claimWork", "function"],
  ["collectDoctorVersionReport", "function"],
  ["compareImportShadow", "function"],
  ["coordinationPresentationDigest", "function"],
  ["createCoordinationAdapter", "function"],
  ["createDaemonCommandPorts", "function"],
  ["createExpansionReleaseAuthorityReader", "function"],
  ["createFoundationAttemptService", "function"],
  ["createFoundationVerificationService", "function"],
  ["createNodeRecoveryCryptoPort", "function"],
  ["createRecoveryIncarnationService", "function"],
  ["createRecoverySuccessionService", "function"],
  ["createV2Compiler", "function"],
  ["decodeBootstrapRequestBytes", "function"],
  ["decodeReviewRequestBytes", "function"],
  ["deriveRecipeAggregateId", "function"],
  ["deriveVerificationAggregateId", "function"],
  ["evaluateDoctorCommandBytes", "function"],
  ["evaluateGraphPreviewRequestBytes", "function"],
  ["handleCommandRequest", "function"],
  ["isDependencyProvider", "function"],
  ["parseWorkRequest", "function"],
  ["qualifyGoalClosure", "function"],
  ["readAnchoredIncarnation", "function"],
  ["readCurrentProjectConfiguration", "function"],
  ["readEventPage", "function"],
  ["readExpansionReleaseSelection", "function"],
  ["readFoundationAttemptRecord", "function"],
  ["readImportShadowProjection", "function"],
  ["readLatestProjectConfiguration", "function"],
  ["readReconciliationRecords", "function"],
  ["readRecoveryCompletionEvidence", "function"],
  ["readRecoveryReconciliation", "function"],
  ["readReviewLedger", "function"],
  ["readSuccessionChain", "function"],
  ["reconcileOnRestart", "function"],
  ["recordRecoveryReconciliation", "function"],
  ["recoveryCompletionApprovalDigest", "function"],
  ["recoveryCompletionDigest", "function"],
  ["recoveryCoverageProofDigest", "function"],
  ["refuseEntry", "function"],
  ["resolveCurrentProviderProfile", "function"],
  ["resumeFromSnapshot", "function"],
  ["runBootstrapCommand", "function"],
  ["runContinuationCommand", "function"],
  ["runRecoveryCompleteCommand", "function"],
  ["runReviewCommand", "function"],
  ["selectProjectConfiguration", "function"],
  ["startControlRoomListener", "function"],
  ["startDaemon", "function"],
];

/** Transcribed from review-services.ts; the table is frozen and owns exactly these kinds. */
const REVIEW_HANDLER_KINDS = [
  "escalation.decide",
  "integration.accept_output",
  "qualification.replan",
  "review.submit",
] as const;

/**
 * Names that a single `export *` anywhere in the Foundation curation path would
 * publish. The first seven predate this list's Foundation half; the rest are
 * transcribed from the producer modules the curated surface re-exports FROM —
 * `goals/goal-closure-test-fixtures.ts` (a fixture module sitting inside the
 * closure family's own directory), the codec helpers `work/foundation-attempt-
 * contracts.ts` itself re-exports, `evidence/foundation-verification-store.ts`,
 * and the internal `refuse`/payload readers of `review/review-ledger.ts`.
 * A star re-export makes the public surface whatever a sibling declares tomorrow;
 * these are the exact names that would arrive if one were ever added.
 */
const FORBIDDEN_FIXTURES = [
  "LEDGER_EVENT_IDS",
  "PROJECTION",
  "SNAPSHOT_CHECKPOINT",
  "STATE_DIGEST",
  "SUBSCRIBER",
  "ledgerIdsUpTo",
  "streamPort",
  "accountDurableActivations",
  "approveNodes",
  "cleanupGoalClosureFixtures",
  "commitPhase",
  "eventsOf",
  "exactKeys",
  "foundationAttemptRefusal",
  "indexDurableReceipts",
  "isRecord",
  "loadDurable",
  "nestedRecord",
  "nonEmpty",
  "payloadRef",
  "readApprovedNodeScope",
  "readRecipientFold",
  "reconciliationAggregateId",
  "refuse",
  "refuseFromKernel",
  "refuseLocal",
  "sameBytes",
  "seedProvenAttempt",
  "seedReviewAcceptance",
  "seedVerifiedNode",
  "sha256Hex",
  "storedRecipe",
  "textOf",
  "typed",
  // The profile ADMISSION seam: provider.probe is the only way a profile becomes durable, so
  // these three staying unpublished is what makes that "only" true rather than conventional.
  "admitProviderProfile",
  "decodeProviderProfileBytes",
  "encodeProviderProfileBytes",
] as const;

const surface: Readonly<Record<string, unknown>> = daemon;
const execFileAsync = promisify(execFile);

describe("daemon package root", () => {
  it("guards the hand-written runtime export catalogue", () => {
    expect(EXPECTED_EXPORTS.length).toBe(146);
  });

  it("publishes exactly the reviewed runtime namespace", () => {
    expect(Object.keys(daemon).sort()).toEqual(EXPECTED_EXPORTS.map(([name]) => name));
  });

  it.each(EXPECTED_EXPORTS)("publishes %s as %s", (name, kind) => {
    expect(typeof surface[name]).toBe(kind);
  });

  it("collects executing-host versions through the bare root in plain Node", async () => {
    const daemonDirectory = fileURLToPath(new URL("..", import.meta.url));
    const source = `
import assert from "node:assert/strict";
import { collectDoctorVersionReport } from "@moe/daemon";
const report = await collectDoctorVersionReport();
assert.deepStrictEqual(report.observed.platform, { known: true, value: process.platform });
assert.deepStrictEqual(report.observed.node, { known: true, value: process.version });
process.stdout.write(JSON.stringify({ node: report.observed.node, platform: report.observed.platform }));
`;
    const result = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", source],
      { cwd: daemonDirectory, maxBuffer: 1_048_576, timeout: 60_000, windowsHide: true },
    );

    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      node: { known: true, value: process.version },
      platform: { known: true, value: process.platform },
    });
  }, 70_000);

  it("publishes the review command table by name with exactly its four handlers", () => {
    expect(Object.hasOwn(daemon, "REVIEW_HANDLERS")).toBe(true);
    expect(typeof surface["REVIEW_HANDLERS"]).toBe("object");
    expect(Object.keys(daemon.REVIEW_HANDLERS).sort()).toEqual([...REVIEW_HANDLER_KINDS]);
    for (const kind of REVIEW_HANDLER_KINDS) {
      expect(typeof daemon.REVIEW_HANDLERS[kind]).toBe("function");
    }
  });

  it("guards the explicit fixture deny-list", () => {
    expect(FORBIDDEN_FIXTURES.length).toBe(37);
  });

  it.each(FORBIDDEN_FIXTURES)("does not publish fixture %s", (name) => {
    expect(Object.hasOwn(daemon, name)).toBe(false);
  });
});

describe("daemon package-root type closure", () => {
  it("names the complete HTTP transport and entrypoint closure", () => {
    expectTypeOf<BoundaryCodesAreRuntimeCodes>().toEqualTypeOf<true>();
    expectTypeOf<(typeof daemon.HTTP_BOUNDARY_ERROR_CODES)[number]>()
      .toEqualTypeOf<HttpBoundaryErrorCode>();
    expectTypeOf<(typeof daemon.HTTP_REFUSAL_STAGES)[number]>()
      .toEqualTypeOf<HttpRefusalStage>();
    expectTypeOf<typeof daemon.WIRE_PROTOCOL_VERSION>().toEqualTypeOf<WireProtocolVersion>();
    expectTypeOf<AuthenticationResult>().toEqualTypeOf<
      | { readonly principal: AuthenticatedPrincipal; readonly verdict: "AUTHENTICATED" }
      | { readonly refusal: PortRefusal; readonly verdict: "REFUSED" }
      | { readonly verdict: "UNAUTHENTICATED" }
    >();
    expectTypeOf<AuthVerdict>().toEqualTypeOf<
      "AUTHENTICATED" | "REFUSED" | "UNAUTHENTICATED" | "UNAUTHORIZED"
    >();
    expectTypeOf<CommandAdapterDeps["authenticator"]>().toEqualTypeOf<Authenticator>();
    expectTypeOf<CommandAdapterDeps["decisions"]>().toEqualTypeOf<CommandDecisionPort>();
    expectTypeOf<CommandAdapterDeps["registry"]>().toEqualTypeOf<CommandRegistry>();
    expectTypeOf<CommandRegistryEntry["handler"]>().toEqualTypeOf<HttpCommandHandler>();
    expectTypeOf<Parameters<HttpCommandHandler>>().toEqualTypeOf<[input: CommandHandlerInput]>();
    expectTypeOf<ReturnType<HttpCommandHandler>>().toEqualTypeOf<DurableDecision>();
    expectTypeOf<Parameters<CommandDecisionPort["decide"]>[0]>().toEqualTypeOf<DecisionKey>();
    expectTypeOf<ReturnType<CommandDecisionPort["decide"]>>().toEqualTypeOf<DecisionPortResult>();
    expectTypeOf<Extract<DecisionPortResult, { readonly outcome: "REFUSED" }>["refusal"]>()
      .toEqualTypeOf<PortRefusal>();
    expectTypeOf<HttpCommandResult>().toEqualTypeOf<HttpAccepted | HttpPortRefused | HttpRefused>();
    expectTypeOf<Parameters<typeof daemon.handleCommandRequest>>()
      .toEqualTypeOf<[deps: CommandAdapterDeps, request: HttpCommandRequest]>();
    expectTypeOf<ReturnType<typeof daemon.handleCommandRequest>>().toEqualTypeOf<HttpCommandResult>();

    expectTypeOf<(typeof daemon.LISTENER_REFUSAL_CODES)[number]>()
      .toEqualTypeOf<ListenerRefusalCode>();
    expectTypeOf<StartListenerResult>().toEqualTypeOf<ControlRoomListener | ListenerRefused>();
    expectTypeOf<Parameters<typeof daemon.startControlRoomListener>>()
      .toEqualTypeOf<[options: StartListenerOptions]>();
    expectTypeOf<ReturnType<typeof daemon.startControlRoomListener>>()
      .toEqualTypeOf<Promise<StartListenerResult>>();
    expectTypeOf<(typeof daemon.DAEMON_ENTRY_REFUSAL_CODES)[number]>()
      .toEqualTypeOf<DaemonEntryRefusalCode>();
    // Four arms, not three: a refused boot reconciliation keeps the producer's own
    // code and layer rather than being re-stamped as a DAEMON_ENTRY refusal.
    expectTypeOf<DaemonStartResult>()
      .toEqualTypeOf<
        BootReconciliationRefused | DaemonEntryRefused | ListenerRefused | StartedDaemon
      >();
    expectTypeOf<DaemonStartOptions["dependencies"]>()
      .toEqualTypeOf<DaemonDependencyProvider | null | undefined>();
    expectTypeOf<ReturnType<StartedDaemon["shutdown"]>>().toEqualTypeOf<Promise<ShutdownResult>>();
    expectTypeOf<Parameters<typeof daemon.startDaemon>>()
      .toEqualTypeOf<[options: DaemonStartOptions]>();
  });

  it("names every bootstrap decoder and service branch", () => {
    expectTypeOf<(typeof daemon.BOOTSTRAP_COMMAND_KINDS)[number]>()
      .toEqualTypeOf<BootstrapCommandKind>();
    expectTypeOf<(typeof daemon.BOOTSTRAP_REFUSAL_CODES)[number]>()
      .toEqualTypeOf<BootstrapRefusalCode>();
    expectTypeOf<BootstrapDecodeRefusal>()
      .toEqualTypeOf<BootstrapInputRejected | BootstrapRequestRefused>();
    expectTypeOf<BootstrapDecodeResult>()
      .toEqualTypeOf<BootstrapInputRejected | BootstrapRequestAccepted | BootstrapRequestRefused>();
    expectTypeOf<BootstrapRequestAccepted["request"]>().toEqualTypeOf<BootstrapRequest>();
    expectTypeOf<BootstrapInputRejected["refusedBy"] | BootstrapRequestRefused["refusedBy"]>()
      .toEqualTypeOf<BootstrapRefusedBy>();
    expectTypeOf<ReturnType<typeof daemon.decodeBootstrapRequestBytes>>()
      .toEqualTypeOf<BootstrapDecodeResult>();

    expectTypeOf<(typeof daemon.SERVICE_REFUSED_BY)[number]>().toEqualTypeOf<ServiceRefusedBy>();
    expectTypeOf<(typeof daemon.PREREQUISITE_REFUSAL_CODES)[number]>()
      .toEqualTypeOf<PrerequisiteRefusalCode>();
    expectTypeOf<DurableLedger["aggregates"]>()
      .toEqualTypeOf<ReadonlyMap<string, DurableAggregate>>();
    expectTypeOf<HandlerContext["ledger"]>().toEqualTypeOf<DurableLedger>();
    expectTypeOf<Parameters<CommandHandler>>().toEqualTypeOf<[context: HandlerContext]>();
    expectTypeOf<ReturnType<CommandHandler>>().toEqualTypeOf<ServiceOutcome>();
    expectTypeOf<ServiceOutcome>().toEqualTypeOf<ServiceAccepted | ServiceRefused>();
    expectTypeOf(daemon.BOOTSTRAP_HANDLERS).toEqualTypeOf<HandlerTable>();
    expectTypeOf(daemon.GOAL_HANDLERS).toEqualTypeOf<HandlerTable>();
    expectTypeOf(daemon.PLANNING_HANDLERS).toEqualTypeOf<HandlerTable>();
    expectTypeOf<Parameters<typeof daemon.createV2Compiler>>()
      .toEqualTypeOf<[dependencies: V2CompilerFactoryDependencies]>();
    expectTypeOf<ReturnType<typeof daemon.createV2Compiler>>().toEqualTypeOf<V2Compiler>();
    expectTypeOf<keyof V2CompilerFactoryDependencies>().toEqualTypeOf<
      | "clock" | "projectId" | "qualificationAuthority" | "readGraphAuthority"
      | "readNodeAdmissionAuthority" | "readNodePlanningAuthority"
      | "readPublishedSourceSnapshot"
    >();
    expectTypeOf<Parameters<V2Compiler["mintResolutionToken"]>[1]>()
      .toEqualTypeOf<V2CompilerResolutionRequest>();
    expectTypeOf<Parameters<V2Compiler["compile"]>[1]>()
      .toEqualTypeOf<readonly V2CompilerResolutionToken[]>();
    expectTypeOf<ReturnType<V2Compiler["mintResolutionToken"]>>()
      .toEqualTypeOf<V2CompilerResolutionTokenMintResult>();
    expectTypeOf<Parameters<typeof daemon.runBootstrapCommand>[2]>()
      .toEqualTypeOf<HandlerTable | undefined>();
    expectTypeOf<ReturnType<typeof daemon.runBootstrapCommand>>().toEqualTypeOf<ServiceOutcome>();
  });

  it("names every work request and result branch", () => {
    expectTypeOf<(typeof daemon.WORK_COMMANDS)[number]>().toEqualTypeOf<WorkCommand>();
    expectTypeOf<(typeof daemon.CLAIM_LEGS)[number]>().toEqualTypeOf<ClaimLeg>();
    expectTypeOf<(typeof daemon.WORK_LEGS)[number]>().toEqualTypeOf<WorkLeg>();
    expectTypeOf<(typeof daemon.WORK_LAYERS)[number]>().toEqualTypeOf<WorkLayer>();
    expectTypeOf<(typeof daemon.WORK_ERROR_CODES)[number]>().toEqualTypeOf<WorkErrorCode>();
    expectTypeOf<(typeof daemon.WORK_AUTHORITY_LABELS)[number]>()
      .toEqualTypeOf<WorkAuthorityLabel>();
    expectTypeOf<WorkFailure["leg"]>().toEqualTypeOf<WorkLeg | null>();
    expectTypeOf<WorkGranted["successors"]>().toEqualTypeOf<ClaimSuccessors>();
    // Exactly five fields, each the upstream record type rather than `unknown`:
    // a placeholder field would satisfy any consumer and prove nothing.
    expectTypeOf<keyof ClaimSuccessors>().toEqualTypeOf<
      "budgetReservation" | "budgetView" | "effectIntent" | "lease" | "providerSlot"
    >();
    expectTypeOf<ClaimSuccessors["lease"]>().toEqualTypeOf<LeaseRecord>();
    expectTypeOf<ClaimSuccessors["providerSlot"]>().toEqualTypeOf<ProviderSlotReservation>();
    expectTypeOf<ClaimSuccessors["budgetReservation"]>().toEqualTypeOf<ReservationRecord>();
    expectTypeOf<ClaimSuccessors["budgetView"]>().toEqualTypeOf<BudgetAvailableView>();
    expectTypeOf<ClaimSuccessors["effectIntent"]>().toEqualTypeOf<EffectIntent>();
    expectTypeOf<WorkResult>().toEqualTypeOf<
      WorkApplied | WorkContextView | WorkGranted | WorkInputRejected | WorkRefused
    >();
    expectTypeOf<Extract<WorkRequestParse, { readonly ok: true }>["envelope"]>()
      .toEqualTypeOf<WorkRequestEnvelope>();
    expectTypeOf<Extract<WorkRequestParse, { readonly ok: false }>["result"]>()
      .toEqualTypeOf<WorkResult>();
    expectTypeOf<ReturnType<typeof daemon.parseWorkRequest>>().toEqualTypeOf<WorkRequestParse>();
    expectTypeOf<ReturnType<typeof daemon.claimWork>>().toEqualTypeOf<WorkResult>();
  });

  it("names every event-stream port and wire branch", () => {
    expectTypeOf<(typeof daemon.EVENT_STREAM_REFUSAL_CODES)[number]>()
      .toEqualTypeOf<EventStreamRefusalCode>();
    expectTypeOf<StreamReadResult>().toEqualTypeOf<StreamGap | StreamPage | StreamRefused>();
    expectTypeOf<StreamSeatResult>().toEqualTypeOf<StreamRefused | StreamSeated>();
    expectTypeOf<StreamAcknowledgeResult>()
      .toEqualTypeOf<StreamAcknowledged | StreamRefused>();
    expectTypeOf<Parameters<SubscriptionPort["acknowledge"]>>()
      .toEqualTypeOf<[request: StreamAcknowledgeRequest]>();
    expectTypeOf<ReturnType<SubscriptionPort["acknowledge"]>>()
      .toEqualTypeOf<StreamAcknowledgeResult>();
    expectTypeOf<Parameters<SubscriptionPort["readPage"]>>()
      .toEqualTypeOf<[request: StreamPageRequest]>();
    expectTypeOf<ReturnType<SubscriptionPort["readPage"]>>().toEqualTypeOf<StreamReadResult>();
    expectTypeOf<Parameters<SubscriptionPort["reseat"]>>()
      .toEqualTypeOf<[request: StreamReseatRequest]>();
    expectTypeOf<ReturnType<SubscriptionPort["reseat"]>>().toEqualTypeOf<StreamSeatResult>();
    expectTypeOf<StreamPage["events"]>().toEqualTypeOf<readonly StreamEvent[]>();
    expectTypeOf<StreamPage["nextCursor"]>().toEqualTypeOf<StreamCursor | null>();
    expectTypeOf<StreamGap["snapshot"] | StreamSeated["snapshot"]>()
      .toEqualTypeOf<StreamSnapshot>();
    expectTypeOf<EventPageFrame["events"]>().toEqualTypeOf<readonly WireEvent[]>();
    expectTypeOf<EventPageFrame["nextCursor"]>().toEqualTypeOf<WireCursor | null>();
    expectTypeOf<EventGapFrame["snapshot"] | EventReseatedFrame["snapshot"]>()
      .toEqualTypeOf<WireSnapshot>();
    expectTypeOf<EventReadFrame>()
      .toEqualTypeOf<EventGapFrame | EventPageFrame | EventRefusedFrame>();
    expectTypeOf<EventResumeFrame>().toEqualTypeOf<EventRefusedFrame | EventReseatedFrame>();
    expectTypeOf<EventAcknowledgeFrame>()
      .toEqualTypeOf<EventAcknowledgedFrame | StreamRefused>();
    expectTypeOf<Parameters<typeof daemon.acknowledgeEventPage>>()
      .toEqualTypeOf<[port: SubscriptionPort, request: EventAcknowledgeRequest]>();
    expectTypeOf<ReturnType<typeof daemon.acknowledgeEventPage>>()
      .toEqualTypeOf<EventAcknowledgeFrame>();
    expectTypeOf<Parameters<typeof daemon.readEventPage>>()
      .toEqualTypeOf<
        [port: SubscriptionPort, request: EventReadRequest, observer?: SeamObserver | undefined]
      >();
    expectTypeOf<ReturnType<typeof daemon.readEventPage>>().toEqualTypeOf<EventReadFrame>();
    expectTypeOf<Parameters<typeof daemon.resumeFromSnapshot>>()
      .toEqualTypeOf<[port: SubscriptionPort, request: EventResumeRequest]>();
    expectTypeOf<ReturnType<typeof daemon.resumeFromSnapshot>>().toEqualTypeOf<EventResumeFrame>();
    expectTypeOf<(typeof daemon.EVENT_STREAM_OBSERVERS)[number]>()
      .toEqualTypeOf<EventStreamObserver>();
    expectTypeOf<(typeof daemon.EVENT_STREAM_CLOCKS)[number]>().toEqualTypeOf<EventStreamClock>();
    expectTypeOf<(typeof daemon.EVENT_STREAM_UNKNOWN_CODES)[number]>()
      .toEqualTypeOf<EventStreamUnknownCode>();
    expectTypeOf<WireValue>().toEqualTypeOf<WireKnownValue | WireUnknownValue>();
    expectTypeOf<WireEvent["identity"]>().toEqualTypeOf<WireEventIdentity>();
    expectTypeOf<WireEvent["ledgerObservation"] | WireEvent["seamObservation"]>()
      .toEqualTypeOf<WireObservation>();
  });

  it("names every doctor command result branch", () => {
    expectTypeOf<(typeof daemon.DOCTOR_COMMAND_KINDS)[number]>().toEqualTypeOf<DoctorCommandKind>();
    expectTypeOf<(typeof daemon.DOCTOR_ERROR_CODES)[number]>().toEqualTypeOf<DoctorErrorCode>();
    expectTypeOf<DoctorCommandResult>().toEqualTypeOf<
      DoctorAuthorityStale | DoctorInputRejected | DoctorProposed | DoctorReported
      | DoctorRequestInvalid | DoctorVersionsReported | DoctorVersionReportAbsent
    >();
    expectTypeOf<ReturnType<typeof daemon.collectDoctorVersionReport>>()
      .toEqualTypeOf<Promise<DoctorVersionReport>>();
    expectTypeOf<ReturnType<typeof daemon.evaluateDoctorCommandBytes>>()
      .toEqualTypeOf<DoctorCommandResult>();
  });

  it("names every review request, refusing layer and outcome branch", () => {
    expectTypeOf<ReviewDecodeRefusal>()
      .toEqualTypeOf<ReviewInputRejected | ReviewRequestRefused>();
    expectTypeOf<ReviewDecodeResult>()
      .toEqualTypeOf<ReviewInputRejected | ReviewRequestAccepted | ReviewRequestRefused>();
    expectTypeOf<ReviewRequestAccepted["request"]>().toEqualTypeOf<ReviewRequest>();
    expectTypeOf<ReviewRequest["kind"]>().toEqualTypeOf<ReviewCommandKind>();
    expectTypeOf<ReviewDaemonRefusalCode>()
      .toEqualTypeOf<ReviewIngressRefusalCode | ReviewPrerequisiteRefusalCode>();
    expectTypeOf<ReviewDaemonLayer>()
      .toEqualTypeOf<Extract<ReviewRefusedBy, `DAEMON_${string}`>>();
    expectTypeOf<ReviewRefused["refusedBy"]>().toEqualTypeOf<ReviewRefusedBy>();
    expectTypeOf<ReviewRefused["kind"]>().toEqualTypeOf<ReviewCommandKind | null>();
    expectTypeOf<ReviewAccepted["kind"]>().toEqualTypeOf<ReviewCommandKind>();
    expectTypeOf<ReviewOutcome>().toEqualTypeOf<ReviewAccepted | ReviewRefused>();

    expectTypeOf<ReviewHandlerContext["ledger"]>().toEqualTypeOf<ReviewLedger>();
    expectTypeOf<ReviewHandlerContext["request"]>().toEqualTypeOf<ReviewRequest>();
    expectTypeOf<ReviewLedger["rounds"]>().toEqualTypeOf<readonly ReviewRoundRecord[]>();
    expectTypeOf<DeltaNodeClassification["classification"]>().toEqualTypeOf<DeltaClassification>();
    expectTypeOf<Parameters<ReviewCommandHandler>>()
      .toEqualTypeOf<[context: ReviewHandlerContext]>();
    expectTypeOf<ReturnType<ReviewCommandHandler>>().toEqualTypeOf<ReviewOutcome>();
    expectTypeOf<ReviewHandlerTable[ReviewCommandKind]>()
      .toEqualTypeOf<ReviewCommandHandler | undefined>();
    expectTypeOf(daemon.REVIEW_HANDLERS).toEqualTypeOf<ReviewHandlerTable>();
    expectTypeOf<Parameters<typeof daemon.createDaemonCommandPorts>>()
      .toEqualTypeOf<[options: DaemonCommandPortOptions]>();
    expectTypeOf<ReturnType<typeof daemon.createDaemonCommandPorts>>()
      .toEqualTypeOf<DaemonCommandPorts>();
    expectTypeOf<DaemonCommandPorts["decisions"]>().toEqualTypeOf<CommandDecisionPort>();
    expectTypeOf<DaemonCommandPorts["registry"]>().toEqualTypeOf<CommandRegistry>();
  });

  it("names every recovery incarnation branch and keeps the mint non-authoritative", () => {
    expectTypeOf<(typeof daemon.RECOVERY_INCARNATION_ERROR_CODES)[number]>()
      .toEqualTypeOf<RecoveryIncarnationErrorCode>();
    expectTypeOf<RecoveryIncarnationResult>()
      .toEqualTypeOf<RecoveryIncarnationMinted | RecoveryIncarnationRefused>();
    // The published binding is an exact tagged union, and the port-based mint
    // publishes ONLY the restore branch: a genesis fence never travels this way.
    expectTypeOf<RecoveryIncarnationBinding>()
      .toEqualTypeOf<GenesisIncarnationBinding | RestoreIncarnationBinding>();
    expectTypeOf<RecoveryIncarnationMinted["binding"]>()
      .toEqualTypeOf<RestoreIncarnationBinding>();
    // Both branches carry authority NONE: neither a mint nor a refusal may be
    // read as PREPARED. RecoveryAnchor alone owns that.
    expectTypeOf<RecoveryIncarnationMinted["authority"]>().toEqualTypeOf<"NONE">();
    expectTypeOf<RecoveryIncarnationRefused["authority"]>().toEqualTypeOf<"NONE">();
    expectTypeOf<RecoveryIncarnationRefused["truth"]>().toEqualTypeOf<"UNKNOWN">();
    expectTypeOf<RecoveryIncarnationRefused["layer"]>().toEqualTypeOf<"RECOVERY_INCARNATION">();
    expectTypeOf<RecoveryIncarnationRequest["restoreCommandId"]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<RecoveryIncarnationService["mint"]>>()
      .toEqualTypeOf<[request: unknown]>();
    expectTypeOf<ReturnType<RecoveryIncarnationService["mint"]>>()
      .toEqualTypeOf<Promise<RecoveryIncarnationResult>>();
    expectTypeOf<Parameters<typeof daemon.createRecoveryIncarnationService>>()
      .toEqualTypeOf<[port: RecoveryIncarnationCryptoPort]>();
    expectTypeOf<ReturnType<typeof daemon.createRecoveryIncarnationService>>()
      .toEqualTypeOf<RecoveryIncarnationService>();
    expectTypeOf<ReturnType<typeof daemon.createNodeRecoveryCryptoPort>>()
      .toEqualTypeOf<RecoveryIncarnationCryptoPort>();
    expectTypeOf<ReturnType<RecoveryIncarnationCryptoPort["generateSigningKey"]>>()
      .toEqualTypeOf<Promise<RecoveryIncarnationKeyPair>>();
  });

  it("publishes the R3 completion command and the reconciliation ledger it consumes", () => {
    // Every assertion below imports the TYPE in a compiled position. A
    // type-only export is invisible to the runtime key catalogue above, so
    // counting keys would leave the whole published type closure unproven.
    expectTypeOf<(typeof daemon.RECOVERY_COMPLETION_CODES)[number]>()
      .toEqualTypeOf<RecoveryCompletionCode>();
    expectTypeOf<typeof daemon.RECOVERY_COMPLETION_LAYER>().toEqualTypeOf<"RECOVERY_COMPLETION">();
    expectTypeOf<typeof daemon.RECOVERY_COMPLETION_COMMAND_KIND>()
      .toEqualTypeOf<"recovery.complete">();
    expectTypeOf<typeof daemon.RECOVERY_COMPLETION_APPROVAL_DOMAIN>()
      .toEqualTypeOf<"moe-recovery-completion-approval/1">();
    // Authentication is evidence, never an answer. No witness, truth class, or
    // caller-selected accepted digest is admitted.
    expect([...daemon.RECOVERY_COMPLETE_PAYLOAD_KEYS])
      .toEqual(["approval", "authentication", "command", "reconciliationDigest"]);
    expectTypeOf<Parameters<typeof daemon.recoveryCompletionApprovalDigest>>()
      .toEqualTypeOf<[subject: RecoveryCompletionApprovalSubject]>();
    expectTypeOf<ReturnType<typeof daemon.recoveryCompletionDigest>>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<typeof daemon.recoveryCompletionDigest>>()
      .toEqualTypeOf<[evidence: RecoveryCompletionEvidence]>();
    expectTypeOf<ReturnType<typeof daemon.recoveryCoverageProofDigest>>().toEqualTypeOf<string>();
    expectTypeOf<RecoveryCompletionEvidence["proofs"]>()
      .toEqualTypeOf<readonly RecoveryCompletionProofEvidence[]>();
    expectTypeOf<RecoveryCompletionEvidence["items"]>()
      .toEqualTypeOf<readonly RecoveryCompletionItemEvidence[]>();
    expectTypeOf<RecoveryCompletionItemEvidence["quarantineRef"]>().toEqualTypeOf<string | null>();
    expectTypeOf<ReturnType<typeof daemon.runRecoveryCompleteCommand>>()
      .toEqualTypeOf<RecoveryCompletionOutcome>();
    expectTypeOf<RecoveryCompletionOutcome>()
      .toEqualTypeOf<RecoveryCompletionAccepted | RecoveryCompletionRefused>();
    // The witness a caller receives is the one core validated, and a refusal
    // never carries authority.
    expectTypeOf<RecoveryCompletionAccepted["witness"]>()
      .toEqualTypeOf<RecoveryCompletionWitness>();
    expectTypeOf<RecoveryCompletionAccepted["authority"]>().toEqualTypeOf<"DURABLE_DECISION">();
    expectTypeOf<RecoveryCompletionRefused["authority"]>().toEqualTypeOf<"NONE">();
    expectTypeOf<RecoveryCompletionRefused["upstream"]>()
      .toEqualTypeOf<RecoveryCompletionUpstream | null>();
    expectTypeOf<ReturnType<typeof daemon.readRecoveryCompletionEvidence>>()
      .toEqualTypeOf<RecoveryCompletionEvidenceResult>();
    expectTypeOf<RecoveryCompletionEvidenceResult>()
      .toEqualTypeOf<RecoveryCompletionEvidenceFound | RecoveryCompletionRefused>();
    expectTypeOf<RecoveryCompletionEvidenceFound["record"]>()
      .toEqualTypeOf<RecoveryReconciliationRecord>();
    expectTypeOf<RecoveryCompleteRequest["reconciliationDigest"]>().toEqualTypeOf<string>();
    // The reconciliation ledger is reachable from the root, so the completion
    // command has a published producer rather than an unreachable island.
    expectTypeOf<ReturnType<typeof daemon.readRecoveryReconciliation>>()
      .toEqualTypeOf<RecoveryReconciliationReadResult>();
    expectTypeOf<ReturnType<typeof daemon.recordRecoveryReconciliation>>()
      .toEqualTypeOf<RecoveryReconciliationWriteResult>();
    expectTypeOf<RecoveryReconciliationReadResult>()
      .toEqualTypeOf<RecoveryReconciliationFound | RecoveryInventoryRefusal>();
    expectTypeOf<RecoveryReconciliationWriteResult>()
      .toEqualTypeOf<RecoveryReconciliationRecorded | RecoveryInventoryRefusal>();
    expectTypeOf<RecoveryReconciliationRecord["items"]>()
      .toEqualTypeOf<readonly RecoveryReconciliationItem[]>();
    expectTypeOf<RecoveryReconciliationRecord["proofs"]>()
      .toEqualTypeOf<readonly RecoveryReconciliationProof[]>();
    expectTypeOf<RecoveryReconciliationExternalFacts["subjects"]>().not.toBeAny();
    expectTypeOf<RecoveryDurableReconcileRequest["projectId"]>().toEqualTypeOf<string>();
    expectTypeOf<RecoveryInventoryRefusal["authority"]>().toEqualTypeOf<"NONE">();
    expectTypeOf<RecoveryInventoryRefusal["truth"]>().toEqualTypeOf<"UNKNOWN">();
  });

  it("names every recovery succession branch and keeps a succession non-authoritative", () => {
    expectTypeOf<(typeof daemon.RECOVERY_SUCCESSION_ERROR_CODES)[number]>()
      .toEqualTypeOf<RecoverySuccessionErrorCode>();
    expectTypeOf<RecoverySuccessionResult>()
      .toEqualTypeOf<RecoverySuccessionRecorded | RecoverySuccessionRefused>();
    expectTypeOf<RecoverySuccessionRecorded["record"]>().toEqualTypeOf<RecoverySuccessionRecord>();
    // Recording a succession proves lineage, never authority: an anchor still
    // owns PREPARED, exactly as it does for a mint.
    expectTypeOf<RecoverySuccessionRecorded["authority"]>().toEqualTypeOf<"NONE">();
    expectTypeOf<RecoverySuccessionRefused["authority"]>().toEqualTypeOf<"NONE">();
    expectTypeOf<RecoverySuccessionRefused["truth"]>().toEqualTypeOf<"UNKNOWN">();
    expectTypeOf<RecoverySuccessionRefused["layer"]>().toEqualTypeOf<"RECOVERY_SUCCESSION">();
    // The record carries a proof, not a key: the successor's signature is the
    // only cryptographic thing that ever becomes durable.
    expectTypeOf<RecoverySuccessionRecord["proof"]>().toEqualTypeOf<RecoveryIncarnationProof>();
    expectTypeOf<RecoverySuccessionRequest["predecessorIncarnationRef"]>()
      .toEqualTypeOf<string>();
    expectTypeOf<Parameters<typeof daemon.createRecoverySuccessionService>>()
      .toEqualTypeOf<[port: RecoveryIncarnationCryptoPort]>();
    expectTypeOf<ReturnType<typeof daemon.createRecoverySuccessionService>>()
      .toEqualTypeOf<RecoverySuccessionService>();
    expectTypeOf<ReturnType<RecoverySuccessionService["succeed"]>>()
      .toEqualTypeOf<Promise<RecoverySuccessionResult>>();
    expectTypeOf<ReturnType<typeof daemon.readSuccessionChain>>()
      .toEqualTypeOf<RecoverySuccessionChainResult>();
    expectTypeOf<RecoverySuccessionChainResult>()
      .toEqualTypeOf<RecoverySuccessionChain | RecoverySuccessionRefused>();
    expectTypeOf<RecoverySuccessionChain["links"]>()
      .toEqualTypeOf<readonly RecoverySuccessionRecord[]>();
    expectTypeOf<ReturnType<typeof daemon.readAnchoredIncarnation>>()
      .toEqualTypeOf<RestoreIncarnationBinding | null>();
    expectTypeOf<ReturnType<typeof daemon.anchorIncarnation>>().toEqualTypeOf<boolean>();
  });

  it("keeps graph preview branches advisory through the published root", () => {
    expectTypeOf<GraphPreviewRequestResult>().toEqualTypeOf<
      GraphPreviewInputRejected | GraphPreviewRequestEvaluated | GraphPreviewRequestInvalid
    >();
    expectTypeOf<GraphPreviewRequestInvalid["error"]>().toEqualTypeOf<GraphPreviewRequestError>();
    expectTypeOf<ReturnType<typeof daemon.evaluateGraphPreviewRequestBytes>>()
      .toEqualTypeOf<GraphPreviewRequestResult>();

    expect(daemon.evaluateGraphPreviewRequestBytes(new TextEncoder().encode("{}"))).toEqual({
      advisoryOnly: true,
      authority: "NONE",
      error: {
        code: "GRAPH_PREVIEW_REQUEST_INVALID",
        message: "Graph preview request must match moe-graph-preview-request/1 exactly.",
      },
      ok: false,
      outcome: "REQUEST_INVALID",
    });
  });
});

describe("project configuration package-root consumer edge", () => {
  it("publishes the complete current-selection type closure", () => {
    expectTypeOf<(typeof daemon.PROJECT_CONFIGURATION_SELECTION_CODES)[number]>()
      .toEqualTypeOf<ProjectConfigurationSelectionCode>();
    expectTypeOf<typeof daemon.PROJECT_CONFIGURATION_SELECTION_LAYER>()
      .toEqualTypeOf<"PROJECT_CONFIGURATION_SELECTION">();
    expectTypeOf<Parameters<typeof daemon.selectProjectConfiguration>>()
      .toEqualTypeOf<[store: ProjectConfigurationStore, input: unknown]>();
    expectTypeOf<ReturnType<typeof daemon.selectProjectConfiguration>>()
      .toEqualTypeOf<SelectProjectConfigurationResult>();
    expectTypeOf<ReturnType<typeof daemon.readCurrentProjectConfiguration>>()
      .toEqualTypeOf<ReadCurrentProjectConfigurationResult>();
    expectTypeOf<SelectedProjectConfiguration["manifest"]>()
      .toEqualTypeOf<ProjectConfigurationManifest>();
    expectTypeOf<CurrentProjectConfiguration["authority"]>().toEqualTypeOf<"DAEMON_VERIFIED">();
    expectTypeOf<ProjectConfigurationSelectionUnknown["upstream"]>()
      .toEqualTypeOf<ProjectConfigurationSelectionUpstream | null>();
  });

  it("selects and reopens exact current bytes through bare package roots", async () => {
    const daemonDirectory = join(fileURLToPath(new URL(".", import.meta.url)), "..");
    const directory = mkdtempSync(join(tmpdir(), "moe-project-configuration-smoke-"));
    const databasePath = join(directory, "consumer.db");
    const source = `
import assert from "node:assert/strict";
import { PROJECT_CONFIGURATION_LIMIT_KEYS } from "@moe/contracts";
import { createProjectConfigurationManifest, encodeProjectConfigurationManifest } from "@moe/core";
import { readCurrentProjectConfiguration, selectProjectConfiguration } from "@moe/daemon";
import { SqliteEventStore } from "@moe/store";
const projectId = "package-root-configuration-smoke";
const settings = {
  isolation: { hostContainment: "NOT_CLAIMED", workspace: "PER_ATTEMPT_WORKTREE" },
  limits: PROJECT_CONFIGURATION_LIMIT_KEYS.map((key, index) => ({ key, value: index + 1 })),
  network: { daemonExposure: "LOOPBACK_ONLY", providerEgress: "EGRESS_ALLOWLISTED" },
  orchestrationSource: { objectFormat: "sha256", sourceSha: "2".repeat(64) },
  policy: { acceptanceGate: "MANUAL_HUMAN_APPROVAL", autoApprovalOptInDigest: null,
    evaluatorVersion: "policy-evaluator-v1", expansionGate: "MANUAL_HUMAN_APPROVAL",
    planningGate: "MANUAL_HUMAN_APPROVAL", policyRevisionId: "policy-revision-1", revision: 1 },
  schemaVersions: { commandSchemaVersion: "moe-command-1", errorSchemaVersion: "moe-error-1",
    querySchemaVersion: "moe-query-1" },
  selection: { modelRef: "model-1", profileRef: "profile-1", providerRef: "provider-1",
    reasoningEffortRef: "effort-1", runtimeRef: "runtime-1", snapshotRef: "snapshot-1",
    structuredOutputSchemaRef: "schema-1" },
};
const created = createProjectConfigurationManifest(projectId, settings);
if (!created.ok) throw new Error(created.code);
const encoded = encodeProjectConfigurationManifest(created.manifest);
if (!encoded.ok) throw new Error(encoded.code);
let store = SqliteEventStore.openForProject(${JSON.stringify(databasePath)}, projectId);
try {
  const selected = selectProjectConfiguration(store, { projectId, commandId: "command-1",
    correlationId: "correlation-1", decidedAt: "2026-08-15T18:00:00.000Z",
    principalId: "principal-1", expectedVersion: 0, manifestBytes: encoded.bytes });
  assert.deepStrictEqual(selected, { authority: "DAEMON_VERIFIED", evidence: "DURABLE",
    manifest: created.manifest, manifestBytes: encoded.bytes, ok: true, outcome: "SELECTED",
    selectionVersion: 1 });
} finally { store.close(); }
store = SqliteEventStore.openForProject(${JSON.stringify(databasePath)}, projectId);
try {
  const current = readCurrentProjectConfiguration(store, { projectId,
    expectedSettingsDigest: created.manifest.settingsDigest });
  assert.deepStrictEqual(current, { authority: "DAEMON_VERIFIED", evidence: "DURABLE",
    manifest: created.manifest, manifestBytes: encoded.bytes, ok: true, outcome: "CURRENT",
    selectionVersion: 1 });
  process.stdout.write(JSON.stringify({ authority: current.authority, evidence: current.evidence,
    outcome: current.outcome, selectionVersion: current.selectionVersion }));
} finally { store.close(); }
`;
    try {
      const result = await execFileAsync(process.execPath, [
        "--experimental-strip-types", "--input-type=module", "--eval", source,
      ], {
        cwd: daemonDirectory,
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 1_048_576,
      });
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        authority: "DAEMON_VERIFIED",
        evidence: "DURABLE",
        outcome: "CURRENT",
        selectionVersion: 1,
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, 75_000);
});

describe("daemon package-root Foundation ingress closure", () => {
  it("names every review command and ledger read branch", () => {
    expectTypeOf<ReturnType<typeof daemon.runReviewCommand>>().toEqualTypeOf<ReviewOutcome>();
    expectTypeOf<ReviewOutcome>().toEqualTypeOf<ReviewAccepted | ReviewRefused>();
    expectTypeOf<ReturnType<typeof daemon.readReviewLedger>>().toEqualTypeOf<ReviewLedger>();
    // The barrel published ReviewLedger long before it published these two, so a
    // consumer could hold the ledger and still not narrow either optional member.
    expectTypeOf<ReviewLedger["accepted"]>().toEqualTypeOf<AcceptanceRecord | undefined>();
    expectTypeOf<ReviewLedger["delta"]>().toEqualTypeOf<DeltaRecord | undefined>();
    expectTypeOf<ReviewLedger["rounds"]>().toEqualTypeOf<readonly ReviewRoundRecord[]>();
    expectTypeOf<ReturnType<typeof daemon.decodeReviewRequestBytes>>()
      .toEqualTypeOf<ReviewDecodeResult>();
    expectTypeOf<ReviewDecodeResult>()
      .toEqualTypeOf<ReviewRequestAccepted | ReviewInputRejected | ReviewRequestRefused>();
    expectTypeOf<ReviewDecodeRefusal>()
      .toEqualTypeOf<ReviewInputRejected | ReviewRequestRefused>();
    expectTypeOf<(typeof daemon.REVIEW_COMMAND_KINDS)[number]>().toEqualTypeOf<ReviewCommandKind>();
    expectTypeOf<(typeof daemon.REVIEW_INGRESS_REFUSAL_CODES)[number]>()
      .toEqualTypeOf<ReviewIngressRefusalCode>();
    expectTypeOf<(typeof daemon.REVIEW_PREREQUISITE_REFUSAL_CODES)[number]>()
      .toEqualTypeOf<ReviewPrerequisiteRefusalCode>();
    expectTypeOf<(typeof daemon.REVIEW_REFUSED_BY)[number]>().toEqualTypeOf<ReviewRefusedBy>();
    expectTypeOf<(typeof daemon.DELTA_CLASSIFICATIONS)[number]>()
      .toEqualTypeOf<DeltaClassification>();
    expect(daemon.REVIEW_SCHEMA_VERSION).toBe("moe-review-command/1");
  });

  it("names every restart reconciliation and continuation branch", () => {
    expectTypeOf<ReturnType<typeof daemon.reconcileOnRestart>>()
      .toEqualTypeOf<RestartReconciliationResult>();
    expectTypeOf<Parameters<typeof daemon.reconcileOnRestart>[1]>()
      .toEqualTypeOf<RestartReconciliationRequest>();
    expectTypeOf<RestartReconciliationRequest["attempts"]>()
      .toEqualTypeOf<readonly InFlightAttempt[]>();
    expectTypeOf<ReturnType<typeof daemon.readReconciliationRecords>>()
      .toEqualTypeOf<ReadonlyMap<string, ReconciliationRecord>>();
    expectTypeOf<ReconciliationRecord["classification"]>()
      .toEqualTypeOf<RestartRecordClassification>();
    expectTypeOf<ReconciliationRecord["truthClass"]>().toEqualTypeOf<RestartTruthClass>();
    expectTypeOf<ReturnType<typeof daemon.runContinuationCommand>>()
      .toEqualTypeOf<ContinuationCommandOutcome>();
    expectTypeOf<Parameters<typeof daemon.runContinuationCommand>[1]>()
      .toEqualTypeOf<ContinuationCommandInput>();
    expect(daemon.RESTART_RECONCILIATION_SCHEMA_VERSION).toBe("moe-restart-reconciliation/2");
    expect(daemon.RESTART_RECONCILIATION_COMMAND_KIND).toBe("reconciliation.decide");
    expect(daemon.CONTINUATION_COMMAND_KIND).toBe("work.resume");
    expect([...daemon.CONTINUATION_PAYLOAD_KEYS]).toEqual(["attemptRef", "successorRef"]);
  });

  it("names both Foundation attempt dispatch and read-model branches", () => {
    expectTypeOf<Parameters<typeof daemon.createFoundationAttemptService>[0]>()
      .toEqualTypeOf<FoundationAttemptDeps>();
    expectTypeOf<ReturnType<ReturnType<typeof daemon.createFoundationAttemptService>["dispatch"]>>()
      .toEqualTypeOf<Promise<FoundationAttemptOutcome>>();
    expectTypeOf<ReturnType<typeof daemon.readFoundationAttemptRecord>>()
      .toEqualTypeOf<FoundationAttemptOutcome>();
    expectTypeOf<FoundationAttemptOutcome>()
      .toEqualTypeOf<FoundationAttemptRecordAnswer | FoundationAttemptRefused>();
    expectTypeOf<FoundationAttemptRecordAnswer["authority"]>().toEqualTypeOf<"ADVISORY_RECORD">();
    expectTypeOf<FoundationAttemptRefused["ok"]>().toEqualTypeOf<false>();
    expectTypeOf<(typeof daemon.FOUNDATION_ATTEMPT_CODES)[number]>()
      .toEqualTypeOf<FoundationAttemptCode>();
    expect(daemon.FOUNDATION_ATTEMPT_SCHEMA_VERSION).toBe("moe-foundation-attempt/1");
    expect(daemon.FOUNDATION_DISPATCH_COMMAND_KIND).toBe("foundation.dispatch");
    expect(daemon.DAEMON_FOUNDATION_ATTEMPT).toBe("DAEMON_FOUNDATION_ATTEMPT");
  });

  it("names all three verification operations and the source-tagged refusal", () => {
    type VerificationService = ReturnType<typeof daemon.createFoundationVerificationService>;
    expectTypeOf<Parameters<typeof daemon.createFoundationVerificationService>[0]>()
      .toEqualTypeOf<FoundationVerificationDeps>();
    expectTypeOf<ReturnType<VerificationService["verify"]>>()
      .toEqualTypeOf<Promise<FoundationVerificationOutcome>>();
    expectTypeOf<ReturnType<VerificationService["readReceipt"]>>()
      .toEqualTypeOf<FoundationVerificationOutcome>();
    expectTypeOf<ReturnType<VerificationService["sealRecipe"]>>()
      .toEqualTypeOf<FoundationRecipeOutcome>();
    expectTypeOf<Parameters<VerificationService["sealRecipe"]>>()
      .toEqualTypeOf<[input: FoundationRecipeRegistration]>();
    expectTypeOf<FoundationVerificationOutcome>()
      .toEqualTypeOf<FoundationVerificationAnswer | FoundationVerificationRefused>();
    expectTypeOf<FoundationVerificationAnswer["verdict"]>()
      .toEqualTypeOf<FoundationVerificationVerdict>();
    // Six producers can refuse here, so WHICH layer refused is part of the
    // published closure, not an internal detail.
    expectTypeOf<FoundationVerificationRefused["source"]>()
      .toEqualTypeOf<FoundationVerificationRefusalSource>();
    expectTypeOf<(typeof daemon.FOUNDATION_VERIFICATION_REFUSAL_SOURCES)[number]>()
      .toEqualTypeOf<FoundationVerificationRefusalSource>();
    expectTypeOf<(typeof daemon.FOUNDATION_VERIFICATION_CODES)[number]>()
      .toEqualTypeOf<FoundationVerificationCode>();
    expectTypeOf<(typeof daemon.FOUNDATION_VERIFICATION_LAYERS)[number]>()
      .toEqualTypeOf<FoundationVerificationLayer>();
    expectTypeOf<(typeof daemon.FOUNDATION_VERIFICATION_VERDICTS)[number]>()
      .toEqualTypeOf<FoundationVerificationVerdict>();
    expect(daemon.FOUNDATION_VERIFICATION_SCHEMA_VERSION).toBe("moe-foundation-verification/1");
    expect(daemon.FOUNDATION_VERIFICATION_COMMAND_KIND).toBe("foundation.verification");
    expect([...daemon.FOUNDATION_VERIFICATION_VERDICTS]).toEqual(["PASSED", "FAILED"]);
  });

  it("names both review-qualified goal closure branches", () => {
    expectTypeOf<ReturnType<typeof daemon.qualifyGoalClosure>>()
      .toEqualTypeOf<GoalClosureQualification>();
    expectTypeOf<GoalClosureQualification>()
      .toEqualTypeOf<GoalClosureQualified | GoalClosureRefused>();
    expectTypeOf<GoalClosureQualified["ok"]>().toEqualTypeOf<true>();
    expectTypeOf<GoalClosureRefused["code"]>().toEqualTypeOf<GoalPrerequisiteRefusalCode>();
    expectTypeOf<GoalClosureRefused["layer"]>()
      .toEqualTypeOf<typeof daemon.GOAL_PREREQUISITE_LAYER>();
    expectTypeOf<(typeof daemon.GOAL_PREREQUISITE_REFUSAL_CODES)[number]>()
      .toEqualTypeOf<GoalPrerequisiteRefusalCode>();
    expect(daemon.GOAL_PREREQUISITE_LAYER).toBe("DAEMON_PREREQUISITE");
    expect(daemon.GOAL_CLOSURE_WITNESS_VERSION).toBe("moe-goal-closure-witness/1");
  });

  it("names every coordination adapter operation", () => {
    expectTypeOf<Parameters<typeof daemon.createCoordinationAdapter>>()
      .toEqualTypeOf<[options: CoordinationAdapterOptions]>();
    expectTypeOf<ReturnType<typeof daemon.createCoordinationAdapter>>()
      .toEqualTypeOf<CoordinationAdapter>();
    expectTypeOf<ReturnType<CoordinationAdapter["acknowledge"]>>()
      .toEqualTypeOf<CoordinationAckResult>();
    expectTypeOf<ReturnType<CoordinationAdapter["read"]>>().toEqualTypeOf<CoordinationReadResult>();
    expectTypeOf<ReturnType<CoordinationAdapter["replay"]>>()
      .toEqualTypeOf<CoordinationReadResult>();
    expectTypeOf<ReturnType<CoordinationAdapter["send"]>>().toEqualTypeOf<CoordinationSendResult>();
    expectTypeOf<CoordinationAuthRefused["ok"]>().toEqualTypeOf<false>();
    expectTypeOf<Parameters<typeof daemon.coordinationPresentationDigest>>()
      .toEqualTypeOf<[fields: CoordinationPresentationFields]>();
    expectTypeOf<ReturnType<typeof daemon.coordinationPresentationDigest>>().toEqualTypeOf<string>();
  });

  it("refuses malformed review bytes at DAEMON_INGRESS without touching a store", () => {
    // Both the decoder and the command refuse BEFORE any durable read, so the
    // store argument is never dereferenced. Asserting the code AND the refusing
    // layer, not merely that it refused: a second guard answering first would
    // leave "it refused" green while testing nothing.
    const decoded = daemon.decodeReviewRequestBytes(new TextEncoder().encode("{"));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("expected a decode refusal");
    expect(decoded.code).toBe("REVIEW_INPUT_REJECTED");
    expect(decoded.refusedBy).toBe("DAEMON_INGRESS");

    const outcome = daemon.runReviewCommand(
      null as unknown as Parameters<typeof daemon.runReviewCommand>[0],
      new TextEncoder().encode("{"),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a command refusal");
    expect(outcome.code).toBe("REVIEW_INPUT_REJECTED");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(outcome.authority).toBe("NONE");
  });

  it("refuses goal closure against an unreadable store with the prerequisite code", () => {
    // qualifyGoalClosure fails CLOSED on a thrown store rather than propagating.
    // Pinning the code and the layer keeps that guarantee from silently becoming
    // "it threw somewhere else".
    const unreadable = {
      readEvents(): never {
        throw new Error("store unavailable");
      },
    } as unknown as Parameters<typeof daemon.qualifyGoalClosure>[0];

    const result = daemon.qualifyGoalClosure(unreadable, "project-1", "goal-1");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a closure refusal");
    expect(result.code).toBe("GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED");
    expect(result.layer).toBe("DAEMON_PREREQUISITE");
  });
});

describe("provider profile package-root consumer edge", () => {
  it("publishes the current-profile reader type closure", () => {
    expectTypeOf<(typeof daemon.PROVIDER_PROFILE_READER_CODES)[number]>().toEqualTypeOf<
      "PROVIDER_PROFILE_ABSENT" | "PROVIDER_PROFILE_BINDING_MISMATCH"
      | "PROVIDER_PROFILE_TRUTH_UNVERIFIED" | "PROVIDER_PROFILE_UNREADABLE"
    >();
    // Type exports are invisible to the runtime export count, so each one is USED in an
    // annotation here: that is the only thing that proves the type actually crossed the root.
    const layer: ProviderProfileReaderLayer = "PROVIDER_PROFILE_READER";
    expect(layer).toBe("PROVIDER_PROFILE_READER");
    expectTypeOf<ProviderCapabilities["authority"]>().toEqualTypeOf<"DAEMON_VERIFIED">();
    expectTypeOf<ProviderCapabilities["outcome"]>().toEqualTypeOf<"CURRENT">();
    expectTypeOf<ProviderProfileRevision["provider"]>().toEqualTypeOf<"claude">();
    expectTypeOf<ProviderProfileIssue["layer"]>().toEqualTypeOf<
      "PROVIDER_PROFILE_CODEC" | "PROVIDER_PROFILE_REGISTRATION"
    >();
  });

  it("refuses PROVIDER_PROFILE_ABSENT through the bare namespace on an empty store", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest("package-root-profile-smoke");
    try {
      const result = daemon.resolveCurrentProviderProfile(store, {
        projectId: "package-root-profile-smoke",
        expectedConfigurationDigest: "a".repeat(64),
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a reader refusal");
      expect(result.code).toBe("PROVIDER_PROFILE_ABSENT");
      expect(result.layer).toBe("PROVIDER_PROFILE_READER");
    } finally {
      store.close();
    }
  });
});
