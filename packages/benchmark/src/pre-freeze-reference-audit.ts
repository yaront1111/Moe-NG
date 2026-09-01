import {
  FROZEN_GATE_IDS, FROZEN_REFERENCE_CARDINALITY, type FrozenReferenceFamily,
} from "./pre-freeze-audit-rosters.js";
import {
  type PreFreezeAuditRefusal, type PreFreezeAuditVerdict, preFreezeAuditRefusal,
  preFreezeAuditVerdict,
} from "./pre-freeze-audit-vocabulary.js";
import {
  type LocatedToken, type PinnedSource, collectBareScenarioTokens, collectFamilyDefinitions,
  collectFamilyUses, collectGateIdUses, collectHeadingNumbers, collectSectionPointers,
} from "./pre-freeze-source-reader.js";

/**
 * DoD 1 — THE PRE-FREEZE REFERENCE LINT THE SPEC ASKS FOR AT SPEC:8, over BOTH pinned
 * documents, because one of them is not enough.
 *
 * WHY THIS IS A CROSS-DOCUMENT CHECK AND WHY THAT IS NOT AN IMPLEMENTATION DETAIL.
 * `BENCH-S1…BENCH-S14` are defined AND used inside the benchmark, so their equality is
 * in-file. `CORE-I1…CORE-I22` and `CORE-S1…CORE-S14` are NOT: the benchmark cites them
 * only as ranges and states at spec:64 that it "CONSUMES those artifacts; it never
 * redefines them". Measured on the pinned bytes, the benchmark contains 2 distinct CORE-I
 * and 2 distinct CORE-S literal tokens. Their 22 and 14 definitions live in the rebuild
 * design, whose digest equals epic rail 1's pin.
 *
 * So an audit that looked for definitions inside the benchmark would either fail
 * spuriously or — far worse — run its "bidirectional" sweep over a two-element set and
 * report PASS. That is why `familyCases` is returned and why the tests assert 22 / 14 / 14
 * on it: a sweep whose own case count is not asserted is indistinguishable from a sweep
 * that found nothing wrong because it looked at almost nothing.
 *
 * BOTH DIRECTIONS, AND THEY CATCH DIFFERENT DEFECTS. A use with no definition is a
 * pointer at nothing (REFERENCE_UNRESOLVED). A definition with no use is a member that
 * silently left the ladder (TOKEN_SET_MISMATCH) — invisible to any sweep that iterates the
 * use side only, which is exactly the shape a one-directional roster test takes.
 */

const FAMILIES = Object.freeze(["CORE-I", "CORE-S", "BENCH-S"] as const);

/** Which document DEFINES each family. Uses are always read from the benchmark. */
const FAMILY_DEFINED_BY: Readonly<Record<FrozenReferenceFamily, "benchmark" | "design">> =
  Object.freeze({ "BENCH-S": "benchmark", "CORE-I": "design", "CORE-S": "design" });

/**
 * A gate cited by position instead of by its ID. Spec:8: every gate "is always cited by
 * that ID, never by section number, so renumbering can never silently retarget a gate".
 * REFERENCE_AMBIGUOUS is the right code because the repair is the same one a bare `S3`
 * needs: name the thing by its unambiguous ID.
 */
const POSITIONAL_GATE_CITATION = /gates?\s+(?:in|at|of|from|per)\s+Section\s+\d[\d.]*/gi;

export type ReferenceAuditInput = {
  readonly benchmark: PinnedSource;
  readonly design: PinnedSource;
};

export type ReferenceAuditReport = PreFreezeAuditVerdict & {
  readonly familyCases: Readonly<Record<FrozenReferenceFamily, number>>;
  readonly gateIdCases: number;
  readonly sectionPointerCases: number;
};

/** First occurrence wins, so a reported location is where a reader should start looking. */
const firstLocations = (tokens: readonly LocatedToken[]): ReadonlyMap<string, number> => {
  const located = new Map<string, number>();
  for (const token of tokens) if (!located.has(token.text)) located.set(token.text, token.line);
  return located;
};

const auditFamily = (
  family: FrozenReferenceFamily,
  input: ReferenceAuditInput,
  refusals: PreFreezeAuditRefusal[],
): number => {
  const definitions = collectFamilyDefinitions(input[FAMILY_DEFINED_BY[family]], family);
  const defined = new Map<string, number>();
  for (const definition of definitions) {
    if (defined.has(definition.text)) {
      refusals.push(preFreezeAuditRefusal("REFERENCE_DUPLICATE", definition.line, definition.text));
      continue;
    }
    defined.set(definition.text, definition.line);
  }
  const used = firstLocations(collectFamilyUses(input.benchmark, family));
  for (const [token, line] of used) {
    if (!defined.has(token)) refusals.push(preFreezeAuditRefusal("REFERENCE_UNRESOLVED", line, token));
  }
  for (const [token, line] of defined) {
    if (!used.has(token)) refusals.push(preFreezeAuditRefusal("TOKEN_SET_MISMATCH", line, token));
  }
  if (defined.size !== FROZEN_REFERENCE_CARDINALITY[family]) {
    refusals.push(preFreezeAuditRefusal("TOKEN_SET_MISMATCH", 0, family));
  }
  const cases = new Set([...defined.keys(), ...used.keys()]).size;
  if (cases === 0) refusals.push(preFreezeAuditRefusal("SWEEP_ZERO_CASES", 0, family));
  return cases;
};

/**
 * Gate IDs, both directions against the hand-transcribed roster of twenty. The roster is
 * transcribed rather than scanned precisely so that deleting a gate from the document
 * reddens here instead of shrinking both sides of the comparison together.
 */
const auditGateIds = (
  benchmark: PinnedSource,
  refusals: PreFreezeAuditRefusal[],
): number => {
  const used = firstLocations(collectGateIdUses(benchmark));
  for (const [token, line] of used) {
    if (!(FROZEN_GATE_IDS as readonly string[]).includes(token)) {
      refusals.push(preFreezeAuditRefusal("REFERENCE_UNRESOLVED", line, token));
    }
  }
  for (const token of FROZEN_GATE_IDS) {
    if (!used.has(token)) refusals.push(preFreezeAuditRefusal("TOKEN_SET_MISMATCH", 0, token));
  }
  if (used.size === 0) refusals.push(preFreezeAuditRefusal("SWEEP_ZERO_CASES", 0, "G-*"));
  return used.size;
};

/**
 * `Section N` pointers. The spec asks that each resolve "to the intended TITLE"; intent is
 * outside mechanical reach, so this resolves each pointer to a numbered heading and says
 * so plainly rather than implying it verified an intention it never read.
 */
const auditSectionPointers = (
  benchmark: PinnedSource,
  refusals: PreFreezeAuditRefusal[],
): number => {
  const headings = new Map<string, number>();
  for (const heading of collectHeadingNumbers(benchmark)) {
    if (headings.has(heading.text)) {
      refusals.push(preFreezeAuditRefusal("REFERENCE_DUPLICATE", heading.line, heading.text));
      continue;
    }
    headings.set(heading.text, heading.line);
  }
  const pointers = firstLocations(collectSectionPointers(benchmark));
  for (const [token, line] of pointers) {
    if (!headings.has(token)) {
      refusals.push(preFreezeAuditRefusal("REFERENCE_UNRESOLVED", line, `Section ${token}`));
    }
  }
  if (pointers.size === 0) refusals.push(preFreezeAuditRefusal("SWEEP_ZERO_CASES", 0, "Section"));
  return pointers.size;
};

const auditCitationConventions = (
  benchmark: PinnedSource,
  refusals: PreFreezeAuditRefusal[],
): void => {
  for (const bare of collectBareScenarioTokens(benchmark)) {
    refusals.push(preFreezeAuditRefusal("REFERENCE_AMBIGUOUS", bare.line, bare.text));
  }
  benchmark.lines.forEach((text, index) => {
    for (const match of text.matchAll(POSITIONAL_GATE_CITATION)) {
      refusals.push(preFreezeAuditRefusal("REFERENCE_AMBIGUOUS", index + 1, match[0]));
    }
  });
};

export const auditReferences = (input: ReferenceAuditInput): ReferenceAuditReport => {
  const refusals: PreFreezeAuditRefusal[] = [];
  const familyCases = Object.fromEntries(
    FAMILIES.map((family) => [family, auditFamily(family, input, refusals)]),
  ) as Record<FrozenReferenceFamily, number>;
  const gateIdCases = auditGateIds(input.benchmark, refusals);
  const sectionPointerCases = auditSectionPointers(input.benchmark, refusals);
  auditCitationConventions(input.benchmark, refusals);
  const total = Object.values(familyCases).reduce((sum, count) => sum + count, 0)
    + gateIdCases + sectionPointerCases;
  return Object.freeze({
    ...preFreezeAuditVerdict(total, refusals),
    familyCases: Object.freeze(familyCases),
    gateIdCases,
    sectionPointerCases,
  });
};
