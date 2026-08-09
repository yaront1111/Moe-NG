/** Package-root publication contract for the daemon command surface. */
import { describe, expect, expectTypeOf, it } from "vitest";

import * as daemon from "@moe/daemon";
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
  DaemonDependencyProvider,
  DaemonEntryRefusalCode,
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
  DoctorVersionReportAbsent,
  DoctorVersionsReported,
  DurableDecision,
  DurableAggregate,
  DurableLedger,
  EventGapFrame,
  EventPageFrame,
  EventReadFrame,
  EventReadRequest,
  EventRefusedFrame,
  EventReseatedFrame,
  EventResumeFrame,
  EventResumeRequest,
  EventStreamRefusalCode,
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
  RecoveryIncarnationBinding,
  RecoveryIncarnationCryptoPort,
  RecoveryIncarnationErrorCode,
  RecoveryIncarnationKeyPair,
  RecoveryIncarnationMinted,
  RecoveryIncarnationRefused,
  RecoveryIncarnationRequest,
  RecoveryIncarnationResult,
  RecoveryIncarnationService,
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
  ShutdownResult,
  StartedDaemon,
  StartListenerOptions,
  StartListenerResult,
  StreamCursor,
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
} from "@moe/daemon";

type ExportKind = "function" | "number" | "object" | "string";

/** Hand-transcribed from the reviewed command-driving modules. */
const EXPECTED_EXPORTS: readonly (readonly [string, ExportKind])[] = [
  ["BOOTSTRAP_COMMAND_KINDS", "object"],
  ["BOOTSTRAP_HANDLERS", "object"],
  ["BOOTSTRAP_REFUSAL_CODES", "object"],
  ["BOOTSTRAP_REQUEST_KEYS", "object"],
  ["BOOTSTRAP_SCHEMA_VERSION", "string"],
  ["CLAIM_LEGS", "object"],
  ["CONTROL_ROOM_LISTENER_LAYER", "string"],
  ["DAEMON_ENTRY_LAYER", "string"],
  ["DAEMON_ENTRY_REFUSAL_CODES", "object"],
  ["DOCTOR_COMMAND_KINDS", "object"],
  ["DOCTOR_ERROR_CODES", "object"],
  ["DOCTOR_RECOVERY_SCHEMA_VERSION", "string"],
  ["EVENT_STREAM_LAYER", "string"],
  ["EVENT_STREAM_REFUSAL_CODES", "object"],
  ["GOAL_HANDLERS", "object"],
  ["HTTP_BOUNDARY_ERROR_CODES", "object"],
  ["HTTP_INPUT_BOUNDS", "object"],
  ["HTTP_REFUSAL_STAGES", "object"],
  ["LISTENER_REFUSAL_CODES", "object"],
  ["MAX_COMMAND_PAYLOAD_FIELDS", "number"],
  ["MAX_EVENT_PAGE_SIZE", "number"],
  ["PLANNING_HANDLERS", "object"],
  ["PREREQUISITE_REFUSAL_CODES", "object"],
  ["RECOVERY_INCARNATION_ERROR_CODES", "object"],
  ["RECOVERY_INCARNATION_SCHEMA_VERSION", "string"],
  ["REVIEW_HANDLERS", "object"],
  ["SERVICE_REFUSED_BY", "object"],
  ["SLOT_CEILING_LEG", "string"],
  ["WIRE_PROTOCOL_VERSION", "string"],
  ["WORK_AUTHORITY_LABELS", "object"],
  ["WORK_COMMANDS", "object"],
  ["WORK_ERROR_CODES", "object"],
  ["WORK_LAYERS", "object"],
  ["WORK_LEGS", "object"],
  ["WORK_SCHEMA_VERSION", "string"],
  ["buildCommandRegistry", "function"],
  ["claimWork", "function"],
  ["createNodeRecoveryCryptoPort", "function"],
  ["createRecoveryIncarnationService", "function"],
  ["decodeBootstrapRequestBytes", "function"],
  ["evaluateDoctorCommandBytes", "function"],
  ["evaluateGraphPreviewRequestBytes", "function"],
  ["handleCommandRequest", "function"],
  ["isDependencyProvider", "function"],
  ["parseWorkRequest", "function"],
  ["readEventPage", "function"],
  ["refuseEntry", "function"],
  ["resumeFromSnapshot", "function"],
  ["runBootstrapCommand", "function"],
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

const FORBIDDEN_FIXTURES = [
  "LEDGER_EVENT_IDS",
  "PROJECTION",
  "SNAPSHOT_CHECKPOINT",
  "STATE_DIGEST",
  "SUBSCRIBER",
  "ledgerIdsUpTo",
  "streamPort",
] as const;

const surface: Readonly<Record<string, unknown>> = daemon;

describe("daemon package root", () => {
  it("guards the hand-written runtime export catalogue", () => {
    expect(EXPECTED_EXPORTS.length).toBe(51);
  });

  it("publishes exactly the reviewed runtime namespace", () => {
    expect(Object.keys(daemon).sort()).toEqual(EXPECTED_EXPORTS.map(([name]) => name));
  });

  it.each(EXPECTED_EXPORTS)("publishes %s as %s", (name, kind) => {
    expect(typeof surface[name]).toBe(kind);
  });

  it("publishes the review command table by name with exactly its four handlers", () => {
    expect(Object.hasOwn(daemon, "REVIEW_HANDLERS")).toBe(true);
    expect(typeof surface["REVIEW_HANDLERS"]).toBe("object");
    expect(Object.keys(daemon.REVIEW_HANDLERS).sort()).toEqual([...REVIEW_HANDLER_KINDS]);
    for (const kind of REVIEW_HANDLER_KINDS) {
      expect(typeof daemon.REVIEW_HANDLERS[kind]).toBe("function");
    }
  });

  it("guards the explicit fixture deny-list", () => {
    expect(FORBIDDEN_FIXTURES.length).toBe(7);
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
      | { readonly verdict: "UNAUTHENTICATED" }
    >();
    expectTypeOf<AuthVerdict>().toEqualTypeOf<
      "AUTHENTICATED" | "UNAUTHENTICATED" | "UNAUTHORIZED"
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
    expectTypeOf<DaemonStartResult>()
      .toEqualTypeOf<DaemonEntryRefused | ListenerRefused | StartedDaemon>();
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
    expectTypeOf<Parameters<typeof daemon.readEventPage>>()
      .toEqualTypeOf<[port: SubscriptionPort, request: EventReadRequest]>();
    expectTypeOf<ReturnType<typeof daemon.readEventPage>>().toEqualTypeOf<EventReadFrame>();
    expectTypeOf<Parameters<typeof daemon.resumeFromSnapshot>>()
      .toEqualTypeOf<[port: SubscriptionPort, request: EventResumeRequest]>();
    expectTypeOf<ReturnType<typeof daemon.resumeFromSnapshot>>().toEqualTypeOf<EventResumeFrame>();
  });

  it("names every doctor command result branch", () => {
    expectTypeOf<(typeof daemon.DOCTOR_COMMAND_KINDS)[number]>().toEqualTypeOf<DoctorCommandKind>();
    expectTypeOf<(typeof daemon.DOCTOR_ERROR_CODES)[number]>().toEqualTypeOf<DoctorErrorCode>();
    expectTypeOf<DoctorCommandResult>().toEqualTypeOf<
      DoctorAuthorityStale | DoctorInputRejected | DoctorProposed | DoctorReported
      | DoctorRequestInvalid | DoctorVersionsReported | DoctorVersionReportAbsent
    >();
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
  });

  it("names every recovery incarnation branch and keeps the mint non-authoritative", () => {
    expectTypeOf<(typeof daemon.RECOVERY_INCARNATION_ERROR_CODES)[number]>()
      .toEqualTypeOf<RecoveryIncarnationErrorCode>();
    expectTypeOf<RecoveryIncarnationResult>()
      .toEqualTypeOf<RecoveryIncarnationMinted | RecoveryIncarnationRefused>();
    expectTypeOf<RecoveryIncarnationMinted["binding"]>()
      .toEqualTypeOf<RecoveryIncarnationBinding>();
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
