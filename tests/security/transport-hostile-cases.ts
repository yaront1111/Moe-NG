/**
 * HOSTILE CASE TABLE — the authority-transport axis of the declared-boundary roster.
 *
 * NOT a `*.security.ts` file, deliberately: the lane collects that suffix, and a second suite
 * would split the whole-slice no-admission invariant across modules that `isolate: true` keeps
 * from ever seeing each other's outcomes. Every assertion lives in
 * `transport-boundaries.security.ts`; this table only SCHEDULES hostile input against
 * production and hands back whatever production returned, unread. It judges nothing, derives
 * no expected code, and reimplements no admission rule.
 *
 * Each entry names the roster constant it claims, its arm, the exact refusal it expects (built
 * in `transport-hostile-fixtures.ts` from the boundary's OWN exported constant, never from a
 * typed literal), and a thunk that runs the schedule under a bound.
 *
 * EVERY RACE IS HOSTILE ON BOTH LEGS, so both sides are expected to refuse. Neither side's
 * expectation consults the settle order, so no case depends on which leg wins.
 */

import {
  decideControlRoomOpen, decideDaemonDiscovery, decideDaemonStart,
} from "../../adapters/ide-contract/src/index.js";
import type {
  ControlRoomOpenEvidence, DaemonDiscoveryEvidence, DaemonStartEvidence,
} from "../../adapters/ide-contract/src/index.js";
import { shapeEffortObservation } from "../../apps/control-room/src/performance/effort-admission.js";
import { createEffortCollector } from "../../apps/control-room/src/performance/effort-collector.js";
import { walkTimeline } from "../../apps/control-room/src/timeline/timeline-page.js";
import { startDaemon } from "../../apps/daemon/src/daemon-entry.js";
import { observation } from "../../apps/daemon/src/http/event-stream-observation.js";
import {
  checkHeaders, readEventAcknowledgeRequest, readEventRequest,
} from "../../apps/daemon/src/http/http-listener-guards.js";
import { canonicalPayload } from "../../packages/import/src/import-canonical.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import type { RaceOutcome, RefusalExpectation } from "./hostile-harness.js";
import {
  ADMISSION_CONTRADICTORY, ASSETS_MISSING, AUTHENTICATION_FAILED, AUTHORITY, BOUND,
  COLLECTOR_CONTRADICTORY, CSRF_INVALID, CURSOR_NOT_ADVANCING, DISCOVERY_REFUSED,
  ENDPOINT_MISSING, EVIDENCE_MALFORMED, FORBIDDEN_FIELD, FREE_INTERACTION, HOST_INVALID,
  IDENTITY_ABSENT, INGRESS_MALFORMED, INTERVAL_OPEN_AWAY, LEDGER_UNREADABLE, LIMIT_INVALID,
  NO_PROVIDER, ORIGIN, PAGE_REQUEST, PROVIDER_THREW, READING_NOT_PROVIDED, RECIPIENT_UNKNOWN,
  RELEASE_FAILED, REQUEST_FAILED, RESPONSE_UNREADABLE, RESUME_INPUT_INVALID,
  RESUME_SESSION_MISMATCH, SOURCE_ABSENT, START_REFUSED,
  STREAM_INVALID, UNCANONICAL, UNPARSEABLE, decodeCompletion, decodedRecord, drained, encode,
  attemptResume, forgedBinding, garbled, grantedBinding, hostile, jsonBytes, orphanClose, request,
  resumePayload,
  revokedProvider, sendVia, severed, stalling, sweepHeldSessions, verdictFor,
  withPoisonedSurface,
} from "./transport-hostile-fixtures.js";

export type HostileArm = "AFTER" | "BEFORE" | "RACE";

interface CaseBase {
  readonly arm: HostileArm;
  /** The roster constant this case claims coverage of. */
  readonly boundary: string;
  readonly name: string;
}

export interface RefusalCase extends CaseBase {
  readonly arm: "AFTER" | "BEFORE";
  readonly expected: RefusalExpectation;
  readonly run: () => Promise<unknown>;
}

export interface RaceCase extends CaseBase {
  readonly arm: "RACE";
  readonly expected: { readonly left: RefusalExpectation; readonly right: RefusalExpectation };
  readonly run: () => Promise<RaceOutcome<unknown, unknown>>;
}

export type HostileCase = RaceCase | RefusalCase;

const both = (
  left: RefusalExpectation, right: RefusalExpectation,
): RaceCase["expected"] => ({ left, right });

const csrf = (token: string): Record<string, string> =>
  ({ host: AUTHORITY, origin: ORIGIN, "x-moe-csrf": token });

export const TRANSPORT_HOSTILE_CASES: readonly HostileCase[] = Object.freeze([
  { arm: "BEFORE", boundary: "IDE_ADAPTER_LAYER", expected: EVIDENCE_MALFORMED,
    name: "forged evidence with no recognised status is refused by the contract",
    run: async () => (await probeBefore(BOUND,
      async () => decideDaemonDiscovery(hostile<DaemonDiscoveryEvidence>({ status: "FORGED" })),
      async () => decideDaemonStart(hostile<DaemonStartEvidence>({ status: "" })))).probe },

  { arm: "AFTER", boundary: "IDE_ADAPTER_LAYER", expected: EVIDENCE_MALFORMED,
    name: "evidence replayed as a bare null is refused, never dereferenced",
    run: async () => (await probeAfter(BOUND,
      async () => decideDaemonDiscovery({ status: "NOT_LISTENING" }),
      async () => decideControlRoomOpen(hostile<ControlRoomOpenEvidence>(null)))).probe },

  { arm: "RACE", boundary: "IDE_ADAPTER_LAYER",
    expected: both(EVIDENCE_MALFORMED, EVIDENCE_MALFORMED),
    name: "two malformed decisions contend and neither is admitted",
    run: async () => await probeRacing(BOUND,
      async () => decideDaemonStart(hostile<DaemonStartEvidence>(undefined)),
      async () => decideControlRoomOpen(hostile<ControlRoomOpenEvidence>({ assets: "FORGED" }))) },

  { arm: "BEFORE", boundary: "IDE_ADAPTER_LAYERS", expected: DISCOVERY_REFUSED,
    name: "a refusing discovery port answers as itself, not as the contract",
    run: async () => (await probeBefore(BOUND,
      async () => decideDaemonDiscovery({ detail: "probe denied", status: "REFUSED" }),
      async () => decideDaemonStart({ detail: "spawn denied", status: "REFUSED" }))).probe },

  { arm: "AFTER", boundary: "IDE_ADAPTER_LAYERS", expected: ENDPOINT_MISSING,
    name: "an endpoint withdrawn after listening was claimed stays UNKNOWN",
    run: async () => (await probeAfter(BOUND,
      async () => decideDaemonDiscovery({ endpoint: "http://127.0.0.1:9876", status: "LISTENING" }),
      async () => decideDaemonDiscovery({ endpoint: "   ", status: "LISTENING" }))).probe },

  { arm: "RACE", boundary: "IDE_ADAPTER_LAYERS", expected: both(ASSETS_MISSING, START_REFUSED),
    name: "a stripped asset set and a denied spawn refuse at their own ports",
    run: async () => await probeRacing(BOUND,
      async () => decideControlRoomOpen({ assets: "ABSENT", detail: "assets stripped" }),
      async () => decideDaemonStart({ detail: "spawn denied", status: "REFUSED" })) },

  { arm: "BEFORE", boundary: "EFFORT_ADMISSION_LAYER", expected: SOURCE_ABSENT,
    name: "an observation stating no source is refused before anything is recorded",
    run: async () => (await probeBefore(BOUND,
      async () => shapeEffortObservation({
        commandId: "cmd-1", observedAt: 1, type: "FREE_INTERACTION" }),
      async () => shapeEffortObservation(null))).probe },

  { arm: "AFTER", boundary: "EFFORT_ADMISSION_LAYER", expected: UNPARSEABLE,
    name: "a derived field smuggled onto a replayed observation is refused, not ignored",
    run: async () => (await probeAfter(BOUND,
      async () => shapeEffortObservation({ ...FREE_INTERACTION }),
      async () => shapeEffortObservation({ ...FREE_INTERACTION, durationMs: 5_000 }))).probe },

  { arm: "RACE", boundary: "EFFORT_ADMISSION_LAYER",
    expected: both(IDENTITY_ABSENT, ADMISSION_CONTRADICTORY),
    name: "an unattributed demand and a self-declared ADDITIONAL both refuse",
    run: async () => await probeRacing(BOUND,
      async () => shapeEffortObservation({
        demandedKind: "APPROVE", observedAt: 1, source: "OPERATOR_REPORT",
        type: "DEMANDED_DECISION" }),
      async () => shapeEffortObservation({
        commandId: "cmd-2", demandedKind: "ADDITIONAL", observedAt: 2,
        source: "OPERATOR_REPORT", type: "DEMANDED_DECISION" })) },

  { arm: "BEFORE", boundary: "EFFORT_COLLECTOR_LAYER", expected: COLLECTOR_CONTRADICTORY,
    name: "a close for an interval nobody opened is refused, never back-dated",
    run: async () => {
      const machine = createEffortCollector();
      return (await probeBefore(BOUND,
        async () => machine.record(orphanClose(10)),
        async () => machine.observations())).probe;
    } },

  { arm: "AFTER", boundary: "EFFORT_COLLECTOR_LAYER", expected: COLLECTOR_CONTRADICTORY,
    name: "an observation appended once the account was sealed is refused",
    run: async () => {
      const machine = createEffortCollector();
      return (await probeAfter(BOUND,
        async () => machine.seal(),
        async () => machine.record({ ...FREE_INTERACTION }))).probe;
    } },

  { arm: "RACE", boundary: "EFFORT_COLLECTOR_LAYER",
    expected: both(COLLECTOR_CONTRADICTORY, COLLECTOR_CONTRADICTORY),
    name: "two orphan closes contend on one interval kind and neither is admitted",
    run: async () => {
      const machine = createEffortCollector();
      return await probeRacing(BOUND,
        async () => machine.record(orphanClose(20)),
        async () => machine.record(orphanClose(30)));
    } },

  { arm: "BEFORE", boundary: "EFFORT_LAYERS", expected: UNPARSEABLE,
    name: "a malformed interval kind is answered by the admission member, not the collector",
    run: async () => (await probeBefore(BOUND,
      async () => shapeEffortObservation({
        commandId: "cmd-1", intervalKind: "SIDEWAYS", observedAt: 1,
        source: "CONTROL_ROOM_DOM", type: "INTERVAL_OPEN" }),
      async () => createEffortCollector().observations())).probe },

  { arm: "AFTER", boundary: "EFFORT_LAYERS", expected: COLLECTOR_CONTRADICTORY,
    name: "a well-formed record raised past the seal is answered by the collector member",
    run: async () => {
      const machine = createEffortCollector();
      return (await probeAfter(BOUND,
        async () => machine.seal(),
        async () => machine.record({ ...INTERVAL_OPEN_AWAY }))).probe;
    } },

  { arm: "RACE", boundary: "EFFORT_LAYERS", expected: both(SOURCE_ABSENT, COLLECTOR_CONTRADICTORY),
    name: "an admission refusal and a collector refusal stay on their own members",
    run: async () => {
      const machine = createEffortCollector();
      return await probeRacing(BOUND,
        async () => shapeEffortObservation({ observedAt: 1, type: "INTERVAL_OPEN" }),
        async () => machine.record({
          commandId: "cmd-1", intervalKind: "AWAY", observedAt: 3,
          source: "CONTROL_ROOM_DOM", type: "INTERVAL_CLOSE" }));
    } },

  { arm: "BEFORE", boundary: "TIMELINE_REFUSAL_LAYERS", expected: LIMIT_INVALID,
    name: "a forged row bound is refused at INPUT before any page is fetched",
    run: async () => (await probeBefore(BOUND,
      async () => walkTimeline({ filter: null, maxRows: 0, source: stalling, startCursor: null }),
      async () => walkTimeline({
        filter: null, maxRows: Number.NaN, source: stalling, startCursor: null }))).probe },

  { arm: "AFTER", boundary: "TIMELINE_REFUSAL_LAYERS", expected: CURSOR_NOT_ADVANCING,
    name: "a source still claiming more once the cursor stopped advancing is refused",
    run: async () => (await probeAfter(BOUND,
      async () => walkTimeline({ filter: null, maxRows: 5, source: drained, startCursor: null }),
      async () => walkTimeline({
        filter: null, maxRows: 5, source: stalling, startCursor: 42 }))).probe },

  { arm: "RACE", boundary: "TIMELINE_REFUSAL_LAYERS",
    expected: both(LIMIT_INVALID, CURSOR_NOT_ADVANCING),
    name: "a forged bound and a stalling source contend; neither walks a row",
    run: async () => await probeRacing(BOUND,
      async () => walkTimeline({
        filter: null, maxRows: Number.NaN, source: stalling, startCursor: null }),
      async () => walkTimeline({ filter: null, maxRows: 3, source: stalling, startCursor: 7 })) },

  { arm: "BEFORE", boundary: "DAEMON_ENTRY_LAYER", expected: NO_PROVIDER,
    name: "a start with no dependency provider refuses before any socket is bound",
    run: async () => (await probeBefore(BOUND,
      async () => await startDaemon({}),
      async () => await startDaemon({ dependencies: null }))).probe },

  { arm: "AFTER", boundary: "DAEMON_ENTRY_LAYER", expected: PROVIDER_THREW,
    name: "a provider that throws once its authority is withdrawn refuses at entry",
    run: async () => (await probeAfter(BOUND,
      async () => await startDaemon({ dependencies: null }),
      async () => await startDaemon({ dependencies: revokedProvider }))).probe },

  { arm: "RACE", boundary: "DAEMON_ENTRY_LAYER", expected: both(NO_PROVIDER, PROVIDER_THREW),
    name: "two concurrent starts contend and neither yields a listening daemon",
    run: async () => await probeRacing(BOUND,
      async () => await startDaemon({}),
      async () => await startDaemon({ dependencies: revokedProvider })) },

  { arm: "BEFORE", boundary: "EVENT_STREAM_LAYER", expected: READING_NOT_PROVIDED,
    name: "a forged reading object is refused rather than unwrapped into a value",
    run: async () => (await probeBefore(BOUND,
      async () => observation("DAEMON_SEAM", "DAEMON_WALL_CLOCK", {
        value: "2026-01-01T00:00:00.000Z" }).reading,
      async () => observation(
        "STORE_LEDGER", "STORE_COMMIT_CLOCK", "2026-01-01T00:00:00.000Z"))).probe },

  { arm: "AFTER", boundary: "EVENT_STREAM_LAYER", expected: READING_NOT_PROVIDED,
    name: "a reading blanked once the source stopped stating it stays UNKNOWN",
    run: async () => (await probeAfter(BOUND,
      async () => observation("STORE_LEDGER", "STORE_COMMIT_CLOCK", "2026-01-01T00:00:00.000Z"),
      async () => observation("STORE_LEDGER", "STORE_COMMIT_CLOCK", "").reading)).probe },

  { arm: "RACE", boundary: "EVENT_STREAM_LAYER",
    expected: both(READING_NOT_PROVIDED, READING_NOT_PROVIDED),
    name: "two clocks observed concurrently never borrow each other's reading",
    run: async () => await probeRacing(BOUND,
      async () => observation("DAEMON_SEAM", "DAEMON_WALL_CLOCK", null).reading,
      async () => observation("STORE_LEDGER", "STORE_COMMIT_CLOCK", 0).reading) },

  { arm: "BEFORE", boundary: "EVENT_STREAM_RESUME_LAYER", expected: RESUME_INPUT_INVALID,
    name: "a cursor omitted before dispatch refuses without consulting durable subscription state",
    run: async () => (await probeBefore(BOUND,
      async () => attemptResume({
        projection: "moe.board", subscriberId: "security-event-subscriber" }),
      async () => attemptResume(resumePayload(), "crossed-target"))).probe },

  { arm: "AFTER", boundary: "EVENT_STREAM_RESUME_LAYER", expected: RESUME_SESSION_MISMATCH,
    name: "a subscriber swapped after payload formation cannot borrow the authenticated session",
    run: async () => (await probeAfter(BOUND,
      async () => attemptResume({ ...resumePayload(), extra: "smuggled" }),
      async () => attemptResume(resumePayload("forged-subscriber"), "forged-subscriber"))).probe },

  { arm: "RACE", boundary: "EVENT_STREAM_RESUME_LAYER",
    expected: both(RESUME_INPUT_INVALID, RESUME_SESSION_MISMATCH),
    name: "a malformed cursor and crossed subscriber race; neither reaches the subscription store",
    run: async () => await probeRacing(BOUND,
      async () => attemptResume({
        ...resumePayload(), presentedCursor: { generation: 0, position: "0" } }),
      async () => attemptResume(resumePayload("crossed-subscriber"), "crossed-subscriber")) },

  { arm: "BEFORE", boundary: "CONTROL_ROOM_LISTENER_LAYER", expected: HOST_INVALID,
    name: "a forged Host is refused before Origin or CSRF are ever consulted",
    run: async () => verdictFor((await probeBefore(BOUND,
      async () => checkHeaders(request({
        host: "evil.example:9876", origin: ORIGIN, "x-moe-csrf": "token-1" }),
        AUTHORITY, ORIGIN, "token-1"),
      async () => checkHeaders(request({ host: AUTHORITY, "x-moe-csrf": "token-1" }),
        AUTHORITY, ORIGIN, "token-1"))).probe) },

  { arm: "AFTER", boundary: "CONTROL_ROOM_LISTENER_LAYER", expected: CSRF_INVALID,
    name: "a CSRF token replayed after rotation is refused",
    run: async () => verdictFor((await probeAfter(BOUND,
      async () => checkHeaders(request(csrf("token-1")), AUTHORITY, ORIGIN, "token-1"),
      async () => checkHeaders(request(csrf("token-1")), AUTHORITY, ORIGIN, "token-2"))).probe) },

  { arm: "RACE", boundary: "CONTROL_ROOM_LISTENER_LAYER",
    expected: both(STREAM_INVALID, STREAM_INVALID),
    name: "two malformed bodies are read concurrently and neither becomes a request",
    run: async () => await probeRacing(BOUND,
      async () => verdictFor(readEventRequest(
        encode('{"projection":1,"subscriberId":"sub-1"}')) === null
        ? "LISTENER_STREAM_REQUEST_INVALID" : null),
      async () => verdictFor(readEventAcknowledgeRequest(
        encode('{"subscriberId":"sub-1"}')) === null
        ? "LISTENER_STREAM_REQUEST_INVALID" : null)) },

  { arm: "BEFORE", boundary: "DAEMON_INGRESS_LAYER", expected: INGRESS_MALFORMED,
    name: "a completion request that is not bytes at all is refused at ingress",
    run: async () => (await probeBefore(BOUND,
      async () => decodeCompletion({ payload: { reconciliationDigest: "a".repeat(64) } }),
      async () => decodeCompletion(jsonBytes({ payload: null })))).probe },

  { arm: "AFTER", boundary: "DAEMON_INGRESS_LAYER", expected: INGRESS_MALFORMED,
    name: "a forged digest replayed inside a well-shaped envelope is refused",
    run: async () => (await probeAfter(BOUND,
      async () => decodeCompletion(jsonBytes({ payload: {} })),
      async () => decodeCompletion(
        jsonBytes({ payload: { reconciliationDigest: "not-a-digest" } })))).probe },

  { arm: "RACE", boundary: "DAEMON_INGRESS_LAYER",
    expected: both(INGRESS_MALFORMED, INGRESS_MALFORMED),
    name: "two forged completion requests contend and neither decodes",
    run: async () => await probeRacing(BOUND,
      async () => decodeCompletion(
        jsonBytes({ extra: 1, payload: { reconciliationDigest: "b".repeat(64) } })),
      async () => decodeCompletion(new Uint8Array([0x7b, 0x00]))) },

  { arm: "BEFORE", boundary: "CONTROL_ROOM_TRANSPORT_LAYER", expected: REQUEST_FAILED,
    name: "a request that never reaches the daemon invents no daemon answer",
    run: async () => (await probeBefore(BOUND,
      async () => await severed.readEventPage({ ...PAGE_REQUEST }),
      async () => await severed.readDocumentDossier())).probe },

  { arm: "AFTER", boundary: "CONTROL_ROOM_TRANSPORT_LAYER", expected: RESPONSE_UNREADABLE,
    name: "an unreadable answer returned after delivery is refused, not parsed",
    run: async () => (await probeAfter(BOUND,
      async () => await garbled.readDocumentDossier(),
      async () => await garbled.acknowledgeEventPage({
        presentedCursor: { generation: 1, position: "42" }, subscriberId: "sub-1" }))).probe },

  { arm: "RACE", boundary: "CONTROL_ROOM_TRANSPORT_LAYER",
    expected: both(REQUEST_FAILED, RESPONSE_UNREADABLE),
    name: "a severed and a garbled round trip contend and neither is delivered",
    run: async () => await probeRacing(BOUND,
      async () => await severed.readEventPage({ ...PAGE_REQUEST }),
      async () => await garbled.readEventPage({
        projection: "timeline", subscriberId: "sub-2" })) },

  { arm: "BEFORE", boundary: "IMPORT_REFUSAL_LAYERS", expected: UNCANONICAL,
    name: "bytes canonical JSON cannot represent are refused before any digest",
    run: async () => (await probeBefore(BOUND,
      async () => canonicalPayload(decodedRecord({ blob: new Uint8Array([1, 2, 3]) })),
      async () => canonicalPayload(decodedRecord({ title: "ok" })))).probe },

  { arm: "AFTER", boundary: "IMPORT_REFUSAL_LAYERS", expected: UNCANONICAL,
    name: "a non-safe integer smuggled in after a clean record is refused",
    run: async () => (await probeAfter(BOUND,
      async () => canonicalPayload(decodedRecord({ title: "ok" })),
      async () => canonicalPayload(
        decodedRecord({ count: Number.MAX_SAFE_INTEGER + 2 })))).probe },

  { arm: "RACE", boundary: "IMPORT_REFUSAL_LAYERS", expected: both(UNCANONICAL, UNCANONICAL),
    name: "two uncanonicalisable payloads contend and neither yields a digestable string",
    run: async () => await probeRacing(BOUND,
      async () => canonicalPayload(decodedRecord({ when: Number.NaN })),
      async () => canonicalPayload(decodedRecord({ blob: new Uint8Array([9]) }))) },

  { arm: "BEFORE", boundary: "HTTP_SHUTDOWN_LAYER", expected: RELEASE_FAILED,
    name: "a transport that refuses to close is reported, never swallowed",
    run: async () => (await probeBefore(BOUND,
      async () => await sweepHeldSessions("mcp-1"),
      async () => await sweepHeldSessions())).probe },

  { arm: "AFTER", boundary: "HTTP_SHUTDOWN_LAYER", expected: RELEASE_FAILED,
    name: "a session still held on a second sweep keeps raising the shutdown code",
    run: async () => (await probeAfter(BOUND,
      async () => await sweepHeldSessions("mcp-2"),
      async () => await sweepHeldSessions("mcp-2"))).probe },

  { arm: "RACE", boundary: "HTTP_SHUTDOWN_LAYER", expected: both(RELEASE_FAILED, RELEASE_FAILED),
    name: "two concurrent sweeps over held sessions both fail closed",
    run: async () => await probeRacing(BOUND,
      async () => await sweepHeldSessions("mcp-3"),
      async () => await sweepHeldSessions("mcp-4")) },

  { arm: "BEFORE", boundary: "AFFORDANCE_SURFACE_LAYER", expected: LEDGER_UNREADABLE,
    name: "a surface over a session ledger that will not read back refuses outright",
    run: async () => await withPoisonedSurface("affordance-before", async (readSurface) =>
      (await probeBefore(BOUND, async () => readSurface(), async () => readSurface())).probe) },

  { arm: "AFTER", boundary: "AFFORDANCE_SURFACE_LAYER", expected: LEDGER_UNREADABLE,
    name: "a second read after the first refusal does not recover the surface's authority",
    run: async () => await withPoisonedSurface("affordance-after", async (readSurface) =>
      (await probeAfter(BOUND, async () => readSurface(), async () => readSurface())).probe) },

  { arm: "RACE", boundary: "AFFORDANCE_SURFACE_LAYER",
    expected: both(LEDGER_UNREADABLE, LEDGER_UNREADABLE),
    name: "two concurrent surface reads contend and neither offers a command",
    run: async () => await withPoisonedSurface("affordance-race", async (readSurface) =>
      await probeRacing(BOUND, async () => readSurface(), async () => readSurface())) },

  { arm: "BEFORE", boundary: "COORDINATION_LAYERS", expected: FORBIDDEN_FIELD,
    name: "an envelope smuggling a credential field is refused at decode, before any auth",
    run: async () => (await probeBefore(BOUND,
      async () => sendVia(grantedBinding, true, { token: "stolen" }),
      async () => sendVia(grantedBinding, true, { password: "stolen" }))).probe },

  { arm: "AFTER", boundary: "COORDINATION_LAYERS", expected: AUTHENTICATION_FAILED,
    name: "a binding presented unfrozen after a grant is a forgery, not a weaker grant",
    run: async () => (await probeAfter(BOUND,
      async () => sendVia(grantedBinding, false, { note: "first" }),
      async () => sendVia(forgedBinding, true, { note: "replayed" }))).probe },

  { arm: "RACE", boundary: "COORDINATION_LAYERS",
    expected: both(AUTHENTICATION_FAILED, RECIPIENT_UNKNOWN),
    name: "a forged binding and a revoked recipient contend and neither is accepted",
    run: async () => await probeRacing(BOUND,
      async () => sendVia(forgedBinding, true, { note: "left" }),
      async () => sendVia(grantedBinding, false, { note: "right" })) },
]);
