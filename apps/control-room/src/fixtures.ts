import {
  EMPTY_NEXT_ALLOWED_COMMANDS,
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  historicalRuntimeResult,
} from "@moe/contracts";
import type { NextAllowedCommand, RuntimeCommandKind } from "@moe/contracts";

/**
 * Development-only shell fixtures.
 *
 * Nothing here is evidence and nothing here carries authority. Every value is a
 * literal written by hand so two builds are byte-identical, and no clock, random
 * source, or network read is consulted. Live data arrives through the adapters
 * this module deliberately does not contain.
 */
export const CONTROL_ROOM_FIXTURE_KIND = "DEVELOPMENT_ONLY/NOT_CONFIRMATORY" as const;

/** The typed link a provenance popover offers, chosen by the fact's truth class. */
export type ProvenanceLinkKind = "receipt" | "decision" | "report" | "finding";

/** Shell-local shape of the provenance popover; the daemon owns no such type yet. */
export interface FixtureProvenance {
  readonly actor: string;
  readonly eventId: string;
  readonly eventSequence: number;
  readonly leaseEpoch: number | null;
  readonly linkKind: ProvenanceLinkKind;
  readonly linkRef: string;
  readonly sessionId: string;
  readonly timestamp: string;
}

/** One rendered claim. `truthClass` is intentionally `unknown`: payloads lie. */
export interface FixtureFact {
  readonly factId: string;
  readonly label: string;
  readonly provenance: FixtureProvenance;
  readonly truthClass: unknown;
  readonly value: string;
}

export type FixtureSurfaceId = "goals" | "board" | "node" | "approval" | "evidence" | "doctor";

export interface FixtureSurface {
  readonly facts: readonly FixtureFact[];
  readonly surfaceId: FixtureSurfaceId;
  readonly title: string;
}

/** Transport states the shell must render differently. */
export type FixtureConnectionState = "CONNECTED" | "LAGGING" | "DISCONNECTED" | "HISTORICAL";

export interface FixtureAffordanceSnapshot {
  readonly connection: FixtureConnectionState;
  readonly mutationsEnabled: boolean;
  readonly nextAllowedCommands: readonly NextAllowedCommand[];
  readonly requiresAffordanceRefresh: boolean;
  readonly statusLabel: string;
}

export interface ControlRoomFixtures {
  readonly affordances: readonly FixtureAffordanceSnapshot[];
  readonly kind: typeof CONTROL_ROOM_FIXTURE_KIND;
  readonly surfaces: readonly FixtureSurface[];
}

const LINK_ACTORS: Record<ProvenanceLinkKind, string> = {
  decision: "human/operator-1",
  finding: "daemon/integrity",
  receipt: "daemon/runner",
  report: "agent/session-a",
};

type FactSeed = readonly [
  factId: string, label: string, value: string, truthClass: unknown, linkKind: ProvenanceLinkKind,
];

function provenanceFor(seed: FactSeed, index: number): FixtureProvenance {
  const [factId, , , , linkKind] = seed;
  const sequence = index + 1;
  return Object.freeze({
    actor: LINK_ACTORS[linkKind],
    eventId: `evt-j1-${String(sequence).padStart(4, "0")}`,
    eventSequence: sequence,
    leaseEpoch: linkKind === "receipt" ? sequence : null,
    linkKind,
    linkRef: `${linkKind}/${factId}`,
    sessionId: `session-j1-${linkKind}`,
    // Minutes, not hours: an hour offset silently produces "T24:00" once a
    // seventeenth fact is added, and nothing downstream would reject it.
    timestamp: `2026-08-07T08:${String(index % 60).padStart(2, "0")}:00.000Z`,
  });
}

function factFrom(seed: FactSeed, index: number): FixtureFact {
  const [factId, label, value, truthClass] = seed;
  return Object.freeze({ factId, label, provenance: provenanceFor(seed, index), truthClass, value });
}

/**
 * Surface seeds. Two entries are deliberately dishonest payloads: the board's
 * readiness fact omits its class entirely and the doctor's relay fact carries a
 * structurally wrong one, so the shell's absent and invalid paths are exercised
 * by real fixture data rather than only by tests.
 */
const SURFACE_SEEDS: readonly (readonly [FixtureSurfaceId, string, readonly FactSeed[]])[] = [
  ["goals", "Goals", [
    ["goal.title", "Goal", "Ship the J1 vertical slice", "HUMAN_APPROVED", "decision"],
    ["goal.progress", "Progress", "2 of 3 nodes accepted", "DAEMON_VERIFIED", "receipt"],
  ]],
  ["board", "Board", [
    ["board.frontier", "Frontier", "1 node ready, 1 blocked", "OBSERVED", "report"],
    ["board.readiness", "Readiness", "Awaiting dependency explain", undefined, "finding"],
  ]],
  ["node", "Node", [
    ["node.state", "Node run", "WORK_REVIEW", "OBSERVED", "report"],
    ["node.attempt", "Latest attempt", "Tests green in 41s", "AGENT_REPORTED", "report"],
  ]],
  ["approval", "Approval", [
    ["approval.request", "Pending decision", "Accept node output", "HUMAN_APPROVED", "decision"],
    ["approval.validity", "Validity", "CURRENT", "DAEMON_VERIFIED", "receipt"],
  ]],
  ["evidence", "Evidence", [
    ["evidence.receipt", "Receipt", "typecheck and tests, exit 0", "DAEMON_VERIFIED", "receipt"],
    ["evidence.claim", "Agent claim", "No regressions observed", "AGENT_REPORTED", "report"],
  ]],
  ["doctor", "Doctor", [
    ["doctor.store", "Event store", "Reachable, 0 gaps", "DAEMON_VERIFIED", "receipt"],
    ["doctor.relay", "Relay", "Reporting an unreadable class", { class: "OBSERVED" }, "finding"],
  ]],
];

function buildSurfaces(): readonly FixtureSurface[] {
  let index = 0;
  const surfaces = SURFACE_SEEDS.map(([surfaceId, title, seeds]) => {
    const facts = seeds.map((seed) => factFrom(seed, index++));
    return Object.freeze({ facts: Object.freeze(facts), surfaceId, title });
  });
  return Object.freeze(surfaces);
}

/** Ordered as the contracts parser orders them: by command kind, then command id. */
const J1_COMMAND_SEEDS: readonly (
  readonly [string, RuntimeCommandKind, string, number]
)[] = [
  ["cmd-j1-approve-plan", "approval.decide", "approval-j1-plan", 4],
  ["cmd-j1-close-goal", "goal.close", "goal-j1", 2],
  ["cmd-j1-accept-output", "integration.accept_output", "integration-j1-node-2", 7],
];

/**
 * Declared directly instead of built through the contracts parser.
 *
 * That parser guards against revoked proxies through a Node-only API, so calling it
 * from browser code throws once the bundler stubs that API out. Declaring the entries
 * keeps this module loadable in a browser; the test suite runs the real parser over
 * exactly these entries and rejects anything the daemon would not have produced, so
 * the shape stays contract-checked rather than merely asserted.
 */
function j1Commands(): readonly NextAllowedCommand[] {
  return Object.freeze(
    J1_COMMAND_SEEDS.map(([commandId, commandKind, targetAggregateId, expectedVersion]) =>
      Object.freeze({
        commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
        commandId,
        commandKind,
        expectedVersion,
        inputSchemaVersion: "moe-runtime-command-input/1",
        targetAggregateId,
      })),
  );
}

/**
 * Mutation enablement is derived, never authored: a surface may act only when the
 * transport is live, the daemon has not asked for an affordance refresh, and the
 * daemon actually supplied affordances. Outbox lag labels the view stale without
 * blocking commands; a disconnected or replayed view carries no affordances at all.
 */
function snapshot(
  connection: FixtureConnectionState,
  nextAllowedCommands: readonly NextAllowedCommand[],
  requiresAffordanceRefresh: boolean,
  statusLabel: string,
): FixtureAffordanceSnapshot {
  const live = connection !== "DISCONNECTED" && !requiresAffordanceRefresh;
  return Object.freeze({
    connection,
    mutationsEnabled: live && nextAllowedCommands.length > 0,
    nextAllowedCommands,
    requiresAffordanceRefresh,
    statusLabel,
  });
}

function buildAffordances(): readonly FixtureAffordanceSnapshot[] {
  const historical = historicalRuntimeResult();
  return Object.freeze([
    snapshot("CONNECTED", j1Commands(), false, ""),
    snapshot(
      "LAGGING",
      j1Commands(),
      false,
      "Showing data as of the last relay update; commands remain available.",
    ),
    snapshot(
      "DISCONNECTED",
      EMPTY_NEXT_ALLOWED_COMMANDS,
      false,
      "Disconnected from the daemon. Actions stay visible and disabled.",
    ),
    snapshot(
      "HISTORICAL",
      historical.nextAllowedCommands,
      historical.requiresAffordanceRefresh,
      "Replayed view. Refresh affordances before acting.",
    ),
  ]);
}

/**
 * One snapshot per blocking leg, each built so EVERY other condition would permit
 * mutation — the named leg is the only thing holding the gate closed. The canonical
 * four states cannot serve this: each blocked state is blocked by more than one leg
 * at once, so every individual leg is deletable without a test noticing.
 *
 * The first is why this is load-bearing rather than theoretical: a view that keeps
 * its last-known affordances when the transport drops must still refuse to act.
 */
export const MUTATION_BLOCK_ISOLATION: readonly FixtureAffordanceSnapshot[] = Object.freeze([
  snapshot("DISCONNECTED", j1Commands(), false, "Dropped while holding last-known affordances."),
  snapshot("CONNECTED", j1Commands(), true, "Connected; affordances must be refreshed first."),
  snapshot("CONNECTED", EMPTY_NEXT_ALLOWED_COMMANDS, false, "Connected; no affordances supplied."),
]);

/** Rebuilds the fixture set. Two calls are deep-equal and JSON-identical. */
export function buildControlRoomFixtures(): ControlRoomFixtures {
  return Object.freeze({
    affordances: buildAffordances(),
    kind: CONTROL_ROOM_FIXTURE_KIND,
    surfaces: buildSurfaces(),
  });
}

export const CONTROL_ROOM_FIXTURES: ControlRoomFixtures = buildControlRoomFixtures();
