/**
 * THE LEDGER — shared recording machinery for the three runtime-provider slices.
 *
 * NOT a `*.security.ts` file, deliberately: the lane collects that suffix, so this would
 * register as a suite with no cases and `passWithNoTests: false` would fail on its emptiness.
 * Same reason `hostile-harness.ts` carries no suffix.
 *
 * The PARTITION and the slice-wide invariants live in `runtime-provider-invariants.ts`; they
 * were split out when this file crossed the 400-line rail. The division is by concern: this
 * module records what a boundary ANSWERED, that one reads a completed ledger and judges
 * COVERAGE.
 *
 * IT HOLDS NO AUTHORITY. Every field it stores is derived from the value production returned;
 * it never derives an expected code or layer, and never judges a refusal. Every code and layer
 * expectation is written at the case, taken from the boundary's OWN exported constant.
 */

import { expect } from "vitest";

import { assertRefusedWith } from "./hostile-harness.js";
import type { HostileBound, LegOutcome, RefusalExpectation } from "./hostile-harness.js";

/**
 * The partition and the coverage judgements, re-exported so the three slices keep ONE import
 * site for the shared machinery. The split was forced by the 400-line rail, and a slice should
 * not have to know which side of it a helper landed on. No runtime cycle: the sibling imports
 * only the `Ledger` TYPE back, which is erased.
 */
export {
  RUNTIME_PROVIDER_PARTITION,
  assertAdmittedNothing,
  assertMessagesEchoNothing,
  assertPositiveCounts,
  assertRosterPartition,
  assertSweepsExactly,
  describeRosterCompleteness,
  describeSliceInvariants,
  rosterRuntimeProvider,
  type PartitionKey,
} from "./runtime-provider-invariants.js";

/**
 * Two seconds. `MAX_BOUND_MS` is 2**31-1 — the `setTimeout` clamp boundary, where a wider
 * bound silently becomes the TIGHTEST one — so this sits four orders of magnitude below it.
 * The failure mode guarded against is a HANG: the lane runs `fileParallelism: false`, so one
 * unbounded wait stalls every file after it and reports no verdict at all rather than a red.
 */
export const RUNTIME_BOUND: HostileBound = Object.freeze({
  label: "runtime-provider-boundary",
  timeoutMs: 2_000,
});

export type Arm = "AFTER" | "BEFORE" | "RACE";

export interface Admission {
  readonly boundary: string;
  readonly arm: Arm;
  /**
   * DERIVED FROM THE PRODUCTION VALUE, never asserted into existence.
   *
   * An earlier revision hard-coded `false` at every writer, which made
   * `assertAdmittedNothing` a tautology: with the field constant, the filter could not be
   * non-empty and the slice-wide invariant could not fail for any mutation whatsoever. It is
   * now read off what the surface actually returned, and the entry is pushed BEFORE the
   * per-case assertion runs — so a boundary that starts admitting reddens the invariant even
   * though the same value also reddens its own case.
   */
  readonly admitted: boolean;
  /**
   * The truth class the surface reported, or `null` where it reports none. DoD's first clause
   * is "no hostile case upgrades a truth class to PROVEN", which nothing could sweep while
   * `Admission` carried no truth class at all — one case checked it by hand and the rest went
   * unchecked.
   */
  readonly truthClass: string | null;
  /** The refusal message the production surface returned, kept for the hygiene property. */
  readonly message: string;
}

/** Reads a layer off the boundary's OWN declared constant, so a layer that stops being
 *  declared there reddens here instead of surviving as a string literal nobody rechecks. */
export function layerOf<T extends string>(declared: readonly T[], name: string): T {
  const found = declared.find((layer) => layer === name);
  if (found === undefined) {
    throw new Error(`${name} is no longer declared by its boundary constant`);
  }
  return found;
}

/** Cast a hostile fixture into the declared parameter type. Named so a reader can grep every
 *  place a slice deliberately hands production something its type forbids. */
export const hostile = <T,>(value: unknown): T => value as T;

function messageOf(actual: unknown): string {
  if (typeof actual !== "object" || actual === null) return "";
  const record = actual as Record<string, unknown>;
  const text = record["message"] ?? record["reason"] ?? record["detail"];
  return typeof text === "string" ? text : "";
}

/**
 * Was this value an ADMISSION? Read off the production value, with the burden of proof on
 * refusal: only an explicit `ok: false`, or a refusal shape carrying a stable `code`, counts as
 * a refusal. Everything else — `ok: true`, a bare accepted record, a plain string — records
 * `true`, which is what lets `assertAdmittedNothing` redden. Erring the other way would restore
 * exactly the tautology this replaces.
 */
function admissionOf(actual: unknown): boolean {
  if (typeof actual !== "object" || actual === null) return true;
  // A surface that THREW admitted nothing. Several boundaries here refuse by throwing
  // (`ScopeObserverError`), and a race leg that rejected hands its reason through this path.
  if (actual instanceof Error) return false;
  const record = actual as Record<string, unknown>;
  if (record["ok"] === false) return false;
  if (record["ok"] === true) return true;
  const code = record["code"] ?? record["reasonCode"];
  return !(typeof code === "string" && code !== "");
}

/** The truth class the value reported, or `null` where it reports none. Never defaulted to
 *  `"UNKNOWN"`: an absent truth class is not an observed one, and defaulting would let a
 *  surface that stopped reporting truth pass the PROVEN sweep silently. */
function truthClassOf(actual: unknown): string | null {
  if (typeof actual !== "object" || actual === null) return null;
  const reported = (actual as Record<string, unknown>)["truthClass"];
  return typeof reported === "string" ? reported : null;
}

export interface Ledger {
  readonly entries: readonly Admission[];
  /** Assert a refusal by code AND layer, and record what the surface actually returned.
   *  `observedTruthClass` overrides the value read off `actual`, for surfaces whose truth class
   *  lives on a SIBLING value — a platform verdict's failure carries none, but the observation
   *  wrapping it does, and dropping it on the floor would leave that boundary unswept. */
  refused: (
    boundary: string,
    arm: Arm,
    actual: unknown,
    expected: RefusalExpectation,
    observedTruthClass?: string | null,
  ) => void;
  /**
   * As `refused`, plus the EXACT refusal message.
   *
   * For boundaries where ONE code at ONE layer is returned by several distinct guards, so
   * code-and-layer cannot say which one answered and a mutation deleting the intended guard
   * survives. `readQuote` is the measured case: seven branches, one code, one layer. The
   * message is the only discriminator production exposes; splitting the branch onto its own
   * stable code would be strictly better and belongs to that boundary's owner, not to a test.
   */
  refusedExactly: (
    boundary: string,
    arm: Arm,
    actual: unknown,
    expected: RefusalExpectation,
    message: string,
  ) => void;
  /** As `refused`, for ONE side of a race. Asserted per side: an aggregate assertion over a
   *  race can hide a double admit, which is the one defect a race case exists to find. */
  refusedSide: <T>(boundary: string, side: LegOutcome<T>, expected: RefusalExpectation) => void;
  /** Record a non-admission whose code the CASE already asserted against the production value
   *  and whose surface reports no layer of its own. Never a shortcut around `refused`: the only
   *  callers are the render contracts, whose layer vocabulary lives on the accepted envelope's
   *  manifest and is exercised by a manifest-attributed case on the same boundary. Takes the
   *  production VALUE, not a message, so admission and truth class stay derived rather than
   *  asserted by the caller. */
  record: (boundary: string, arm: Arm, actual: unknown) => void;
}

export function createLedger(): Ledger {
  const entries: Admission[] = [];
  /** Push FIRST, assert SECOND. If the assertion threw first, an admitted value would never
   *  reach the ledger and the slice-wide invariant would go blind to the one outcome it exists
   *  to catch. Both reddening is the point: the case names the boundary, the invariant proves
   *  no case anywhere escaped. */
  const push = (boundary: string, arm: Arm, actual: unknown, truthClass?: string | null): void => {
    entries.push({
      admitted: admissionOf(actual),
      arm,
      boundary,
      message: messageOf(actual),
      truthClass: truthClass === undefined ? truthClassOf(actual) : truthClass,
    });
  };
  return {
    entries,
    refused(boundary, arm, actual, expected, observedTruthClass) {
      push(boundary, arm, actual, observedTruthClass);
      assertRefusedWith(actual, expected);
    },
    refusedExactly(boundary, arm, actual, expected, message) {
      push(boundary, arm, actual);
      assertRefusedWith(actual, expected);
      expect(messageOf(actual)).toBe(message);
    },
    record(boundary, arm, actual) {
      push(boundary, arm, actual);
    },
    refusedSide(boundary, side, expected) {
      const value = side.status === "fulfilled" ? side.value : side.reason;
      push(boundary, "RACE", value);
      expect(side.status).toBe("fulfilled");
      assertRefusedWith(value, expected);
    },
  };
}

/**
 * Record a refusal from a surface that reports NO LAYER OF ITS OWN.
 *
 * Some production surfaces are that by design — `claudeFailure`/`codexFailure` and
 * `scopeFailure` return `{ok, code, message}`, and their layer vocabulary is spelled elsewhere
 * (a render manifest entry, a thrown `ScopeObserverError`). The layer's ABSENCE is asserted
 * rather than assumed, so a layer that starts being reported reddens here and forces the case
 * to pin it; and every boundary using this ALSO carries a layer-attributed case, so its layer
 * vocabulary is never left unexercised.
 */
export function refusedWithoutLayer(
  ledger: Ledger,
  boundary: string,
  arm: Arm,
  actual: unknown,
  expectedCode: string,
): void {
  // Recorded BEFORE the assertions, for the same reason `refused` is: a value carrying `ok:
  // true` must reach the slice-wide invariant rather than be swallowed by the first `expect`.
  ledger.record(boundary, arm, actual);
  const record = actual as Record<string, unknown>;
  expect(record["ok"]).toBe(false);
  expect(record["code"]).toBe(expectedCode);
  expect(record["layer"] ?? record["reasonLayer"]).toBeUndefined();
}
