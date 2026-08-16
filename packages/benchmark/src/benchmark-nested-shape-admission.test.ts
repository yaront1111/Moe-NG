/**
 * The guard family for containers the projector reads INTO, and the cell invariant it
 * upholds. These two describe one rule from its two ends.
 *
 * THE DEFECT THIS FILE EXISTS FOR. A shape table that checks only a container's top-level
 * KIND stops one level above where the reading happens. `{}` passes `isPlainRecord`, its
 * absent members read back as `undefined`, and `undefined` is not a refusal but a value —
 * so a cell publishes `{known: true, value: undefined}` and missing evidence has gained an
 * observation's authority in silence. Every fixture in this package is COMPLETE, so no
 * existing test drove a container of the right kind with the wrong inside, and a mutation
 * drill could not reach it either: this is a case production was never asked about.
 *
 * WHY BOTH HALVES ARE NEEDED, and where the other half lives. This file is the sweep: it
 * proves each partial container is REFUSED with its exact code and layer. Its sibling
 * `benchmark-cell-invariant.test.ts` walks whatever admission does let through and proves
 * the cell invariant holds at every depth. Either alone detaches — a sweep enumerates only
 * the shapes someone thought of, and a walker over complete fixtures can never see a hole.
 */

import { describe, expect, it } from "vitest";

import {
  FIXTURE_OBSERVED_END_OTHER_BOOT, FIXTURE_USAGE_ROW, completeRunRecordFixture,
  unobservedRunRecordFixture,
} from "./benchmark-record-fixture.js";
import { projectBenchmarkRun } from "./benchmark-run-projection.js";

const BASE = completeRunRecordFixture();

/**
 * What production ANSWERED, as one comparable string.
 *
 * A throw is captured rather than allowed to escape, because a crash out of an
 * `(input: unknown)` entry point is itself the defect under test: it carries no code and
 * no layer, so there is nothing a caller can pin. Rendering it as `THREW:TypeError`
 * against an expected refusal makes "it failed" and "it failed closed" visibly different.
 */
function outcomeOf(input: unknown): string {
  try {
    const result = projectBenchmarkRun(input);
    return result.ok ? "PROJECTED" : `${result.code}@${result.layer}`;
  } catch (error) {
    return `THREW:${(error as Error).name}`;
  }
}

interface ShapeCase {
  readonly label: string;
  readonly input: unknown;
}

/**
 * Containers of the right KIND carrying the wrong INSIDE. The first eight are the exact
 * inputs confirmed against production to leak; the rest walk the same guard family across
 * the remaining containers the projector reads into.
 */
const PARTIAL_CONTAINERS: readonly ShapeCase[] = [
  { label: "launch:{}", input: { ...BASE, launch: {} } },
  {
    label: "declared selection truncated",
    input: { ...BASE, declared: { known: true, selection: { selectedModelId: "m" } } },
  },
  { label: "sequence:{}", input: { ...BASE, sequence: {} } },
  { label: "stdoutReceiptDigest:{}", input: { ...BASE, stdoutReceiptDigest: {} } },
  { label: "providerRunRef:{}", input: { ...BASE, providerRunRef: {} } },
  { label: "declared:{known:true} with no selection", input: { ...BASE, declared: { known: true } } },
  { label: "observedModel:{}", input: { ...BASE, observedModel: {} } },
  { label: "tokens:{}", input: { ...BASE, tokens: {} } },
  { label: "steps:{}", input: { ...BASE, steps: {} } },
  { label: "concurrency:{}", input: { ...BASE, concurrency: {} } },
  { label: "stderrReceiptDigest known with no value", input: { ...BASE, stderrReceiptDigest: { known: true } } },
  {
    label: "providerRunRef epoch is text",
    input: { ...BASE, providerRunRef: { ...BASE.providerRunRef, epoch: "3" } },
  },
  {
    label: "launch startedAt is a number",
    input: { ...BASE, launch: { ...BASE.launch, startedAt: 42 } },
  },
  {
    label: "declared unknown carries no code or layer",
    input: { ...BASE, declared: { known: false } },
  },
  {
    label: "declared unknown carries a code but no layer",
    input: { ...BASE, declared: { known: false, code: "TELEMETRY_LAUNCH_UNREADABLE" } },
  },
  {
    label: "observedModel modelId known with no value",
    input: {
      ...BASE,
      observedModel: { ...BASE.observedModel, modelId: { known: true } },
    },
  },
  {
    label: "token count is text, not a quantity",
    input: { ...BASE, tokens: { ...BASE.tokens, inputTokens: { known: true, value: "120" } } },
  },
  {
    label: "sequence unknown carries no layer",
    input: { ...BASE, sequence: { known: false, code: "TELEMETRY_RESULT_ABSENT" } },
  },
  {
    label: "concurrency achieved is a bare object",
    input: { ...BASE, concurrency: { ...BASE.concurrency, achieved: {} } },
  },
  { label: "upstreamRefusal:{}", input: { ...BASE, upstreamRefusal: {} } },
  { label: "usageRefusals carries a bare object", input: { ...BASE, usageRefusals: [{}] } },
];

describe("a container is guarded to the depth the projector reads it", () => {
  it("refuses every partial container with the shape code, and never by throwing", () => {
    const observed = Object.fromEntries(
      PARTIAL_CONTAINERS.map(({ label, input }) => [label, outcomeOf(input)]),
    );
    const expected = Object.fromEntries(
      PARTIAL_CONTAINERS.map(({ label }) => [label, "BENCHMARK_RECORD_FIELD_MALFORMED@BENCHMARK_SHAPE"]),
    );
    // One assertion over the whole family: a case that PROJECTED and a case that THREW are
    // each named in the diff, so a leak and a crash cannot be confused for one another.
    expect(observed).toEqual(expected);
    expect(PARTIAL_CONTAINERS.length).toBe(21);
    expect(PARTIAL_CONTAINERS.length).toBeGreaterThan(0);
  });

  it("attributes a partial cost row to the ROW layer, not to the record's shape", () => {
    // `pricebookBinding: {}` would make `costBasis` report PRICEBOOK_BINDING against a
    // binding naming no pricebook revision — a cost basis with nothing bound to it.
    const rowCases: readonly ShapeCase[] = [
      {
        label: "pricebookBinding:{}",
        input: { ...BASE, usage: [{ ...FIXTURE_USAGE_ROW, pricebookBinding: {} }] },
      },
      {
        label: "pricebookBinding unit price is text",
        input: {
          ...BASE,
          usage: [{
            ...FIXTURE_USAGE_ROW,
            pricebookBinding: { ...FIXTURE_USAGE_ROW.pricebookBinding, unitPriceMicros: "1500" },
          }],
        },
      },
    ];
    const observed = Object.fromEntries(rowCases.map(({ label, input }) => [label, outcomeOf(input)]));
    expect(observed).toEqual({
      "pricebookBinding:{}": "BENCHMARK_ROW_BASIS_ABSENT@BENCHMARK_ROW",
      "pricebookBinding unit price is text": "BENCHMARK_ROW_BASIS_ABSENT@BENCHMARK_ROW",
    });
    expect(rowCases.length).toBeGreaterThan(0);
  });

  it("still admits every record whose containers are whole", () => {
    // The guards must refuse partial containers WITHOUT refusing real ones. A launch that
    // carries an `exit` field this package does not project is a real record: the daemon's
    // `ClaudeTelemetryLaunchFacts` has one, and a guard demanding an exact key set would
    // refuse every run the daemon commits.
    const admissible: readonly ShapeCase[] = [
      { label: "complete", input: completeRunRecordFixture() },
      { label: "unobserved", input: unobservedRunRecordFixture() },
      { label: "boot mismatch", input: { ...BASE, observedEnd: FIXTURE_OBSERVED_END_OTHER_BOOT } },
      {
        label: "launch carries an unprojected exit field",
        input: { ...BASE, launch: { ...BASE.launch, exit: { code: 0, signal: null } } },
      },
      {
        label: "launch stamps unobserved",
        input: { ...BASE, launch: { ...BASE.launch, startedAt: null, completedAt: null } },
      },
    ];
    const observed = Object.fromEntries(admissible.map(({ label, input }) => [label, outcomeOf(input)]));
    expect(observed).toEqual({
      complete: "PROJECTED",
      unobserved: "PROJECTED",
      "boot mismatch": "PROJECTED",
      "launch carries an unprojected exit field": "PROJECTED",
      "launch stamps unobserved": "PROJECTED",
    });
    expect(admissible.length).toBeGreaterThan(0);
  });
});
