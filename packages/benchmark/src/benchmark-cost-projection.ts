/**
 * The cost-class and count columns.
 *
 * A BINDING IS NOT A COST, and this module is where that is either kept or lost. Each
 * usage row carries a `pricebookBinding` — a derived list price against a named,
 * immutable pricebook revision. Multiplying it by the measured quantity would produce a
 * number that LOOKS like what the run cost and is not: it is a list price, computed by a
 * consumer, presented as an observation. There is deliberately no multiplication in this
 * file, and the row has no field a total could be written into.
 *
 * A row therefore reports three separate things and never fuses them: what was measured
 * (`quantity`, with its own coverage and source), what a price would be bound to
 * (`pricebookBinding`, verbatim), and which of those two states the row is in
 * (`costBasis`). A consumer that wants a price computes it, and owns the claim.
 */

import { factCell, knownCell, unknownCell } from "./benchmark-projection-cells.js";
import type { BenchmarkCostBasis, BenchmarkValue } from "./benchmark-projection-vocabulary.js";
import type {
  ProjectedPricebookBinding, ProjectedRunRecord, ProjectedUsageRow,
} from "./benchmark-record-contracts.js";

/** One usage row's cost class. No field here can hold a computed total. */
export interface BenchmarkCostRow {
  readonly meter: string;
  readonly quantity: BenchmarkValue<number>;
  readonly coverage: string;
  readonly source: string;
  readonly sequence: number;
  readonly identity: string;
  readonly truncated: boolean;
  readonly pricebookBinding: ProjectedPricebookBinding | null;
  readonly costBasis: BenchmarkCostBasis;
}

/** Counts with their own coverage. A coverage short of complete is carried, not dropped. */
export interface BenchmarkCounts {
  readonly inputTokens: BenchmarkValue<number>;
  readonly outputTokens: BenchmarkValue<number>;
  readonly cacheCreationInputTokens: BenchmarkValue<number>;
  readonly cacheReadInputTokens: BenchmarkValue<number>;
  readonly tokenCoverage: string;
  readonly turns: BenchmarkValue<number>;
  readonly stepCoverage: string;
  readonly sequence: BenchmarkValue<number>;
}

/**
 * `quantity: null` on the durable contract is an envelope the scheduler admitted without
 * a reading. It becomes an explicit UNKNOWN: rendering it as 0 would report a measured
 * zero-usage envelope, which is a different and false fact.
 */
function projectCostRow(row: ProjectedUsageRow): BenchmarkCostRow {
  const { measurement } = row;
  return {
    meter: measurement.meter,
    quantity: measurement.quantity === null
      ? unknownCell<number>("QUANTITY_ABSENT")
      : knownCell(measurement.quantity),
    coverage: measurement.coverage,
    source: measurement.source,
    sequence: measurement.sequence,
    identity: row.identity,
    truncated: row.truncated,
    pricebookBinding: row.pricebookBinding,
    costBasis: row.pricebookBinding === null ? "NO_BINDING" : "PRICEBOOK_BINDING",
  };
}

/** One row per admitted usage envelope, in the provider's original order, none dropped. */
export function projectCostClass(record: ProjectedRunRecord): readonly BenchmarkCostRow[] {
  return record.usage.map(projectCostRow);
}

export function projectCounts(record: ProjectedRunRecord): BenchmarkCounts {
  const { tokens, steps } = record;
  return {
    inputTokens: factCell(tokens.inputTokens),
    outputTokens: factCell(tokens.outputTokens),
    cacheCreationInputTokens: factCell(tokens.cacheCreationInputTokens),
    cacheReadInputTokens: factCell(tokens.cacheReadInputTokens),
    tokenCoverage: tokens.coverage,
    turns: factCell(steps.turns),
    stepCoverage: steps.coverage,
    sequence: factCell(record.sequence),
  };
}
