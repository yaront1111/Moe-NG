import {
  FROZEN_COMPARABLE_COHORT_FLOOR, FROZEN_COMPARATOR_GATE_IDS, FROZEN_CONSTANT_SYMBOL_COUNT,
  FROZEN_GATE_THRESHOLD_SYMBOLS, FROZEN_NI_TAIL_DIRECTIONS, FROZEN_SCHEDULE_COVERAGE_FLOOR,
  FROZEN_SYMBOL_ASCII_ALIASES, type NiTail,
} from "./pre-freeze-audit-rosters.js";
import {
  type PreFreezeAuditRefusal, type PreFreezeAuditVerdict, preFreezeAuditRefusal,
  preFreezeAuditVerdict,
} from "./pre-freeze-audit-vocabulary.js";
import {
  type GateVerdict, type ReportBlock, isReportBlock, parseReportBlock, resolveRungVerdict,
} from "./pre-freeze-gate-audit.js";
import type { PinnedSource } from "./pre-freeze-source-reader.js";

/**
 * DoD 2 (c), (d) and (e) — COMPARATOR COVERAGE, FROZEN CONSTANTS, AND THE CI TAIL.
 *
 * THE CI-TAIL CHECK IS THE MOST VALUABLE THING IN THIS AUDIT, and the spec says so
 * itself at 12.1 item 6: a mismatched tail "is a freeze-blocking defect (this is the check
 * that would have caught the acceptance-gate sign inversion)". That names a defect that
 * really happened. Acceptance is higher-is-better, so bounding its UPPER tail limits only
 * how much BETTER Moe is and can never detect Moe being worse — the gate reads as passing
 * while measuring nothing. The endpoint DIRECTION is transcribed; the TAIL is re-read out
 * of the gate's own rule and compared, so a document that flips one reddens.
 *
 * A ZERO-MEMBER COHORT REFUSES RATHER THAN PASSING. `[].every(isPass)` is `true`, which is
 * exactly how "no comparator ran, therefore nothing failed, therefore L5 PASSes" gets
 * written by accident. Spec 12.1 item 2: a missing member verdict makes the rung UNKNOWN,
 * "never silently PASS".
 */

const CONSTANT_SYMBOL = /`([A-Za-z_Ͱ-Ͽ][A-Za-z0-9_Ͱ-Ͽ]*(?:\[[A-Za-z]+\])?)`/g;
const SECTION_ZERO_START = /^##\s+0\./;
const NEXT_TOP_HEADING = /^##\s+(?!0\.)/;
const TAIL_IN_RULE = /(lower|upper)[^.;]{0,40}?CI/i;

/** Section 0's table only. A document-wide backtick scan would swallow every gate ID. */
export const collectConstantSymbols = (source: PinnedSource): readonly string[] => {
  const symbols = new Set<string>();
  let inside = false;
  for (const line of source.lines) {
    if (SECTION_ZERO_START.test(line)) { inside = true; continue; }
    if (inside && NEXT_TOP_HEADING.test(line)) break;
    if (!inside || !line.startsWith("|")) continue;
    const firstCell = line.split("|")[1] ?? "";
    for (const match of firstCell.matchAll(CONSTANT_SYMBOL)) symbols.add(match[1] as string);
  }
  return Object.freeze([...symbols]);
};

/**
 * The Section 12 report block is plain ASCII, so `Gamma_cost` there is `Γ_cost` in the
 * table. A rule "names" its symbol when either spelling appears with word boundaries —
 * boundaries matter because `M_accept` is a prefix of `M_accept_x`, and a substring test
 * would report the fan-out margin as present in every comparator acceptance gate.
 */
const boundedSymbol = (spelling: string): RegExp => {
  const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`);
};

const namesSymbol = (rule: string, symbol: string): boolean => {
  const ascii = Object.entries(FROZEN_SYMBOL_ASCII_ALIASES)
    .find(([, greek]) => greek === symbol)?.[0];
  return [symbol, ascii].filter(Boolean)
    .some((spelling) => boundedSymbol(spelling as string).test(rule));
};

/**
 * A gate's rule is its OWN Section 12 report line, and nothing else. Widening this to the
 * rung's ladder row looks harmless and is not: the L4 row carries the spec's own warning
 * "never the fan-out `M_accept`" and the L5 row carries `M_accept_x` as prose, so a
 * concatenated rule both refuses the pinned document for a defect it does not have AND
 * hides a real margin swap behind the neighbouring text. Symbols a gate states only in its
 * ladder rule get a dedicated arm instead.
 */
const ruleTextFor = (block: ReportBlock, gateId: string): { line: number; rule: string } => {
  const definition = block.gateDefinitions.find((gate) => gate.gateId === gateId);
  return { line: definition?.line ?? 0, rule: definition?.body ?? "" };
};

const auditConstants = (block: ReportBlock, refusals: PreFreezeAuditRefusal[]): number => {
  const table = new Set(collectConstantSymbols(block.source));
  if (table.size !== FROZEN_CONSTANT_SYMBOL_COUNT) {
    refusals.push(preFreezeAuditRefusal("CONSTANT_UNRESOLVED", 0, "Frozen Constants Table"));
  }
  let cases = 0;
  for (const [gateId, symbols] of Object.entries(FROZEN_GATE_THRESHOLD_SYMBOLS)) {
    const { line, rule } = ruleTextFor(block, gateId);
    for (const symbol of symbols) {
      cases += 1;
      if (!table.has(symbol)) {
        refusals.push(preFreezeAuditRefusal("CONSTANT_UNRESOLVED", 0, symbol));
      }
      if (!namesSymbol(rule, symbol)) {
        refusals.push(preFreezeAuditRefusal("CONSTANT_UNRESOLVED", line, `${gateId}:${symbol}`));
      }
    }
  }
  return cases;
};

/**
 * THE FAN-OUT MARGIN TRAP, spec:88: acceptance non-inferiority against a comparator uses
 * `M_accept_x`, "never the fan-out `M_accept`". Both are real table symbols, so no
 * membership test can separate them — only this one can, and only with word boundaries.
 */
const auditAcceptanceMargins = (
  block: ReportBlock,
  refusals: PreFreezeAuditRefusal[],
): number => {
  const forbidden: readonly (readonly [string, string])[] = [
    ["G-L3-accept", "M_accept_x"], ["G-L4-accept", "M_accept"], ["G-L5-accept", "M_accept"],
  ];
  for (const [gateId, wrongSymbol] of forbidden) {
    const { line, rule } = ruleTextFor(block, gateId);
    if (boundedSymbol(wrongSymbol).test(rule)) {
      refusals.push(preFreezeAuditRefusal("CONSTANT_UNRESOLVED", line, `${gateId}:${wrongSymbol}`));
    }
  }
  return forbidden.length;
};

/** Spec:43 — the floor, its governor, and spec 12.1 item 5's non-reducibility clause. */
const auditScheduleCoverageFloor = (
  block: ReportBlock,
  refusals: PreFreezeAuditRefusal[],
): number => {
  const row = block.source.lines.find(
    (line) => line.startsWith("|") && /`N_sched`/.test(line),
  ) ?? "";
  const floor = FROZEN_SCHEDULE_COVERAGE_FLOOR.toLocaleString("en-US");
  const clauses: readonly (readonly [boolean, string])[] = [
    [row.includes(floor), `N_sched >= ${floor}`],
    [/ScheduleCoverageManifest/.test(row), "N_sched >= CORE manifest minima"],
    [/manifest governs/i.test(row), "CORE manifest governs"],
    [/never lower|never be lowered|but never lower/i.test(block.source.text), "manifest minima are a floor"],
  ];
  for (const [holds, token] of clauses) {
    if (!holds) refusals.push(preFreezeAuditRefusal("CONSTANT_UNRESOLVED", 0, token));
  }
  return clauses.length;
};

const auditCiTails = (block: ReportBlock, refusals: PreFreezeAuditRefusal[]): number => {
  let cases = 0;
  for (const [gateId, expected] of Object.entries(FROZEN_NI_TAIL_DIRECTIONS)) {
    const { line, rule } = ruleTextFor(block, gateId);
    const observed = TAIL_IN_RULE.exec(rule);
    cases += 1;
    if (!observed) {
      refusals.push(
        preFreezeAuditRefusal("CI_TAIL_DIRECTION_WRONG", line, `${gateId}:tail-unstated`),
      );
      continue;
    }
    const tail = (observed[1] as string).toUpperCase() as NiTail;
    if (tail !== expected.tail) {
      refusals.push(preFreezeAuditRefusal("CI_TAIL_DIRECTION_WRONG", line, `${gateId}:${tail}`));
    }
  }
  if (cases === 0) refusals.push(preFreezeAuditRefusal("SWEEP_ZERO_CASES", 0, "CI tail"));
  return cases;
};

export type ThresholdAuditReport = PreFreezeAuditVerdict & {
  readonly ciTailCases: number;
  readonly constantCases: number;
  readonly marginCases: number;
};

export const auditThresholds = (source: PinnedSource): ThresholdAuditReport => {
  const block = parseReportBlock(source);
  if (!isReportBlock(block)) {
    return Object.freeze({
      ...preFreezeAuditVerdict(0, [block]), ciTailCases: 0, constantCases: 0, marginCases: 0,
    });
  }
  const refusals: PreFreezeAuditRefusal[] = [];
  const constantCases = auditConstants(block, refusals)
    + auditScheduleCoverageFloor(block, refusals);
  const marginCases = auditAcceptanceMargins(block, refusals);
  const ciTailCases = auditCiTails(block, refusals);
  for (const gateId of FROZEN_COMPARATOR_GATE_IDS) {
    const definition = block.gateDefinitions.find((gate) => gate.gateId === gateId);
    if (!definition?.indexed) {
      refusals.push(
        preFreezeAuditRefusal("COMPARATOR_INDEX_MISSING", definition?.line ?? 0, gateId),
      );
    }
  }
  return Object.freeze({
    ...preFreezeAuditVerdict(constantCases + marginCases + ciTailCases, refusals),
    ciTailCases, constantCases, marginCases,
  });
};

/** `gateId -> memberId -> verdict`, the per-member table spec:89 requires be printed. */
export type ComparatorVerdictTable =
  Readonly<Record<string, Readonly<Record<string, GateVerdict>>>>;

export type ComparatorCoverageReport = PreFreezeAuditVerdict & {
  readonly verdict: GateVerdict;
};

/**
 * The intersection-union test of spec:89: every comparator-indexed gate must carry a
 * printed verdict for EVERY model-matched COMPARABLE member, AND-ed across the cohort.
 * An empty cohort and a cohort below `C_min` both refuse COMPARATOR_INDEX_MISSING, and the
 * resolved verdict is UNKNOWN — never PASS — whenever any member verdict is absent.
 */
export const auditComparatorCoverage = (
  cohort: readonly string[],
  table: ComparatorVerdictTable,
): ComparatorCoverageReport => {
  const refusals: PreFreezeAuditRefusal[] = [];
  if (cohort.length === 0) {
    refusals.push(preFreezeAuditRefusal("COMPARATOR_INDEX_MISSING", 0, "COMPARABLE cohort"));
  } else if (cohort.length < FROZEN_COMPARABLE_COHORT_FLOOR) {
    refusals.push(preFreezeAuditRefusal("COMPARATOR_INDEX_MISSING", 0, "C_min"));
  }
  const printed: GateVerdict[] = [];
  let cases = 0;
  for (const gateId of FROZEN_COMPARATOR_GATE_IDS) {
    for (const member of cohort) {
      cases += 1;
      const verdict = table[gateId]?.[member];
      if (verdict === undefined) {
        refusals.push(
          preFreezeAuditRefusal("COMPARATOR_INDEX_MISSING", 0, `${gateId}[${member}]`),
        );
        printed.push("UNKNOWN");
        continue;
      }
      printed.push(verdict);
    }
  }
  return Object.freeze({
    ...preFreezeAuditVerdict(cases, refusals),
    verdict: resolveRungVerdict(printed),
  });
};
