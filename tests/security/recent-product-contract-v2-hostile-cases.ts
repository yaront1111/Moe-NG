/**
 * Hostile arms for the seven Product Contract `/2` boundary constants the digit-aware
 * roster scanner surfaced without arms. Five are `integrity` by SUBJECT (codecs, a
 * materiality assessment, a durable-row validator and two reader/binding families) and
 * two are `scheduler-activation` (the ask-clarification and propose-revision command
 * services, which decide whether a command may advance the workflow).
 *
 * EVERY thunk here is deterministic and side-effect free. Hostile SHAPES drive the pure
 * admissions (`null`, a record with no options, bytes that are not UTF-8). Where the only
 * refusal-shaped producer takes a store, the store is an INERT proxy whose every property
 * read throws, so the arm proves the refusal answers before the store is touched; the two
 * readers whose first refusal needs a row get a store that answers exactly ONE canned page
 * carrying a non-JSON payload and throws on everything else. No store on disk, no
 * filesystem, no child process, no timer.
 *
 * Layers are read OUT of the production constants (a bare literal would stay green through
 * a rename) and codes are read OUT of each module's `*_CODES` roster where one exists; the
 * provenance validator publishes its codes only as a union type, so those two are pinned
 * at compile time through `ProductContractV2ProvenanceCode` instead.
 *
 * `PRODUCT_CONTRACT_V2_LAYERS` has no `*_ADMISSION` member: the `/2` admission refuses a
 * malformed value at its PROVENANCE layer (`product-contract-v2-admission.ts`, `invalid()`),
 * so PROVENANCE is the member the admission arms read.
 */
import {
  PRODUCT_CONTRACT_V2_CODES,
  PRODUCT_CONTRACT_V2_LAYERS,
} from "../../packages/core/src/product-contract/product-contract-v2-contract.js";
import {
  admitProductContractRevisionV2,
} from "../../packages/core/src/product-contract/product-contract-v2-admission.js";
import {
  decodeProductContractRevisionV2Bytes,
} from "../../packages/core/src/product-contract/product-contract-v2-codec.js";
import {
  PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY_CODES,
  PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY_LAYER,
  assessProductContractClarificationMaterialityV2,
} from "../../packages/core/src/product-contract/product-contract-v2-materiality.js";
import type {
  ProductContractClarificationV2SharedIdentity,
} from "../../packages/core/src/product-contract/product-contract-v2-materiality.js";
import {
  PRODUCT_CONTRACT_V2_GOAL_BINDING_CODES,
  PRODUCT_CONTRACT_V2_GOAL_BINDING_LAYER,
} from "../../apps/daemon/src/product-contract/product-contract-v2-goal-binding-contract.js";
import {
  prepareProductContractV2GoalBindingLegs,
} from "../../apps/daemon/src/product-contract/product-contract-v2-goal-binding-leg.js";
import {
  readProductContractV2GoalBinding,
} from "../../apps/daemon/src/product-contract/product-contract-v2-goal-binding-reader.js";
import {
  PRODUCT_CONTRACT_V2_WORKFLOW_CODES,
  PRODUCT_CONTRACT_V2_WORKFLOW_LAYER,
} from "../../apps/daemon/src/product-contract/product-contract-v2-workflow-contract.js";
import {
  readProductContractV2WorkflowHead,
} from "../../apps/daemon/src/product-contract/product-contract-v2-workflow-reader.js";
import {
  advanceProductContractV2AskWorkflow,
} from "../../apps/daemon/src/product-contract/product-contract-v2-workflow-transition.js";
import {
  PRODUCT_CONTRACT_V2_REVISION_READER_LAYER,
  validateProductContractV2EventProvenance,
} from "../../apps/daemon/src/product-contract/product-contract-v2-provenance.js";
import type {
  ProductContractV2ProvenanceCode,
} from "../../apps/daemon/src/product-contract/product-contract-v2-provenance.js";
import {
  PRODUCT_CONTRACT_CLARIFICATION_V2_CODES,
  PRODUCT_CONTRACT_CLARIFICATION_V2_LAYER,
} from "../../apps/daemon/src/product-contract/product-contract-v2-clarification-contract.js";
import {
  runAskProductContractClarificationV2,
} from "../../apps/daemon/src/product-contract/product-contract-v2-clarification-service.js";
import {
  PRODUCT_CONTRACT_PROPOSE_REVISION_V2_CODES,
  PRODUCT_CONTRACT_PROPOSE_REVISION_V2_LAYER,
  runProductContractProposeRevisionV2,
} from "../../apps/daemon/src/product-contract/product-contract-v2-propose-service.js";
import {
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
} from "../../packages/store/src/store-contracts.js";
import type { SqliteEventStore, StoredEvent } from "../../packages/store/src/index.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import type { RefusalExpectation } from "./hostile-harness.js";
import type { HostileCase as IntegrityCase } from "./integrity-hostile-cases.js";
import type {
  HostileCase as SchedulerCase,
  HostileRaceCase as SchedulerRaceCase,
} from "./scheduler-activation-hostile-cases.js";

const BOUND_MS = 2_000;
const HEX_64 = "a".repeat(64);
/** One byte that is not UTF-8, let alone JSON: every bounded decoder on this path refuses it. */
const NOT_UTF8 = Uint8Array.of(0xff);

function memberOf(declared: readonly string[], wanted: string, kind: string): string {
  const found = declared.find((entry) => entry === wanted);
  if (found === undefined) {
    throw new Error(`${wanted} is not a member of the declared ${kind}`);
  }
  return found;
}

/**
 * Reads a layer OUT of the boundary's own declared constant, the same drill the integrity
 * slice applies: a typed literal would stay green through a rename.
 */
function layerOf(declared: readonly string[], wanted: string): string {
  return memberOf(declared, wanted, "layer constant");
}

/** Reads a code OUT of the module's `*_CODES` roster, so a retired code reds here. */
function codeOf(declared: readonly string[], wanted: string): string {
  return memberOf(declared, wanted, "code roster");
}

// ── Store stand-ins ───────────────────────────────────────────────────────────────────────

/**
 * Every property read throws: the refusal under test must answer before touching the store.
 * A proxy rather than a method list because `SqliteEventStore` has a wide surface and the
 * claim is "nothing on it was called", not "these seven were not".
 */
function inertStore(): SqliteEventStore {
  return new Proxy(Object.freeze({}), {
    get(_target, property) {
      throw new Error(`the boundary touched store.${String(property)} before refusing`);
    },
  }) as never;
}

/**
 * Answers the reader's ONE aggregate read with a single event whose payload is not JSON;
 * every other property read throws, so the arm proves the reader refuses on that row
 * before any decision, receipt or companion lookup.
 */
function storeWithOneMalformedRow(): SqliteEventStore {
  const page = Object.freeze({
    hasMore: false,
    items: Object.freeze([Object.freeze({ payload: NOT_UTF8 })]),
  });
  return new Proxy(Object.freeze({}), {
    get(_target, property) {
      if (property === "readAggregateEvents") return () => page;
      throw new Error(`the reader touched store.${String(property)} after its first refusal`);
    },
  }) as never;
}

// ── Integrity axis ────────────────────────────────────────────────────────────────────────

interface Refusal {
  readonly expect: RefusalExpectation;
  /** A noun phrase naming the hostile input, composed into the three arm names. */
  readonly input: string;
  run(): Promise<unknown>;
}

interface IntegritySubject {
  readonly constant: string;
  readonly slug: string;
  readonly first: Refusal;
  readonly second: Refusal;
}

/** BEFORE / AFTER / RACE over two deterministic refusals of one boundary. */
function integrityArms(subject: IntegritySubject): readonly IntegrityCase[] {
  const { constant, first, second, slug } = subject;
  return Object.freeze([
    {
      arm: "BEFORE", constant, expect: first.expect,
      name: `${slug}: ${first.input} is refused before ${second.input} is seen`,
      run: async () => (await probeBefore(
        { label: `${slug}-before`, timeoutMs: BOUND_MS }, first.run, second.run,
      )).probe,
    },
    {
      arm: "AFTER", constant, expect: second.expect,
      name: `${slug}: ${second.input} is refused after ${first.input} was refused`,
      run: async () => (await probeAfter(
        { label: `${slug}-after`, timeoutMs: BOUND_MS }, first.run, second.run,
      )).probe,
    },
    {
      arm: "RACE", constant,
      name: `${slug}: ${first.input} races ${second.input}; neither is admitted`,
      expectLeft: first.expect, expectRight: second.expect,
      run: async () => probeRacing(
        { label: `${slug}-race`, timeoutMs: BOUND_MS }, first.run, second.run,
      ),
    },
  ]);
}

// 1. PRODUCT_CONTRACT_V2_LAYERS — the `/2` revision admission and its byte codec.
const V2_ADMISSION_LAYER = layerOf(PRODUCT_CONTRACT_V2_LAYERS, "PRODUCT_CONTRACT_V2_PROVENANCE");
const revisionSubject: IntegritySubject = {
  constant: "PRODUCT_CONTRACT_V2_LAYERS", slug: "product-contract-v2",
  first: {
    expect: {
      code: codeOf(PRODUCT_CONTRACT_V2_CODES, "PRODUCT_CONTRACT_V2_PROVENANCE_INVALID"),
      layer: V2_ADMISSION_LAYER,
    },
    input: "a non-record revision",
    run: async () => admitProductContractRevisionV2(null),
  },
  second: {
    expect: {
      code: codeOf(PRODUCT_CONTRACT_V2_CODES, "PRODUCT_CONTRACT_V2_BYTES_INVALID"),
      layer: V2_ADMISSION_LAYER,
    },
    input: "revision bytes that are not UTF-8",
    run: async () => decodeProductContractRevisionV2Bytes(NOT_UTF8),
  },
};

// 2. PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY_LAYER — the materiality assessment.
// (`deriveProductContractClarificationProjectionDigestV2` refuses at the `/2` PROVENANCE
// layer, not at this one, so it is not a producer of this constant's refusals.)
const MATERIALITY_LAYER = layerOf(
  [PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY_LAYER],
  "PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY",
);
const materialitySubject: IntegritySubject = {
  constant: "PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY_LAYER",
  slug: "product-contract-v2-materiality",
  first: {
    expect: {
      code: codeOf(
        PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY_CODES,
        "PRODUCT_CONTRACT_V2_CLARIFICATION_INVALID",
      ),
      layer: MATERIALITY_LAYER,
    },
    input: "a non-record clarification",
    run: async () => assessProductContractClarificationMaterialityV2(null),
  },
  second: {
    expect: {
      code: codeOf(
        PRODUCT_CONTRACT_V2_CLARIFICATION_MATERIALITY_CODES,
        "PRODUCT_CONTRACT_V2_CLARIFICATION_VACUOUS",
      ),
      layer: MATERIALITY_LAYER,
    },
    input: "a clarification with no options",
    run: async () => assessProductContractClarificationMaterialityV2({
      options: [], question: "Which way?",
    }),
  },
};

// 3. PRODUCT_CONTRACT_V2_GOAL_BINDING_LAYER — the contract's decoder answers `null`, so the
// refusal-shaped producers are the leg preparer (pure cause check) and the reader.
const GOAL_BINDING_LAYER = layerOf(
  [PRODUCT_CONTRACT_V2_GOAL_BINDING_LAYER], "PRODUCT_CONTRACT_V2_GOAL_BINDING",
);
const goalBindingSubject: IntegritySubject = {
  constant: "PRODUCT_CONTRACT_V2_GOAL_BINDING_LAYER", slug: "product-contract-v2-goal-binding",
  first: {
    expect: {
      code: codeOf(
        PRODUCT_CONTRACT_V2_GOAL_BINDING_CODES, "PRODUCT_CONTRACT_V2_GOAL_BINDING_MISMATCH",
      ),
      layer: GOAL_BINDING_LAYER,
    },
    input: "a binding cause naming a foreign command",
    run: async () => prepareProductContractV2GoalBindingLegs(inertStore(), {
      cause: { commandId: "cmd-forged", kind: "REVISION", ref: "rev-1" },
      commandId: "cmd-real", contractId: "contract-1", goalRef: "goal-1", projectId: "project-1",
    }),
  },
  second: {
    expect: {
      code: codeOf(
        PRODUCT_CONTRACT_V2_GOAL_BINDING_CODES, "PRODUCT_CONTRACT_V2_GOAL_BINDING_INVALID",
      ),
      layer: GOAL_BINDING_LAYER,
    },
    input: "a stored binding row that is not UTF-8",
    run: async () => readProductContractV2GoalBinding(storeWithOneMalformedRow(), {
      goalRef: "goal-1", projectId: "project-1",
    }),
  },
};

// 4. PRODUCT_CONTRACT_V2_WORKFLOW_LAYER — likewise: the head decoder answers `null`; the
// reader refuses a malformed row and the pure ask-transition refuses a lineage claim on an
// aggregate that has no history to descend from.
const WORKFLOW_LAYER = layerOf([PRODUCT_CONTRACT_V2_WORKFLOW_LAYER], "PRODUCT_CONTRACT_V2_WORKFLOW");
const LINEAGE_WITHOUT_HISTORY: ProductContractClarificationV2SharedIdentity = Object.freeze({
  authorRef: "author-1",
  contractId: "contract-1",
  lineage: Object.freeze({ parentRevisionDigest: HEX_64, parentRevisionId: "rev-0" }),
  retiredCriterionIds: Object.freeze([]),
  retiredRequirementIds: Object.freeze([]),
  revisionId: "rev-1",
  sourceDocumentDigests: Object.freeze([HEX_64]),
});
const workflowSubject: IntegritySubject = {
  constant: "PRODUCT_CONTRACT_V2_WORKFLOW_LAYER", slug: "product-contract-v2-workflow",
  first: {
    expect: {
      code: codeOf(PRODUCT_CONTRACT_V2_WORKFLOW_CODES, "PRODUCT_CONTRACT_V2_WORKFLOW_INVALID"),
      layer: WORKFLOW_LAYER,
    },
    input: "a stored workflow row that is not UTF-8",
    run: async () => readProductContractV2WorkflowHead(storeWithOneMalformedRow(), {
      contractId: "contract-1", projectId: "project-1",
    }),
  },
  second: {
    expect: {
      code: codeOf(
        PRODUCT_CONTRACT_V2_WORKFLOW_CODES, "PRODUCT_CONTRACT_V2_WORKFLOW_CURRENT_MISMATCH",
      ),
      layer: WORKFLOW_LAYER,
    },
    input: "a first ask claiming lineage from an unrecorded parent",
    run: async () => advanceProductContractV2AskWorkflow(null, {
      clarificationId: `clar-v2-${HEX_64}`, commandId: "cmd-1", goalRef: "goal-1",
      identity: LINEAGE_WITHOUT_HISTORY, projectId: "project-1",
    }),
  },
};

// 5. PRODUCT_CONTRACT_V2_REVISION_READER_LAYER — the two-leg provenance validator. It reads
// both events' traces before the first store call, so both refusals answer over an inert
// store. The module publishes its codes as a union type only; pinning each literal through
// that type is the compile-time roster check.
const READER_LAYER = layerOf(
  [PRODUCT_CONTRACT_V2_REVISION_READER_LAYER], "PRODUCT_CONTRACT_V2_REVISION_READER",
);
const PROVENANCE_ABSENT: ProductContractV2ProvenanceCode = "PRODUCT_CONTRACT_V2_PROVENANCE_ABSENT";
const COMMAND_KIND_MISMATCH: ProductContractV2ProvenanceCode =
  "PRODUCT_CONTRACT_V2_COMMAND_KIND_MISMATCH";
/** A well-formed decision trace whose command kind is not the `/2` revision command. */
function eventTracedAs(commandKind: string): StoredEvent {
  return Object.freeze({
    aggregateSequence: 1,
    decisionTrace: Object.freeze({
      commandId: "cmd-1", commandKind, principalId: "principal-1", projectId: "project-1",
      requestIdentityVersion: COMMAND_DECISION_REQUEST_IDENTITY_VERSION, requestSha256: HEX_64,
    }),
    requestSha256: HEX_64,
  }) as never;
}
const provenanceSubject: IntegritySubject = {
  constant: "PRODUCT_CONTRACT_V2_REVISION_READER_LAYER", slug: "product-contract-v2-provenance",
  first: {
    expect: { code: PROVENANCE_ABSENT, layer: READER_LAYER },
    input: "an event pair carrying no decision trace",
    run: async () => validateProductContractV2EventProvenance(inertStore(), {
      contractId: "contract-1", projectId: "project-1", revisionEvent: {} as never,
      revisionId: "rev-1", slotEvent: {} as never,
    }),
  },
  second: {
    expect: { code: COMMAND_KIND_MISMATCH, layer: READER_LAYER },
    input: "an event pair traced to a foreign command kind",
    run: async () => validateProductContractV2EventProvenance(inertStore(), {
      contractId: "contract-1", projectId: "project-1",
      revisionEvent: eventTracedAs("not-the-v2-revision-command"), revisionId: "rev-1",
      slotEvent: eventTracedAs("not-the-v2-revision-command"),
    }),
  },
};

export const RECENT_PRODUCT_CONTRACT_V2_INTEGRITY_CASES: readonly IntegrityCase[] =
  Object.freeze([
    revisionSubject, materialitySubject, goalBindingSubject, workflowSubject, provenanceSubject,
  ].flatMap(integrityArms));

// ── Scheduler-activation axis ─────────────────────────────────────────────────────────────

/** A well-formed command envelope, so the ONLY malformed thing is the `null` payload. */
const COMMAND_ENVELOPE = Object.freeze({
  commandId: "cmd-1",
  correlationId: "corr-1",
  decidedAt: "2026-09-02T00:00:00.000Z",
  principalId: "principal-1",
  projectId: "project-1",
  targetAggregateId: "goal-1",
});

interface SchedulerSpec {
  readonly constant: string;
  readonly expected: RefusalExpectation;
  readonly refused: () => unknown;
}

const schedulerSpecs: readonly SchedulerSpec[] = Object.freeze([
  // 6. The ask-clarification command service: the payload is shape-checked before any
  // materiality, authority or store read, so a `null` payload is refused over an inert store.
  {
    constant: "PRODUCT_CONTRACT_CLARIFICATION_V2_LAYER",
    expected: {
      code: codeOf(
        PRODUCT_CONTRACT_CLARIFICATION_V2_CODES, "PRODUCT_CONTRACT_V2_CLARIFICATION_MALFORMED",
      ),
      layer: layerOf(
        [PRODUCT_CONTRACT_CLARIFICATION_V2_LAYER], "PRODUCT_CONTRACT_V2_CLARIFICATION",
      ),
    },
    refused: () => runAskProductContractClarificationV2(inertStore(), {
      ...COMMAND_ENVELOPE, payload: null,
    }),
  },
  // 7. The propose-revision command service: same ordering, same inert store.
  {
    constant: "PRODUCT_CONTRACT_PROPOSE_REVISION_V2_LAYER",
    expected: {
      code: codeOf(
        PRODUCT_CONTRACT_PROPOSE_REVISION_V2_CODES, "PRODUCT_CONTRACT_V2_PROPOSE_MALFORMED",
      ),
      layer: layerOf(
        [PRODUCT_CONTRACT_PROPOSE_REVISION_V2_LAYER], "PRODUCT_CONTRACT_V2_PROPOSE",
      ),
    },
    refused: () => runProductContractProposeRevisionV2(inertStore(), {
      ...COMMAND_ENVELOPE, payload: null,
    }),
  },
]);

export const RECENT_PRODUCT_CONTRACT_V2_SCHEDULER_CASES: readonly SchedulerCase[] =
  Object.freeze(schedulerSpecs.flatMap((spec) => [
    {
      constant: spec.constant, arm: "BEFORE" as const,
      name: "a null payload is refused before the store is touched",
      arranged: spec.expected.layer, expected: spec.expected,
      run: async () => spec.refused(),
    },
    {
      constant: spec.constant, arm: "AFTER" as const,
      name: "a null payload remains refused after a prior refusal",
      arranged: spec.expected.layer, expected: spec.expected,
      run: async () => { spec.refused(); return spec.refused(); },
    },
  ]));

export const RECENT_PRODUCT_CONTRACT_V2_SCHEDULER_RACES: readonly SchedulerRaceCase[] =
  Object.freeze(schedulerSpecs.map((spec) => ({
    constant: spec.constant,
    name: "two null payloads racing admit neither",
    arranged: spec.expected.layer,
    expected: spec.expected,
    maxAdmitted: 0 as const,
    run: async () => Promise.all([
      Promise.resolve().then(spec.refused),
      Promise.resolve().then(spec.refused),
    ]),
  })));
