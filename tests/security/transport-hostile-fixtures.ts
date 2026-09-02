/**
 * HOSTILE FIXTURES for the authority-transport axis — the input side, and nothing else.
 *
 * NOT a `*.security.ts` file, deliberately: the lane collects that suffix, and a second suite
 * would split the whole-slice no-admission invariant across modules that `isolate: true` keeps
 * from ever seeing each other's outcomes. This module builds hostile input, names the expected
 * refusal by reading the boundary's OWN exported constant, and calls production. It judges
 * nothing and reimplements no admission rule.
 *
 * WHY DEEP RELATIVE IMPORTS. This lane is not a workspace package and its tsconfig declares no
 * `paths`, so a bare `@moe/...` specifier does not resolve here — measured: `@moe/store` gives
 * TS2307 from this directory. The lane's tsconfig sets `composite: false` and no `rootDir`, so
 * a deep relative import into a package's `src` typechecks and runs.
 *
 * EVERY EXPECTED LAYER BELOW COMES FROM THE BOUNDARY'S DECLARED CONSTANT, never from a typed
 * literal, and `layerOf` reddens if a constant stops declaring the member it is asked for.
 * That is the point of the roster: these constants are the vocabulary.
 */

import { join } from "node:path";
import type { IncomingMessage } from "node:http";

import {
  IDE_ADAPTER_LAYER, IDE_ADAPTER_LAYERS,
} from "../../adapters/ide-contract/src/index.js";
import {
  LIVE_BUDGET_COMMITMENT_LAYER, readBudgetCommitment,
} from "../../apps/control-room/src/live/live-budget-commitment.js";
import {
  EFFORT_ADMISSION_LAYER, EFFORT_COLLECTOR_LAYER, EFFORT_LAYERS,
} from "../../apps/control-room/src/performance/effort-records.js";
import {
  TIMELINE_REFUSAL_LAYERS,
} from "../../apps/control-room/src/timeline/timeline-contract.js";
import type { TimelineSourcePage } from "../../apps/control-room/src/timeline/timeline-contract.js";
import {
  APPROVAL_COMMAND_KIND, PLAN_APPROVAL_BUILD_LAYER, PLAN_APPROVAL_TRANSPORT_LAYER,
  createPlanApprovalPort,
} from "../../apps/control-room/src/v2/goals/plan-approval.js";
import type { PlanApprovalWire } from "../../apps/control-room/src/v2/goals/plan-approval.js";
import { CAPABILITIES } from "../../apps/daemon/src/daemon-command-vocabulary.js";
import { DAEMON_ENTRY_LAYER } from "../../apps/daemon/src/daemon-entry.js";
import { AFFORDANCE_SURFACE_LAYER } from "../../apps/daemon/src/http/affordance-contract.js";
import { createAffordancePort } from "../../apps/daemon/src/http/affordance-read.js";
import {
  DOCUMENT_INGEST_ROUTE_LAYER, handleDocumentIngestRequest,
} from "../../apps/daemon/src/http/document-ingest-route.js";
import type { DocumentIngestPort } from "../../apps/daemon/src/http/document-ingest-route.js";
import {
  EVENT_STREAM_RESUME_LAYER, runEventResumeCommand,
} from "../../apps/daemon/src/http/event-resume-command.js";
import { EVENT_STREAM_LAYER } from "../../apps/daemon/src/http/event-stream-observation.js";
import {
  CONTROL_ROOM_LISTENER_LAYER, refuse as refuseListener,
} from "../../apps/daemon/src/http/http-listener-guards.js";
import type { ListenerRefusalCode } from "../../apps/daemon/src/http/http-listener-guards.js";
import { WIRE_PROTOCOL_VERSION } from "../../apps/daemon/src/http/http-contract.js";
import type { AuthenticatedPrincipal } from "../../apps/daemon/src/http/http-contract.js";
import {
  PAIRING_OPEN_KEYS, PAIRING_OPEN_LAYER, PAIRING_OPEN_MAX_BODY_BYTES,
  createPairingOpenCompletion,
} from "../../apps/daemon/src/http/pairing-open-completion.js";
import {
  DAEMON_INGRESS_LAYER, decodeRecoveryCompleteRequest,
} from "../../apps/daemon/src/recovery/recovery-completion-evidence.js";
import {
  CONTROL_ROOM_TRANSPORT_LAYER, createControlRoomTransport,
} from "../../packages/control-room-client/src/client-transport.js";
import type { FetchLike } from "../../packages/control-room-client/src/client-transport.js";
import {
  GENERATED_COMMAND_BUILDERS,
} from "../../packages/control-room-client/src/generated/generated-client.js";
import {
  COORDINATION_LAYERS, coordinationCapability,
} from "../../packages/coordination/src/coordination-contracts.js";
import type { CoordinationDependencies } from "../../packages/coordination/src/coordination-ports.js";
import { createCoordinationService } from "../../packages/coordination/src/coordination-service.js";
import type { LegacySourceRecord } from "../../packages/import/src/import-canonical.js";
import { IMPORT_REFUSAL_LAYERS } from "../../packages/import/src/import-contract.js";
import {
  HTTP_SHUTDOWN_LAYER, closeAllDaemonSessions,
} from "../../packages/mcp/src/http/http-shutdown.js";
import { createHttpSessionRegistry } from "../../packages/mcp/src/http/http-session.js";
import type {
  HttpSessionEntry, HttpSessionPort,
} from "../../packages/mcp/src/http/http-session.js";
import { SqliteEventStore } from "../../packages/store/src/index.js";
import { withHostileRoot } from "./hostile-harness.js";
import type { HostileBound, RefusalExpectation } from "./hostile-harness.js";

/**
 * Two seconds. `MAX_BOUND_MS` is 2**31-1, the `setTimeout` clamp boundary, so a bound at or
 * above it clamps to 1ms and would race nothing; this is six orders of magnitude below it. The
 * failure mode guarded against is a HANG — the lane runs `fileParallelism: false`, so one
 * unbounded wait stalls every file after it and reports no verdict at all rather than a red.
 */
export const BOUND: HostileBound = Object.freeze({
  label: "transport-boundary", timeoutMs: 2_000,
});

/** Reads a layer off the boundary's OWN declared constant, so a member that stops being
 *  declared reddens here instead of surviving as a literal nobody rechecks. */
export function layerOf<T extends string>(declared: readonly T[], name: string): T {
  const found = declared.find((layer) => layer === name);
  if (found === undefined) throw new Error(`${name} is no longer declared by its constant`);
  return found;
}

/** Hostile input the production type does not admit. Test doubles are the INPUT side only;
 *  every surface these fixtures call is the real one. */
export const hostile = <T,>(value: unknown): T => value as T;

const at = (code: string, layer: string): RefusalExpectation => ({ code, layer });
export const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

// ── IDE adapter ───────────────────────────────────────────────────────────────────────────
// IDE_ADAPTER answers only when the evidence status is UNRECOGNISED; a recognised status is
// answered by the declared PORT instead. Every fixture is built on exactly that line, so the
// intended layer is the one that answers.
export const EVIDENCE_MALFORMED = at("EVIDENCE_MALFORMED", IDE_ADAPTER_LAYER);
export const DISCOVERY_REFUSED =
  at("DAEMON_DISCOVERY_REFUSED", layerOf(IDE_ADAPTER_LAYERS, "DAEMON_DISCOVERY_PORT"));
export const START_REFUSED =
  at("DAEMON_START_REFUSED", layerOf(IDE_ADAPTER_LAYERS, "DAEMON_START_PORT"));
export const ASSETS_MISSING =
  at("CONTROL_ROOM_ASSETS_MISSING", layerOf(IDE_ADAPTER_LAYERS, "CONTROL_ROOM_OPEN_PORT"));
export const ENDPOINT_MISSING =
  at("DAEMON_ENDPOINT_MISSING", layerOf(IDE_ADAPTER_LAYERS, IDE_ADAPTER_LAYER));

// ── effort domain ─────────────────────────────────────────────────────────────────────────
// Admission answers before the collector ever sees a payload, so every COLLECTOR fixture is a
// well-formed observation that already passed admission — otherwise admission would answer and
// the assertion would silently stop testing its subject.
const admission = layerOf(EFFORT_LAYERS, EFFORT_ADMISSION_LAYER);
const collector = layerOf(EFFORT_LAYERS, EFFORT_COLLECTOR_LAYER);
export const SOURCE_ABSENT = at("EFFORT_SOURCE_ABSENT", admission);
export const UNPARSEABLE = at("EFFORT_OBSERVATION_UNPARSEABLE", admission);
export const IDENTITY_ABSENT = at("EFFORT_COMMAND_IDENTITY_ABSENT", admission);
export const ADMISSION_CONTRADICTORY = at("EFFORT_OBSERVATION_CONTRADICTORY", admission);
export const COLLECTOR_CONTRADICTORY = at("EFFORT_OBSERVATION_CONTRADICTORY", collector);
export const orphanClose = (observedAt: number): Record<string, unknown> => ({
  commandId: "cmd-1", intervalKind: "FOCUS", observedAt,
  source: "SESSION_RECORDING", type: "INTERVAL_CLOSE",
});
export const FREE_INTERACTION = Object.freeze({
  commandId: "cmd-1", interaction: "click", observedAt: 1,
  source: "CONTROL_ROOM_INPUT", type: "FREE_INTERACTION",
});
export const INTERVAL_OPEN_AWAY = Object.freeze({
  commandId: "cmd-1", intervalKind: "AWAY", observedAt: 9,
  source: "CONTROL_ROOM_DOM", type: "INTERVAL_OPEN",
});

// ── timeline ──────────────────────────────────────────────────────────────────────────────
// INPUT answers before any page is read, so every PAGING fixture carries a VALID `maxRows`.
export const LIMIT_INVALID =
  at("TIMELINE_LIMIT_INVALID", layerOf(TIMELINE_REFUSAL_LAYERS, "INPUT"));
export const CURSOR_NOT_ADVANCING =
  at("TIMELINE_CURSOR_NOT_ADVANCING", layerOf(TIMELINE_REFUSAL_LAYERS, "PAGING"));
export const stalling = (): TimelineSourcePage => ({ hasMore: true, nextCursor: null, rows: [] });
export const drained = (): TimelineSourcePage => ({ hasMore: false, nextCursor: null, rows: [] });

// ── daemon entry ──────────────────────────────────────────────────────────────────────────
// No fixture reaches a listener bind, so a ListenerRefused can never stand in for the entry
// layer's own answer.
export const NO_PROVIDER = at("DAEMON_ENTRY_NO_DEPENDENCY_PROVIDER", DAEMON_ENTRY_LAYER);
export const PROVIDER_THREW = at("DAEMON_ENTRY_PROVIDER_THREW", DAEMON_ENTRY_LAYER);
export const revokedProvider = {
  provide: (): never => { throw new Error("provider authority revoked"); },
};

// ── event stream seam ─────────────────────────────────────────────────────────────────────
export const READING_NOT_PROVIDED =
  at("EVENT_STREAM_READING_NOT_PROVIDED", EVENT_STREAM_LAYER);

// The command handler must reject payload/session authority before it can touch the durable
// subscription port. A store proxy that throws on every property read makes that ordering part
// of every hostile case instead of relying on an assertion over a mock call count.
export const RESUME_INPUT_INVALID =
  at("EVENT_STREAM_RESUME_INPUT_INVALID", EVENT_STREAM_RESUME_LAYER);
export const RESUME_SESSION_MISMATCH =
  at("EVENT_STREAM_RESUME_SESSION_MISMATCH", EVENT_STREAM_RESUME_LAYER);
const RESUME_PRINCIPAL_ID = "security-event-subscriber";
const RESUME_PROJECT_ID = "security-event-project";
const RESUME_SUBSCRIBER_ID = "control-room-1";
const unreachableResumeStore = new Proxy({}, {
  get: (_target, property): never => {
    throw new Error(`hostile events.resume input reached store.${String(property)}`);
  },
});

export const resumePayload = (
  subscriberId = RESUME_SUBSCRIBER_ID,
): Readonly<Record<string, unknown>> => Object.freeze({
  presentedCursor: Object.freeze({ generation: 1, position: "0" }),
  projection: "moe.board",
  subscriberId,
});

export function attemptResume(
  payload: unknown,
  targetAggregateId = RESUME_SUBSCRIBER_ID,
): unknown {
  try {
    return runEventResumeCommand({
      authorizedSubscriberId: RESUME_SUBSCRIBER_ID,
      decidedAt: "2026-08-25T00:00:00.000Z",
      envelope: hostile({
        commandId: "security-events-resume",
        commandKind: "events.resume",
        correlationId: "security-events-resume-correlation",
        expectedVersion: 0,
        payload,
        requestDigest: "d".repeat(64),
        schemaVersion: "moe-runtime-command/1",
        sessionCredential: "not-read-by-the-command-handler",
        targetAggregateId,
      }),
      principal: Object.freeze({
        capabilities: Object.freeze(["work"]),
        principalId: RESUME_PRINCIPAL_ID,
        projectId: RESUME_PROJECT_ID,
      }),
      projectId: RESUME_PROJECT_ID,
      store: hostile<SqliteEventStore>(unreachableResumeStore),
    });
  } catch (error) {
    return error;
  }
}

// ── document ingest route ─────────────────────────────────────────────────────────────────
// Both hostile principals pass authentication, protocol, ADMIN reach and port availability.
// The AGENT also passes the project fence, while FOREIGN_PROJECT carries the configured operator
// identity so only the later project check can answer it.
export const INGEST_OPERATOR_PRINCIPAL_REQUIRED =
  at("OPERATOR_PRINCIPAL_REQUIRED", "DAEMON_AUTHORIZATION");
export const INGEST_PROJECT_MISMATCH =
  at("DOCUMENT_INGEST_PROJECT_MISMATCH", DOCUMENT_INGEST_ROUTE_LAYER);
const INGEST_PROJECT = "proj-security-ingest";
const INGEST_OPERATOR = "operator-security";
type IngestAttempt = "AGENT" | "FOREIGN_PROJECT";

export async function withHostileDocumentIngest<T>(
  work: (attempt: (kind: IngestAttempt) => unknown) => Promise<T>,
): Promise<T> {
  let ingestCalls = 0;
  const port: DocumentIngestPort = Object.freeze({
    boundProjectId: INGEST_PROJECT,
    ingest: () => {
      ingestCalls += 1;
      return hostile<ReturnType<DocumentIngestPort["ingest"]>>({ outcome: "INGESTED" });
    },
    operatorPrincipalId: INGEST_OPERATOR,
  });
  const attempt = (kind: IngestAttempt): unknown => {
    const principal: AuthenticatedPrincipal = Object.freeze({
      capabilities: Object.freeze([CAPABILITIES.ADMIN, CAPABILITIES.WORK]),
      principalId: kind === "AGENT" ? "session-agent-1" : INGEST_OPERATOR,
      projectId: kind === "AGENT" ? INGEST_PROJECT : "proj-security-foreign",
    });
    const dispatch = handleDocumentIngestRequest({
      authenticator: { authenticate: () => ({ principal, verdict: "AUTHENTICATED" }) },
      documentIngest: port,
    }, {
      body: jsonBytes({ displayPath: "docs/prd.md", mediaType: "text/markdown", text: "# PRD" }),
      credential: "present",
      protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    return dispatch.kind === "REPLY" ? dispatch.body : dispatch;
  };
  const result = await work(attempt);
  if (ingestCalls !== 0) throw new Error(`hostile document ingest calls: ${String(ingestCalls)}`);
  return result;
}

// ── control-room listener ─────────────────────────────────────────────────────────────────
// The socket guard refuses BEFORE any affordance surface or event seam sees a request, and
// inside it the order is Host, then Origin, then CSRF — so each fixture is valid at every
// check ahead of the one it targets. `refuseListener` mints the verdict, so the code AND the
// layer are production's rather than this module's.
export const HOST_INVALID = at("LISTENER_HOST_INVALID", CONTROL_ROOM_LISTENER_LAYER);
export const CSRF_INVALID = at("LISTENER_CSRF_INVALID", CONTROL_ROOM_LISTENER_LAYER);
export const STREAM_INVALID =
  at("LISTENER_STREAM_REQUEST_INVALID", CONTROL_ROOM_LISTENER_LAYER);
export const AUTHORITY = "127.0.0.1:9876";
export const ORIGIN = "http://127.0.0.1:9876";
export const request = (headers: Record<string, string>): IncomingMessage =>
  hostile<IncomingMessage>({ headers });
export const verdictFor = (code: ListenerRefusalCode | null): unknown =>
  refuseListener(hostile<ListenerRefusalCode>(code));

// ── daemon ingress ────────────────────────────────────────────────────────────────────────
// This boundary spells its answering layer `refusedBy`. The read below renames the FIELD only:
// both values still come from production, and both are still compared by the assertion.
export const INGRESS_MALFORMED =
  at("RECOVERY_COMPLETION_REQUEST_MALFORMED", DAEMON_INGRESS_LAYER);
export const decodeCompletion = (input: unknown): unknown => {
  const result = decodeRecoveryCompleteRequest(input);
  if (result.ok) return { admitted: true };
  const { code, refusedBy } = result.refusal;
  return { code, layer: refusedBy };
};
export const jsonBytes = (value: unknown): Uint8Array => encode(JSON.stringify(value));

// ── control-room transport ────────────────────────────────────────────────────────────────
// Its two codes describe the ROUND TRIP only, so a daemon code appearing here would itself be
// the defect. The fetch double is the hostile input; the transport under test is the real one.
export const REQUEST_FAILED = at("TRANSPORT_REQUEST_FAILED", CONTROL_ROOM_TRANSPORT_LAYER);
export const RESPONSE_UNREADABLE =
  at("TRANSPORT_RESPONSE_UNREADABLE", CONTROL_ROOM_TRANSPORT_LAYER);
const clientWith = (fetch: FetchLike): ReturnType<typeof createControlRoomTransport> =>
  createControlRoomTransport({
    csrfToken: "token-1", fetch, origin: ORIGIN,
    sessionCredential: "cred-1", wireProtocolVersion: "moe-wire/1",
  });
export const severed = clientWith(async () => { throw new Error("connection refused"); });
export const garbled = clientWith(async () => new Response("<html>not json</html>"));
export const PAGE_REQUEST = Object.freeze({ projection: "timeline", subscriberId: "sub-1" });

// ── import ────────────────────────────────────────────────────────────────────────────────
// CANONICAL is the member exercised. DECODE answers earlier on the real pipeline, so every
// fixture is an ALREADY-DECODED record: one that had failed DECODE would be answered there.
export const UNCANONICAL =
  at("IMPORT_RECORD_UNCANONICAL", layerOf(IMPORT_REFUSAL_LAYERS, "CANONICAL"));
export const decodedRecord = (payload: Record<string, unknown>): LegacySourceRecord => ({
  declaredTime: null, kind: "task", legacyId: "legacy-1", payload, sourcePath: "a.json",
});

// ── mcp http shutdown ─────────────────────────────────────────────────────────────────────
export const RELEASE_FAILED =
  at("HTTP_SHUTDOWN_SESSION_RELEASE_FAILED", HTTP_SHUTDOWN_LAYER);
interface Attachment {
  readonly server: { close(): void };
  readonly transport: { close(): void };
}
const VERDICT = Object.freeze({
  ok: true as const, principalRef: "principal-1", sessionRef: "session-1",
});
const sessionPort: HttpSessionPort = {
  bindSession: (): void => undefined,
  closeSession: (): void => undefined,
  validateBearer: () => VERDICT,
};
const heldEntry = (sessionId: string): HttpSessionEntry<Attachment> => ({
  attachment: {
    server: { close: (): void => undefined },
    transport: { close: (): never => { throw new Error("session handle still held"); } },
  },
  sessionId,
  verdict: VERDICT,
});
/** Resolves WITH the raised error rather than rejecting, so both race legs settle and each
 *  side can be reported instead of one being discarded with the settle order. */
export const sweepHeldSessions = async (...sessionIds: readonly string[]): Promise<unknown> =>
  await closeAllDaemonSessions<Attachment>(
    createHttpSessionRegistry<Attachment>(), sessionPort, sessionIds.map(heldEntry),
  ).then(() => ({ admitted: true }), (cause: unknown) => cause);

// ── affordance surface ────────────────────────────────────────────────────────────────────
// The surface's only refusal fires when the session ledger will not read back as session
// facts. The listener guard refuses malformed REQUESTS long before this point, so the hostile
// input here is DURABLE: a committed `session.open` decision whose result is not session
// facts. A real SqliteEventStore under a hostile root, closed on every exit path.
export const LEDGER_UNREADABLE = at("SESSION_LEDGER_UNREADABLE", AFFORDANCE_SURFACE_LAYER);
const AFFORDANCE_PROJECT = "proj-hostile-transport";

export async function withPoisonedSurface<T>(
  label: string, work: (readSurface: () => unknown) => Promise<T>,
): Promise<T> {
  return await withHostileRoot(label, async (root) => {
    const store = SqliteEventStore.openForProject(join(root, "store.db"), AFFORDANCE_PROJECT);
    try {
      store.commitExpectedVersionDecision({
        commandKind: "session.open",
        committedResultBytes: encode('{"not":"session facts"}'),
        correlationId: "corr-hostile",
        decidedAt: "2026-08-16T12:00:00.000Z",
        events: [{
          eventId: "evt-hostile-1", eventType: "session.opened", payload: encode("{}"),
        }],
        expectedVersion: 0,
        key: {
          commandId: "cmd-hostile-1", principalId: "operator-local",
          projectId: AFFORDANCE_PROJECT,
        },
        requestBytes: encode("{}"),
        targetAggregateId: "session/sess-ui-1",
      });
      let minted = 0;
      const port = createAffordancePort({
        mintId: () => `afford-${String((minted += 1))}`,
        projectId: AFFORDANCE_PROJECT,
        store,
      });
      return await work(() => port.readSurface());
    } finally {
      // A held SQLite handle kills the vitest worker outright, so this closes on the THROW
      // path too — which is precisely the path a hostile case takes.
      store.close();
    }
  });
}

// ── coordination ──────────────────────────────────────────────────────────────────────────
// COORDINATION_LAYERS DECISION (plan step 2, option (a)): COVERED AT ITS OWN LAYER. The plan
// named `createCoordinationAdapter`, which is not in the declaring package — it lives in
// apps/daemon and is reached only by its own test. The real seam is `createCoordinationService`
// from packages/coordination, whose refusals carry a layer drawn from COORDINATION_LAYERS
// itself. `send` decodes first, then authenticates, then resolves the address, so each fixture
// below is valid at every layer ahead of the one it targets.
export const FORBIDDEN_FIELD =
  at("COORDINATION_FORBIDDEN_FIELD", layerOf(COORDINATION_LAYERS, "DECODE"));
export const AUTHENTICATION_FAILED =
  at("COORDINATION_AUTHENTICATION_FAILED", layerOf(COORDINATION_LAYERS, "AUTHENTICATION"));
export const RECIPIENT_UNKNOWN =
  at("COORDINATION_RECIPIENT_UNKNOWN", layerOf(COORDINATION_LAYERS, "ADDRESS"));
const CODER = Object.freeze({ effectId: null, role: "CODER" as const, sessionId: "sess-coder" });
const REVIEWER = Object.freeze({
  effectId: null, role: "REVIEWER" as const, sessionId: "sess-reviewer",
});
/** Throws on ANY access. Not a stand-in for the admission boundary — proof that admission
 *  refused before a single durable call was made. */
const untouchableMailbox = hostile<CoordinationDependencies["mailbox"]>(new Proxy({}, {
  get: (): never => { throw new Error("mailbox contacted: admission did not refuse first"); },
}));
const GRANTED = Object.freeze({
  capabilities: Object.freeze([
    coordinationCapability("SEND", CODER.sessionId, "EVENT"),
    coordinationCapability("READ", REVIEWER.sessionId),
  ]),
  ok: true,
  principalId: "principal-1",
  sessionId: REVIEWER.sessionId,
});
export const grantedBinding = (): unknown => GRANTED;
/** NOT frozen. `readBinding` admits only a frozen exact answer, so this is a forged credential
 *  presentation rather than a merely malformed one. */
export const forgedBinding = (): unknown =>
  ({ ...GRANTED, capabilities: [...GRANTED.capabilities] });

export const sendVia = (
  authenticate: CoordinationDependencies["authenticate"],
  recipientKnown: boolean,
  data: Record<string, unknown>,
): unknown => createCoordinationService({
  authenticate,
  mailbox: untouchableMailbox,
  now: () => 1_800_000_000_000,
  resolveEffectBinding: (query) =>
    Object.freeze({ bound: true, effectId: query.effectId, sessionId: query.sessionId }),
  resolveRecipient: (address) => Object.freeze({ known: recipientKnown, role: address.role }),
}).send({
  envelope: {
    advisory: null, correlationId: "corr-1", data, kind: "EVENT", messageId: "msg-1",
    recipient: CODER, sender: REVIEWER, ttlMilliseconds: 3_600_000,
  },
  presentation: { proofMaterial: "never-stored" },
  transportId: "transport-hostile",
});

// ── DIVERGENCE FIXTURES for four ROSTERED transport boundaries ─────────────────────────────
//
// WHY THESE EXIST BESIDE ARMS THAT ALREADY PASS. `LIVE_BUDGET_COMMITMENT_LAYER`,
// `PLAN_APPROVAL_BUILD_LAYER`, `PLAN_APPROVAL_TRANSPORT_LAYER` and `PAIRING_OPEN_LAYER` are
// rostered (`boundary-roster.security.ts:146,156,157,204`) and each already carries three arms
// in `recent-transport-hostile-cases.ts`. Those arms are REACHING, not divergent, and measuring
// them is what motivated this set:
//   * `casesFor` (:51-75) builds BEFORE, AFTER and RACE from ONE thunk, so all three run the
//     identical input and the arm name is a label rather than a schedule;
//   * the build and transport arms inject a FAKE builder/transport that hands back
//     `APPROVAL_COMMAND_BUILD_REFUSED` / `APPROVAL_TRANSPORT_REFUSED` — neither string occurs
//     anywhere in `apps/`, `packages/` or `adapters/`, so those arms assert only that
//     plan-approval echoes a code a fixture authored;
//   * the pairing arm passes an EMPTY body, so `JSON.parse` throws and the PARSE fence answers:
//     the byte cap and the exact roster are never reached;
//   * the budget arm calls `mapBudgetCommitmentAnswer(200, null)`, so `readBudgetCommitment`
//     and its transport catch are never entered.
// Every fixture below therefore drives the REAL seam and is built so that exactly ONE named
// guard can answer. Each expected code and layer was measured off production before it was
// written down, never copied from a plan.
//
// THEY ARE DELIBERATELY NOT ADDED TO `TRANSPORT_HOSTILE_CASES`.
// `transport-boundaries.security.ts:158` is `expect(races).toBe(ROSTER_TRANSPORT.length)` —
// EXACT equality, so a second RACE arm for an already-covered boundary reddens it. The
// separate export carries its own runner, its own recorded array and its own denominator.

// ── live budget commitment ────────────────────────────────────────────────────────────────
// The CODE is spelled as a literal and only the LAYER is read off the boundary's constant,
// which is this module's convention throughout and is load-bearing rather than stylistic:
// importing `BUDGET_COMMITMENT_TRANSPORT_FAILED_CODE` here would let ONE edit move both the
// expected and the observed side of the assertion, so a renamed code would stay green. The
// two literals below were measured off a live call before being written down.
export const BUDGET_TRANSPORT_FAILED =
  at("TRANSPORT_REQUEST_FAILED", LIVE_BUDGET_COMMITMENT_LAYER);
export const BUDGET_RESPONSE_INVALID =
  at("BUDGET_COMMITMENT_RESPONSE_INVALID", LIVE_BUDGET_COMMITMENT_LAYER);

const BUDGET_HEADERS: Readonly<Record<string, string>> =
  Object.freeze({ "content-type": "application/json" });

/** The POST never returns, so the client's OWN catch is the only mechanism that can answer:
 *  no response exists for the status gate or the shape gate to read. */
export const budgetTransportThrows = async (): Promise<unknown> =>
  await readBudgetCommitment(BUDGET_HEADERS, "run-budget-1", () => {
    throw new TypeError("fetch failed");
  });

/**
 * EXACT-SHAPE-INVALID BY ONE SURPLUS KEY, and that is the whole divergence.
 *
 * The frame is HTTP 200 so the status gate cannot answer; its three keys are neither
 * `{code, layer}` nor `{code, layer, outcome}` so `refusalFrom` cannot answer; and
 * `outcome`/`ref` are both exactly what a COMMITMENT carries, so nothing downstream of the
 * exact-key check has anything to object to. Loosening that one check admits the frame as a
 * COMMITMENT rather than moving the refusal to a neighbouring fence.
 */
export const budgetShapeInvalid = async (): Promise<unknown> =>
  await readBudgetCommitment(BUDGET_HEADERS, "run-budget-1", async () => new Response(
    JSON.stringify({ extra: "surplus", outcome: "COMMITMENT", ref: "commitment-ref-1" }),
    { status: 200 },
  ));

// ── plan approval: the BUILD layer ────────────────────────────────────────────────────────
/** Measured, not assumed: the GENERATED builder refuses an affordance whose `commandKind` is
 *  not the kind being built, and `createRuntimeError` resolves that to `INPUT_INVALID`. */
export const APPROVAL_BUILD_REFUSED = at("INPUT_INVALID", PLAN_APPROVAL_BUILD_LAYER);
export const APPROVAL_TRANSPORT_FAILED =
  at("TRANSPORT_REQUEST_FAILED", PLAN_APPROVAL_TRANSPORT_LAYER);
export const APPROVAL_TRANSPORT_UNREADABLE =
  at("TRANSPORT_RESPONSE_UNREADABLE", PLAN_APPROVAL_TRANSPORT_LAYER);

const APPROVAL_RUN_ID = "run-approval-1";

/** A daemon-shaped `NextAllowedCommand`. Only `commandKind` and `targetAggregateId` vary, so a
 *  case differs from a valid offer by exactly the fact it is testing. */
const approvalOffer = (
  commandKind: string, targetAggregateId: string,
): Readonly<Record<string, unknown>> => Object.freeze({
  commandId: "cmd-approval-1", commandKind, expectedVersion: 7, targetAggregateId,
});

/** A GENUINE affordance for the caller-authored `approval.decide`, bound to a FOREIGN run.
 *  Well-formed in every respect the daemon mints; wrong on the fact the builder checks. */
export const foreignRunOffer = (): Readonly<Record<string, unknown>> =>
  approvalOffer("approval.decide", "run-someone-else");

/** The same offer replayed with its kind dropped, so the builder cannot recognise a subject. */
export const kindlessOffer = (): Readonly<Record<string, unknown>> => Object.freeze({
  commandId: "cmd-approval-1", expectedVersion: 7, targetAggregateId: "run-someone-else",
});

/** A valid offer for the DAEMON-OWNED wire, bound to the run being approved: it passes the
 *  build layer, so a refusal downstream of it can only be the transport's. */
const boundApprovalOffer = (): Readonly<Record<string, unknown>> =>
  approvalOffer(APPROVAL_COMMAND_KIND, APPROVAL_RUN_ID);

/** UNREACHABLE ON PURPOSE. The build arms leave no second mechanism that could refuse: if the
 *  build guard stops answering, this throws instead of producing a tidier refusal. */
const unreachableTransport = Object.freeze({
  sendCommand: async (): Promise<never> => {
    throw new Error("transport contacted: the build layer did not refuse first");
  },
});

const approvalWire = (
  transport: PlanApprovalWire["transport"],
): PlanApprovalWire => Object.freeze({
  client: { commands: GENERATED_COMMAND_BUILDERS },
  sessionCredential: "session-credential-1",
  transport,
});

/** The REAL generated builder and the REAL port; only the offer is hostile. */
export const approvalBuild = async (
  offer: () => Readonly<Record<string, unknown>>,
): Promise<unknown> => await createPlanApprovalPort(approvalWire(unreachableTransport))
  .submit(Object.freeze({ affordance: offer(), runId: APPROVAL_RUN_ID }));

// ── plan approval: the TRANSPORT layer ────────────────────────────────────────────────────
/** The REAL `createControlRoomTransport`, so `delivered:false` is produced by the transport
 *  rather than declared by a stub. `fetch` is the only injected seam. */
const approvalTransport = (fetchLike: FetchLike): PlanApprovalWire["transport"] =>
  createControlRoomTransport({
    csrfToken: "csrf-1", fetch: fetchLike, origin: "http://127.0.0.1:0",
    sessionCredential: "session-credential-1", wireProtocolVersion: WIRE_PROTOCOL_VERSION,
  });

/**
 * The request is BUILT VALIDLY FIRST — a bound offer through the genuine builder — so the build
 * layer has already said yes and the undelivered round trip is the only refusal in play.
 */
export const approvalSend = async (fetchLike: FetchLike): Promise<unknown> =>
  await createPlanApprovalPort(approvalWire(approvalTransport(fetchLike)))
    .submit(Object.freeze({ affordance: boundApprovalOffer(), runId: APPROVAL_RUN_ID }));

/** Nothing is delivered: the round trip never completes. */
export const sendUnreachable: FetchLike = () => { throw new TypeError("fetch failed"); };
/** Delivered bytes that are not JSON, so the round trip completes and the BODY is unreadable —
 *  a different transport-owned code, which keeps the two transport arms distinguishable. */
export const sendUnreadable: FetchLike = async () =>
  new Response("<html>not json</html>", { status: 200 });

// ── pairing open completion ───────────────────────────────────────────────────────────────
export const PAIRING_BODY_TOO_LARGE = at("PAIRING_OPEN_BODY_TOO_LARGE", PAIRING_OPEN_LAYER);
export const PAIRING_REQUEST_INVALID = at("PAIRING_OPEN_REQUEST_INVALID", PAIRING_OPEN_LAYER);

/**
 * A body that satisfies the exact roster AND every shape rule, so the route's own two remaining
 * guards are the only things that can object to a variation of it. Checked AGAINST
 * `PAIRING_OPEN_KEYS` rather than trusted, so a roster change reddens the fixture instead of
 * silently leaving it testing a stale shape.
 */
const validPairingBody = (): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    clientKeyId: "client-key-1", commandId: "cmd-pair-1", correlationId: "corr-pair-1",
    credentialId: "cred-1", principalId: "principal-1", proof: { signatureHex: "ab" },
    publicKeySpkiHex: "cd", requestDigest: "ef", sessionId: "session-1",
    transportId: "transport-1", transportIds: ["transport-1"],
  };
  const declared = [...PAIRING_OPEN_KEYS].sort().join(",");
  if (Object.keys(body).sort().join(",") !== declared) {
    throw new Error(`pairing fixture no longer matches PAIRING_OPEN_KEYS: ${declared}`);
  }
  return body;
};

/** UNREACHABLE ON PURPOSE, exactly as `unreachableTransport` is: the authority is the only
 *  thing downstream of these guards, so a guard that stops answering throws here. */
const untouchableSessions = Object.freeze({
  openSession: (): never => {
    throw new Error("pairing authority contacted: the route guard did not refuse first");
  },
});

export const pairingComplete = (body: Uint8Array): unknown =>
  createPairingOpenCompletion(untouchableSessions).complete(body);

/**
 * OTHERWISE-VALID AND OVER-BOUND BY WHITESPACE ALONE. The padding is JSON-insignificant, so if
 * the byte cap stops answering the body parses, passes the exact roster and passes every shape
 * rule — the cap is the single mechanism separating this input from an accepted one.
 */
export const pairingOverBound = (): Uint8Array => {
  const padded = encode(
    `${JSON.stringify(validPairingBody())}${" ".repeat(PAIRING_OPEN_MAX_BODY_BYTES)}`,
  );
  if (padded.byteLength <= PAIRING_OPEN_MAX_BODY_BYTES) {
    throw new Error(`pairing over-bound fixture is not over the bound: ${padded.byteLength}`);
  }
  return padded;
};

/**
 * EXACT ROSTER DRIFT, UNDER THE BOUND, BY ONE SURPLUS KEY THAT SORTS LAST.
 *
 * `exactRoster` compares a sorted key list positionally after comparing its length. A key
 * sorting AFTER every rostered key leaves the positional comparison true for all eleven, so the
 * LENGTH clause alone refuses — and `shapeOk` has nothing to object to either. This is the
 * narrowest input that isolates the exact-arity guard from its own neighbouring clause.
 */
export const pairingRosterDrift = (): Uint8Array => {
  const drifted = encode(JSON.stringify({ ...validPairingBody(), zzSurplus: "unrostered" }));
  if (drifted.byteLength > PAIRING_OPEN_MAX_BODY_BYTES) {
    throw new Error(`pairing drift fixture must stay under the bound: ${drifted.byteLength}`);
  }
  return drifted;
};

// ── DIVERGENCE POSITIVE CONTROLS ──────────────────────────────────────────────────────────
//
// Each hostile fixture above claims to be "otherwise valid" — identical to an ACCEPTED input
// except for the one fact its named guard judges. That claim is what makes the arm a test of
// THAT guard rather than of the system's general willingness to refuse, and a claim only
// asserted in a comment is not asserted at all. These controls are the same inputs with the
// hostile fact REMOVED, so the runner can prove admission is otherwise reachable. If a control
// stops being admitted, the matching hostile arm has silently become a reaching fixture and the
// suite reddens here rather than passing on a refusal some neighbouring fence produced.
//
// They are deliberately NOT hostile cases: they are expected to SUCCEED, so they never enter
// the recorded outcomes or the no-admission invariant.

/** The surplus-key frame with the surplus key removed: an accepted COMMITMENT. */
export const budgetShapeValid = async (): Promise<unknown> =>
  await readBudgetCommitment(BUDGET_HEADERS, "run-budget-1", async () => new Response(
    JSON.stringify({ outcome: "COMMITMENT", ref: "commitment-ref-1" }), { status: 200 },
  ));

/** The same validly built approval, answered by a daemon that actually replies `ok`. Proves the
 *  build layer genuinely passes for `boundApprovalOffer`, so the transport arms are not
 *  silently grading the builder. */
export const approvalDelivered = async (): Promise<unknown> =>
  await approvalSend(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

/** The pairing body with neither the padding nor the surplus key: the authority is REACHED.
 *  A separate port is used because `untouchableSessions` throws by design. */
export const pairingAccepted = (): unknown => createPairingOpenCompletion({
  openSession: () => hostile({
    authority: { session: { sessionId: "session-1" } }, disposition: "DECIDED",
    ok: true, receipt: {},
  }),
}).complete(encode(JSON.stringify(validPairingBody())));
