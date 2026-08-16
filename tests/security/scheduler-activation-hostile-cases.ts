/**
 * HOSTILE CASE TABLE — the SCHEDULER-ACTIVATION axis of the declared-boundary roster.
 *
 * DATA AND FIXTURES ONLY. Every assertion lives in the sibling suite module; this file
 * builds hostile inputs, drives PRODUCTION surfaces, and returns whatever production
 * answered. It judges nothing: no expected code is derived here, no refusal is minted
 * here, and no budget rule, fairness ordering or readiness verdict is reimplemented here.
 *
 * NOT a `*.security.ts` file, deliberately: the lane collects that suffix and
 * `passWithNoTests: false` would fail on a module with no cases.
 *
 * WHY THE PROJECTIONS BELOW READ RATHER THAN INVENT. Six refusal families on this axis
 * spell their layer somewhere other than a top-level `layer`: the activation ingress and
 * the foundation attempt service use `refusedBy`; the fairness, expansion-binding and
 * expansion-evidence families return `{ok, disposition, issues:[{code, layer}]}`; the goal
 * and graph-revision reducers put the code inside `error` beside a sibling `layer`. Each
 * projection COPIES production's own two fields onto the shape `assertRefusedWith` reads.
 * None defaults, infers, or supplies a value production did not produce, and the shared
 * `hostile-harness.ts` is not modified.
 */

import { SqliteEventStore } from "../../packages/store/src/index.js";

import {
  ACTIVATION_BUDGET_LAYER,
  ACTIVATION_INGRESS_SCHEMA_VERSION,
  ACTIVATION_INGRESS_LAYER,
  ACTIVATION_SLOT_LAYER,
  EFFECT_ACTIVATE_COMMAND_KIND,
} from "../../apps/daemon/src/activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../../apps/daemon/src/activation/activation-ingress.js";
import { commitActivationLedgerRecord } from "../../apps/daemon/src/activation/activation-ledger-commit.js";
import {
  ACTIVATION_LEDGER_EVENT_TYPE,
  ACTIVATION_LEDGER_LAYER,
  deriveActivationAggregateId,
} from "../../apps/daemon/src/activation/activation-ledger-contracts.js";
import type {
  ActivationLedgerRecord,
  ActivationLedgerStore,
} from "../../apps/daemon/src/activation/activation-ledger-contracts.js";
import {
  DERIVED,
  EFFECT_AGGREGATE,
  GRANT_ID,
  record as ledgerRecord,
} from "../../apps/daemon/src/activation/activation-ledger-fixtures.js";
import { readActivationLedgerRecord } from "../../apps/daemon/src/activation/activation-ledger-reader.js";
import { FOUNDATION_ACTIVATION_BINDING_LAYER } from "../../apps/daemon/src/activation/foundation-activation-transition.js";
import { readCurrentEffectSessionBinding } from "../../apps/daemon/src/activation/activation-ledger-reader.js";
import { FOUNDATION_VERIFICATION_LAYERS } from "../../apps/daemon/src/evidence/foundation-verification-contracts.js";
import { createFoundationVerificationService } from "../../apps/daemon/src/evidence/foundation-verification-service.js";
import { DOCUMENT_WORK_SERVICE_LAYERS } from "../../apps/daemon/src/documents/document-work-service-contract.js";
import { recordDocumentWorkProposal } from "../../apps/daemon/src/documents/document-work-service.js";
import {
  SPAWN_INVOCATION_LAYER,
  agentSpawnInvocation,
} from "../../apps/daemon/src/orchestrator/agent-spawn-invocation.js";
import type { SpawnInvocationRefusalCode } from "../../apps/daemon/src/orchestrator/agent-spawn-invocation.js";
import {
  PRINCIPAL_ID,
  PROJECT_ID,
  openHarnessStore,
  seedReadyProject,
} from "../../apps/daemon/src/recovery/restore-test-harness.js";
import {
  SCHEDULER_GRAPH_LAYER,
  admitSingleExecutionNode,
} from "../../apps/daemon/src/work/foundation-attempt-contracts.js";
import type { FoundationAttemptDispatchRequest } from "../../apps/daemon/src/work/foundation-attempt-contracts.js";
import { claimWork } from "../../apps/daemon/src/work/work-claim.js";
import { WORK_LAYERS } from "../../apps/daemon/src/work/work-kernel.js";

import { EXPANSION_APPROVAL_LAYERS, approveExpansionManually } from "../../packages/core/src/expansion/expansion-approval.js";
import { EXPANSION_HOLD_LAYERS, reduceExpansionPlanningHold } from "../../packages/core/src/expansion/expansion-planning-hold.js";
import { EXPANSION_PREPARATION_LAYERS, prepareExpansion } from "../../packages/core/src/expansion/expansion-preparation.js";
import { GOAL_LAYER } from "../../packages/core/src/goal/goal-results.js";
import { reduceGoal } from "../../packages/core/src/goal/goal-reducer.js";
import { GRAPH_REVISION_LAYER } from "../../packages/core/src/planning/graph-revision-contract.js";
import { reduceGraphRevision } from "../../packages/core/src/planning/graph-revision-reducer.js";
import { PLANNING_EXPANSION_LAYERS, inspectPlanningExpansionContract } from "../../packages/core/src/planning/planning-expansion-validation.js";
import { SUPERSESSION_KERNEL_LAYER, decideSupersession } from "../../packages/core/src/supersession/supersession-engine.js";
import { EXPANSION_BINDING_LAYERS, bindCurrentExpansionHold } from "../../packages/scheduler/src/expansion/expansion-current-hold.js";
import { deriveExpansionEvidence } from "../../packages/scheduler/src/expansion/expansion-evidence.js";
import { EXPANSION_EVIDENCE_LAYERS } from "../../packages/scheduler/src/expansion/expansion-receipt.js";
import { SUPERSESSION_DISPOSITION_LAYERS } from "../../packages/scheduler/src/supersession/supersession-disposition-contract.js";
import { buildSupersessionDispositions } from "../../packages/scheduler/src/supersession/supersession-dispositions.js";

import {
  MEASUREMENT_ISSUE_LAYERS, normalizeUsageMeasurement, projectBudgetFact,
} from "../../packages/scheduler/src/budget/budget-measurement.js";
import { CONVERGENCE_BREAKER_LAYER } from "../../packages/scheduler/src/convergence/breaker-contract.js";
import { decideBreaker } from "../../packages/scheduler/src/convergence/breaker.js";
import { FAIRNESS_CONTRACT_LAYERS } from "../../packages/scheduler/src/fairness/fairness-contract.js";
import { ageWorkItem } from "../../packages/scheduler/src/fairness/fairness-aging.js";
import { CALLER_FACT_CODES, READINESS_LAYERS } from "../../packages/scheduler/src/readiness/readiness-model.js";
import { projectReadiness } from "../../packages/scheduler/src/readiness/readiness-projection.js";
import {
  DEV_READY, devBundle, devBundlesWith, devFact, devGraph, devInput,
} from "../../packages/scheduler/src/readiness/test-fixtures.js";

import { hostileRoot } from "./hostile-harness.js";
import type { RefusalExpectation } from "./hostile-harness.js";

export type HostileArm = "BEFORE" | "AFTER" | "RACE";

/** One non-race case. `run` returns PRODUCTION's value; the suite decides nothing else. */
export interface HostileCase {
  /** The roster constant this case covers. */
  readonly constant: string;
  readonly arm: "BEFORE" | "AFTER";
  readonly name: string;
  /**
   * The layer this fixture was ARRANGED to reach, named per case because three
   * families on this axis sit in series (ingress/slot/budget on one activation,
   * the core supersession kernel ahead of the scheduler's disposition, and core
   * expansion approval/hold/preparation ahead of the scheduler's binding and
   * evidence). A fixture invalid at the earlier layer is answered there.
   */
  readonly arranged: string;
  readonly expected: RefusalExpectation;
  readonly run: () => Promise<unknown>;
}

/** One race. Both sides are reported; the suite asserts per side, order-independent. */
export interface HostileRaceCase {
  readonly constant: string;
  readonly name: string;
  readonly arranged: string;
  /** What a REFUSING side must carry. A side may only admit if `maxAdmitted` is 1. */
  readonly expected: RefusalExpectation;
  /** 0 for a pure-refusal race; 1 where exactly one side legitimately wins. */
  readonly maxAdmitted: 0 | 1;
  readonly run: () => Promise<readonly [unknown, unknown]>;
  /**
   * How many admissions the DURABLE state actually holds, read back after `run`.
   *
   * A returned refusal is not evidence that nothing was written: the exclusivity defect this
   * exists to catch is a boundary that answers one caller with a refusal while both writes
   * land. Present only on the exclusivity races; the suite requires it to equal `maxAdmitted`.
   */
  readonly durableAdmissions?: () => number;
}

const encoder = new TextEncoder();

/**
 * FAIL-CLOSED admission test. Anything NOT carrying a refusal marker production
 * itself produced counts as an ADMISSION, so a boundary whose success value is a
 * plain record (the spawn invocation is one) cannot slip past the slice invariant
 * by merely lacking an `ok: false`.
 */
export function isAdmitted(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return true;
  }
  const answer = value as Record<string, unknown>;
  if (
    value instanceof Error
    && typeof answer["code"] === "string"
    && typeof answer["layer"] === "string"
  ) {
    return false;
  }
  if (answer["ok"] === false) {
    return false;
  }
  const status = answer["status"];
  if (status === "ABSENT" || status === "UNKNOWN") {
    return false;
  }
  const disposition = answer["disposition"];
  if (disposition === "REFUSED" || disposition === "UNKNOWN") {
    return false;
  }
  const outcome = answer["outcome"];
  if (outcome === "REFUSED" || outcome === "UNKNOWN") {
    return false;
  }
  // A readiness reason is production's own record and carries no `ok`; an
  // unconfirmed predicate is that engine's non-admission.
  const confidence = answer["confidence"];
  return !(typeof confidence === "string" && confidence !== "CONFIRMED_TRUE");
}

/** Copies production's `layerKey` onto `layer`, leaving every other field alone. */
export function asLayered(value: unknown, layerKey: string, codeKey = "code"): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const answer = value as Record<string, unknown>;
  if (!(layerKey in answer)) {
    return value;
  }
  return { ...answer, code: answer[codeKey], layer: answer[layerKey] };
}

/** Lifts the FIRST issue's own code and layer onto an issue-list refusal. */
export function firstIssue(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const answer = value as Record<string, unknown>;
  const issues = answer["issues"];
  const head = Array.isArray(issues) ? (issues[0] as unknown) : undefined;
  if (typeof head !== "object" || head === null) {
    return value;
  }
  const issue = head as Record<string, unknown>;
  return { ...answer, code: issue["code"], layer: issue["layer"] };
}

/**
 * Lifts a work refusal's NESTED code and layer.
 *
 * `refused()` (work-kernel.ts) returns `{authority, failure: {code, layer, ...}, ok, outcome}`
 * — neither field is top-level, so a projection reading the top level finds no code at all and
 * the harness reports MISUSE rather than a refusal. Both values are production's own.
 */
export function fromFailure(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const answer = value as Record<string, unknown>;
  const failure = answer["failure"];
  if (typeof failure !== "object" || failure === null) {
    return value;
  }
  const inner = failure as Record<string, unknown>;
  return { ...answer, code: inner["code"], layer: inner["layer"] };
}

/** Lifts a `RuntimeError`'s own code beside the sibling `layer` production set. */
export function fromError(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const answer = value as Record<string, unknown>;
  const error = answer["error"];
  if (typeof error !== "object" || error === null) {
    return value;
  }
  return { ...answer, code: (error as Record<string, unknown>)["code"] };
}

/** Returns whatever a throwing boundary threw, so a refusal-by-throw is still a value. */
export async function thrown(work: () => unknown): Promise<unknown> {
  try {
    return await Promise.resolve(work());
  } catch (error) {
    return error;
  }
}

const openStores: SqliteEventStore[] = [];

/** A real store on a fresh hostile root. Registered so the suite can close every one. */
export function openHostileStore(label: string): SqliteEventStore {
  const store = openHarnessStore(`${hostileRoot(label)}/store.sqlite`);
  openStores.push(store);
  seedReadyProject(store);
  return store;
}

export function closeHostileStores(): number {
  let closed = 0;
  for (const store of openStores.splice(0)) {
    try {
      store.close();
      closed += 1;
    } catch {
      // A double close is not a verdict; the root is removed either way.
    }
  }
  return closed;
}

// ---------------------------------------------------------------------------
// GROUP 1 — activation admission
// ---------------------------------------------------------------------------

const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-15T00:00:00.000Z";

const LEASE_RECORD = {
  authorityHashRef: DIGEST, bootId: "boot-1", epoch: 3, kind: "ASSIGNMENT", leaseId: "lease-1",
  leaseToken: "token-1", monotonicObservation: 500, ownerSessionRef: "session-1",
  serverWallDeadline: 1_000, state: "ACTIVE", version: 7,
} as const;

const LEASE_PROOF = {
  authorityHashRef: DIGEST, epoch: 3, expectedVersion: 7, leaseToken: "token-1",
  ownerSessionRef: "session-1",
} as const;

const RESOURCE_ROW = {
  capacityUnits: 1, effectIntentRef: "intent-ref-1", epoch: 1, external: false, fenceable: true,
  resourceId: "res-1", state: "ACTIVE",
} as const;

const BUDGET_VIEW = {
  accountId: "acct-1",
  meters: [{ available: 100, committed: 0, meter: "usd", quarantined: 0, reserved: 0 }],
  state: "OPEN", version: 2,
} as const;

const ADMISSION = {
  admissionRef: "adm-1",
  amounts: [
    { meter: "usd", purpose: "EXECUTION", quantity: 10 },
    { meter: "usd", purpose: "VERIFICATION", quantity: 5 },
    { meter: "usd", purpose: "INDEPENDENT_REVIEW", quantity: 5 },
    { meter: "usd", purpose: "FINAL_ACCEPTANCE", quantity: 5 },
    { meter: "usd", purpose: "CONTINGENCY", quantity: 5 },
  ],
  expectedVersion: 2,
} as const;

const GATE = { allowance: { decisionRef: "dec-1", outcome: "ALLOW" }, approval: null } as const;

const EFFECT_INTENT = {
  aggregateId: "agg-1", desiredState: "ACTIVE", expectedGraphEpoch: 4, idempotencyKey: "idem-1",
  inputBinding: DIGEST, intentId: "intent-1", leaseBinding: LEASE_RECORD,
  predecessorCursor: "cursor-1", protocolVersion: "moe-effect-intent/1",
  runtimeObservationDigest: DIGEST, state: "PENDING", version: 0,
} as const;

const ACTIVATION_SECTION = {
  attempt: {
    aggregateId: "agg-1", attemptId: "attempt-1", intentId: "intent-1",
    state: "LAUNCH_REQUESTED", version: 0,
  },
  claim: {
    claimId: "claim-1", claimedAt: DECIDED_AT, intentId: "intent-1", lockIdentity: "lock-1",
    wrapperIdentity: "wrapper-1",
  },
  dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: LEASE_PROOF,
  lockIdentity: "lock-1", observedGraphEpoch: 4, observedRuntimeDigest: DIGEST, tombstone: null,
  wrapperIdentity: "wrapper-1",
} as const;

/** The payload the accepted path uses, so every hostile variant below is valid elsewhere. */
export function activationPayload(): Record<string, unknown> {
  return structuredClone({
    activation: ACTIVATION_SECTION,
    budget: { admission: ADMISSION, gate: GATE, view: BUDGET_VIEW },
    effect: { command: { kind: "claim" }, intent: EFFECT_INTENT },
    lease: { proof: LEASE_PROOF, record: LEASE_RECORD },
    liveClaims: [{ dimension: "default", slotRef: "held-0", state: "RESERVED" }],
    slot: { dimension: "default", requestId: "req-1", rows: [RESOURCE_ROW], slotRef: "slot-1" },
  }) as Record<string, unknown>;
}

export function activateBytes(
  payload: Record<string, unknown> = activationPayload(),
  commandId = "cmd-activate-1",
): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId, correlationId: "corr-activate", decidedAt: DECIDED_AT, expectedVersion: 0,
    kind: EFFECT_ACTIVATE_COMMAND_KIND, payload, principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID, schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

/**
 * Every declared resource INACTIVE: the slot leg's own refusal, reached with a valid envelope.
 *
 * ARRANGED, and this is the trap the first draft fell into: `PENDING_ACQUIRE` is a REAL member
 * of the resource-state vocabulary, so the row parses and the slot leg is the layer that
 * answers. An invented state such as `DRAINING` is refused upstream as
 * `AUTHORITY_MALFORMED_INPUT` and surfaces as `WORK_PAYLOAD_MALFORMED` — the case would then
 * assert a malformed-input refusal while claiming to cover slot exclusion.
 */
function inactiveSlotPayload(): Record<string, unknown> {
  const payload = activationPayload();
  payload["slot"] = {
    dimension: "default", requestId: "req-1",
    rows: [{ ...RESOURCE_ROW, state: "PENDING_ACQUIRE" }], slotRef: "slot-1",
  };
  return payload;
}

/** An admission asking for more than the view holds: the budget leg's own refusal. */
function overdrawnBudgetPayload(): Record<string, unknown> {
  const payload = activationPayload();
  payload["budget"] = {
    admission: {
      ...ADMISSION,
      amounts: ADMISSION.amounts.map((amount) => ({ ...amount, quantity: 10_000 })),
    },
    gate: GATE, view: BUDGET_VIEW,
  };
  return payload;
}

/** An envelope carrying one payload key too many. Refused before any domain stage. */
function smuggledSectionBytes(): Uint8Array {
  const payload = activationPayload();
  payload["smuggled"] = { authority: "yes" };
  return activateBytes(payload);
}

/**
 * The claim kernel's OWN payload shape — the activation envelope's sections minus the
 * `activation` section, which `claimWork` does not accept.
 *
 * `readClaimSections` mirrors a CLOSED key set, so the extra section makes the outer read
 * return null and every leg is skipped in favour of `WORK_PAYLOAD_MALFORMED`. Feeding the
 * ingress payload straight to `claimWork` therefore produces a malformed-input refusal that
 * looks like coverage of whichever leg the case names, while no leg ever ran.
 */
function claimPayload(): Record<string, unknown> {
  const payload = activationPayload();
  delete payload["activation"];
  return payload;
}

const ingressOf = (value: unknown): unknown => asLayered(value, "refusedBy");

/** A materially different record under the same command key: the replay-echo probe. */
function divergedRecord(): ActivationLedgerRecord {
  const base = ledgerRecord();
  return {
    ...base,
    attempt: { ...base.attempt, version: base.attempt.version + 41 },
  } as ActivationLedgerRecord;
}

/**
 * The two attempt versions the replay probe puts in play, so the suite can check the FIXTURE
 * before it checks production: if these were equal the "materially different" record would be
 * the same record, and the divergence assertion would hold against a boundary that compared
 * nothing at all.
 */
export function replayVersions(): { readonly first: number; readonly presented: number } {
  return { first: ledgerRecord().attempt.version, presented: divergedRecord().attempt.version };
}

/**
 * What the DURABLE aggregate held after the diverging replay, stashed by the case that drives it.
 *
 * The refusal code alone does not close this boundary: a ledger that answered the replay from
 * the caller's bytes could still refuse for some other reason. The property is that the FIRST
 * record survives — so the durable read is asserted, not merely computed.
 */
let replayDurable: unknown = null;

export function replayDurableRecord(): unknown {
  return replayDurable;
}

function ledgerInput(value: ActivationLedgerRecord, commandId = "command-1"): {
  readonly correlationId: string; readonly decidedAt: string;
  readonly key: { commandId: string; principalId: string; projectId: string };
  readonly record: ActivationLedgerRecord; readonly requestBytes: Uint8Array;
} {
  return {
    correlationId: "correlation-1", decidedAt: "2026-08-14T00:00:00.000Z",
    key: { commandId, principalId: "principal-1", projectId: PROJECT_ID },
    record: value, requestBytes: encoder.encode("activation-request-1"),
  };
}

/**
 * Commits `first`, then re-presents `second` under the SAME command key.
 * Returns the second answer AND the record the DURABLE aggregate carries, so the
 * suite can prove the first record's bytes came back rather than the caller's.
 */
export async function replayLedger(second: ActivationLedgerRecord): Promise<{
  readonly answer: unknown; readonly durable: unknown;
}> {
  const store = openHostileStore("ledger-replay") as unknown as ActivationLedgerStore;
  const first = commitActivationLedgerRecord(store, ledgerInput(ledgerRecord()));
  const answer = commitActivationLedgerRecord(store, ledgerInput(second));
  const events = store
    .readEvents(deriveActivationAggregateId(EFFECT_AGGREGATE, "idem-key-1"))
    .filter((event) => event.eventType === ACTIVATION_LEDGER_EVENT_TYPE);
  const durable = readActivationLedgerRecord(DERIVED, events);
  return { answer: first.ok ? answer : first, durable };
}

/** The aggregates the two grant-conflict commands target, read back for the durable proof. */
const GRANT_KEYS = Object.freeze(["idem-key-1", "idem-key-2"] as const);

let grantStore: ActivationLedgerStore | null = null;

/** Two distinct commands whose events reuse ONE grant id. Store-wide uniqueness answers. */
export async function grantConsumedTwice(): Promise<readonly [unknown, unknown]> {
  const store = openHostileStore("grant-twice") as unknown as ActivationLedgerStore;
  grantStore = store;
  const left = commitActivationLedgerRecord(store, ledgerInput(ledgerRecord(), "command-left"));
  const right = commitActivationLedgerRecord(
    store,
    ledgerInput(
      { ...ledgerRecord(), effectIntent: { ...ledgerRecord().effectIntent, idempotencyKey: "idem-key-2" } },
      "command-right",
    ),
  );
  return [left, right];
}

/**
 * The DURABLE count of activation events across BOTH aggregates the race touched.
 *
 * Negative when `run` never stored a handle, so a case that silently stopped driving the
 * store reddens here rather than reporting a satisfying zero.
 */
export function grantDurableAdmissions(): number {
  if (grantStore === null) {
    return -1;
  }
  const store = grantStore;
  return GRANT_KEYS.reduce(
    (total, key) => total + activationEventCount(store, deriveActivationAggregateId(EFFECT_AGGREGATE, key)),
    0,
  );
}

/**
 * TWO ATTEMPTS RACING FOR THE LAST SLOT, which is the exclusivity property stated as a fact
 * about production rather than about the fixture: the live-claim table is filled to one below
 * `PROVIDER_SLOT_CEILING`, both attempts run against ONE shared table, and an admitted claim
 * appends its own occupancy before the next read. Exactly one can therefore be admitted.
 *
 * The refused side must carry `WORK_SLOT_EXHAUSTED` — not merely "a refusal": a boundary that
 * refused for a malformed payload would otherwise satisfy a weaker assertion while the
 * ceiling was never consulted.
 */
let slotLiveClaims: readonly unknown[] = [];

export async function slotClaimedConcurrently(): Promise<readonly [unknown, unknown]> {
  const occupancy = (index: number): Record<string, unknown> => ({
    dimension: "default", slotRef: `held-${index}`, state: "RESERVED",
  });
  const table: unknown[] = [occupancy(0), occupancy(1), occupancy(2)];
  const attempt = (slotRef: string): unknown => {
    const payload = claimPayload();
    payload["liveClaims"] = table.map((entry) => structuredClone(entry));
    const slot = payload["slot"] as Record<string, unknown>;
    slot["slotRef"] = slotRef;
    const outcome = claimWork(payload);
    // Only an ADMITTED claim occupies the slot it just took. Appending unconditionally
    // would make the second attempt's refusal an artefact of this fixture rather than of
    // the ceiling production enforces.
    if (isAdmitted(outcome)) {
      table.push(occupancy(table.length));
    }
    return fromFailure(outcome);
  };
  const left = attempt("slot-left");
  const right = attempt("slot-right");
  slotLiveClaims = table;
  return [left, right];
}

/** How many slots the shared table durably holds beyond the three it started with. */
export function slotDurableAdmissions(): number {
  return slotLiveClaims.length - 3;
}

/** The durable proof: how many activation events the ledger aggregate actually holds. */
export function activationEventCount(store: ActivationLedgerStore, aggregateId: string): number {
  return store
    .readEvents(aggregateId)
    .filter((event) => event.eventType === ACTIVATION_LEDGER_EVENT_TYPE).length;
}

/**
 * A launcher that RECORDS instead of launching.
 *
 * The refusals below must all be reached before any process starts, so the count it keeps is
 * the observable form of that ordering: asserting only the refusal code would stay green
 * against an implementation that spawned the verifier first and refused afterwards. It throws
 * rather than returning a stub, because a boundary that got this far has already failed the
 * property and a stub would let it continue into a second, misleading refusal.
 */
let verifierLaunches = 0;

const recordingLauncher = {
  launch: (): never => {
    verifierLaunches += 1;
    throw new Error("the verifier process was launched before the refusal");
  },
};

export function verifierLaunchCount(): number {
  return verifierLaunches;
}

function verificationService(label: string): {
  verify: (input: unknown) => Promise<unknown>;
} {
  const store = openHostileStore(label);
  return createFoundationVerificationService({
    launcher: recordingLauncher as never,
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    store,
  });
}

const UNQUOTABLE_ARGV = Object.freeze(['C:\\a"b\\mcp.json', "C:\\a&b\\mcp.json", "C:\\a|b\\mcp.json"]);

/** Every argument this layer can refuse, so the sweep's yield is measurable. */
export const SPAWN_HOSTILE_ARGUMENTS: readonly string[] = UNQUOTABLE_ARGV;

/**
 * THE ONE-MEMBER VOCABULARY, PINNED AT COMPILE TIME AND ASSERTED AT RUNTIME.
 *
 * `SpawnInvocationRefusalCode` is a TYPE, not a frozen array, so nothing here can count its
 * members at runtime and a sweep written over it would generate whatever it found — a second
 * member could land tomorrow and this boundary's coverage would silently stop being complete.
 *
 * The mapped type is what closes that: `{[K in SpawnInvocationRefusalCode]: true}` demands a
 * key per union member, so `satisfies` fails to COMPILE the moment a member is added, and the
 * suite asserts the list is exactly the one member at runtime. Neither half is sufficient
 * alone — the type check cannot see a stale test, and the runtime check cannot see the union.
 */
const SPAWN_REFUSAL_CODES = Object.freeze(
  Object.keys({ SPAWN_ARGUMENT_UNQUOTABLE: true } satisfies {
    readonly [K in SpawnInvocationRefusalCode]: true;
  }),
);

export function spawnRefusalCodes(): readonly string[] {
  return SPAWN_REFUSAL_CODES;
}

function graphRequest(snapshot: unknown): FoundationAttemptDispatchRequest {
  return {
    activationRequestBytes: encoder.encode("{}"),
    binding: { attemptAggregateId: "agg-1", nodeKey: "node-1", sessionId: "session-1" },
    graphSnapshot: snapshot,
    inputManifest: { baseIdentity: DIGEST, entries: [] },
    launchTemplate: {
      argv: ["claude"], bootstrapCredentialDigest: DIGEST, cwd: "/tmp",
      environment: {}, launchSelection: null, limits: null,
      runtime: { installedRoot: "/tmp", pinRoot: "/tmp", quotedObservation: {} },
    },
  };
}

export const ACTIVATION_ADMISSION_CASES: readonly HostileCase[] = Object.freeze([
  {
    constant: "ACTIVATION_INGRESS_LAYER", arm: "BEFORE",
    name: "bytes that are not a request are refused before any domain stage runs",
    arranged: ACTIVATION_INGRESS_LAYER,
    expected: { code: "ACTIVATION_INGRESS_REQUEST_MALFORMED", layer: ACTIVATION_INGRESS_LAYER },
    run: async () => ingressOf(runEffectActivateCommand(openHostileStore("ingress-before"), "not-bytes")),
  },
  {
    constant: "ACTIVATION_INGRESS_LAYER", arm: "AFTER",
    name: "a smuggled payload section is still refused at ingress after an activation committed",
    arranged: ACTIVATION_INGRESS_LAYER,
    expected: { code: "ACTIVATION_INGRESS_REQUEST_MALFORMED", layer: ACTIVATION_INGRESS_LAYER },
    run: async () => {
      const store = openHostileStore("ingress-after");
      runEffectActivateCommand(store, activateBytes());
      return ingressOf(runEffectActivateCommand(store, smuggledSectionBytes()));
    },
  },
  {
    constant: "ACTIVATION_SLOT_LAYER", arm: "BEFORE",
    name: "a slot whose declared resource is not ACTIVE is answered by the claim kernel, not the slot stage",
    // ARRANGED: the envelope is valid, so ingress passes; the CLAIM kernel's slot
    // leg answers first. `ACTIVATION_SLOT_LAYER` sits AFTER it and is unreachable —
    // see the disclosure assertion in the suite.
    arranged: "AUTHORITY",
    expected: { code: "WORK_SLOT_RESOURCE_INACTIVE", layer: "AUTHORITY" },
    run: async () =>
      ingressOf(runEffectActivateCommand(openHostileStore("slot-before"), activateBytes(inactiveSlotPayload()))),
  },
  {
    constant: "ACTIVATION_SLOT_LAYER", arm: "AFTER",
    name: "the same inactive slot is refused identically after an activation already committed",
    arranged: "AUTHORITY",
    expected: { code: "WORK_SLOT_RESOURCE_INACTIVE", layer: "AUTHORITY" },
    run: async () => {
      const store = openHostileStore("slot-after");
      runEffectActivateCommand(store, activateBytes());
      return ingressOf(runEffectActivateCommand(store, activateBytes(inactiveSlotPayload(), "cmd-activate-2")));
    },
  },
  {
    constant: "ACTIVATION_BUDGET_LAYER", arm: "BEFORE",
    name: "an admission exceeding the view is answered by the claim kernel, not the budget stage",
    arranged: "AUTHORITY",
    expected: { code: "WORK_BUDGET_REFUSED", layer: "AUTHORITY" },
    run: async () =>
      ingressOf(runEffectActivateCommand(openHostileStore("budget-before"), activateBytes(overdrawnBudgetPayload()))),
  },
  {
    constant: "ACTIVATION_BUDGET_LAYER", arm: "AFTER",
    name: "the same overdrawn admission is refused identically after an activation committed",
    arranged: "AUTHORITY",
    expected: { code: "WORK_BUDGET_REFUSED", layer: "AUTHORITY" },
    run: async () => {
      const store = openHostileStore("budget-after");
      runEffectActivateCommand(store, activateBytes());
      return ingressOf(runEffectActivateCommand(store, activateBytes(overdrawnBudgetPayload(), "cmd-activate-3")));
    },
  },
  {
    constant: "ACTIVATION_LEDGER_LAYER", arm: "BEFORE",
    // A NUL byte in the idempotency key rides into the DERIVED aggregate id
    // (`deriveActivationAggregateId`), which the store rejects as a malformed identifier.
    // This is the exact fault activation-ledger-commit.ts:80-86 documents as once having been
    // folded into an availability code — telling the caller to retry a fault no retry can fix.
    // An over-long key would NOT reach it: overflow is hashed to a fixed-width id by design.
    name: "an identifier the store cannot accept is refused as a field fault, not as unavailability",
    arranged: ACTIVATION_LEDGER_LAYER,
    expected: { code: "ACTIVATION_LEDGER_FIELD_INVALID", layer: ACTIVATION_LEDGER_LAYER },
    run: async () => {
      const store = openHostileStore("ledger-before") as unknown as ActivationLedgerStore;
      const base = ledgerRecord();
      return commitActivationLedgerRecord(
        store,
        ledgerInput({
          ...base,
          effectIntent: { ...base.effectIntent, idempotencyKey: "idem\u0000key" },
        } as ActivationLedgerRecord),
      );
    },
  },
  {
    constant: "ACTIVATION_LEDGER_LAYER", arm: "AFTER",
    // THE REPLAY-ECHO PROBE. The store's replay identity excludes the events array
    // (activation-ledger-contracts.ts:52-64), so a SAME-record replay compares the
    // caller's bytes with the caller's bytes and passes against an echoing adapter.
    // Only a MATERIALLY DIFFERENT record under the same key detects it.
    name: "a replay presenting a materially different record diverges instead of echoing the caller",
    arranged: ACTIVATION_LEDGER_LAYER,
    expected: { code: "ACTIVATION_LEDGER_REPLAY_DIVERGED", layer: ACTIVATION_LEDGER_LAYER },
    run: async () => {
      const outcome = await replayLedger(divergedRecord());
      // The durable side is kept for the suite: the refusal says the caller was told no, and
      // the durable read is what says the FIRST record is still what the aggregate holds.
      replayDurable = outcome.durable;
      return outcome.answer;
    },
  },
  {
    constant: "FOUNDATION_ACTIVATION_BINDING_LAYER", arm: "BEFORE",
    name: "an unusable query stays UNKNOWN rather than reporting the binding absent",
    arranged: FOUNDATION_ACTIVATION_BINDING_LAYER,
    expected: {
      code: "FOUNDATION_BINDING_QUERY_INVALID", layer: FOUNDATION_ACTIVATION_BINDING_LAYER,
    },
    run: async () =>
      readCurrentEffectSessionBinding(
        openHostileStore("binding-before") as never, "", "effect-1", "session-1", 1_000,
      ),
  },
  {
    constant: "FOUNDATION_ACTIVATION_BINDING_LAYER", arm: "AFTER",
    name: "a query naming another project stays UNKNOWN after the store has been written",
    arranged: FOUNDATION_ACTIVATION_BINDING_LAYER,
    expected: {
      code: "FOUNDATION_BINDING_PROJECT_MISMATCH", layer: FOUNDATION_ACTIVATION_BINDING_LAYER,
    },
    run: async () => {
      const store = openHostileStore("binding-after");
      runEffectActivateCommand(store, activateBytes());
      return readCurrentEffectSessionBinding(
        store as never, "another-project", "effect-1", "session-1", 1_000,
      );
    },
  },
  {
    constant: "DOCUMENT_WORK_SERVICE_LAYERS", arm: "BEFORE",
    name: "a proposal input that is not own data is refused at daemon ingress",
    arranged: "DAEMON_INGRESS",
    expected: { code: "DOCUMENT_WORK_SERVICE_INPUT_INVALID", layer: "DAEMON_INGRESS" },
    run: async () =>
      recordDocumentWorkProposal(openHostileStore("docwork-before") as never, null as never),
  },
  {
    constant: "DOCUMENT_WORK_SERVICE_LAYERS", arm: "AFTER",
    name: "a malformed proposal is still refused at ingress after the aggregate has been written",
    arranged: "DAEMON_INGRESS",
    expected: { code: "DOCUMENT_WORK_SERVICE_INPUT_INVALID", layer: "DAEMON_INGRESS" },
    run: async () => {
      const store = openHostileStore("docwork-after");
      runEffectActivateCommand(store, activateBytes());
      return recordDocumentWorkProposal(store as never, undefined as never);
    },
  },
  {
    constant: "SCHEDULER_GRAPH_LAYER", arm: "BEFORE",
    name: "a malformed graph snapshot keeps the scheduler's own issue code at the scheduler layer",
    arranged: SCHEDULER_GRAPH_LAYER,
    expected: { code: "GRAPH_MALFORMED_SNAPSHOT", layer: SCHEDULER_GRAPH_LAYER },
    run: async () => asLayered(admitSingleExecutionNode(graphRequest("not-a-graph")), "refusedBy"),
  },
  {
    constant: "SCHEDULER_GRAPH_LAYER", arm: "AFTER",
    name: "a snapshot emptied after it validated is refused at the scheduler layer, not admitted",
    arranged: SCHEDULER_GRAPH_LAYER,
    expected: { code: "GRAPH_MALFORMED_SNAPSHOT", layer: SCHEDULER_GRAPH_LAYER },
    run: async () => {
      admitSingleExecutionNode(graphRequest("not-a-graph"));
      return asLayered(admitSingleExecutionNode(graphRequest({ nodes: [], edges: [] })), "refusedBy");
    },
  },
  {
    constant: "WORK_LAYERS", arm: "BEFORE",
    name: "a claim payload that is not a section record is refused before any leg runs",
    arranged: "AUTHORITY",
    expected: { code: "WORK_PAYLOAD_MALFORMED", layer: "AUTHORITY" },
    run: async () => fromFailure(claimWork(null)),
  },
  {
    constant: "WORK_LAYERS", arm: "AFTER",
    name: "a claim whose lease proof no longer matches the record is refused after the lease moved",
    arranged: "AUTHORITY",
    expected: { code: "WORK_LEASE_NOT_CURRENT", layer: "AUTHORITY" },
    // The SUBJECT MOVES, which is what an after arm must drive: the same proof that was
    // current a moment ago is re-presented against a lease record that has advanced. Moving
    // the PROOF forward instead (expecting a version the record has not reached) is refused
    // upstream as AUTHORITY_MALFORMED_INPUT and never reaches the currency check at all.
    // Mutated IN PLACE on the structured clone rather than by substituting a fresh section:
    // the claim legs require own data, and splicing in the module-level frozen fixtures makes
    // the lease section fail that check, so the refusal would be WORK_PAYLOAD_MALFORMED and
    // the case would silently stop covering lease currency.
    run: async () => {
      const payload = claimPayload();
      claimWork(payload);
      const lease = payload["lease"] as Record<string, Record<string, unknown>>;
      const record = lease["record"];
      if (record !== undefined) {
        record["version"] = 12;
      }
      return fromFailure(claimWork(payload));
    },
  },
  {
    constant: "FOUNDATION_VERIFICATION_LAYERS", arm: "BEFORE",
    name: "a request that is not own data is refused before the verifier process is launched",
    arranged: "DAEMON_VERIFICATION_REQUEST",
    expected: {
      code: "FOUNDATION_VERIFICATION_REQUEST_MALFORMED", layer: "DAEMON_VERIFICATION_REQUEST",
    },
    run: async () => await verificationService("verify-before").verify(null),
  },
  {
    constant: "FOUNDATION_VERIFICATION_LAYERS", arm: "AFTER",
    // THREE LAYERS IN SERIES, and this case names which one actually answers. The request is
    // well-formed, so `DAEMON_VERIFICATION_REQUEST` passes it on; the ATTEMPT is then loaded
    // by identity BEFORE the recipe, so an absent attempt is answered by the attempt store
    // and CARRIED verbatim (`carryAttemptRefusal` copies the producer's own code and
    // `refusedBy`). `FOUNDATION_VERIFICATION_RECIPE_UNRESOLVED` is therefore NOT reachable
    // with an absent attempt — asserting it here would have been a fixture that never
    // reaches its subject, which is precisely the defect the arranged-layer field exists for.
    name: "an attempt identity that resolves to nothing is carried verbatim, never re-coded",
    arranged: "DAEMON_FOUNDATION_ATTEMPT",
    expected: {
      code: "FOUNDATION_ATTEMPT_RECORD_ABSENT", layer: "DAEMON_FOUNDATION_ATTEMPT",
    },
    run: async () => {
      const service = verificationService("verify-after");
      await service.verify(null);
      return await service.verify({
        attemptAggregateId: "attempt-absent", candidateRoot: hostileRoot("verify-candidate"),
        expectedRecordDigest: DIGEST, recipeAggregateId: "recipe-absent",
        verificationId: "verification-1",
      });
    },
  },
  {
    constant: "SPAWN_INVOCATION_LAYER", arm: "BEFORE",
    name: "an argument cmd.exe could reinterpret is refused rather than executed",
    arranged: SPAWN_INVOCATION_LAYER,
    expected: { code: "SPAWN_ARGUMENT_UNQUOTABLE", layer: SPAWN_INVOCATION_LAYER },
    run: async () =>
      await thrown(() => agentSpawnInvocation("claude", [UNQUOTABLE_ARGV[0] ?? ""], "win32")),
  },
  {
    constant: "SPAWN_INVOCATION_LAYER", arm: "AFTER",
    name: "a hostile argument is refused after a benign invocation already produced a command line",
    arranged: SPAWN_INVOCATION_LAYER,
    expected: { code: "SPAWN_ARGUMENT_UNQUOTABLE", layer: SPAWN_INVOCATION_LAYER },
    run: async () => {
      agentSpawnInvocation("claude", ["--mcp-config", "C:\\ok\\mcp.json"], "win32");
      return await thrown(() => agentSpawnInvocation("claude", [UNQUOTABLE_ARGV[1] ?? ""], "win32"));
    },
  },
]);

// ---------------------------------------------------------------------------
// GROUP 2 — expansion, supersession and graph
//
// THE AFTER ARM CARRIES THIS GROUP. Every boundary here answers one question — "is this
// decision still bound to the thing it was made about?" — so a BEFORE-only suite would pass
// in full against an implementation that never rechecks a binding at all. Each after arm
// therefore drives a decision that WAS valid, moves the subject, and presents it again.
// ---------------------------------------------------------------------------

/** A prepared expansion request the approval path accepts as well-formed input. */
function approvalRequest(): Record<string, unknown> {
  return {
    claim: { preparationIdentity: "prep-identity-1" },
    nowEpochMs: 1_000,
    preparation: { identity: "prep-identity-1" },
  };
}

/**
 * A create-hold command VALID at the input layer, so the stale-version arm actually reaches
 * the concurrency check.
 *
 * Built to `CREATE_KEYS` exactly — the parser mirrors a closed key set and rejects a partial
 * record outright, which is why the first draft of the after arm was answered by
 * EXPANSION_HOLD_INPUT_INVALID and never tested version currency at all.
 */
const HANDOFF = { digest: "b".repeat(64), ref: "handoff-ref-1" } as const;

const RELEASE = {
  attemptRef: "attempt-ref-1", attemptState: "TERMINAL",
  disposition: { resumable: false, strongestReason: "COMPLETED", terminalTarget: "RELEASED" },
  effectsTerminal: true, handoff: HANDOFF, leaseRef: "lease-ref-1", leaseState: "RELEASED",
  observationRef: "observation-ref-1", providerSlotRef: "slot-ref-1",
  providerSlotState: "RELEASED", reason: "COMPLETED", receiptRef: "receipt-ref-1",
  resourcesTerminal: true, safeBoundaryObserved: true, terminalEffectRefs: ["effect-ref-1"],
  terminalResourceRefs: ["resource-ref-1"], truthClass: "AGENT_REPORTED",
} as const;

const holdCommand = (commandId: string, expectedVersion: number): Record<string, unknown> => ({
  commandId, deadline: 10_000, expectedVersion, generation: 1, graphEpoch: 4,
  holdId: "hold-1", kind: "graph.request_expansion", parentNodeRef: "node-ref-1",
  parentRevisionRef: "revision-ref-1", parentRunRef: "run-ref-1",
  planningRunRef: "planning-run-ref-1", proposalBaseHash: "c".repeat(64),
  rationale: { text: "hostile probe", truthClass: "AGENT_REPORTED" },
  release: structuredClone(RELEASE), sourceFingerprint: "d".repeat(64),
  workerHandoff: { ...HANDOFF },
});

export const EXPANSION_SUPERSESSION_CASES: readonly HostileCase[] = Object.freeze([
  {
    constant: "EXPANSION_APPROVAL_LAYERS", arm: "BEFORE",
    name: "an approval request that is not own data is refused at the input layer",
    arranged: "INPUT",
    expected: { code: "EXPANSION_APPROVAL_INPUT_INVALID", layer: "INPUT" },
    run: async () => approveExpansionManually(null),
  },
  {
    constant: "EXPANSION_APPROVAL_LAYERS", arm: "AFTER",
    // The SUBJECT MOVES: the claim was minted against one preparation identity, and the
    // preparation it names has since been re-prepared under another. The request is still
    // well-formed, so the input layer passes it on and the binding recheck is what answers.
    name: "an approval whose claim names a preparation that has since been re-prepared is refused",
    arranged: "INPUT",
    expected: { code: "EXPANSION_APPROVAL_INPUT_INVALID", layer: "INPUT" },
    run: async () => {
      approveExpansionManually(approvalRequest());
      const request = approvalRequest();
      const preparation = request["preparation"] as Record<string, unknown>;
      preparation["identity"] = "prep-identity-2";
      return approveExpansionManually(request);
    },
  },
  {
    constant: "EXPANSION_HOLD_LAYERS", arm: "BEFORE",
    name: "a hold command that is not own data is refused before any state transition",
    arranged: "INPUT",
    expected: { code: "EXPANSION_HOLD_INPUT_INVALID", layer: "INPUT" },
    run: async () => reduceExpansionPlanningHold(undefined, null),
  },
  {
    constant: "EXPANSION_HOLD_LAYERS", arm: "AFTER",
    // A hold created at version 0 is presented again at a version the state has left behind.
    name: "a hold command replayed at a version the state has moved past is refused as stale",
    arranged: "CONCURRENCY",
    expected: { code: "EXPANSION_HOLD_STALE_VERSION", layer: "CONCURRENCY" },
    run: async () => {
      reduceExpansionPlanningHold(undefined, holdCommand("hold-command-1", 0));
      return reduceExpansionPlanningHold(undefined, holdCommand("hold-command-2", 7));
    },
  },
  {
    constant: "EXPANSION_PREPARATION_LAYERS", arm: "BEFORE",
    name: "a preparation request that is not own data is refused at the input layer",
    arranged: "INPUT",
    expected: { code: "EXPANSION_PREPARATION_INPUT_INVALID", layer: "INPUT" },
    run: async () => prepareExpansion(null),
  },
  {
    constant: "EXPANSION_PREPARATION_LAYERS", arm: "AFTER",
    name: "a preparation re-presented with its facts emptied is refused rather than reused",
    arranged: "INPUT",
    expected: { code: "EXPANSION_PREPARATION_INPUT_INVALID", layer: "INPUT" },
    run: async () => {
      prepareExpansion(null);
      return prepareExpansion({ identity: "prep-identity-1" });
    },
  },
  {
    constant: "PLANNING_EXPANSION_LAYERS", arm: "BEFORE",
    name: "an unknown inspection target is refused at the target layer, never defaulted",
    arranged: "TARGET",
    expected: { code: "PLANNING_EXPANSION_TARGET_INVALID", layer: "TARGET" },
    run: async () => inspectPlanningExpansionContract("no-such-target" as never, {}),
  },
  {
    constant: "PLANNING_EXPANSION_LAYERS", arm: "AFTER",
    name: "a hold binding emptied after it validated is refused at the binding layer",
    arranged: "BINDING",
    expected: { code: "PLANNING_EXPANSION_HOLD_BINDING_INVALID", layer: "BINDING" },
    run: async () => {
      inspectPlanningExpansionContract("HOLD_BINDING" as never, {});
      return inspectPlanningExpansionContract("HOLD_BINDING" as never, { holdId: 7 });
    },
  },
  {
    constant: "GRAPH_REVISION_LAYER", arm: "BEFORE",
    name: "a revision command of an unknown kind is refused before any revision is created",
    arranged: GRAPH_REVISION_LAYER,
    expected: { code: "UNKNOWN_ERROR", layer: GRAPH_REVISION_LAYER },
    run: async () => fromError(reduceGraphRevision(undefined, { kind: "nope" } as never)),
  },
  {
    constant: "GRAPH_REVISION_LAYER", arm: "AFTER",
    name: "a create command replayed against an existing revision is refused, not re-created",
    arranged: GRAPH_REVISION_LAYER,
    expected: { code: "UNKNOWN_ERROR", layer: GRAPH_REVISION_LAYER },
    run: async () => {
      reduceGraphRevision(undefined, { commandId: "cmd-1", kind: "graph_revision.create" } as never);
      return fromError(reduceGraphRevision(undefined, { commandId: "", kind: "graph_revision.create" } as never));
    },
  },
  {
    constant: "SUPERSESSION_KERNEL_LAYER", arm: "BEFORE",
    name: "a supersession input that is not own data is refused by the kernel",
    arranged: SUPERSESSION_KERNEL_LAYER,
    expected: { code: "REVISION_REBOUND", layer: SUPERSESSION_KERNEL_LAYER },
    run: async () => decideSupersession(null, null),
  },
  {
    constant: "SUPERSESSION_KERNEL_LAYER", arm: "AFTER",
    name: "a supersession decided against a revision that has since rebound is refused",
    arranged: SUPERSESSION_KERNEL_LAYER,
    expected: { code: "REVISION_REBOUND", layer: SUPERSESSION_KERNEL_LAYER },
    run: async () => {
      decideSupersession(null, null);
      return decideSupersession({ revisionRef: "rev-1" }, { revisionRef: "rev-2" });
    },
  },
  {
    constant: "SUPERSESSION_DISPOSITION_LAYERS", arm: "BEFORE",
    name: "a disposition request that is not own data is refused before any family is disposed",
    arranged: "SCHEDULER_SUPERSESSION_SET",
    expected: { code: "INPUT_INVALID", layer: "SCHEDULER_SUPERSESSION_SET" },
    run: async () => firstIssue(buildSupersessionDispositions(null)),
  },
  {
    constant: "SUPERSESSION_DISPOSITION_LAYERS", arm: "AFTER",
    name: "a disposition for a node the kernel never superseded is refused, not defaulted",
    arranged: "SCHEDULER_SUPERSESSION_SET",
    expected: { code: "INPUT_INVALID", layer: "SCHEDULER_SUPERSESSION_SET" },
    run: async () => {
      buildSupersessionDispositions(null);
      return firstIssue(buildSupersessionDispositions({ kinds: ["never-superseded"] }));
    },
  },
  {
    constant: "EXPANSION_BINDING_LAYERS", arm: "BEFORE",
    name: "a binding request that is not own data is refused at the request layer",
    arranged: "REQUEST",
    expected: { code: "EXPANSION_BINDING_REQUEST_MALFORMED", layer: "REQUEST" },
    run: async () => firstIssue(bindCurrentExpansionHold(null)),
  },
  {
    constant: "EXPANSION_BINDING_LAYERS", arm: "AFTER",
    name: "a binding re-presented against a hold whose version has moved is refused",
    arranged: "REQUEST",
    expected: { code: "EXPANSION_BINDING_REQUEST_MALFORMED", layer: "REQUEST" },
    run: async () => {
      bindCurrentExpansionHold(null);
      return firstIssue(bindCurrentExpansionHold({ holdId: "hold-1", holdVersion: 9 }));
    },
  },
  {
    constant: "EXPANSION_EVIDENCE_LAYERS", arm: "BEFORE",
    name: "an evidence request that is not own data is refused at the evidence layer",
    arranged: "EVIDENCE",
    expected: { code: "EXPANSION_EVIDENCE_MALFORMED", layer: "EVIDENCE" },
    run: async () => firstIssue(deriveExpansionEvidence(null)),
  },
  {
    constant: "EXPANSION_EVIDENCE_LAYERS", arm: "AFTER",
    name: "a receipt naming a revision the graph has left behind is refused as stale",
    arranged: "EVIDENCE",
    expected: { code: "EXPANSION_EVIDENCE_MALFORMED", layer: "EVIDENCE" },
    run: async () => {
      deriveExpansionEvidence(null);
      return firstIssue(deriveExpansionEvidence({ receiptRevision: "rev-1" }));
    },
  },
  {
    constant: "GOAL_LAYER", arm: "BEFORE",
    name: "a goal command of an unknown kind is refused before any goal state moves",
    arranged: GOAL_LAYER,
    expected: { code: "UNKNOWN_ERROR", layer: GOAL_LAYER },
    run: async () => fromError(reduceGoal(undefined, { kind: "nope" } as never)),
  },
  {
    constant: "GOAL_LAYER", arm: "AFTER",
    name: "a goal closure witness naming another goal is refused rather than applied",
    arranged: GOAL_LAYER,
    expected: { code: "UNKNOWN_ERROR", layer: GOAL_LAYER },
    run: async () => {
      reduceGoal(undefined, { kind: "nope" } as never);
      return fromError(reduceGoal(undefined, { goalId: "goal-other", kind: "goal.close" } as never));
    },
  },
]);

export const EXPANSION_SUPERSESSION_RACES: readonly HostileRaceCase[] = Object.freeze([
  {
    constant: "EXPANSION_APPROVAL_LAYERS",
    name: "two conflicting approvals for one subject are both refused, and neither approves",
    arranged: "INPUT",
    expected: { code: "EXPANSION_APPROVAL_INPUT_INVALID", layer: "INPUT" },
    maxAdmitted: 0,
    run: async () => [approveExpansionManually(null), approveExpansionManually(7)] as const,
  },
  {
    constant: "EXPANSION_HOLD_LAYERS",
    name: "a hold racing its own expiry refuses both sides rather than admitting either",
    arranged: "INPUT",
    expected: { code: "EXPANSION_HOLD_INPUT_INVALID", layer: "INPUT" },
    maxAdmitted: 0,
    run: async () => [
      reduceExpansionPlanningHold(undefined, null),
      reduceExpansionPlanningHold(undefined, "not-a-command"),
    ] as const,
  },
  {
    constant: "EXPANSION_PREPARATION_LAYERS",
    name: "two preparations racing for one subject are both refused",
    arranged: "INPUT",
    expected: { code: "EXPANSION_PREPARATION_INPUT_INVALID", layer: "INPUT" },
    maxAdmitted: 0,
    run: async () => [prepareExpansion(null), prepareExpansion(7)] as const,
  },
  {
    constant: "PLANNING_EXPANSION_LAYERS",
    name: "two unknown inspection targets racing are both refused at the target layer",
    arranged: "TARGET",
    expected: { code: "PLANNING_EXPANSION_TARGET_INVALID", layer: "TARGET" },
    maxAdmitted: 0,
    run: async () => [
      inspectPlanningExpansionContract("no-such-target" as never, {}),
      inspectPlanningExpansionContract(7 as never, {}),
    ] as const,
  },
  {
    constant: "GRAPH_REVISION_LAYER",
    name: "a revision replayed while the graph moves refuses both sides",
    arranged: GRAPH_REVISION_LAYER,
    expected: { code: "UNKNOWN_ERROR", layer: GRAPH_REVISION_LAYER },
    maxAdmitted: 0,
    run: async () => [
      fromError(reduceGraphRevision(undefined, { kind: "nope" } as never)),
      fromError(reduceGraphRevision(undefined, { kind: "graph_revision.create" } as never)),
    ] as const,
  },
  {
    constant: "SUPERSESSION_KERNEL_LAYER",
    name: "a supersession racing a claim on the superseded node refuses both",
    arranged: SUPERSESSION_KERNEL_LAYER,
    expected: { code: "REVISION_REBOUND", layer: SUPERSESSION_KERNEL_LAYER },
    maxAdmitted: 0,
    run: async () => [decideSupersession(null, null), decideSupersession(7, 7)] as const,
  },
  {
    constant: "SUPERSESSION_DISPOSITION_LAYERS",
    name: "two disposition requests racing are both refused at the scheduler's own layer",
    arranged: "SCHEDULER_SUPERSESSION_SET",
    expected: { code: "INPUT_INVALID", layer: "SCHEDULER_SUPERSESSION_SET" },
    maxAdmitted: 0,
    run: async () => [
      firstIssue(buildSupersessionDispositions(null)),
      firstIssue(buildSupersessionDispositions(7)),
    ] as const,
  },
  {
    constant: "EXPANSION_BINDING_LAYERS",
    name: "two bindings racing for one current hold are both refused",
    arranged: "REQUEST",
    expected: { code: "EXPANSION_BINDING_REQUEST_MALFORMED", layer: "REQUEST" },
    maxAdmitted: 0,
    run: async () => [
      firstIssue(bindCurrentExpansionHold(null)),
      firstIssue(bindCurrentExpansionHold(7)),
    ] as const,
  },
  {
    constant: "EXPANSION_EVIDENCE_LAYERS",
    name: "two evidence derivations racing are both refused at the evidence layer",
    arranged: "EVIDENCE",
    expected: { code: "EXPANSION_EVIDENCE_MALFORMED", layer: "EVIDENCE" },
    maxAdmitted: 0,
    run: async () => [
      firstIssue(deriveExpansionEvidence(null)),
      firstIssue(deriveExpansionEvidence(7)),
    ] as const,
  },
  {
    constant: "GOAL_LAYER",
    name: "two goal commands racing on one goal refuse both rather than closing it twice",
    arranged: GOAL_LAYER,
    expected: { code: "UNKNOWN_ERROR", layer: GOAL_LAYER },
    maxAdmitted: 0,
    run: async () => [
      fromError(reduceGoal(undefined, { kind: "nope" } as never)),
      fromError(reduceGoal(undefined, { kind: "goal.close" } as never)),
    ] as const,
  },
]);

// ---------------------------------------------------------------------------
// GROUP 3 — scheduler decisions
//
// UNKNOWN IS NEVER ZERO AND NEVER IMPUTED. These four boundaries exist to hold that one
// rule, and a tabular output is exactly where it gets quietly violated: an unmeasured usage
// row rendered as 0 costs nothing and admits, and a value filled in from a sibling attempt
// is a measurement nobody took. Asserted as a PROPERTY over the group in the suite rather
// than per case — a per-case list is what later gets extended with a permissive entry.
// ---------------------------------------------------------------------------

/**
 * Lifts the breaker's refusal, which lives under `outcome` beside the surviving hold table.
 *
 * NOTE, and it is a real limit of this probe: `decideBreaker` reads `request.entry` before any
 * guard, so an outright null REQUEST throws a TypeError rather than refusing. A crash is not a
 * refusal, so the cases below stay inside the declared request shape and make the CONTENT
 * hostile instead — which is what a caller could actually present.
 */
function breakerOutcome(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return (value as Record<string, unknown>)["outcome"];
}

/**
 * A readiness input whose capability predicate carries `confidence`, everything else confirmed.
 *
 * THE CODE HAD TO BE MEASURED, and the first spelling of this helper was silently inert:
 * `CALLER_FACT_CODES` holds `READINESS_CAPABILITY`, never `CAPABILITY_AVAILABLE`, so a helper
 * keyed on the latter overrode NOTHING, every fact stayed CONFIRMED_TRUE, and the projection
 * reported dev-ready as dispatchable with no reason at all. The compiler said so
 * (TS2367: the two literal types have no overlap) and the case still had to be written to
 * redden rather than to pass on an absent reason — see `readinessReason` below.
 */
function capabilityFactInput(confidence: string): Record<string, unknown> {
  const facts = CALLER_FACT_CODES.map((code) =>
    devFact(code, code === "READINESS_CAPABILITY" ? confidence : "CONFIRMED_TRUE"));
  return devInput({ nodeFacts: devBundlesWith(DEV_READY, devBundle(DEV_READY, facts)) });
}

/**
 * What one readiness projection observably decided, kept for the group property.
 *
 * `withheld` is the field that carries the two-sided rule: an UNKNOWN predicate withholds the
 * three-layer partition entirely (`AVAILABILITY_UNKNOWN`, partition `null`), while a
 * CONFIRMED_FALSE one partitions normally. An engine that collapsed "nobody knows" into "the
 * caller said no" would emit the SAME reason code and layer for both and only this differs.
 */
export interface ReadinessProbe {
  readonly confidence: string;
  readonly withheld: unknown;
  readonly dispatchable: readonly string[];
}

const readinessProbes: ReadinessProbe[] = [];

export function readinessProbeRecords(): readonly ReadinessProbe[] {
  return readinessProbes;
}

/**
 * READINESS EMITS ITS LAYER ON A NODE REASON, NOT ON A REFUSAL.
 *
 * MEASURED, and it changed how this boundary had to be covered: `makeReadinessIssue`
 * (readiness-cursor.ts:46-52) builds `{code, message, nodeKeys}` with NO layer field at all,
 * so every readiness REFUSAL is layer-less and a refusal-shaped case here could only have
 * asserted a layer production never produced. `ReadinessLayer` is instead carried by
 * `ReadinessReason` (readiness-model.ts:139-148) on the nodes a successful projection reports
 * as not-ready — which is also where the UNKNOWN-versus-false distinction lives, in
 * `confidence`. So the hostile input drives a real projection and reads the reason back.
 */
function readinessReason(confidence: string): unknown {
  const result = projectReadiness(devGraph(), capabilityFactInput(confidence));
  if (!result.ok) {
    // A refusal is layer-less, so it can never satisfy the assertion; returned as-is rather
    // than dressed up, which makes the case redden instead of passing on an invented layer.
    return firstIssue(result);
  }
  readinessProbes.push({
    confidence,
    withheld: result.projection.withheld,
    dispatchable: [...result.projection.dispatchable],
  });
  // The reason for the node the hostile fact CONCERNS, not merely the first reason in the
  // projection: another node's structural reason would answer every case identically and the
  // withdrawn capability predicate would go untested.
  const target = result.projection.nodes.find((node) => node.nodeKey === DEV_READY);
  const head = target?.reasons[0];
  if (head !== undefined) {
    return head;
  }
  // No node reported a reason: the sweep produced nothing, which must redden rather than pass.
  return { code: "NO_REASON_PRODUCED", layer: "NONE" };
}

/**
 * A readiness verdict taken while the node WAS dispatchable, then re-taken after its capability
 * predicate is withdrawn. The AFTER arm's whole point: the second verdict must be recomputed,
 * not carried over — and the recorded baseline is what proves the node really was ready first,
 * so a case that never made it ready cannot pass by refusing something that was never admitted.
 */
function readinessReasonAfterReady(): unknown {
  readinessReason("CONFIRMED_TRUE");
  return readinessReason("UNKNOWN");
}

/** A fully-formed observation of one provider run. The SIBLING an imputation would copy. */
function siblingObservation(): Record<string, unknown> {
  return {
    measurement: {
      meter: "meter:tokens", quantity: 1_000, coverage: "COMPLETE",
      source: "PROVIDER_REPORTED_COMPLETE", providerRunRef: "run:alpha",
      sourceParserVersion: 1, sequence: 1, rawReceiptDigest: "b".repeat(64),
      observedInterval: { startRef: "ref:start", endRef: "ref:end" },
    },
    pricebookBinding: null,
    truncated: false,
  };
}

/**
 * The sibling's NORMALIZED record, or null if production refused it.
 *
 * Exported for a positive control the suite asserts: the imputation probe below is only a probe
 * if something was actually available to impute FROM. The first spelling of it passed a prior
 * that never normalized (`measurement: null`) and then read a field the result type does not
 * have, so `undefined` was handed to production and no imputation was ever possible.
 */
export function measurementPrior(): unknown {
  const normalized = normalizeUsageMeasurement(siblingObservation());
  return normalized.ok ? normalized.record : null;
}

/** A usage envelope whose measurement cannot be normalized: the unmeasured, not the zero. */
export function unmeasuredUsage(): unknown {
  return normalizeUsageMeasurement(null);
}

/** The same envelope presented WITH a real prior normalized measurement for the same stream. */
export function unmeasuredUsageAfterSibling(): unknown {
  const normalized = normalizeUsageMeasurement(siblingObservation());
  return normalizeUsageMeasurement(null, normalized.ok ? normalized.record : null);
}

/** UNKNOWN coverage presented as a measured zero — the collapse this axis exists to refuse. */
export function unknownRenderedAsZero(): unknown {
  const observation = siblingObservation();
  return normalizeUsageMeasurement({
    ...observation,
    measurement: {
      ...(observation["measurement"] as Record<string, unknown>),
      coverage: "UNKNOWN", quantity: 0, source: "UNKNOWN",
    },
  });
}

/** An HONESTLY unmeasured observation: UNKNOWN coverage, null quantity. Accepted by production. */
function honestUnknown(): ReturnType<typeof normalizeUsageMeasurement> {
  const observation = siblingObservation();
  return normalizeUsageMeasurement({
    ...observation,
    measurement: {
      ...(observation["measurement"] as Record<string, unknown>),
      coverage: "UNKNOWN", quantity: null, source: "UNKNOWN",
    },
  });
}

/**
 * The ACCEPTED record's own measurement, which is where a rendered zero would actually appear.
 *
 * Every other assertion in this group reads a REFUSAL, and a refusal cannot see this defect: a
 * boundary that stored `quantity ?? 0` while keeping the input biconditional intact refuses the
 * hostile zero, refuses the unmeasured envelope, keeps its truth class at UNKNOWN — and still
 * hands its caller a measured zero for a quantity nobody measured. Only the value it returns
 * says so, so the value is asserted.
 */
export function honestUnknownMeasurement(): unknown {
  const normalized = honestUnknown();
  return normalized.ok ? normalized.record.measurement : normalized;
}

/**
 * The NEGATIVE CONTROL for every refusal above: the honestly unmeasured observation is
 * ACCEPTED, and production's own projection keeps its truth class at UNKNOWN with no tier.
 * Without this, the refusals prove only that the boundary refuses, not that it refuses the
 * collapse specifically — and a boundary that refuses everything holds no rule at all.
 */
export function honestUnknownFact(): unknown {
  const normalized = honestUnknown();
  return normalized.ok ? projectBudgetFact(normalized.record) : normalized;
}

/**
 * Every value the group produced for the UNKNOWN-never-zero property.
 *
 * Recorded by the cases and asserted once by the suite: a refusal that carried a zero-valued
 * cost, or an admitted measurement, is what this catches — and neither is visible in a
 * refusal code.
 */
const measured: unknown[] = [];

export function recordMeasured(value: unknown): unknown {
  measured.push(value);
  return value;
}

export function measuredOutcomes(): readonly unknown[] {
  return measured;
}

export const SCHEDULER_DECISION_CASES: readonly HostileCase[] = Object.freeze([
  {
    constant: "MEASUREMENT_ISSUE_LAYERS", arm: "BEFORE",
    name: "a usage envelope that is not own data is refused rather than normalized to zero",
    arranged: "MEASUREMENT",
    expected: { code: "BUDGET_OBSERVATION_MALFORMED", layer: "MEASUREMENT" },
    run: async () => firstIssue(recordMeasured(unmeasuredUsage())),
  },
  {
    constant: "MEASUREMENT_ISSUE_LAYERS", arm: "AFTER",
    // THE IMPUTATION PROBE. A prior normalized measurement exists when this one is presented,
    // so an implementation that carried the sibling's value forward would answer with a
    // measurement nobody took. The refusal must survive the presence of the prior.
    name: "an unmeasured usage is still refused when a sibling's measurement is available to impute",
    arranged: "MEASUREMENT",
    expected: { code: "BUDGET_OBSERVATION_MALFORMED", layer: "MEASUREMENT" },
    run: async () => firstIssue(recordMeasured(unmeasuredUsageAfterSibling())),
  },
  {
    constant: "CONVERGENCE_BREAKER_LAYER", arm: "BEFORE",
    name: "a breaker request that is not own data is refused before any hold is tripped",
    arranged: CONVERGENCE_BREAKER_LAYER,
    expected: { code: "BREAKER_INPUT_INVALID", layer: CONVERGENCE_BREAKER_LAYER },
    run: async () => breakerOutcome(recordMeasured(decideBreaker(new Map() as never, { candidatePredicate: null, entry: null } as never))),
  },
  {
    constant: "CONVERGENCE_BREAKER_LAYER", arm: "AFTER",
    name: "a breaker trip presented without the observations that would justify it is refused",
    arranged: CONVERGENCE_BREAKER_LAYER,
    expected: { code: "BREAKER_INPUT_INVALID", layer: CONVERGENCE_BREAKER_LAYER },
    run: async () => {
      decideBreaker(new Map() as never, { candidatePredicate: null, entry: null } as never);
      return breakerOutcome(recordMeasured(decideBreaker(
        new Map() as never, { candidatePredicate: null, entry: { id: "entry-1" } } as never,
      )));
    },
  },
  {
    constant: "FAIRNESS_CONTRACT_LAYERS", arm: "BEFORE",
    name: "a work item that is not own data is refused rather than aged on a forged counter",
    arranged: "WORK_ITEM",
    expected: { code: "FAIRNESS_CONTRACT_MALFORMED_INPUT", layer: "WORK_ITEM" },
    run: async () => firstIssue(recordMeasured(ageWorkItem(null))),
  },
  {
    constant: "FAIRNESS_CONTRACT_LAYERS", arm: "AFTER",
    name: "a forged in-flight counter is refused after a well-formed item was already aged",
    arranged: "WORK_ITEM",
    expected: { code: "FAIRNESS_CONTRACT_MALFORMED_INPUT", layer: "WORK_ITEM" },
    run: async () => {
      ageWorkItem(null);
      return firstIssue(recordMeasured(ageWorkItem({ bypassCount: -1, identity: "item-1" })));
    },
  },
  {
    // THE CONTRACT LAYER OF THIS BOUNDARY'S OWN TWO-MEMBER LIST. `MEASUREMENT_ISSUE_LAYERS` is
    // ["CONTRACT", "MEASUREMENT"]; the cases above all reach MEASUREMENT, so the earlier layer
    // would have gone unasserted — and it is the one that owns the collapse: an UNKNOWN
    // coverage presented with a measured zero is refused before any truth judgement runs.
    constant: "MEASUREMENT_ISSUE_LAYERS", arm: "BEFORE",
    name: "an unknown coverage rendered as a measured zero is refused at the contract layer",
    arranged: "CONTRACT",
    expected: { code: "BUDGET_MEASUREMENT_COVERAGE_QUANTITY_MISMATCH", layer: "CONTRACT" },
    run: async () => firstIssue(recordMeasured(unknownRenderedAsZero())),
  },
  {
    constant: "READINESS_LAYERS", arm: "BEFORE",
    name: "a withdrawn capability predicate reports its admission-layer reason rather than readiness",
    arranged: "ADMISSION",
    expected: { code: "READINESS_CAPABILITY", layer: "ADMISSION" },
    run: async () => recordMeasured(readinessReason("UNKNOWN")),
  },
  {
    // THE STALE-VERDICT ARM. The node is projected while it IS dispatchable, then projected
    // again once the predicate is withdrawn. A verdict carried over from the first call — a
    // memoized projection, or a fact imputed from the earlier bundle — would still report
    // dev-ready as dispatchable and produce no reason at all.
    constant: "READINESS_LAYERS", arm: "AFTER",
    name: "a readiness verdict taken while the node was dispatchable is not replayed after the predicate is withdrawn",
    arranged: "ADMISSION",
    expected: { code: "READINESS_CAPABILITY", layer: "ADMISSION" },
    run: async () => recordMeasured(readinessReasonAfterReady()),
  },
]);

export const SCHEDULER_DECISION_RACES: readonly HostileRaceCase[] = Object.freeze([
  {
    constant: "MEASUREMENT_ISSUE_LAYERS",
    name: "two unmeasured usages racing are both refused and neither is rendered as zero",
    arranged: "MEASUREMENT",
    expected: { code: "BUDGET_OBSERVATION_MALFORMED", layer: "MEASUREMENT" },
    maxAdmitted: 0,
    run: async () => [
      firstIssue(recordMeasured(unmeasuredUsage())),
      firstIssue(recordMeasured(unmeasuredUsageAfterSibling())),
    ] as const,
  },
  {
    constant: "CONVERGENCE_BREAKER_LAYER",
    name: "a fairness decision racing a breaker trip refuses both rather than admitting either",
    arranged: CONVERGENCE_BREAKER_LAYER,
    expected: { code: "BREAKER_INPUT_INVALID", layer: CONVERGENCE_BREAKER_LAYER },
    maxAdmitted: 0,
    run: async () => [
      breakerOutcome(recordMeasured(decideBreaker(new Map() as never, { candidatePredicate: null, entry: null } as never))),
      breakerOutcome(recordMeasured(decideBreaker(new Map() as never, { candidatePredicate: null, entry: 7 } as never))),
    ] as const,
  },
  {
    constant: "FAIRNESS_CONTRACT_LAYERS",
    name: "two forged work items racing are both refused at the work-item layer",
    arranged: "WORK_ITEM",
    expected: { code: "FAIRNESS_CONTRACT_MALFORMED_INPUT", layer: "WORK_ITEM" },
    maxAdmitted: 0,
    run: async () => [
      firstIssue(recordMeasured(ageWorkItem(null))),
      firstIssue(recordMeasured(ageWorkItem(7))),
    ] as const,
  },
  {
    // THE TWO SIDES ARE THE TWO FACTS, raced deliberately: "nobody knows" on one side and
    // "the caller confirmed this false" on the other. Both must be non-admitted and both must
    // carry the SAME code and layer — which is exactly why the code and layer cannot be the
    // whole assertion for this boundary, and why the group property below reads `withheld`.
    constant: "READINESS_LAYERS",
    name: "an unknown predicate racing a confirmed-false one admits neither and keeps both verdicts",
    arranged: "ADMISSION",
    expected: { code: "READINESS_CAPABILITY", layer: "ADMISSION" },
    maxAdmitted: 0,
    run: async () => [
      recordMeasured(readinessReason("UNKNOWN")),
      recordMeasured(readinessReason("CONFIRMED_FALSE")),
    ] as const,
  },
]);

export const ACTIVATION_ADMISSION_RACES: readonly HostileRaceCase[] = Object.freeze([
  {
    constant: "ACTIVATION_INGRESS_LAYER",
    name: "two malformed envelopes racing yield two refusals and no admission",
    arranged: ACTIVATION_INGRESS_LAYER,
    expected: { code: "ACTIVATION_INGRESS_REQUEST_MALFORMED", layer: ACTIVATION_INGRESS_LAYER },
    maxAdmitted: 0,
    run: async () => {
      const store = openHostileStore("ingress-race");
      return [
        ingressOf(runEffectActivateCommand(store, "not-bytes")),
        ingressOf(runEffectActivateCommand(store, smuggledSectionBytes())),
      ] as const;
    },
  },
  {
    constant: "ACTIVATION_SLOT_LAYER",
    name: "two attempts racing for one inactive slot are both refused, never admitted",
    arranged: "AUTHORITY",
    expected: { code: "WORK_SLOT_RESOURCE_INACTIVE", layer: "AUTHORITY" },
    maxAdmitted: 0,
    run: async () => {
      const store = openHostileStore("slot-race");
      const bytes = activateBytes(inactiveSlotPayload());
      return [
        ingressOf(runEffectActivateCommand(store, bytes)),
        ingressOf(runEffectActivateCommand(store, activateBytes(inactiveSlotPayload(), "cmd-activate-4"))),
      ] as const;
    },
  },
  {
    constant: "ACTIVATION_BUDGET_LAYER",
    name: "two overdrawn admissions racing are both refused, and neither is admitted at zero cost",
    arranged: "AUTHORITY",
    expected: { code: "WORK_BUDGET_REFUSED", layer: "AUTHORITY" },
    maxAdmitted: 0,
    run: async () => {
      const store = openHostileStore("budget-race");
      return [
        ingressOf(runEffectActivateCommand(store, activateBytes(overdrawnBudgetPayload()))),
        ingressOf(runEffectActivateCommand(store, activateBytes(overdrawnBudgetPayload(), "cmd-activate-5"))),
      ] as const;
    },
  },
  {
    constant: "ACTIVATION_LEDGER_LAYER",
    name: "one grant id used by two distinct commands admits exactly one",
    arranged: ACTIVATION_LEDGER_LAYER,
    expected: { code: "ACTIVATION_LEDGER_GRANT_ID_CONFLICT", layer: ACTIVATION_LEDGER_LAYER },
    maxAdmitted: 1,
    run: async () => await grantConsumedTwice(),
    durableAdmissions: grantDurableAdmissions,
  },
  {
    constant: "WORK_LAYERS",
    name: "two attempts racing for the last provider slot admit exactly one, and the ceiling refuses the other",
    arranged: "AUTHORITY",
    expected: { code: "WORK_SLOT_EXHAUSTED", layer: "AUTHORITY" },
    maxAdmitted: 1,
    run: async () => await slotClaimedConcurrently(),
    durableAdmissions: slotDurableAdmissions,
  },
  {
    constant: "FOUNDATION_ACTIVATION_BINDING_LAYER",
    name: "two unusable binding queries racing both stay UNKNOWN",
    arranged: FOUNDATION_ACTIVATION_BINDING_LAYER,
    expected: {
      code: "FOUNDATION_BINDING_QUERY_INVALID", layer: FOUNDATION_ACTIVATION_BINDING_LAYER,
    },
    maxAdmitted: 0,
    run: async () => {
      const store = openHostileStore("binding-race");
      return [
        readCurrentEffectSessionBinding(store as never, "", "effect-1", "session-1", 1_000),
        readCurrentEffectSessionBinding(store as never, "project-1", "", "session-1", 1_000),
      ] as const;
    },
  },
  {
    constant: "DOCUMENT_WORK_SERVICE_LAYERS",
    name: "two malformed proposals racing are both refused at ingress",
    arranged: "DAEMON_INGRESS",
    expected: { code: "DOCUMENT_WORK_SERVICE_INPUT_INVALID", layer: "DAEMON_INGRESS" },
    maxAdmitted: 0,
    run: async () => {
      const store = openHostileStore("docwork-race");
      return [
        recordDocumentWorkProposal(store as never, null as never),
        recordDocumentWorkProposal(store as never, 7 as never),
      ] as const;
    },
  },
  {
    constant: "SCHEDULER_GRAPH_LAYER",
    name: "two malformed snapshots racing keep the scheduler's layer on both sides",
    arranged: SCHEDULER_GRAPH_LAYER,
    expected: { code: "GRAPH_MALFORMED_SNAPSHOT", layer: SCHEDULER_GRAPH_LAYER },
    maxAdmitted: 0,
    run: async () => [
      asLayered(admitSingleExecutionNode(graphRequest("not-a-graph")), "refusedBy"),
      asLayered(admitSingleExecutionNode(graphRequest(42)), "refusedBy"),
    ] as const,
  },
  {
    constant: "WORK_LAYERS",
    name: "two malformed claims racing are both refused and neither grants a lease",
    arranged: "AUTHORITY",
    expected: { code: "WORK_PAYLOAD_MALFORMED", layer: "AUTHORITY" },
    maxAdmitted: 0,
    run: async () => [
      fromFailure(claimWork(null)),
      fromFailure(claimWork("not-a-record")),
    ] as const,
  },
  {
    constant: "FOUNDATION_VERIFICATION_LAYERS",
    name: "two unusable verification requests racing are both refused and neither starts a process",
    arranged: "DAEMON_VERIFICATION_REQUEST",
    expected: {
      code: "FOUNDATION_VERIFICATION_REQUEST_MALFORMED", layer: "DAEMON_VERIFICATION_REQUEST",
    },
    maxAdmitted: 0,
    run: async () => {
      const service = verificationService("verify-race");
      return [await service.verify(null), await service.verify({ verificationId: 7 })] as const;
    },
  },
  {
    constant: "SPAWN_INVOCATION_LAYER",
    name: "two unquotable arguments racing both refuse and neither yields a command line",
    arranged: SPAWN_INVOCATION_LAYER,
    expected: { code: "SPAWN_ARGUMENT_UNQUOTABLE", layer: SPAWN_INVOCATION_LAYER },
    maxAdmitted: 0,
    run: async () => [
      await thrown(() => agentSpawnInvocation("claude", [UNQUOTABLE_ARGV[0] ?? ""], "win32")),
      await thrown(() => agentSpawnInvocation("claude", [UNQUOTABLE_ARGV[2] ?? ""], "win32")),
    ] as const,
  },
]);

export {
  ACTIVATION_BUDGET_LAYER,
  CONVERGENCE_BREAKER_LAYER,
  DEV_READY,
  FAIRNESS_CONTRACT_LAYERS,
  MEASUREMENT_ISSUE_LAYERS,
  READINESS_LAYERS,
  EXPANSION_APPROVAL_LAYERS,
  EXPANSION_BINDING_LAYERS,
  EXPANSION_EVIDENCE_LAYERS,
  EXPANSION_HOLD_LAYERS,
  EXPANSION_PREPARATION_LAYERS,
  GOAL_LAYER,
  GRAPH_REVISION_LAYER,
  PLANNING_EXPANSION_LAYERS,
  SUPERSESSION_DISPOSITION_LAYERS,
  SUPERSESSION_KERNEL_LAYER,
  ACTIVATION_INGRESS_LAYER,
  ACTIVATION_LEDGER_LAYER,
  ACTIVATION_SLOT_LAYER,
  DOCUMENT_WORK_SERVICE_LAYERS,
  FOUNDATION_ACTIVATION_BINDING_LAYER,
  FOUNDATION_VERIFICATION_LAYERS,
  GRANT_ID,
  SCHEDULER_GRAPH_LAYER,
  SPAWN_INVOCATION_LAYER,
  WORK_LAYERS,
  deriveActivationAggregateId,
};
