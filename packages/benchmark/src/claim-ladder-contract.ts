/**
 * Verbatim transcription of Section 1 in the pinned benchmark claim specification.
 *
 * The SHA below, not the transcriber, is the authority. If the source bytes no longer
 * match it, every constant in this module is invalid until deliberately re-transcribed.
 */

export const PINNED_SPEC_SHA256 =
  "a62b90436cc0b911fb28526af7b7e0f2d1370f6f93db91c26077f6e2956a589c";

const LAYER = "BENCHMARK_CLAIM_LADDER";

export type ClaimLadderLayer = typeof LAYER;
export type ClaimRungId = "L1" | "L2" | "L3" | "L4" | "L5";
export type ReachedRung = "L0" | ClaimRungId;
export type ClaimGateId = "G-L1" | "G-L2" | "G-L3" | "G-L4" | "G-L5";

export interface ClaimLadderEntry {
  readonly gateId: ClaimGateId;
  readonly rungId: ClaimRungId;
  readonly scopeSlots: readonly string[];
  readonly subGateIds: readonly string[];
  readonly template: string;
}

function rung(
  rungId: ClaimRungId,
  gateId: ClaimGateId,
  subGateIds: readonly string[],
  template: string,
  scopeSlots: readonly string[],
): ClaimLadderEntry {
  return Object.freeze({
    gateId,
    rungId,
    scopeSlots: Object.freeze([...scopeSlots]),
    subGateIds: Object.freeze([...subGateIds]),
    template,
  });
}

export const CLAIM_LADDER: readonly ClaimLadderEntry[] = Object.freeze([
  rung(
    "L1",
    "G-L1",
    [],
    "Moe v{ver} satisfies its stated correctness invariants (full CORE coverage manifest) "
      + "and its BENCH-S1–BENCH-S12 corpus oracles (as of {date}).",
    ["ver", "date"],
  ),
  rung(
    "L2",
    "G-L2",
    [],
    "Rebuilt Moe v{ver} is non-inferior on all {n} measured safety properties and strictly "
      + "safer on {K}, versus legacy Moe at {model} (as of {date}).",
    ["ver", "n", "K", "model", "date"],
  ),
  rung(
    "L3",
    "G-L3",
    ["G-L3-speed", "G-L3-budget", "G-L3-accept", "G-L3-cost"],
    "Moe's fan-out makes Moe complete decomposable-feature tasks {X}× faster than Moe "
      + "without fan-out (RMST_OFF/RMST_ON), 95% CI [{a}×,{b}×], at no acceptance-rate "
      + "cost and within the {Γ_cost} cost ceiling (BENCH-S2 corpus, as of {date}).",
    ["X", "a", "b", "Γ_cost", "date"],
  ),
  rung(
    "L4",
    "G-L4",
    [
      "G-L4-quality[m]",
      "G-L4-accept[m]",
      "G-L4-effort[m]",
      "G-J1",
      "G-overhead",
      "G-UI",
      "G-L4-userstudy",
    ],
    "For a solo developer delegating autonomous coding work under local constraints, "
      + "Moe v{ver} (at {effort} to match {comparator}) is no worse in reviewed quality "
      + "and requires fewer {endpoint} than {comparator} on decomposable work "
      + "(as of {date}, {corpus}).",
    ["ver", "effort", "comparator", "endpoint", "date", "corpus"],
  ),
  rung(
    "L5",
    "G-L5",
    [
      "G-L4-quality[m]",
      "G-L5-accept[m]",
      "G-L5-cost[m]",
      "G-L5-effort[m]",
    ],
    "As of {cohort freeze date}, on the {corpus version} corpus, for {target user}, "
      + "Moe v{ver} — re-run against each member at that member's matched model/effort "
      + "(tabulated) — is no worse than each of {named model-matched cohort at pinned versions} "
      + "on quality, acceptance, and cost, and leads on {≥1 superiority-gated dimension}, "
      + "on the tasks each member and Moe could both express.",
    [
      "cohort freeze date",
      "corpus version",
      "target user",
      "ver",
      "named model-matched cohort at pinned versions",
      "≥1 superiority-gated dimension",
    ],
  ),
]);

export const PERMANENTLY_FORBIDDEN = Object.freeze([
  "unscoped or undated superlatives",
  "any \"best\" lacking the four-part scope (date, corpus, target user, named cohort)",
  "production-ready for all users",
  "equals",
  "matching",
  "on par",
  "parity",
  "same as",
  "cheaper",
  "lower cost",
  "any number not linked to raw evidence",
  "any exact ratio across incompatible price bases",
  "safest",
  "more reliable",
  "higher quality",
  "production-ready",
] as const);
