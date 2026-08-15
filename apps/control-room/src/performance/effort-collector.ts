import { createIntervalMachine } from "./effort-intervals.js";
import { shapeEffortObservation } from "./effort-admission.js";
import {
  ADDITIONAL_DECISION_KIND,
  EFFORT_COLLECTOR_LAYER,
  UNATTRIBUTED,
  effortRefusal,
} from "./effort-records.js";
import type { IntervalOutcome } from "./effort-intervals.js";
import type {
  BaselineDecisionKind,
  DecisionKind,
  DemandedDecisionRecord,
  EffortAdmission,
  EffortRecord,
  EffortRefusal,
  EffortSource,
  EffortUnknownCode,
} from "./effort-records.js";

/**
 * Accumulates admitted effort observations, attributes them, and holds the interval
 * machine. It records what was observed; it derives exactly one thing, and says so.
 *
 * THE ONE DERIVATION is additional-ness, and it comes from the OBSERVED SEQUENCE of
 * demands on a command — never from a flag or a counter the caller supplies, because a
 * caller able to declare "this one is the first" could hide every demand that followed
 * it, which is the whole of what DoD 2 exists to prevent.
 *
 * THE ONE THING NEVER DERIVED is attribution. An observation that carried no command
 * identity stays UNATTRIBUTED. It is not assigned to the most recent command: that guess
 * would be indistinguishable from a measurement one layer later, and it is exactly what
 * makes effort numbers untrustworthy. For the same reason additional-ness is never
 * derived ACROSS unattributed demands — two demands nobody can attribute cannot be shown
 * to have been demanded of the same command.
 *
 * Nothing here scores, totals, thresholds or judges. The records are evidence that
 * something happened; what it cost is not this module's to say.
 */

export interface RecordedDecision {
  readonly commandId: string;
  /** Derived from the observed sequence: the baseline kind, or ADDITIONAL. */
  readonly decisionKind: DecisionKind;
  /** What the surface actually demanded, kept verbatim on every arm. */
  readonly demandedKind: BaselineDecisionKind;
  readonly observedAt: number;
  readonly source: EffortSource;
}

export interface SealedEffortObservations {
  readonly decisions: readonly RecordedDecision[];
  readonly intervals: readonly IntervalOutcome[];
  readonly observations: readonly EffortRecord[];
}

export interface EffortCollector {
  readonly decisions: () => readonly RecordedDecision[];
  readonly intervals: () => readonly IntervalOutcome[];
  readonly observations: () => readonly EffortRecord[];
  readonly record: (value: unknown) => EffortAdmission;
  readonly seal: () => SealedEffortObservations;
}

function refuse(code: EffortUnknownCode): EffortRefusal {
  return effortRefusal(code, EFFORT_COLLECTOR_LAYER);
}

export function createEffortCollector(): EffortCollector {
  const observed: EffortRecord[] = [];
  const decided: RecordedDecision[] = [];
  const intervalMachine = createIntervalMachine();
  /** Command identities already observed demanding a decision. Never seeded, never guessed. */
  const demandedOf = new Set<string>();
  let sealed = false;

  /**
   * The one derivation, and the guard that keeps it honest.
   *
   * The command identity is taken from the observation itself. An UNATTRIBUTED demand
   * stays unattributed and keeps the kind that was demanded: additional-ness is a fact
   * about one command's sequence, and with no identity there is no sequence to read.
   */
  function deriveDecision(record: DemandedDecisionRecord): RecordedDecision {
    const attributed = record.commandId !== UNATTRIBUTED;
    const repeated = attributed && demandedOf.has(record.commandId);
    if (attributed) demandedOf.add(record.commandId);
    return Object.freeze({
      commandId: record.commandId,
      decisionKind: repeated ? ADDITIONAL_DECISION_KIND : record.demandedKind,
      demandedKind: record.demandedKind,
      observedAt: record.observedAt,
      source: record.source,
    });
  }

  function route(record: EffortRecord): EffortRefusal | null {
    if (record.type === "INTERVAL_OPEN") return intervalMachine.open(record);
    if (record.type === "INTERVAL_CLOSE") return intervalMachine.close(record);
    if (record.type === "DEMANDED_DECISION") decided.push(deriveDecision(record));
    return null;
  }

  return Object.freeze({
    decisions: (): readonly RecordedDecision[] => Object.freeze([...decided]),
    intervals: (): readonly IntervalOutcome[] => intervalMachine.outcomes(),
    observations: (): readonly EffortRecord[] => Object.freeze([...observed]),
    record: (value: unknown): EffortAdmission => {
      // A sealed set is a finished account of what a human did. Appending to it would
      // change an answer already given, so the observation is refused, not swallowed.
      if (sealed) return refuse("EFFORT_OBSERVATION_CONTRADICTORY");
      const admitted = shapeEffortObservation(value);
      if (!admitted.known) return admitted;
      const refused = route(admitted);
      if (refused !== null) return refused;
      observed.push(admitted);
      return admitted;
    },
    seal: (): SealedEffortObservations => {
      intervalMachine.sealOpen();
      sealed = true;
      return Object.freeze({
        decisions: Object.freeze([...decided]),
        intervals: intervalMachine.outcomes(),
        observations: Object.freeze([...observed]),
      });
    },
  });
}
