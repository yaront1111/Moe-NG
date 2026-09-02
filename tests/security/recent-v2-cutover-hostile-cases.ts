/**
 * Hostile arms for five v2-lineage boundary constants the digit-aware roster scanner
 * now sees without arms: the daemon's cutover v2 authority gate and its two release
 * manifests (integrity by SUBJECT — a fail-closed read over an injected store and two
 * canonical codecs, no durable state of their own), the v2 compiler's layer roster
 * (scheduler-activation — it binds scheduler authority downstream of admission) and the
 * control room's Gate 1 answer mapper (transport — it reads a daemon HTTP answer).
 *
 * Every refusal thunk is DETERMINISTIC and side-effect free. The inputs are hostile
 * SHAPES (`null`, `{}`, `[]`, a well-keyed body naming no v2 command) or an injected port
 * whose every method throws, so the arm proves the refusal answers before the port is
 * touched — a store that is reached throws a message saying so, and the case reddens on
 * the throw rather than passing on a refusal from a different layer. Every layer is read
 * OUT of the boundary's own declared constant (through `layerOf` for the compiler's
 * LAYERS array), so a renamed layer reds here instead of being followed.
 *
 * Two boundaries carry two distinct refusals so the AFTER arm and the RACE's right leg
 * reach a second code on the same layer: the readiness manifest refuses non-bytes at its
 * codec and an unreadable store at its reader; the surface manifest refuses non-bytes and
 * an empty roster. The v1 inverse fence (`V1_AUTHORITY_STATUS_UNKNOWN`) is deliberately
 * NOT driven here: its code is exported beside, not inside, `CUTOVER_V2_AUTHORITY_CODES`.
 */
import {
  GATE1_LAYER,
  mapGate1Answer,
} from "../../apps/control-room/src/v2/goals/gate1-pending-contract.js";
import {
  CUTOVER_V2_AUTHORITY_LAYER,
  admitV2AuthoritativeCommand,
} from "../../apps/daemon/src/cutover/cutover-v2-authority.js";
import type { CutoverMarkerStore } from "../../apps/daemon/src/cutover/cutover-v2-authority.js";
import {
  V2_READINESS_MANIFEST_LAYER,
  decodeV2ReadinessManifest,
  readV2ReadinessManifest,
} from "../../apps/daemon/src/cutover/v2-readiness-manifest.js";
import type {
  V2ReadinessManifestStore,
} from "../../apps/daemon/src/cutover/v2-readiness-manifest.js";
import {
  V2_MUTATION_COMMAND_KINDS,
  V2_SURFACE_MANIFEST_KEYS,
  V2_SURFACE_MANIFEST_LAYER,
  decodeV2SurfaceManifest,
} from "../../apps/daemon/src/cutover/v2-surface-manifest.js";
import { createV2Compiler } from "../../apps/daemon/src/planning/v2-compiler/compiler.js";
import type {
  V2CompilerFactoryDependencies,
} from "../../apps/daemon/src/planning/v2-compiler/compiler.js";
import { V2_COMPILER_LAYERS } from "../../apps/daemon/src/planning/v2-compiler/contracts.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import type { RefusalExpectation } from "./hostile-harness.js";
import type { HostileCase as IntegrityCase } from "./integrity-hostile-cases.js";
import type {
  HostileCase as SchedulerCase,
  HostileRaceCase as SchedulerRaceCase,
} from "./scheduler-activation-hostile-cases.js";
import type { HostileCase as TransportCase } from "./transport-hostile-cases.js";
import { BOUND } from "./transport-hostile-fixtures.js";

const BOUND_MS = 2_000;
/** A project no store on this host has ever held: every store below throws on contact. */
const PROJECT_ID = "moe-security-lane-project";

/**
 * Reads a layer OUT of the boundary's own declared constant, the same drill the
 * integrity slice applies: a typed literal would stay green through a rename.
 */
function layerOf(declared: readonly string[], wanted: string): string {
  const found = declared.find((entry) => entry === wanted);
  if (found === undefined) {
    throw new Error(`${wanted} is not a member of the declared layer constant`);
  }
  return found;
}

/** Every method throws: the refusal under test must answer before touching the store. */
function inertMarkerStore(): CutoverMarkerStore {
  return Object.freeze({
    readEvents: (): never => {
      throw new Error("the authority touched the marker store before refusing");
    },
  });
}

/** The store is reachable but unreadable; the reader must fail closed, never guess. */
function unreadableStore(): CutoverMarkerStore & V2ReadinessManifestStore {
  return Object.freeze({
    readEvents: (): never => { throw new Error("store unavailable"); },
  });
}

// ── Integrity: one boundary, two refusals, three arms ─────────────────────────────────

interface RefusalLeg {
  readonly expect: RefusalExpectation;
  readonly run: () => Promise<unknown>;
}

interface IntegritySubject {
  readonly constant: string;
  /** Refused with nothing consulted: the BEFORE probe and the RACE's left leg. */
  readonly upstream: RefusalLeg;
  /** The second refusal on the same boundary: the AFTER probe and the RACE's right leg. */
  readonly downstream: RefusalLeg;
  readonly names: Readonly<{ after: string; before: string; race: string }>;
  readonly slug: string;
}

function integrityArms(subject: IntegritySubject): readonly IntegrityCase[] {
  const { downstream, upstream } = subject;
  return Object.freeze([
    {
      arm: "BEFORE", constant: subject.constant, expect: upstream.expect,
      name: `${subject.slug}: ${subject.names.before}`,
      run: async () => (await probeBefore(
        { label: `${subject.slug}-before`, timeoutMs: BOUND_MS }, upstream.run, downstream.run,
      )).probe,
    },
    {
      arm: "AFTER", constant: subject.constant, expect: downstream.expect,
      name: `${subject.slug}: ${subject.names.after}`,
      run: async () => (await probeAfter(
        { label: `${subject.slug}-after`, timeoutMs: BOUND_MS }, upstream.run, downstream.run,
      )).probe,
    },
    {
      arm: "RACE", constant: subject.constant,
      name: `${subject.slug}: ${subject.names.race}`,
      expectLeft: upstream.expect, expectRight: downstream.expect,
      run: async () => probeRacing(
        { label: `${subject.slug}-race`, timeoutMs: BOUND_MS }, upstream.run, downstream.run,
      ),
    },
  ]);
}

// ── The cutover v2 authority gate ─────────────────────────────────────────────────────

const COMMAND_UNKNOWN: RefusalExpectation = Object.freeze({
  code: "CUTOVER_V2_COMMAND_UNKNOWN", layer: CUTOVER_V2_AUTHORITY_LAYER,
});
const NOT_ACTIVE: RefusalExpectation = Object.freeze({
  code: "CUTOVER_V2_NOT_ACTIVE", layer: CUTOVER_V2_AUTHORITY_LAYER,
});
/** A command the v2 roster does own, so the marker read is what answers. */
const ROSTERED_COMMAND: string = V2_MUTATION_COMMAND_KINDS[0];

const commandOffRoster = async (): Promise<unknown> => admitV2AuthoritativeCommand(
  inertMarkerStore(), { commandKind: "not-a-v2-command", projectId: PROJECT_ID },
);
const markerUnreadable = async (): Promise<unknown> => admitV2AuthoritativeCommand(
  unreadableStore(), { commandKind: ROSTERED_COMMAND, projectId: PROJECT_ID },
);

const cutoverAuthorityArms = integrityArms({
  constant: "CUTOVER_V2_AUTHORITY_LAYER",
  downstream: { expect: NOT_ACTIVE, run: markerUnreadable },
  names: {
    after: "a rostered command over an unreadable marker store is not active after the roster admitted it",
    before: "a command off the v2 roster is refused before the marker store is read",
    race: "an off-roster command races an unreadable marker; neither is v2-authoritative",
  },
  slug: "cutover-v2-authority",
  upstream: { expect: COMMAND_UNKNOWN, run: commandOffRoster },
});

// ── The v2 readiness manifest ─────────────────────────────────────────────────────────

const READINESS_INVALID: RefusalExpectation = Object.freeze({
  code: "V2_READINESS_MANIFEST_INVALID", layer: V2_READINESS_MANIFEST_LAYER,
});
const READINESS_UNREADABLE: RefusalExpectation = Object.freeze({
  code: "V2_READINESS_MANIFEST_UNREADABLE", layer: V2_READINESS_MANIFEST_LAYER,
});

const readinessNotBytes = async (): Promise<unknown> => decodeV2ReadinessManifest(null);
const readinessUnreadable = async (): Promise<unknown> => readV2ReadinessManifest(
  unreadableStore(), { projectId: PROJECT_ID },
);

const readinessManifestArms = integrityArms({
  constant: "V2_READINESS_MANIFEST_LAYER",
  downstream: { expect: READINESS_UNREADABLE, run: readinessUnreadable },
  names: {
    after: "an unreadable store yields no manifest after a prior decode was refused",
    before: "a non-byte payload is refused at the codec before any store is read",
    race: "a non-byte payload races an unreadable store; no manifest is produced",
  },
  slug: "v2-readiness-manifest",
  upstream: { expect: READINESS_INVALID, run: readinessNotBytes },
});

// ── The v2 surface manifest ───────────────────────────────────────────────────────────

const SURFACE_INVALID: RefusalExpectation = Object.freeze({
  code: "V2_SURFACE_MANIFEST_INVALID", layer: V2_SURFACE_MANIFEST_LAYER,
});
const SURFACE_ROSTER_INVALID: RefusalExpectation = Object.freeze({
  code: "V2_SURFACE_MANIFEST_ROSTER_INVALID", layer: V2_SURFACE_MANIFEST_LAYER,
});

/** The exact key set, built from the declared keys, naming NO command v2-authoritative. */
function emptyRosterBytes(): Uint8Array {
  const body = Object.fromEntries(V2_SURFACE_MANIFEST_KEYS.map(
    (key) => [key, key === "mutationCommandKinds" ? [] : 0],
  ));
  return new TextEncoder().encode(JSON.stringify(body));
}

const surfaceNotBytes = async (): Promise<unknown> => decodeV2SurfaceManifest(null);
const surfaceEmptyRoster = async (): Promise<unknown> =>
  decodeV2SurfaceManifest(emptyRosterBytes());

const surfaceManifestArms = integrityArms({
  constant: "V2_SURFACE_MANIFEST_LAYER",
  downstream: { expect: SURFACE_ROSTER_INVALID, run: surfaceEmptyRoster },
  names: {
    after: "a well-keyed manifest naming no v2 command is refused after a prior decode was refused",
    before: "a non-byte payload is refused before any key is read",
    race: "a non-byte payload races an empty roster; neither becomes the surface pin",
  },
  slug: "v2-surface-manifest",
  upstream: { expect: SURFACE_INVALID, run: surfaceNotBytes },
});

export const RECENT_V2_CUTOVER_INTEGRITY_CASES: readonly IntegrityCase[] = Object.freeze([
  ...cutoverAuthorityArms,
  ...readinessManifestArms,
  ...surfaceManifestArms,
]);

// ── The v2 compiler (scheduler-activation) ────────────────────────────────────────────

const COMPILER_INPUT = layerOf(V2_COMPILER_LAYERS, "V2_COMPILER_INPUT");
const COMPILER_CONTRACT = layerOf(V2_COMPILER_LAYERS, "V2_COMPILER_CONTRACT");
const INPUT_MALFORMED: RefusalExpectation = Object.freeze({
  code: "V2_COMPILER_INPUT_MALFORMED", layer: COMPILER_INPUT,
});
const CONTRACT_INVALID: RefusalExpectation = Object.freeze({
  code: "V2_COMPILER_CONTRACT_INVALID", layer: COMPILER_CONTRACT,
});

const untouched = (port: string) => (): never => {
  throw new Error(`the compiler touched ${port} before refusing`);
};

/**
 * Every authority port throws. The factory descriptor-captures these exact functions
 * (own data properties on a plain object, a text project id), so a refusal answered by
 * the input or contract layer is proven to answer before any authority is consulted.
 */
function inertCompilerDependencies(): V2CompilerFactoryDependencies {
  return Object.freeze({
    clock: untouched("the clock"),
    projectId: PROJECT_ID,
    qualificationAuthority: Object.freeze({
      readDurableQualificationStatus: untouched("the qualification status port"),
      verifyDurableBuilderIdentity: untouched("the builder identity port"),
      verifyDurableOperatorApproval: untouched("the operator approval port"),
      verifyDurableProviderProfile: untouched("the provider profile port"),
      verifyDurableVerifierReceipt: untouched("the verifier receipt port"),
    }),
    readGraphAuthority: untouched("the graph authority port"),
    readNodeAdmissionAuthority: untouched("the node admission port"),
    readNodePlanningAuthority: untouched("the node planning port"),
    readPublishedSourceSnapshot: untouched("the source snapshot port"),
  });
}

const compileNotARecord = (): unknown =>
  createV2Compiler(inertCompilerDependencies()).compile(null, []);
const compileArrayForRecord = (): unknown =>
  createV2Compiler(inertCompilerDependencies()).compile([], []);
/** Exact input keys and admissible graph keys, so the input layer admits the SHAPE and the
 *  contract layer is the one that answers the `null` contract. */
const compileContractNull = (): unknown => createV2Compiler(inertCompilerDependencies()).compile(
  { completionNodeKey: "node-1", contract: null, graphId: "graph-1", nodes: [] }, [],
);

export const RECENT_V2_COMPILER_SCHEDULER_CASES: readonly SchedulerCase[] = Object.freeze([
  {
    constant: "V2_COMPILER_LAYERS", arm: "BEFORE" as const,
    name: "a non-record input is refused before any authority port is read",
    arranged: COMPILER_INPUT, expected: INPUT_MALFORMED,
    run: async () => compileNotARecord(),
  },
  {
    constant: "V2_COMPILER_LAYERS", arm: "AFTER" as const,
    name: "a well-keyed input carrying no contract is refused at the contract layer after the input layer admitted its shape",
    arranged: COMPILER_CONTRACT, expected: CONTRACT_INVALID,
    run: async () => { compileNotARecord(); return compileContractNull(); },
  },
]);

export const RECENT_V2_COMPILER_SCHEDULER_RACES: readonly SchedulerRaceCase[] = Object.freeze([
  {
    constant: "V2_COMPILER_LAYERS",
    name: "a non-record races an array where a record is due; neither compiles",
    arranged: COMPILER_INPUT,
    expected: INPUT_MALFORMED,
    maxAdmitted: 0 as const,
    run: async () => Promise.all([
      Promise.resolve().then(compileNotARecord),
      Promise.resolve().then(compileArrayForRecord),
    ]),
  },
]);

// ── The control room's Gate 1 answer mapper (transport) ───────────────────────────────

/** The module exports no `*_CODES` roster; this is its sole in-module refusal literal. */
const GATE1_RESPONSE_INVALID: RefusalExpectation = Object.freeze({
  code: "GATE1_RESPONSE_INVALID", layer: GATE1_LAYER,
});

const gate1NullBody = async (): Promise<unknown> => mapGate1Answer(200, null);
const gate1EmptyRecord = async (): Promise<unknown> => mapGate1Answer(200, {});
const gate1ArrayBody = async (): Promise<unknown> => mapGate1Answer(200, []);

export const RECENT_GATE1_TRANSPORT_CASES: readonly TransportCase[] = Object.freeze([
  {
    arm: "BEFORE", boundary: "GATE1_LAYER", expected: GATE1_RESPONSE_INVALID,
    name: "a 200 with a non-record body maps to no card state before any key is read",
    run: async () => (await probeBefore(BOUND, gate1NullBody, gate1EmptyRecord)).probe,
  },
  {
    arm: "AFTER", boundary: "GATE1_LAYER", expected: GATE1_RESPONSE_INVALID,
    name: "a 200 with an array where a record is due maps to no card state after a prior refusal",
    run: async () => (await probeAfter(BOUND, gate1EmptyRecord, gate1ArrayBody)).probe,
  },
  {
    arm: "RACE", boundary: "GATE1_LAYER",
    expected: { left: GATE1_RESPONSE_INVALID, right: GATE1_RESPONSE_INVALID },
    name: "a null body races an array body; neither maps to a card state",
    run: async () => probeRacing(BOUND, gate1NullBody, gate1ArrayBody),
  },
]);
