import { createHash } from "node:crypto";

import { canonicalize } from "../canonical-json.js";

import type {
  CanonicalScheduleForm,
  DerivedScheduleUniverse,
  ObligationCoverage,
  RacePairRef,
  ScheduleCode,
  ScheduleCoverageInput,
  ScheduleCoverageManifest,
  ScheduleDefinition,
  ScheduleFinding,
  ScheduleObligation,
  ScheduleStratum,
  ScheduleVerdict,
  TransitionRef,
} from "./schedule-model.js";
import {
  RELEASE_SCHEDULE_FLOOR,
  SCHEDULE_CANONICAL_FORM_VERSION,
  SCHEDULE_COVERAGE_MANIFEST_VERSION,
  SCHEDULE_STRATUM_MINIMA,
  SCHEDULE_STRATUM_MINIMA_VERSION,
  canonicalScheduleForm,
  compareText,
  racePairKey,
  scheduleIdentity,
  transitionKey,
} from "./schedule-model.js";

const UNKNOWN_CODES: ReadonlySet<ScheduleCode> = new Set<ScheduleCode>([
  "SCHEDULE_AGGREGATE_UNLANDED",
  "SCHEDULE_EVIDENCE_ABSENT",
]);

type Detail = readonly [ScheduleCode, string];

interface ScheduleView {
  readonly definition: ScheduleDefinition;
  readonly form: CanonicalScheduleForm;
  readonly identity: string;
}

interface UniverseIndex {
  readonly boundaries: ReadonlySet<string>;
  readonly known: ReadonlySet<string>;
  readonly landed: ReadonlySet<string>;
  readonly pairKeys: ReadonlySet<string>;
  readonly transitionKeys: ReadonlySet<string>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function dedupe<T>(items: readonly T[], key: (item: T) => string): readonly T[] {
  const byKey = new Map<string, T>();
  for (const item of items) {
    byKey.set(key(item), item);
  }
  return [...byKey.entries()]
    .sort((left, right) => compareText(left[0], right[0]))
    .map(([, item]) => item);
}

/** Mechanical universe generation: authors consume these sets and can never shrink them. */
export function deriveScheduleUniverse(
  input: Pick<ScheduleCoverageInput, "faultBoundaries" | "transitionTables">,
): DerivedScheduleUniverse {
  const transitions: TransitionRef[] = [];
  const racePairs: RacePairRef[] = [];
  for (const table of input.transitionTables) {
    const commandsByState = new Map<string, Set<string>>();
    for (const edge of table.edges) {
      const { commandKind, fromState, toState } = edge;
      transitions.push({ aggregate: table.aggregate, commandKind, fromState, toState });
      const commands = commandsByState.get(fromState) ?? new Set<string>();
      commandsByState.set(fromState, commands.add(commandKind));
    }
    for (const [fromState, commandSet] of commandsByState) {
      const commands = [...commandSet].sort(compareText);
      commands.forEach((first, index) => {
        for (const second of commands.slice(index + 1)) {
          racePairs.push({ aggregate: table.aggregate, commandKinds: [first, second], fromState });
        }
      });
    }
  }
  return {
    faultBoundaries: [...new Set(input.faultBoundaries)].sort(compareText),
    racePairs: dedupe(racePairs, racePairKey),
    transitions: dedupe(transitions, transitionKey),
  };
}

function indexUniverse(
  input: ScheduleCoverageInput,
  universe: DerivedScheduleUniverse,
): UniverseIndex {
  return {
    boundaries: new Set(universe.faultBoundaries),
    known: new Set(input.knownAggregates),
    landed: new Set(input.transitionTables.map((table) => table.aggregate)),
    pairKeys: new Set(universe.racePairs.map(racePairKey)),
    transitionKeys: new Set(universe.transitions.map(transitionKey)),
  };
}

/** An unknown aggregate FAILs; a known-but-unlanded one is an auditable UNKNOWN. */
function classifyRef(
  index: UniverseIndex,
  scheduleId: string,
  aggregate: string,
  key: string,
  reachable: boolean,
): Detail | null {
  if (!index.known.has(aggregate)) {
    return ["SCHEDULE_TRANSITION_UNREACHABLE", `${scheduleId}: unknown aggregate in ${key}`];
  }
  if (!index.landed.has(aggregate)) {
    return ["SCHEDULE_AGGREGATE_UNLANDED", `${scheduleId}: aggregate ${aggregate} has no landed transition table (${key})`];
  }
  return reachable
    ? null
    : ["SCHEDULE_TRANSITION_UNREACHABLE", `${scheduleId}: ${key} is outside the derived universe`];
}

function refDetails(view: ScheduleView, index: UniverseIndex): readonly Detail[] {
  const scheduleId = view.definition.scheduleId;
  const transitions = view.form.transitionRefs.map((ref) =>
    classifyRef(index, scheduleId, ref.aggregate, transitionKey(ref),
      index.transitionKeys.has(transitionKey(ref))));
  const pairs = view.form.racePairRefs.map((ref) =>
    classifyRef(index, scheduleId, ref.aggregate, racePairKey(ref),
      index.pairKeys.has(racePairKey(ref))));
  const boundaries = view.form.faultBoundaryRefs
    .filter((boundary) => !index.boundaries.has(boundary))
    .map((boundary): Detail =>
      ["SCHEDULE_FAULT_BOUNDARY_UNREGISTERED", `${scheduleId}: unregistered fault boundary ${boundary}`]);
  return [...transitions, ...pairs].filter((entry): entry is Detail => entry !== null)
    .concat(boundaries);
}

/** Minima are vacuous for an unmapped obligation; that is reported as UNMAPPED alone. */
function minimaDetails(
  obligation: ScheduleObligation,
  mapped: readonly ScheduleView[],
): readonly Detail[] {
  if (mapped.length === 0) return [];
  const details: Detail[] = [];
  // A mandatory stratum applies whether or not the obligation declares it: an author
  // cannot dodge the frozen two-event minimum by trimming applicableStrata.
  const mandatory = Object.entries(SCHEDULE_STRATUM_MINIMA)
    .filter(([, minimum]) => minimum.applicability === "MANDATORY")
    .map(([stratum]) => stratum as ScheduleStratum);
  const required = [...new Set([...obligation.applicableStrata, ...mandatory])];
  for (const stratum of required.sort(compareText)) {
    const minimum = SCHEDULE_STRATUM_MINIMA[stratum];
    const matching = mapped.filter((view) => view.form.stratum === stratum);
    if (matching.length < minimum.minimumSchedules) {
      details.push(["SCHEDULE_STRATUM_MINIMUM_UNMET", `${obligation.obligationId}: ${matching.length} ${stratum} schedules, minimum ${minimum.minimumSchedules}`]);
      continue;
    }
    for (const view of matching) {
      const counted = [
        ["transitionRefs", view.form.transitionRefs.length, minimum.minimumTransitionRefs],
        ["racePairRefs", view.form.racePairRefs.length, minimum.minimumRacePairRefs],
        ["faultBoundaryRefs", view.form.faultBoundaryRefs.length, minimum.minimumFaultBoundaryRefs],
      ] as const;
      for (const [field, actual, required] of counted.filter(([, a, r]) => a < r)) {
        details.push(["SCHEDULE_STRATUM_MINIMUM_UNMET", `${view.definition.scheduleId}: ${actual} ${field} in ${stratum}, minimum ${required}`]);
      }
    }
  }
  return details;
}

function verdictFor(codes: ReadonlySet<ScheduleCode>): ScheduleVerdict {
  for (const code of codes) {
    if (!UNKNOWN_CODES.has(code)) return "FAIL";
  }
  return codes.size === 0 ? "PASS" : "UNKNOWN";
}

function findingsFrom(details: readonly Detail[], obligationId: string | null): ScheduleFinding[] {
  return details.map(([code, detail]) => ({
    code,
    detail,
    obligationId,
    verdict: UNKNOWN_CODES.has(code) ? ("UNKNOWN" as const) : ("FAIL" as const),
  }));
}

function evaluateObligation(
  obligation: ScheduleObligation,
  views: readonly ScheduleView[],
  duplicates: ReadonlySet<string>,
  evidence: ReadonlyMap<string, readonly string[]>,
  index: UniverseIndex,
): { readonly coverage: ObligationCoverage; readonly findings: readonly ScheduleFinding[] } {
  const mapped = views.filter((view) =>
    view.definition.obligationRefs.includes(obligation.obligationId));
  const details: Detail[] = mapped.length === 0
    ? [["SCHEDULE_OBLIGATION_UNMAPPED", `${obligation.obligationId}: no mapped schedule`]]
    : [];
  const reachable: TransitionRef[] = [];
  const evidenceRefs: string[] = [];
  for (const view of mapped) {
    details.push(...refDetails(view, index));
    if (duplicates.has(view.identity)) {
      details.push(["SCHEDULE_IDENTITY_DUPLICATE", `${view.definition.scheduleId}: shares canonical identity ${view.identity}`]);
    }
    const hits = evidence.get(view.identity) ?? [];
    if (hits.length === 0) {
      details.push(["SCHEDULE_EVIDENCE_ABSENT", `${view.definition.scheduleId}: no recorded hit evidence`]);
    }
    evidenceRefs.push(...hits);
    reachable.push(...view.form.transitionRefs.filter((ref) =>
      index.transitionKeys.has(transitionKey(ref))));
  }
  details.push(...minimaDetails(obligation, mapped));
  const uniqueEvidence = [...new Set(evidenceRefs)].sort(compareText);
  const reachableRefs = dedupe(reachable, transitionKey);
  const codes = new Set(details.map(([code]) => code));
  if (verdictFor(codes) === "PASS" && (uniqueEvidence.length === 0 || reachableRefs.length === 0)) {
    details.push(["SCHEDULE_EVIDENCE_ABSENT", `${obligation.obligationId}: no reachable or hit-evidence reference`]);
    codes.add("SCHEDULE_EVIDENCE_ABSENT");
  }
  return {
    coverage: {
      evidenceRefs: uniqueEvidence,
      kind: obligation.kind,
      obligationId: obligation.obligationId,
      reachableTransitionRefs: reachableRefs,
      reasonCodes: [...codes].sort(compareText),
      scheduleIdentities: [...new Set(mapped.map((view) => view.identity))].sort(compareText),
      strata: [...new Set(mapped.map((view) => view.form.stratum))].sort(compareText),
      verdict: verdictFor(codes),
    },
    findings: findingsFrom(details, obligation.obligationId),
  };
}

/** Reverse completeness plus universe-wide defects that belong to no single obligation. */
function globalFindings(
  views: readonly ScheduleView[],
  input: ScheduleCoverageInput,
  universe: DerivedScheduleUniverse,
  duplicates: ReadonlySet<string>,
): readonly ScheduleFinding[] {
  const claimed = {
    boundaries: new Set(views.flatMap((view) => [...view.form.faultBoundaryRefs])),
    pairs: new Set(views.flatMap((view) => view.form.racePairRefs.map(racePairKey))),
    transitions: new Set(views.flatMap((view) => view.form.transitionRefs.map(transitionKey))),
  };
  const registered = new Set(input.obligations.map((obligation) => obligation.obligationId));
  const details: Detail[] = [
    ...[...duplicates].sort(compareText).map((identity): Detail =>
      ["SCHEDULE_IDENTITY_DUPLICATE", `canonical identity ${identity} is shared by more than one schedule`]),
    ...universe.transitions.filter((ref) => !claimed.transitions.has(transitionKey(ref)))
      .map((ref): Detail =>
        ["SCHEDULE_UNIVERSE_UNCOVERED", `transition ${transitionKey(ref)} is claimed by no schedule`]),
    ...universe.racePairs.filter((ref) => !claimed.pairs.has(racePairKey(ref)))
      .map((ref): Detail =>
        ["SCHEDULE_UNIVERSE_UNCOVERED", `race pair ${racePairKey(ref)} is claimed by no schedule`]),
    ...universe.faultBoundaries.filter((boundary) => !claimed.boundaries.has(boundary))
      .map((boundary): Detail =>
        ["SCHEDULE_UNIVERSE_UNCOVERED", `fault boundary ${boundary} is claimed by no schedule`]),
    ...views.flatMap((view) =>
      view.definition.obligationRefs.filter((ref) => !registered.has(ref)).map((ref): Detail =>
        ["SCHEDULE_OBLIGATION_UNMAPPED", `${view.definition.scheduleId}: cites unregistered obligation ${ref}`])),
    // A schedule citing no obligation would still claim universe items, quietly satisfying
    // reverse completeness while no obligation exercises them.
    ...views.filter((view) => view.definition.obligationRefs.length === 0).map((view): Detail =>
      ["SCHEDULE_OBLIGATION_UNMAPPED", `${view.definition.scheduleId}: cites no obligation`]),
  ];
  return findingsFrom(details, null);
}

function manifestVerdict(
  findings: readonly ScheduleFinding[],
  obligations: readonly ObligationCoverage[],
): ScheduleVerdict {
  if (findings.some((finding) => finding.verdict === "FAIL")) return "FAIL";
  if (findings.length > 0 || obligations.some((entry) => entry.verdict !== "PASS")) return "UNKNOWN";
  return obligations.length === 0 ? "UNKNOWN" : "PASS";
}

/** Headless coverage checker: a complete manifest or a fail-closed verdict, never silence. */
export function checkScheduleCoverage(input: ScheduleCoverageInput): ScheduleCoverageManifest {
  const universe = deriveScheduleUniverse(input);
  const index = indexUniverse(input, universe);
  const views: readonly ScheduleView[] = input.universe
    .map((definition) => ({
      definition,
      form: canonicalScheduleForm(definition),
      identity: scheduleIdentity(definition),
    }))
    .sort((left, right) => compareText(left.identity, right.identity)
      || compareText(left.definition.scheduleId, right.definition.scheduleId));
  const counts = new Map<string, number>();
  const evidence = new Map<string, readonly string[]>();
  for (const view of views) {
    counts.set(view.identity, (counts.get(view.identity) ?? 0) + 1);
  }
  for (const hit of input.hitEvidence) {
    // A blank reference is not evidence; it must never buy an obligation a PASS.
    if (hit.evidenceRef.trim().length === 0) continue;
    const held = evidence.get(hit.scheduleIdentity) ?? [];
    evidence.set(hit.scheduleIdentity, [...held, hit.evidenceRef]);
  }
  const duplicates = new Set([...counts].filter(([, count]) => count > 1).map(([identity]) => identity));
  const evaluated = [...input.obligations]
    .sort((left, right) => compareText(left.obligationId, right.obligationId))
    .map((obligation) => evaluateObligation(obligation, views, duplicates, evidence, index));
  const findings = [
    ...evaluated.flatMap((entry) => entry.findings),
    ...globalFindings(views, input, universe, duplicates),
  ].sort((left, right) => compareText(left.code, right.code)
    || compareText(left.obligationId ?? "", right.obligationId ?? "")
    || compareText(left.detail, right.detail));
  const obligations = evaluated.map((entry) => entry.coverage);
  const body = {
    canonicalFormVersion: SCHEDULE_CANONICAL_FORM_VERSION,
    findings,
    manifestVersion: SCHEDULE_COVERAGE_MANIFEST_VERSION,
    obligations,
    provenance: {
      classification: "DEVELOPMENT_ONLY_ENGINEERING_EVIDENCE" as const,
      confirmatory: false as const,
    },
    releaseBar: {
      floor: RELEASE_SCHEDULE_FLOOR,
      observedUniqueSchedules: counts.size,
      status: "UNKNOWN" as const,
    },
    schedules: views.map((view) => ({
      identity: view.identity,
      obligationRefs: [...view.definition.obligationRefs].sort(compareText),
      scheduleId: view.definition.scheduleId,
      stratum: view.form.stratum,
    })),
    strataMinima: SCHEDULE_STRATUM_MINIMA,
    strataMinimaVersion: SCHEDULE_STRATUM_MINIMA_VERSION,
    universe,
    verdict: manifestVerdict(findings, obligations),
  };
  return deepFreeze({
    ...body,
    digest: createHash("sha256").update(canonicalize(body), "utf8").digest("hex"),
  });
}
