import { claimWork } from "./work-claim.js";
import { applyWorkLifecycle } from "./work-lifecycle.js";
import { BASE_PROOF, BASE_RECORD } from "./work-race-fixtures.js";
import type { Payload, Tamper } from "./work-race-tampers.js";
import type { WorkResult } from "./work-kernel.js";

/**
 * The seeded schedule engine for the daemon half of the supervisor slice.
 *
 * Deterministic by construction: splitmix32 from a pinned literal seed array,
 * no clock and no `Math.random` anywhere, so a failing interleaving is
 * reproducible from its seed alone. splitmix32 rather than xorshift32 —
 * `mem:gotcha-lfsr-low-bits-hide-tamper-arms` records a five-code coverage hole
 * caused by an LFSR's correlated low bits on the first build of the runner
 * harness.
 *
 * The engine records; it decides nothing. Every expected outcome kind and every
 * invariant lives in `work-race-orderings.test.ts`, hand-written, so the sweep
 * cannot grade itself.
 */

const DIGEST = "a".repeat(64);

export const RACE_SEEDS: readonly number[] = Object.freeze([7, 19, 43, 97, 211]);
export const RACE_STEPS = 400;
/** 7 honest draws in 10; the remaining 3 pick a tamper arm. */
export const HONEST_IN_TEN = 7;
/** Steps between resets to an asserted-good pool member, so one walk cannot strand the world. */
export const RESET_EVERY = 20;

export const RACE_COMMANDS: readonly string[] = Object.freeze([
  "claim",
  "renew",
  "release",
  "resume",
  "cancel",
  "get_context",
  // Not a command: it resolves on Object.prototype, so a bare index lookup
  // would dispatch it. Kept in the alphabet to hold that guard down.
  "constructor",
]);

/** Hand-written mirror of the production legal-state tables; drift turns the gate red. */
export const LEGAL_STATES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  cancel: ["ACTIVE", "SUSPECT", "DRAINING"],
  claim: ["ACTIVE"],
  get_context: ["ACTIVE", "SUSPECT", "DRAINING", "RELEASED"],
  release: ["ACTIVE", "SUSPECT", "DRAINING"],
  renew: ["ACTIVE"],
  resume: ["SUSPECT", "DRAINING"],
});

export interface World {
  readonly record: Record<string, unknown>;
  readonly intent: Record<string, unknown>;
}

function intentAt(state: string, version: number): Record<string, unknown> {
  return {
    aggregateId: "agg-1",
    desiredState: "ACTIVE",
    expectedGraphEpoch: 4,
    idempotencyKey: "idem-1",
    inputBinding: DIGEST,
    intentId: "intent-1",
    leaseBinding: { ...BASE_RECORD },
    predecessorCursor: "cursor-1",
    protocolVersion: "moe-effect-intent/1",
    runtimeObservationDigest: DIGEST,
    state,
    version,
  };
}

/**
 * The asserted-good state pool. Six members rather than one starting point:
 * a schedule that only ever walks out of ACTIVE explores a single corner and
 * reaches most refusal codes by luck. `work-race-orderings.test.ts` asserts
 * every member parses on both surfaces before any schedule runs.
 */
export const STATE_POOL: readonly World[] = Object.freeze([
  { intent: intentAt("PENDING", 0), record: { ...BASE_RECORD, state: "ACTIVE" } },
  { intent: intentAt("CLAIMED", 1), record: { ...BASE_RECORD, state: "ACTIVE" } },
  { intent: intentAt("ARMED", 2), record: { ...BASE_RECORD, state: "SUSPECT" } },
  { intent: intentAt("ACTIVE", 3), record: { ...BASE_RECORD, state: "DRAINING" } },
  { intent: intentAt("PENDING", 0), record: { ...BASE_RECORD, state: "RELEASED" } },
  { intent: intentAt("CANCEL_REQUESTED", 4), record: { ...BASE_RECORD, state: "REVOKED" } },
]);

const RESOURCE_ROW = {
  capacityUnits: 1,
  effectIntentRef: "intent-ref-1",
  epoch: 1,
  external: false,
  fenceable: true,
  resourceId: "res-1",
  state: "ACTIVE",
};

const BUDGET = {
  admission: {
    admissionRef: "adm-1",
    amounts: [
      { meter: "usd", purpose: "EXECUTION", quantity: 10 },
      { meter: "usd", purpose: "VERIFICATION", quantity: 5 },
      { meter: "usd", purpose: "INDEPENDENT_REVIEW", quantity: 5 },
      { meter: "usd", purpose: "FINAL_ACCEPTANCE", quantity: 5 },
      { meter: "usd", purpose: "CONTINGENCY", quantity: 5 },
    ],
    expectedVersion: 2,
  },
  gate: { allowance: { decisionRef: "dec-1", outcome: "ALLOW" }, approval: null },
  view: {
    accountId: "acct-1",
    meters: [{ available: 100, committed: 0, meter: "usd", quarantined: 0, reserved: 0 }],
    state: "OPEN",
    version: 2,
  },
};

export function proofFor(record: Record<string, unknown>): Record<string, unknown> {
  return {
    ...BASE_PROOF,
    authorityHashRef: record["authorityHashRef"],
    epoch: record["epoch"],
    expectedVersion: record["version"],
    leaseToken: record["leaseToken"],
    ownerSessionRef: record["ownerSessionRef"],
  };
}

function basePayload(world: World, proof: Record<string, unknown>): Payload {
  return {
    budget: JSON.parse(JSON.stringify(BUDGET)) as unknown,
    effect: { command: { kind: "claim" }, intent: { ...world.intent } },
    lease: { proof: { ...proof }, record: { ...world.record } },
    liveClaims: [],
    slot: {
      dimension: "default", requestId: "req-1", rows: [{ ...RESOURCE_ROW }], slotRef: "slot-1",
    },
  };
}

/** `Object.hasOwn`, never a bare index: `LEGAL_STATES["constructor"]` inherits. */
export function legalStatesFor(command: string): readonly string[] | null {
  return Object.hasOwn(LEGAL_STATES, command) ? (LEGAL_STATES[command] ?? null) : null;
}

export function buildPayload(world: World, proof: Record<string, unknown>, tamper: Tamper): Payload {
  const payload = basePayload(world, proof);
  tamper.mutate(payload);
  return payload;
}

export function deliver(command: string, payload: Payload): WorkResult {
  return command === "claim" ? claimWork(payload) : applyWorkLifecycle(command, payload);
}

export function labelOf(result: WorkResult): string {
  if (result.ok) {
    return result.outcome === "CONTEXT_VIEW"
      ? `OK:${result.command}:CONTEXT_VIEW`
      : `OK:${result.command}:${result.authority}`;
  }
  if (result.outcome === "INPUT_REJECTED") return "NO:INGRESS:WORK_INPUT_REJECTED:-";
  const { code, layer, leg } = result.failure;
  return `NO:${layer}:${code}:${leg ?? "-"}`;
}

/** Adopts the successors a granted or applied result published; a refusal leaves no residue. */
export function advance(world: World, result: WorkResult): World {
  if (!result.ok) return world;
  if (result.outcome === "WORK_APPLIED") {
    const successor = result.successor as Record<string, unknown> | null;
    const record = successor?.["lease"];
    return record === undefined || record === null
      ? world
      : { intent: world.intent, record: record as Record<string, unknown> };
  }
  if (result.outcome === "WORK_GRANTED") {
    return { intent: result.successors.effectIntent as Record<string, unknown>, record: world.record };
  }
  return world;
}
