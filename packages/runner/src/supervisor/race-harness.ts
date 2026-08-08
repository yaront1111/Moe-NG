import type { EffectState } from "./effect-kernel.js";
import { isTerminalEffectState } from "./effect-kernel.js";
import type { LaunchLockObservedState, LaunchLockRegistration } from "./launch-lock.js";
import { REGISTRATION } from "./race-scenarios.js";
import {
  applyCommand,
  dispositionRank,
  RACE_COMMANDS,
  statePool,
  type RaceCommand,
  type World,
} from "./race-world.js";

/**
 * The seeded race harness for the external-effect supervisor slice.
 *
 * Determinism is the whole point: every draw comes from an xorshift PRNG seeded
 * by a fixed literal, and there is no clock and no `Math.random` anywhere below.
 * A failing schedule that cannot be replayed is not a bug report, and a harness
 * whose coverage moves between runs cannot support a set-equality assertion.
 */
export const RACE_SEEDS = Object.freeze([3, 11, 29, 61, 127] as const);
export const RACE_STEPS = 240;

/**
 * 70 honest / 30 tampered, matching the lease-presence core. Tilting honest is
 * deliberate: an even split spends half the schedule bouncing off the outermost
 * parser and never reaches the deep post-activation cells the gate exists for.
 */
export const HONEST_IN_TEN = 7;

export const COMMITTED_ACTIVATION_PAIR = "ARMED->ACTIVE|LAUNCH_REQUESTED->RUNNING";

const OBSERVED_LOCK_STATES: readonly LaunchLockObservedState[] = ["HELD", "RELEASED", "UNKNOWN"];
const OBSERVED_REGISTRATIONS: readonly (LaunchLockRegistration | null)[] = [REGISTRATION, null];

export function seeded(seed: number): () => number {
  let state = seed | 0;
  if (state === 0) {
    throw new Error("an xorshift seed of 0 is a fixed point and would emit one value forever");
  }
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

export interface StepRecord {
  readonly index: number;
  readonly command: RaceCommand;
  readonly honest: boolean;
  readonly label: string;
  readonly effectState: EffectState;
  readonly versionDelta: number;
  readonly stateChanged: boolean;
  readonly inputMutated: boolean;
  readonly dispositionRank: number;
  readonly reasonCount: number;
  readonly violation: string | null;
}

export interface RaceEvent {
  readonly index: number;
  readonly kind: "GRANT_ISSUED" | "LAUNCH";
  readonly grantId: string;
  readonly pair: string | null;
}

export interface Trace {
  readonly steps: readonly StepRecord[];
  readonly events: readonly RaceEvent[];
}

export interface OutcomeRecorder {
  record(label: string): void;
  kinds(): readonly string[];
  counts(): ReadonlyMap<string, number>;
  total(): number;
}

/**
 * Accumulates observed outcome KINDS with per-kind counts. When a declared
 * vocabulary is supplied it throws on anything outside it, because a recorder
 * that quietly dropped an unknown kind would defeat the set-equality assertion
 * this whole gate is built on.
 */
export function createRecorder(declared?: readonly string[]): OutcomeRecorder {
  const tally = new Map<string, number>();
  const allowed = declared === undefined ? null : new Set(declared);
  return {
    record(label: string): void {
      if (allowed !== null && !allowed.has(label)) {
        throw new Error(`the harness observed an undeclared outcome kind: ${label}`);
      }
      tally.set(label, (tally.get(label) ?? 0) + 1);
    },
    kinds: () => [...tally.keys()].sort(),
    counts: () => new Map(tally),
    total: () => [...tally.values()].reduce((sum, count) => sum + count, 0),
  };
}

/**
 * DoD 2, first half. A launch spends an external-action authorization, so every
 * one must be preceded in the SAME schedule by the committed activation that
 * minted it, and that commit must be the full ARMED->ACTIVE plus
 * LAUNCH_REQUESTED->RUNNING pair rather than half of it.
 */
export function checkGrantOrdering(events: readonly RaceEvent[]): readonly string[] {
  const violations: string[] = [];
  const issued = new Map<string, RaceEvent>();
  for (const event of events) {
    if (event.kind === "GRANT_ISSUED") {
      if (event.pair !== COMMITTED_ACTIVATION_PAIR) {
        violations.push(`step ${event.index}: grant issued by an uncommitted pair ${event.pair}`);
      }
      if (!issued.has(event.grantId)) issued.set(event.grantId, event);
      continue;
    }
    const source = issued.get(event.grantId);
    if (source === undefined) {
      violations.push(`step ${event.index}: launch precedes any activation of ${event.grantId}`);
      continue;
    }
    if (source.index > event.index) {
      violations.push(`step ${event.index}: launch precedes its activation at ${source.index}`);
    }
  }
  return violations;
}

function resample(world: World, pool: readonly World[], next: () => number): World {
  // A concurrent observer re-reads the lock and the registration between steps;
  // that re-read IS the race this harness is built to interleave.
  let current = world;
  if (next() % 4 === 0) {
    current = {
      ...current,
      lockState: OBSERVED_LOCK_STATES[next() % OBSERVED_LOCK_STATES.length] ?? "UNKNOWN",
      registration: OBSERVED_REGISTRATIONS[next() % OBSERVED_REGISTRATIONS.length] ?? null,
    };
  }
  if (isTerminalEffectState(current.intent.state) && next() % 2 === 0) {
    const member = pool[next() % pool.length];
    // The disposition survives the reset: monotonicity is a property of the
    // schedule, not of one intent, so restarting the walk must not launder it.
    if (member !== undefined) current = { ...member, disposition: current.disposition };
  }
  return current;
}

export function runTrace(seed: number, steps: number): Trace {
  const pool = statePool();
  const next = seeded(seed);
  let world = pool[next() % pool.length];
  if (world === undefined) throw new Error("the asserted-good state pool is empty");
  const records: StepRecord[] = [];
  const events: RaceEvent[] = [];
  for (let index = 0; index < steps; index += 1) {
    const command = RACE_COMMANDS[next() % RACE_COMMANDS.length] ?? "claim";
    const honest = next() % 10 < HONEST_IN_TEN;
    const pick = next();
    const before = structuredClone(world.intent);
    const stepped = applyCommand(world, command, honest, pick);
    records.push({
      index,
      command,
      honest,
      label: stepped.label,
      effectState: stepped.world.intent.state,
      versionDelta: stepped.world.intent.version - world.intent.version,
      stateChanged: stepped.world.intent.state !== world.intent.state,
      inputMutated: JSON.stringify(before) !== JSON.stringify(world.intent),
      dispositionRank: dispositionRank(stepped.world.disposition),
      reasonCount: stepped.world.disposition.reasons.length,
      violation: stepped.violation,
    });
    if (stepped.issued !== null) {
      events.push({ index, kind: "GRANT_ISSUED", grantId: stepped.issued, pair: stepped.pair });
    }
    if (stepped.launched !== null) {
      events.push({ index, kind: "LAUNCH", grantId: stepped.launched, pair: null });
    }
    world = resample(stepped.world, pool, next);
  }
  return { steps: records, events };
}
