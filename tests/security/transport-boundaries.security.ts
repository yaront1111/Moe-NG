/**
 * HOSTILE COVERAGE — the AUTHORITY TRANSPORT axis of the declared-boundary roster.
 *
 * Thirteen of the roster's fifteen `axis: "transport"` boundaries are covered here. The two
 * that can only reach their refusal through a durable SQLite store live in the sibling file
 * `transport-boundaries-store.security.ts` and are named in `STORE_BACKED` below. The split is
 * the 400-line rail, not a scope decision: BOTH files derive their expected boundary set from
 * the SAME roster bytes, so adding a transport entry to the roster reddens one of them.
 *
 * WHY THE ROSTER IS READ AS TEXT rather than imported. `boundary-roster.security.ts` is a
 * `*.security.ts` file whose suites register at module scope, so importing it would
 * re-register its 31 cases inside this file and this file would inherit its verdicts.
 * Reading its committed bytes takes the roster's authority without its test registration, and
 * the parse asserts a POSITIVE match count so a regex that silently matched nothing reddens.
 *
 * EVERY REFUSAL GOES THROUGH `assertRefusedWith(actual, {code, layer})`. The layer is required
 * by the helper's type AND re-checked at its runtime, because several of these boundaries sit
 * behind another: a code-only assertion stays green the moment a different layer answers
 * first. Every expected layer below is taken from the boundary's OWN exported constant.
 *
 * EVERY RACE IS HOSTILE ON BOTH LEGS, so each asserts ZERO admissions rather than the general
 * "exactly one admitted" shape: with two hostile inputs contending at one admission point a
 * single admission is already the defect. Each side is asserted INDEPENDENTLY, so a
 * double-admit cannot hide inside an aggregate, and no case depends on which leg wins.
 */

import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  IDE_ADAPTER_LAYER,
  IDE_ADAPTER_LAYERS,
  decideControlRoomOpen,
  decideDaemonDiscovery,
  decideDaemonStart,
} from "../../adapters/ide-contract/src/index.js";
import type {
  ControlRoomOpenEvidence,
  DaemonDiscoveryEvidence,
  DaemonStartEvidence,
} from "../../adapters/ide-contract/src/index.js";
import { shapeEffortObservation } from "../../apps/control-room/src/performance/effort-admission.js";
import { createEffortCollector } from "../../apps/control-room/src/performance/effort-collector.js";
import {
  EFFORT_ADMISSION_LAYER,
  EFFORT_COLLECTOR_LAYER,
  EFFORT_LAYERS,
} from "../../apps/control-room/src/performance/effort-records.js";
import { TIMELINE_REFUSAL_LAYERS } from "../../apps/control-room/src/timeline/timeline-contract.js";
import { walkTimeline } from "../../apps/control-room/src/timeline/timeline-page.js";
import type { TimelineSourcePage } from "../../apps/control-room/src/timeline/timeline-page.js";
import { DAEMON_ENTRY_LAYER, startDaemon } from "../../apps/daemon/src/daemon-entry.js";
import {
  EVENT_STREAM_LAYER,
  observation,
} from "../../apps/daemon/src/http/event-stream-observation.js";
import {
  CONTROL_ROOM_LISTENER_LAYER,
  checkHeaders,
  readEventAcknowledgeRequest,
  readEventRequest,
  refuse as refuseListener,
} from "../../apps/daemon/src/http/http-listener-guards.js";
import {
  DAEMON_INGRESS_LAYER,
  decodeRecoveryCompleteRequest,
} from "../../apps/daemon/src/recovery/recovery-completion-evidence.js";
import {
  CONTROL_ROOM_TRANSPORT_LAYER,
  createControlRoomTransport,
} from "../../packages/control-room-client/src/client-transport.js";
import type { FetchLike } from "../../packages/control-room-client/src/client-transport.js";
import { canonicalPayload } from "../../packages/import/src/import-canonical.js";
import type { LegacySourceRecord } from "../../packages/import/src/import-canonical.js";
import { IMPORT_REFUSAL_LAYERS } from "../../packages/import/src/import-contract.js";
import {
  HTTP_SHUTDOWN_LAYER,
  closeAllDaemonSessions,
} from "../../packages/mcp/src/http/http-shutdown.js";
import { createHttpSessionRegistry } from "../../packages/mcp/src/http/http-session.js";
import type {
  HttpSessionEntry,
  HttpSessionPort,
} from "../../packages/mcp/src/http/http-session.js";
import {
  assertRefusedWith,
  cleanupHostileRoots,
  probeAfter,
  probeBefore,
  probeRacing,
} from "./hostile-harness.js";
import type { HostileBound, LegOutcome, RefusalExpectation } from "./hostile-harness.js";

// ── roster, registry and bound ────────────────────────────────────────────────────────────

/** Delegated to the sibling file: both need a real `SqliteEventStore` to reach a refusal. */
const STORE_BACKED: readonly string[] = Object.freeze([
  "AFFORDANCE_SURFACE_LAYER",
  "COORDINATION_LAYERS",
]);

const ROSTER_PATH = fileURLToPath(new URL("./boundary-roster.security.ts", import.meta.url));
const TRANSPORT_ENTRY =
  /constant:\s*"([A-Z0-9_]+)",\s*file:\s*"[^"]+",\s*axis:\s*"transport"/gu;

/** The roster's own bytes are the authority on this axis; nothing here re-tags a boundary. */
function transportRoster(): readonly string[] {
  const source = readFileSync(ROSTER_PATH, "utf8");
  return Object.freeze([...source.matchAll(TRANSPORT_ENTRY)].map((match) => match[1] ?? ""));
}

const ROSTER_TRANSPORT = transportRoster();
const OWNED = ROSTER_TRANSPORT.filter((constant) => !STORE_BACKED.includes(constant));

type Arm = "AFTER" | "BEFORE" | "RACE";

interface Admission {
  readonly admitted: boolean;
  readonly arm: Arm;
  readonly boundary: string;
}

/** Every case appends here. The swept boundary set and the no-admission invariant are both
 *  computed FROM this list, so a case cannot be counted as coverage without being checked. */
const ADMISSIONS: Admission[] = [];

/**
 * Two seconds. `MAX_BOUND_MS` is 2**31-1, the `setTimeout` clamp boundary, so a bound at or
 * above it would clamp to 1ms and race nothing; every bound here is four orders of magnitude
 * below it. The failure mode guarded against is a HANG — this lane runs `fileParallelism:
 * false`, so one unbounded wait stalls every file after it and reports no verdict at all.
 */
const BOUND: HostileBound = Object.freeze({ label: "transport-boundary", timeoutMs: 2_000 });

function refused(
  boundary: string, arm: Arm, actual: unknown, expected: RefusalExpectation,
): void {
  assertRefusedWith(actual, expected);
  ADMISSIONS.push({ admitted: false, arm, boundary });
}

/** Asserted PER SIDE. An aggregate assertion over a race can hide a double admit, which is
 *  the one defect a race case exists to find. */
function refusedSide<T>(
  boundary: string, side: LegOutcome<T>, expected: RefusalExpectation,
): void {
  expect(side.status).toBe("fulfilled");
  assertRefusedWith(side.status === "fulfilled" ? side.value : side.reason, expected);
  ADMISSIONS.push({ admitted: false, arm: "RACE", boundary });
}

/** Reads a layer off the boundary's OWN declared constant. A layer that stops being declared
 *  there reddens here rather than surviving as a string literal nobody rechecks. */
function layerOf<T extends string>(declared: readonly T[], name: string): T {
  const found = declared.find((layer) => layer === name);
  if (found === undefined) {
    throw new Error(`${name} is no longer declared by its boundary constant`);
  }
  return found;
}

const hostile = <T,>(value: unknown): T => value as T;

afterAll(() => {
  // No case here opens a hostile root — every surface is driven in process — but the sweep is
  // registered anyway so a root added later cannot leak into the next file in this lane.
  cleanupHostileRoots();
});

// ── IDE_ADAPTER_LAYER ─────────────────────────────────────────────────────────────────────
// The contract's own refusals. Evidence crosses from a foreign editor runtime, so IDE_ADAPTER
// itself answers; every fixture is shaped with an UNRECOGNISED status so the port arms, which
// need a known one, cannot answer first.
describe("IDE_ADAPTER_LAYER", () => {
  const boundary = "IDE_ADAPTER_LAYER";
  const malformed: RefusalExpectation = { code: "EVIDENCE_MALFORMED", layer: IDE_ADAPTER_LAYER };

  it("BEFORE — forged evidence with no recognised status is refused by the contract", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => decideDaemonDiscovery(hostile<DaemonDiscoveryEvidence>({ status: "FORGED" })),
      async () => decideDaemonStart(hostile<DaemonStartEvidence>({ status: "" })),
    );
    refused(boundary, "BEFORE", outcome.probe, malformed);
    refused(boundary, "BEFORE", outcome.effect, malformed);
  });

  it("AFTER — evidence replayed as a bare null is refused, never dereferenced", async () => {
    const outcome = await probeAfter(
      BOUND,
      async () => decideDaemonDiscovery({ status: "NOT_LISTENING" }),
      async () => decideControlRoomOpen(hostile<ControlRoomOpenEvidence>(null)),
    );
    expect(outcome.effect.outcome).toBe("OK");
    refused(boundary, "AFTER", outcome.probe, malformed);
  });

  it("RACE — two malformed decisions contend and neither is admitted", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => decideDaemonStart(hostile<DaemonStartEvidence>(undefined)),
      async () => decideControlRoomOpen(hostile<ControlRoomOpenEvidence>({ assets: "FORGED" })),
    );
    refusedSide(boundary, outcome.left, malformed);
    refusedSide(boundary, outcome.right, malformed);
  });
});

// ── IDE_ADAPTER_LAYERS ────────────────────────────────────────────────────────────────────
// The same surface answering as a PORT. Every fixture carries a RECOGNISED status so the
// contract's malformed arm above cannot answer first and the declared port layer must appear.
describe("IDE_ADAPTER_LAYERS", () => {
  const boundary = "IDE_ADAPTER_LAYERS";
  const discoveryPort = layerOf(IDE_ADAPTER_LAYERS, "DAEMON_DISCOVERY_PORT");
  const startPort = layerOf(IDE_ADAPTER_LAYERS, "DAEMON_START_PORT");
  const openPort = layerOf(IDE_ADAPTER_LAYERS, "CONTROL_ROOM_OPEN_PORT");

  it("BEFORE — refusing ports answer as themselves, not as the contract", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => decideDaemonDiscovery({ detail: "probe denied", status: "REFUSED" }),
      async () => decideDaemonStart({ detail: "spawn denied", status: "REFUSED" }),
    );
    refused(boundary, "BEFORE", outcome.probe, {
      code: "DAEMON_DISCOVERY_REFUSED", layer: discoveryPort,
    });
    refused(boundary, "BEFORE", outcome.effect, {
      code: "DAEMON_START_REFUSED", layer: startPort,
    });
  });

  it("AFTER — an endpoint withdrawn after listening was claimed stays UNKNOWN", async () => {
    const outcome = await probeAfter(
      BOUND,
      async () => decideDaemonDiscovery({ endpoint: "http://127.0.0.1:9876", status: "LISTENING" }),
      async () => decideDaemonDiscovery({ endpoint: "   ", status: "LISTENING" }),
    );
    expect(outcome.effect.outcome).toBe("OK");
    refused(boundary, "AFTER", outcome.probe, {
      code: "DAEMON_ENDPOINT_MISSING", layer: layerOf(IDE_ADAPTER_LAYERS, IDE_ADAPTER_LAYER),
    });
  });

  it("RACE — a stripped asset set and a denied browser both refuse at the open port", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => decideControlRoomOpen({ assets: "ABSENT", detail: "assets stripped" }),
      async () => decideControlRoomOpen({
        assets: "PRESENT",
        browser: { detail: "browser denied", status: "REFUSED" },
        embedded: "UNAVAILABLE",
      }),
    );
    refusedSide(boundary, outcome.left, {
      code: "CONTROL_ROOM_ASSETS_MISSING", layer: openPort,
    });
    refusedSide(boundary, outcome.right, {
      code: "CONTROL_ROOM_BROWSER_REFUSED", layer: openPort,
    });
  });
});

// ── EFFORT_ADMISSION_LAYER ────────────────────────────────────────────────────────────────
// The single door into the effort domain. Admission answers before the collector ever sees a
// payload, so these fixtures are malformed AT ADMISSION on purpose.
describe("EFFORT_ADMISSION_LAYER", () => {
  const boundary = "EFFORT_ADMISSION_LAYER";
  const at = (code: string): RefusalExpectation => ({ code, layer: EFFORT_ADMISSION_LAYER });

  it("BEFORE — an observation stating no source is refused before anything is recorded", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => shapeEffortObservation({
        commandId: "cmd-1", observedAt: 1, type: "FREE_INTERACTION",
      }),
      async () => shapeEffortObservation(null),
    );
    refused(boundary, "BEFORE", outcome.probe, at("EFFORT_SOURCE_ABSENT"));
    refused(boundary, "BEFORE", outcome.effect, at("EFFORT_OBSERVATION_ABSENT"));
  });

  it("AFTER — a derived field smuggled onto a replayed observation is refused, not ignored", async () => {
    const outcome = await probeAfter(
      BOUND,
      async () => shapeEffortObservation({
        commandId: "cmd-1", interaction: "click", observedAt: 1,
        source: "CONTROL_ROOM_INPUT", type: "FREE_INTERACTION",
      }),
      async () => shapeEffortObservation({
        commandId: "cmd-1", durationMs: 5_000, interaction: "click", observedAt: 2,
        source: "CONTROL_ROOM_INPUT", type: "FREE_INTERACTION",
      }),
    );
    expect(outcome.effect.known).toBe(true);
    refused(boundary, "AFTER", outcome.probe, at("EFFORT_OBSERVATION_UNPARSEABLE"));
  });

  it("RACE — an unattributed demand and a self-declared ADDITIONAL both refuse", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => shapeEffortObservation({
        demandedKind: "APPROVE", observedAt: 1, source: "OPERATOR_REPORT",
        type: "DEMANDED_DECISION",
      }),
      async () => shapeEffortObservation({
        commandId: "cmd-2", demandedKind: "ADDITIONAL", observedAt: 2,
        source: "OPERATOR_REPORT", type: "DEMANDED_DECISION",
      }),
    );
    refusedSide(boundary, outcome.left, at("EFFORT_COMMAND_IDENTITY_ABSENT"));
    refusedSide(boundary, outcome.right, at("EFFORT_OBSERVATION_CONTRADICTORY"));
  });
});

// ── EFFORT_COLLECTOR_LAYER ────────────────────────────────────────────────────────────────
// Reached only by payloads that ALREADY satisfied admission. Every fixture here is a
// well-formed observation, so admission cannot answer first and the collector's own
// contradiction guards are the ones under test.
describe("EFFORT_COLLECTOR_LAYER", () => {
  const boundary = "EFFORT_COLLECTOR_LAYER";
  const contradictory: RefusalExpectation = {
    code: "EFFORT_OBSERVATION_CONTRADICTORY", layer: EFFORT_COLLECTOR_LAYER,
  };
  const orphanClose = (observedAt: number): Record<string, unknown> => ({
    commandId: "cmd-1", intervalKind: "FOCUS", observedAt,
    source: "SESSION_RECORDING", type: "INTERVAL_CLOSE",
  });

  it("BEFORE — a close for an interval nobody opened is refused, never back-dated", async () => {
    const collector = createEffortCollector();
    const outcome = await probeBefore(
      BOUND,
      async () => collector.record(orphanClose(10)),
      async () => collector.observations(),
    );
    refused(boundary, "BEFORE", outcome.probe, contradictory);
    expect(outcome.effect).toHaveLength(0);
  });

  it("AFTER — an observation appended once the account was sealed is refused", async () => {
    const collector = createEffortCollector();
    const outcome = await probeAfter(
      BOUND,
      async () => collector.seal(),
      async () => collector.record({
        commandId: "cmd-1", interaction: "click", observedAt: 1,
        source: "CONTROL_ROOM_INPUT", type: "FREE_INTERACTION",
      }),
    );
    expect(outcome.effect.observations).toHaveLength(0);
    refused(boundary, "AFTER", outcome.probe, contradictory);
  });

  it("RACE — two orphan closes contend on one interval kind and neither is admitted", async () => {
    const collector = createEffortCollector();
    const outcome = await probeRacing(
      BOUND,
      async () => collector.record(orphanClose(20)),
      async () => collector.record(orphanClose(30)),
    );
    refusedSide(boundary, outcome.left, contradictory);
    refusedSide(boundary, outcome.right, contradictory);
    expect(collector.observations()).toHaveLength(0);
  });
});

// ── EFFORT_LAYERS ─────────────────────────────────────────────────────────────────────────
// The frozen two-member vocabulary. Its coverage asserts that hostile input is answered by
// DIFFERENT declared members depending on which guard owns the question — the only property a
// shared layer list can carry, and the one a code-only assertion would lose.
describe("EFFORT_LAYERS", () => {
  const boundary = "EFFORT_LAYERS";
  const admission = layerOf(EFFORT_LAYERS, EFFORT_ADMISSION_LAYER);
  const collector = layerOf(EFFORT_LAYERS, EFFORT_COLLECTOR_LAYER);

  it("BEFORE — a malformed interval kind is answered by admission, not the collector", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => shapeEffortObservation({
        commandId: "cmd-1", intervalKind: "SIDEWAYS", observedAt: 1,
        source: "CONTROL_ROOM_DOM", type: "INTERVAL_OPEN",
      }),
      async () => createEffortCollector().observations(),
    );
    refused(boundary, "BEFORE", outcome.probe, {
      code: "EFFORT_OBSERVATION_UNPARSEABLE", layer: admission,
    });
    expect(outcome.effect).toHaveLength(0);
  });

  it("AFTER — a well-formed record raised past the seal is answered by the collector member", async () => {
    const machine = createEffortCollector();
    const outcome = await probeAfter(
      BOUND,
      async () => machine.seal(),
      async () => machine.record({
        commandId: "cmd-1", intervalKind: "AWAY", observedAt: 9,
        source: "CONTROL_ROOM_DOM", type: "INTERVAL_OPEN",
      }),
    );
    refused(boundary, "AFTER", outcome.effect, {
      code: "EFFORT_OBSERVATION_CONTRADICTORY", layer: collector,
    });
  });

  it("RACE — an admission refusal and a collector refusal stay on their own members", async () => {
    const machine = createEffortCollector();
    const outcome = await probeRacing(
      BOUND,
      async () => shapeEffortObservation({ observedAt: 1, type: "INTERVAL_OPEN" }),
      async () => machine.record({
        commandId: "cmd-1", intervalKind: "AWAY", observedAt: 3,
        source: "CONTROL_ROOM_DOM", type: "INTERVAL_CLOSE",
      }),
    );
    refusedSide(boundary, outcome.left, { code: "EFFORT_SOURCE_ABSENT", layer: admission });
    refusedSide(boundary, outcome.right, {
      code: "EFFORT_OBSERVATION_CONTRADICTORY", layer: collector,
    });
  });
});

// ── TIMELINE_REFUSAL_LAYERS ───────────────────────────────────────────────────────────────
// INPUT answers before any page is read, so every PAGING fixture below carries a VALID
// `maxRows` to get past it — otherwise INPUT would answer and the assertion would detach.
describe("TIMELINE_REFUSAL_LAYERS", () => {
  const boundary = "TIMELINE_REFUSAL_LAYERS";
  const input = layerOf(TIMELINE_REFUSAL_LAYERS, "INPUT");
  const paging = layerOf(TIMELINE_REFUSAL_LAYERS, "PAGING");
  const stalling = (): TimelineSourcePage => ({ hasMore: true, nextCursor: null, rows: [] });
  const drained = (): TimelineSourcePage => ({ hasMore: false, nextCursor: null, rows: [] });

  it("BEFORE — a forged row bound is refused at INPUT before any page is fetched", async () => {
    let fetched = 0;
    const outcome = await probeBefore(
      BOUND,
      async () => walkTimeline({
        filter: null, maxRows: 0,
        source: () => { fetched += 1; return stalling(); },
        startCursor: null,
      }),
      async () => fetched,
    );
    refused(boundary, "BEFORE", outcome.probe, { code: "TIMELINE_LIMIT_INVALID", layer: input });
    expect(outcome.effect).toBe(0);
  });

  it("AFTER — a source still claiming more once the cursor stopped advancing is refused", async () => {
    const outcome = await probeAfter(
      BOUND,
      async () => walkTimeline({ filter: null, maxRows: 5, source: drained, startCursor: null }),
      async () => walkTimeline({ filter: null, maxRows: 5, source: stalling, startCursor: 42 }),
    );
    expect(outcome.effect.outcome).toBe("WALKED");
    refused(boundary, "AFTER", outcome.probe, {
      code: "TIMELINE_CURSOR_NOT_ADVANCING", layer: paging,
    });
  });

  it("RACE — a forged bound and a stalling source contend; neither walks a row", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => walkTimeline({
        filter: null, maxRows: Number.NaN, source: stalling, startCursor: null,
      }),
      async () => walkTimeline({ filter: null, maxRows: 3, source: stalling, startCursor: 7 }),
    );
    refusedSide(boundary, outcome.left, { code: "TIMELINE_LIMIT_INVALID", layer: input });
    refusedSide(boundary, outcome.right, {
      code: "TIMELINE_CURSOR_NOT_ADVANCING", layer: paging,
    });
  });
});

// ── DAEMON_ENTRY_LAYER ────────────────────────────────────────────────────────────────────
// The process entry point. No fixture here reaches a listener bind, so the entry layer is the
// only one that can answer and a ListenerRefused can never stand in for it.
describe("DAEMON_ENTRY_LAYER", () => {
  const boundary = "DAEMON_ENTRY_LAYER";
  const at = (code: string): RefusalExpectation => ({ code, layer: DAEMON_ENTRY_LAYER });
  const revoked = {
    provide: (): never => { throw new Error("provider authority revoked"); },
  };

  it("BEFORE — a start with no dependency provider refuses before any socket is bound", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => await startDaemon({}),
      async () => await startDaemon({ dependencies: null }),
    );
    refused(boundary, "BEFORE", outcome.probe, at("DAEMON_ENTRY_NO_DEPENDENCY_PROVIDER"));
    refused(boundary, "BEFORE", outcome.effect, at("DAEMON_ENTRY_NO_DEPENDENCY_PROVIDER"));
  });

  it("AFTER — a provider that throws once its authority is withdrawn refuses at entry", async () => {
    const outcome = await probeAfter(
      BOUND,
      async () => await startDaemon({ dependencies: null }),
      async () => await startDaemon({ dependencies: revoked }),
    );
    refused(boundary, "AFTER", outcome.probe, at("DAEMON_ENTRY_NO_DEPENDENCY_PROVIDER"));
    refused(boundary, "AFTER", outcome.effect, at("DAEMON_ENTRY_PROVIDER_THREW"));
  });

  it("RACE — two concurrent starts contend and neither yields a listening daemon", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => await startDaemon({}),
      async () => await startDaemon({ dependencies: revoked }),
    );
    refusedSide(boundary, outcome.left, at("DAEMON_ENTRY_NO_DEPENDENCY_PROVIDER"));
    refusedSide(boundary, outcome.right, at("DAEMON_ENTRY_PROVIDER_THREW"));
  });
});

// ── EVENT_STREAM_LAYER ────────────────────────────────────────────────────────────────────
// The wire seam refuses by STATING an absence rather than throwing, so the hostile property
// is that a forged reading never becomes a known value and never borrows the other clock's.
describe("EVENT_STREAM_LAYER", () => {
  const boundary = "EVENT_STREAM_LAYER";
  const notProvided: RefusalExpectation = {
    code: "EVENT_STREAM_READING_NOT_PROVIDED", layer: EVENT_STREAM_LAYER,
  };

  it("BEFORE — a forged reading object is refused rather than unwrapped into a value", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => observation(
        "DAEMON_SEAM", "DAEMON_WALL_CLOCK", { value: "2026-01-01T00:00:00.000Z" },
      ).reading,
      async () => observation("STORE_LEDGER", "STORE_COMMIT_CLOCK", "2026-01-01T00:00:00.000Z"),
    );
    refused(boundary, "BEFORE", outcome.probe, notProvided);
    expect(outcome.effect.reading.known).toBe(true);
  });

  it("AFTER — a reading blanked once the source stopped stating it stays UNKNOWN", async () => {
    const outcome = await probeAfter(
      BOUND,
      async () => observation("STORE_LEDGER", "STORE_COMMIT_CLOCK", "2026-01-01T00:00:00.000Z"),
      async () => observation("STORE_LEDGER", "STORE_COMMIT_CLOCK", "").reading,
    );
    expect(outcome.effect.known).toBe(false);
    refused(boundary, "AFTER", outcome.effect, notProvided);
  });

  it("RACE — two clocks observed concurrently never borrow each other's reading", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => observation("DAEMON_SEAM", "DAEMON_WALL_CLOCK", null).reading,
      async () => observation("STORE_LEDGER", "STORE_COMMIT_CLOCK", 0).reading,
    );
    refusedSide(boundary, outcome.left, notProvided);
    refusedSide(boundary, outcome.right, notProvided);
  });
});

// ── CONTROL_ROOM_LISTENER_LAYER ───────────────────────────────────────────────────────────
// The socket guard, which refuses BEFORE any affordance surface or event seam sees a request.
// That ordering is exactly why the affordance fixtures in the sibling file bypass it: a
// request that fails here never reaches the surface behind it.
describe("CONTROL_ROOM_LISTENER_LAYER", () => {
  const boundary = "CONTROL_ROOM_LISTENER_LAYER";
  const AUTHORITY = "127.0.0.1:9876";
  const ORIGIN = "http://127.0.0.1:9876";
  const at = (code: string): RefusalExpectation =>
    ({ code, layer: CONTROL_ROOM_LISTENER_LAYER });
  const request = (headers: Record<string, string>): IncomingMessage =>
    hostile<IncomingMessage>({ headers });
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  /** The listener answers a header verdict through its own `refuse`; using it keeps the code
   *  AND the layer sourced from production rather than from a literal typed here. */
  const verdict = (code: string | null): unknown =>
    refuseListener(hostile<Parameters<typeof refuseListener>[0]>(code));

  it("BEFORE — a forged Host is refused before Origin or CSRF are ever consulted", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => checkHeaders(
        request({ host: "evil.example:9876", origin: ORIGIN, "x-moe-csrf": "token-1" }),
        AUTHORITY, ORIGIN, "token-1",
      ),
      async () => checkHeaders(
        request({ host: AUTHORITY, "x-moe-csrf": "token-1" }), AUTHORITY, ORIGIN, "token-1",
      ),
    );
    refused(boundary, "BEFORE", verdict(outcome.probe), at("LISTENER_HOST_INVALID"));
    refused(boundary, "BEFORE", verdict(outcome.effect), at("LISTENER_ORIGIN_INVALID"));
  });

  it("AFTER — a CSRF token replayed after rotation is refused, and an empty one never passes", async () => {
    const outcome = await probeAfter(
      BOUND,
      async () => checkHeaders(
        request({ host: AUTHORITY, origin: ORIGIN, "x-moe-csrf": "token-1" }),
        AUTHORITY, ORIGIN, "token-1",
      ),
      async () => checkHeaders(
        request({ host: AUTHORITY, origin: ORIGIN, "x-moe-csrf": "token-1" }),
        AUTHORITY, ORIGIN, "token-2",
      ),
    );
    expect(outcome.effect).toBeNull();
    refused(boundary, "AFTER", verdict(outcome.probe), at("LISTENER_CSRF_INVALID"));
    // An empty configured token is not a secret and satisfies NO request, so a bare header
    // cannot forge past it.
    expect(checkHeaders(
      request({ host: AUTHORITY, origin: ORIGIN, "x-moe-csrf": "" }), AUTHORITY, ORIGIN, "",
    )).toBe("LISTENER_CSRF_INVALID");
  });

  it("RACE — two malformed bodies are read concurrently and neither becomes a request", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => readEventRequest(encode('{"projection":1,"subscriberId":"sub-1"}')),
      async () => readEventAcknowledgeRequest(encode('{"subscriberId":"sub-1"}')),
    );
    for (const side of [outcome.left, outcome.right]) {
      expect(side.status).toBe("fulfilled");
      // A structural read states its refusal by yielding NO request at all; the listener's
      // own vocabulary is what that becomes on the wire, asserted below.
      expect(side.status === "fulfilled" ? side.value : "unsettled").toBeNull();
      refused(boundary, "RACE", verdict("LISTENER_STREAM_REQUEST_INVALID"),
        at("LISTENER_STREAM_REQUEST_INVALID"));
    }
  });
});

// ── DAEMON_INGRESS_LAYER ──────────────────────────────────────────────────────────────────
// The recovery-completion decoder. This boundary spells its answering layer `refusedBy`; the
// adapter below renames the FIELD only, so both values still come from production and
// `assertRefusedWith` still compares code AND layer.
describe("DAEMON_INGRESS_LAYER", () => {
  const boundary = "DAEMON_INGRESS_LAYER";
  const malformed: RefusalExpectation = {
    code: "RECOVERY_COMPLETION_REQUEST_MALFORMED", layer: DAEMON_INGRESS_LAYER,
  };
  const decode = (input: unknown): unknown => {
    const result = decodeRecoveryCompleteRequest(input);
    expect(result.ok).toBe(false);
    if (result.ok) return null;
    const { code, refusedBy } = result.refusal;
    return { code, layer: refusedBy };
  };
  const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

  it("BEFORE — a completion request that is not bytes at all is refused at ingress", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => decode({ payload: { reconciliationDigest: "a".repeat(64) } }),
      async () => decode(bytes({ payload: null })),
    );
    refused(boundary, "BEFORE", outcome.probe, malformed);
    refused(boundary, "BEFORE", outcome.effect, malformed);
  });

  it("AFTER — a forged digest replayed inside a well-shaped envelope is refused", async () => {
    const outcome = await probeAfter(
      BOUND,
      async () => decode(bytes({ payload: {} })),
      async () => decode(bytes({ payload: { reconciliationDigest: "not-a-digest" } })),
    );
    refused(boundary, "AFTER", outcome.effect, malformed);
    refused(boundary, "AFTER", outcome.probe, malformed);
  });

  it("RACE — two forged completion requests contend and neither decodes", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => decode(bytes({ extra: 1, payload: { reconciliationDigest: "b".repeat(64) } })),
      async () => decode(new Uint8Array([0x7b, 0x00])),
    );
    refusedSide(boundary, outcome.left, malformed);
    refusedSide(boundary, outcome.right, malformed);
  });
});

// ── CONTROL_ROOM_TRANSPORT_LAYER ──────────────────────────────────────────────────────────
// The browser send path. Its two codes describe the ROUND TRIP only, so a daemon code
// appearing here would itself be the defect. The fetch double is the hostile INPUT side; the
// transport under test is the real one.
describe("CONTROL_ROOM_TRANSPORT_LAYER", () => {
  const boundary = "CONTROL_ROOM_TRANSPORT_LAYER";
  const at = (code: string): RefusalExpectation =>
    ({ code, layer: CONTROL_ROOM_TRANSPORT_LAYER });
  const transport = (fetch: FetchLike): ReturnType<typeof createControlRoomTransport> =>
    createControlRoomTransport({
      csrfToken: "token-1", fetch, origin: "http://127.0.0.1:9876",
      sessionCredential: "cred-1", wireProtocolVersion: "moe-wire/1",
    });
  const severed = transport(async () => { throw new Error("connection refused"); });
  const garbled = transport(async () => new Response("<html>not json</html>"));

  it("BEFORE — a request that never reaches the daemon invents no daemon answer", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => await severed.readEventPage({ projection: "timeline", subscriberId: "sub-1" }),
      async () => await severed.readDocumentDossier(),
    );
    refused(boundary, "BEFORE", outcome.probe, at("TRANSPORT_REQUEST_FAILED"));
    refused(boundary, "BEFORE", outcome.effect, at("TRANSPORT_REQUEST_FAILED"));
  });

  it("AFTER — an unreadable answer returned after delivery is refused, not parsed", async () => {
    const outcome = await probeAfter(
      BOUND,
      async () => await garbled.readDocumentDossier(),
      async () => await garbled.acknowledgeEventPage({
        presentedCursor: { generation: 1, position: "42" }, subscriberId: "sub-1",
      }),
    );
    refused(boundary, "AFTER", outcome.effect, at("TRANSPORT_RESPONSE_UNREADABLE"));
    refused(boundary, "AFTER", outcome.probe, at("TRANSPORT_RESPONSE_UNREADABLE"));
  });

  it("RACE — a severed and a garbled round trip contend and neither is delivered", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => await severed.readEventPage({ projection: "timeline", subscriberId: "sub-1" }),
      async () => await garbled.readEventPage({ projection: "timeline", subscriberId: "sub-2" }),
    );
    refusedSide(boundary, outcome.left, at("TRANSPORT_REQUEST_FAILED"));
    refusedSide(boundary, outcome.right, at("TRANSPORT_RESPONSE_UNREADABLE"));
  });
});

// ── IMPORT_REFUSAL_LAYERS ─────────────────────────────────────────────────────────────────
// CANONICAL is the member exercised here. DECODE answers earlier on the real pipeline, so
// every fixture below is an ALREADY-DECODED record: a record that had failed DECODE would be
// answered there and this assertion would silently stop testing its subject.
describe("IMPORT_REFUSAL_LAYERS", () => {
  const boundary = "IMPORT_REFUSAL_LAYERS";
  const uncanonical: RefusalExpectation = {
    code: "IMPORT_RECORD_UNCANONICAL", layer: layerOf(IMPORT_REFUSAL_LAYERS, "CANONICAL"),
  };
  const decoded = (payload: Record<string, unknown>): LegacySourceRecord => ({
    declaredTime: null, kind: "task", legacyId: "legacy-1", payload, sourcePath: "a.json",
  });

  it("BEFORE — bytes canonical JSON cannot represent are refused before any digest", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => canonicalPayload(decoded({ blob: new Uint8Array([1, 2, 3]) })),
      async () => canonicalPayload(decoded({ title: "ok" })),
    );
    refused(boundary, "BEFORE", outcome.probe, uncanonical);
    expect(typeof outcome.effect).toBe("string");
  });

  it("AFTER — a non-safe integer smuggled in after a clean record is refused", async () => {
    const outcome = await probeAfter(
      BOUND,
      async () => canonicalPayload(decoded({ title: "ok" })),
      async () => canonicalPayload(decoded({ count: Number.MAX_SAFE_INTEGER + 2 })),
    );
    expect(typeof outcome.effect).toBe("string");
    refused(boundary, "AFTER", outcome.probe, uncanonical);
  });

  it("RACE — two uncanonicalisable payloads contend and neither yields a digestable string", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => canonicalPayload(decoded({ when: Number.NaN })),
      async () => canonicalPayload(decoded({ blob: new Uint8Array([9]) })),
    );
    refusedSide(boundary, outcome.left, uncanonical);
    refusedSide(boundary, outcome.right, uncanonical);
  });
});

// ── HTTP_SHUTDOWN_LAYER ───────────────────────────────────────────────────────────────────
// The adapter's teardown sweep. A shutdown fault must never be read as a daemon refusal, so
// the LAYER half of every assertion here is the whole point of the boundary.
describe("HTTP_SHUTDOWN_LAYER", () => {
  const boundary = "HTTP_SHUTDOWN_LAYER";
  const releaseFailed: RefusalExpectation = {
    code: "HTTP_SHUTDOWN_SESSION_RELEASE_FAILED", layer: HTTP_SHUTDOWN_LAYER,
  };
  interface Attachment {
    readonly server: { close(): void };
    readonly transport: { close(): void };
  }
  const verdict = { ok: true, principalRef: "principal-1", sessionRef: "session-1" } as const;
  const port: HttpSessionPort = {
    bindSession: (): void => undefined,
    closeSession: (): void => undefined,
    validateBearer: () => verdict,
  };
  const held = (): never => { throw new Error("session handle still held"); };
  const entry = (sessionId: string): HttpSessionEntry<Attachment> => ({
    attachment: { server: { close: (): void => undefined }, transport: { close: held } },
    sessionId,
    verdict,
  });
  /** Resolves with the raised error rather than rejecting, so both race legs settle and the
   *  driver can report each side instead of discarding one. */
  const sweepSessions = async (
    entries: readonly HttpSessionEntry<Attachment>[],
  ): Promise<unknown> => await closeAllDaemonSessions<Attachment>(
    createHttpSessionRegistry<Attachment>(), port, entries,
  ).then(() => null, (cause: unknown) => cause);

  it("BEFORE — a transport that refuses to close is reported, never swallowed", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => await sweepSessions([entry("mcp-1")]),
      async () => await sweepSessions([]),
    );
    refused(boundary, "BEFORE", outcome.probe, releaseFailed);
    expect(outcome.effect).toBeNull();
  });

  it("AFTER — a session still held on a second sweep keeps raising the shutdown code", async () => {
    const outcome = await probeAfter(
      BOUND,
      async () => await sweepSessions([entry("mcp-2")]),
      async () => await sweepSessions([entry("mcp-2")]),
    );
    refused(boundary, "AFTER", outcome.effect, releaseFailed);
    refused(boundary, "AFTER", outcome.probe, releaseFailed);
  });

  it("RACE — two concurrent sweeps over held sessions both fail closed", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => await sweepSessions([entry("mcp-3")]),
      async () => await sweepSessions([entry("mcp-4")]),
    );
    refusedSide(boundary, outcome.left, releaseFailed);
    refusedSide(boundary, outcome.right, releaseFailed);
  });
});

// ── COMPLETENESS AND THE WHOLE-SLICE INVARIANT ────────────────────────────────────────────
describe("transport axis — completeness and the no-admission invariant", () => {
  const swept = (): ReadonlySet<string> =>
    new Set(ADMISSIONS.map((entry) => `${entry.boundary}#${entry.arm}`));

  it("reads a POSITIVE number of transport entries off the roster's committed bytes", () => {
    // A parse that silently matched nothing would make every set assertion below vacuous.
    expect(ROSTER_TRANSPORT.length).toBeGreaterThan(0);
    expect(ROSTER_TRANSPORT).toHaveLength(15);
    for (const delegated of STORE_BACKED) expect(ROSTER_TRANSPORT).toContain(delegated);
    expect(OWNED).toHaveLength(ROSTER_TRANSPORT.length - STORE_BACKED.length);
  });

  it("sweeps exactly the roster's transport entries this file owns, in BOTH directions", () => {
    const covered = new Set(ADMISSIONS.map((entry) => entry.boundary));
    expect([...covered].filter((name) => !OWNED.includes(name)).sort()).toEqual([]);
    expect(OWNED.filter((name) => !covered.has(name)).sort()).toEqual([]);
  });

  it("gives every owned boundary at least one BEFORE, one AFTER and one RACE case", () => {
    const keys = swept();
    expect(OWNED.flatMap((name) => (["AFTER", "BEFORE", "RACE"] as const)
      .filter((arm) => !keys.has(`${name}#${arm}`))
      .map((arm) => `${name}#${arm}`))).toEqual([]);
  });

  it("records a POSITIVE case count for every owned boundary", () => {
    for (const name of OWNED) {
      expect(ADMISSIONS.filter((entry) => entry.boundary === name).length).toBeGreaterThan(0);
    }
  });

  it("admits nothing: no case yielded a command, a grant, or a truth class above UNKNOWN", () => {
    // ONE assertion over every outcome collected, rather than one per case, so a case added
    // later cannot escape it.
    expect(ADMISSIONS.length).toBeGreaterThan(0);
    expect(ADMISSIONS.filter((entry) => entry.admitted)).toEqual([]);
  });
});
