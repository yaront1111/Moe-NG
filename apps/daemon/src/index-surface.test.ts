/** Package-root publication contract for the daemon command surface. */
import { describe, expect, expectTypeOf, it } from "vitest";

import * as daemon from "@moe/daemon";
import type {
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
  CommandHandler,
  DeltaClassification,
  DeltaNodeClassification,
  DoctorAuthorityStale,
  DoctorCommandKind,
  DoctorCommandResult,
  DoctorErrorCode,
  DoctorInputRejected,
  DoctorProposed,
  DoctorReported,
  DoctorRequestInvalid,
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
  PrerequisiteRefusalCode,
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
  ["DOCTOR_COMMAND_KINDS", "object"],
  ["DOCTOR_ERROR_CODES", "object"],
  ["DOCTOR_RECOVERY_SCHEMA_VERSION", "string"],
  ["EVENT_STREAM_LAYER", "string"],
  ["EVENT_STREAM_REFUSAL_CODES", "object"],
  ["GOAL_HANDLERS", "object"],
  ["MAX_EVENT_PAGE_SIZE", "number"],
  ["PLANNING_HANDLERS", "object"],
  ["PREREQUISITE_REFUSAL_CODES", "object"],
  ["REVIEW_HANDLERS", "object"],
  ["SERVICE_REFUSED_BY", "object"],
  ["SLOT_CEILING_LEG", "string"],
  ["WORK_AUTHORITY_LABELS", "object"],
  ["WORK_COMMANDS", "object"],
  ["WORK_ERROR_CODES", "object"],
  ["WORK_LAYERS", "object"],
  ["WORK_LEGS", "object"],
  ["WORK_SCHEMA_VERSION", "string"],
  ["claimWork", "function"],
  ["decodeBootstrapRequestBytes", "function"],
  ["evaluateDoctorCommandBytes", "function"],
  ["evaluateGraphPreviewRequestBytes", "function"],
  ["parseWorkRequest", "function"],
  ["readEventPage", "function"],
  ["resumeFromSnapshot", "function"],
  ["runBootstrapCommand", "function"],
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
    expect(EXPECTED_EXPORTS.length).toBe(32);
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
      | DoctorRequestInvalid
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
