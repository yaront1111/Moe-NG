import type { ScheduleObligation, ScheduleStratum } from "./schedule-model.js";

/**
 * Frozen CORE obligation registry: exactly CORE-I1..CORE-I22 and CORE-S1..CORE-S14.
 * The namespace is closed (design 20 preamble): no obligation id may be minted here,
 * and the un-named fan-in/graph predicate paragraph is carried as a sub-anchor under
 * the obligations that already own it rather than as a new identifier.
 */
const TWO: readonly ScheduleStratum[] = Object.freeze(["TWO_EVENT"]);
const BOTH: readonly ScheduleStratum[] = Object.freeze(["MULTI_EVENT", "TWO_EVENT"]);
const FAN_IN = "design 20.1 additional fan-in and graph predicates";

function invariant(
  index: number,
  title: string,
  applicableStrata: readonly ScheduleStratum[],
  subAnchors: readonly string[] = [],
): ScheduleObligation {
  const obligationId = `CORE-I${index}`;
  return Object.freeze({
    applicableStrata,
    designAnchors: Object.freeze([`design 20.1 #${obligationId}`, ...subAnchors]),
    kind: "INVARIANT" as const,
    obligationId,
    title,
  });
}

function scenario(
  index: number,
  title: string,
  applicableStrata: readonly ScheduleStratum[],
  subAnchors: readonly string[] = [],
): ScheduleObligation {
  const obligationId = `CORE-S${index}`;
  return Object.freeze({
    applicableStrata,
    designAnchors: Object.freeze([`design 20.2 #${obligationId}`, ...subAnchors]),
    kind: "SCENARIO" as const,
    obligationId,
    title,
  });
}

export const CORE_INVARIANT_OBLIGATIONS: readonly ScheduleObligation[] = Object.freeze([
  invariant(1, "Claim uniqueness", BOTH),
  invariant(2, "Fencing", TWO),
  invariant(3, "Legal lifecycle", TWO),
  invariant(4, "Proof before acceptance", BOTH),
  invariant(5, "Durable ordering", TWO),
  invariant(6, "Join and goal closure", BOTH, [FAN_IN]),
  invariant(7, "Complete derivation", TWO),
  invariant(8, "Supersession", BOTH, [FAN_IN]),
  invariant(9, "Command idempotency", TWO),
  invariant(10, "Graph and budget containment", TWO),
  invariant(11, "Fan-out gate", TWO),
  invariant(12, "Approval binding", TWO),
  invariant(13, "Authority parity", TWO),
  invariant(14, "Evidence integrity", BOTH, [FAN_IN]),
  invariant(15, "Attribution", TWO, [FAN_IN]),
  invariant(16, "Outbox and effect safety", BOTH),
  invariant(17, "Recovery truth", BOTH),
  invariant(18, "Bounded loops and journal", TWO),
  invariant(19, "Same-bug breaker", TWO),
  invariant(20, "Presence isolation", TWO),
  invariant(21, "Dependency and scheduling integrity", BOTH),
  invariant(22, "Restore fencing", BOTH),
]);

export const CORE_SCENARIO_OBLIGATIONS: readonly ScheduleObligation[] = Object.freeze([
  scenario(1, "Causal bug", TWO),
  scenario(2, "Three-way feature", TWO),
  scenario(3, "Overlap and conflict", TWO),
  scenario(4, "Crashes", BOTH),
  scenario(5, "Rejection lineage", TWO),
  scenario(6, "Exclusive resource", TWO),
  scenario(7, "Hostile stale client", TWO),
  scenario(8, "Abusive expansion", TWO),
  scenario(9, "Fan-out refusal", BOTH),
  scenario(10, "Same-bug convergence", TWO),
  scenario(11, "Mid-flight supersession", BOTH),
  scenario(12, "Outbox replay", BOTH),
  scenario(13, "Blocked-chain escape", BOTH, [FAN_IN]),
  scenario(14, "Disaster restore", BOTH),
]);

export const CORE_OBLIGATIONS: readonly ScheduleObligation[] = Object.freeze([
  ...CORE_INVARIANT_OBLIGATIONS,
  ...CORE_SCENARIO_OBLIGATIONS,
]);

export const CORE_OBLIGATION_COUNT = 36 as const;
