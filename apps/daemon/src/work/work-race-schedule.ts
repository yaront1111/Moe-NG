import { RACE_TAMPERS } from "./work-race-tampers.js";
import {
  HONEST_IN_TEN,
  RACE_COMMANDS,
  RACE_STEPS,
  RESET_EVERY,
  STATE_POOL,
  advance,
  buildPayload,
  deliver,
  labelOf,
  proofFor,
} from "./work-race-world.js";
import type { World } from "./work-race-world.js";
import type { Tamper } from "./work-race-tampers.js";
import type { WorkResult } from "./work-kernel.js";

/** splitmix32: a full 32-bit avalanche, so low bits are as usable as high ones. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad) >>> 0;
    mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97) >>> 0;
    return ((mixed ^ (mixed >>> 15)) >>> 0) / 0x1_0000_0000;
  };
}

export interface Delivered {
  readonly record: unknown;
  readonly proof: unknown;
  readonly present: boolean;
}

export interface RaceStep {
  readonly index: number;
  readonly command: string;
  readonly tamper: string;
  readonly label: string;
  readonly result: WorkResult;
  /** The lease pair exactly as the command received it, tamper included. */
  readonly delivered: Delivered;
  readonly before: World;
  readonly after: World;
  /**
   * The same command re-delivered with the SAME proof against the world the
   * first delivery produced — a duplicate arriving after the first was
   * persisted. `null` when the first delivery was refused, since a refusal
   * publishes nothing to duplicate.
   */
  readonly duplicate: { readonly label: string; readonly result: WorkResult } | null;
}

function readDelivered(payload: Record<string, unknown>): Delivered {
  const lease = payload["lease"];
  if (typeof lease !== "object" || lease === null) {
    return { present: false, proof: undefined, record: undefined };
  }
  const section = lease as Record<string, unknown>;
  return { present: true, proof: section["proof"], record: section["record"] };
}

/** The tamper arms, excluding the honest no-op at index 0, stratified by command. */
const TAMPER_ARMS = RACE_TAMPERS.filter((arm) => arm.name !== "honest");
const LEASE_ARMS = TAMPER_ARMS.filter((arm) => arm.claimOnly !== true);

function pick<T>(draw: number, values: readonly T[]): T {
  const value = values[Math.floor(draw * values.length)];
  if (value === undefined) throw new Error("seeded draw fell outside the alphabet");
  return value;
}

function executeStep(index: number, command: string, tamper: Tamper, world: World): RaceStep {
  const proof = proofFor(world.record);
  const payload = buildPayload(world, proof, tamper);
  const delivered = readDelivered(payload);
  const result = deliver(command, payload);
  const after = advance(world, result);
  const replay = result.ok ? deliver(command, buildPayload(after, proof, tamper)) : null;
  return {
    after,
    before: world,
    command,
    delivered,
    duplicate: replay === null ? null : { label: labelOf(replay), result: replay },
    index,
    label: labelOf(result),
    result,
    tamper: tamper.name,
  };
}

/**
 * Runs one seeded schedule. Every choice comes from the seeded generator and
 * the world is reset to an asserted-good pool member every `RESET_EVERY` steps,
 * so a walk that strands itself in RELEASED cannot silently stop exploring.
 */
export function runSchedule(seed: number, steps: number = RACE_STEPS): readonly RaceStep[] {
  const next = seeded(seed);
  const trace: RaceStep[] = [];
  let world: World = STATE_POOL[0] as World;
  for (let index = 0; index < steps; index += 1) {
    if (index % RESET_EVERY === 0) {
      const member = STATE_POOL[(index / RESET_EVERY) % STATE_POOL.length];
      if (member === undefined) throw new Error("state pool is empty");
      world = member;
    }
    const command = pick(next(), RACE_COMMANDS);
    const honest = next() * 10 < HONEST_IN_TEN;
    const arms = command === "claim" ? TAMPER_ARMS : LEASE_ARMS;
    const tamper = honest ? RACE_TAMPERS[0] : pick(next(), arms);
    if (tamper === undefined) throw new Error("tamper alphabet is empty");
    const step = executeStep(index, command, tamper, world);
    trace.push(step);
    world = step.after;
  }
  return trace;
}

/**
 * The stratified sweep: every command x every tamper arm x every pool member,
 * enumerated rather than sampled.
 *
 * A uniform random walk reaches the claim-only legs — slot ceiling, provider
 * slot, budget — only when it happens to draw `claim`, the tampered arm, that
 * specific arm and an ACTIVE lease all at once, which is roughly one step in
 * four hundred. Leaving a declared outcome kind to that kind of luck means the
 * set equality this gate rests on would be decided by the seed. The walk still
 * runs alongside it: the walk explores ORDERINGS and duplicate delivery, which
 * a one-step-per-cell sweep cannot reach.
 */
export function runStratifiedSweep(): readonly RaceStep[] {
  const trace: RaceStep[] = [];
  let index = 0;
  for (const command of RACE_COMMANDS) {
    for (const tamper of RACE_TAMPERS) {
      for (const member of STATE_POOL) {
        trace.push(executeStep(index, command, tamper, member));
        index += 1;
      }
    }
  }
  return trace;
}

export function countByKind(trace: readonly RaceStep[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const step of trace) counts.set(step.label, (counts.get(step.label) ?? 0) + 1);
  return counts;
}
