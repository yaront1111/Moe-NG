/**
 * EVERY ROSTER THE PRE-FREEZE AUDIT COMPARES THE DOCUMENT AGAINST, TRANSCRIBED BY HAND.
 *
 * TRANSCRIBED, NEVER DERIVED, AND THAT IS THE ENTIRE POINT OF THIS FILE. A roster the
 * audit computed from the same scan it is checking cannot disagree with it: delete a gate
 * from the spec and both sides shrink together, the set comparison still passes, and the
 * audit reports a clean freeze over a document that lost a gate. These lists are typed
 * out from the pinned bytes so that they DISAGREE when the document moves. That is a
 * feature — a red here means the spec changed and the audit must be re-read, not that the
 * roster needs quietly bumping.
 *
 * MEASURED AT SPEC SHA-256 a62b9043…a589c (523 lines) AND DESIGN SHA-256 1d9d1ec9…83191.
 * Confirming those hashes is not ratifying the revisions; the audit checks the INTERNAL
 * consistency of exactly those bytes and claims nothing about their normativity.
 *
 * WHY THE ROSTERS AND THE CODES LIVE IN DIFFERENT FILES. The codes are a contract with
 * consumers and change only when the audit gains a new kind of repair. These rosters are
 * a snapshot of one revision of an external document and change whenever it does. Mixing
 * them would make a document revision look like a contract change.
 */

/** Section 1 ladder + Section 12 report block, distinct `G-*` IDs. Twenty, measured. */
export const FROZEN_GATE_IDS = Object.freeze([
  "G-J1", "G-L1", "G-L2", "G-L3", "G-L3-accept", "G-L3-budget", "G-L3-cost", "G-L3-speed",
  "G-L4", "G-L4-accept", "G-L4-effort", "G-L4-quality", "G-L4-userstudy", "G-L5",
  "G-L5-accept", "G-L5-cost", "G-L5-effort", "G-UI", "G-expand", "G-overhead",
] as const);

/**
 * Rung-summary IDs, which are the AND of their listed members and therefore never members
 * of their own inventory. Spec 12.1 item 2 names `G-L3`/`G-L4` as umbrella aliases;
 * `G-L5` is additionally a defined gate whose rule is the cohort intersection-union test,
 * and the Section 12 inventory line for L5 does not list it among its own members either.
 */
export const FROZEN_UMBRELLA_GATE_IDS = Object.freeze(["G-L3", "G-L4", "G-L5"] as const);

/** The one gate spec 12.1 item 2 declares out-of-ladder: reported, gates nothing. */
export const FROZEN_OUT_OF_LADDER_GATE_IDS = Object.freeze(["G-expand"] as const);

export const FROZEN_RUNG_IDS = Object.freeze(["L1", "L2", "L3", "L4", "L5"] as const);

/**
 * SIX, not five. Spec 12.1 item 2 enumerates them verbatim and `grep -oE "G-[A-Za-z0-9-]+\[m\]"`
 * over the pinned bytes returns exactly these. `G-L4-effort[m]` is easy to drop from a
 * hand list because it is the only one of the six that is a SUPERIORITY gate rather than
 * a non-inferiority gate, so it never appears in tail-direction discussions.
 *
 * Stored WITHOUT the `[m]` suffix: the suffix is the member index, not part of the ID.
 */
export const FROZEN_COMPARATOR_GATE_IDS = Object.freeze([
  "G-L4-accept", "G-L4-effort", "G-L4-quality", "G-L5-accept", "G-L5-cost", "G-L5-effort",
] as const);

/**
 * How many distinct members each token family has AT ITS DEFINITION SITE. The two CORE
 * families are defined in the DESIGN, not in the benchmark: the benchmark writes them only
 * as ranges (`CORE-I1…CORE-I22`) and says at spec:64 that it "consumes those artifacts;
 * it never redefines them". Measured: the benchmark contains 2 distinct CORE-I and 2
 * distinct CORE-S literal tokens, the design contains 22 and 14.
 *
 * These numbers are what makes the family sweeps FALSIFIABLE. A sweep that ran over the
 * two literal endpoint tokens would iterate, generate cases, and pass while proving
 * nothing; asserting the count is what detects a range that was never expanded.
 */
export const FROZEN_REFERENCE_CARDINALITY = Object.freeze({
  "BENCH-S": 14, "CORE-I": 22, "CORE-S": 14,
} as const);

export type FrozenReferenceFamily = keyof typeof FROZEN_REFERENCE_CARDINALITY;

/**
 * The CUMULATIVE rung→gate inventory, transcribed from the Section 12 report block at
 * spec:400-404 with `(L3 gates)` / `(L4 gates)` back-references expanded by hand and the
 * umbrella aliases removed. Cumulative because spec:81 states a rung prints PASS only
 * when every gate "at it and below" is PASS, so L2's inventory genuinely contains L1's.
 *
 * The audit compares BOTH parsed sides against this: the closure of the Section 1 ladder
 * rows and the Section 12 inventory lines. Three-way agreement is what a two-way
 * document-against-itself comparison cannot give.
 */
export const FROZEN_RUNG_GATE_INVENTORY = Object.freeze({
  L1: Object.freeze(["G-L1"] as const),
  L2: Object.freeze(["G-L1", "G-L2"] as const),
  L3: Object.freeze([
    "G-L1", "G-L2", "G-L3-speed", "G-L3-budget", "G-L3-accept", "G-L3-cost",
  ] as const),
  L4: Object.freeze([
    "G-L1", "G-L2", "G-L3-speed", "G-L3-budget", "G-L3-accept", "G-L3-cost",
    "G-L4-quality", "G-L4-accept", "G-L4-effort", "G-J1", "G-overhead", "G-UI",
    "G-L4-userstudy",
  ] as const),
  L5: Object.freeze([
    "G-L1", "G-L2", "G-L3-speed", "G-L3-budget", "G-L3-accept", "G-L3-cost",
    "G-L4-quality", "G-L4-accept", "G-L4-effort", "G-J1", "G-overhead", "G-UI",
    "G-L4-userstudy", "G-L5-accept", "G-L5-cost", "G-L5-effort",
  ] as const),
});

/**
 * Which Frozen-Constants-Table symbol each gate is entitled to resolve, transcribed from
 * the Section 12 GATE RESULTS block. Spec 12.1 item 4 forbids a gate consuming an inline
 * literal for a tunable threshold, so a gate reading a symbol that is not in the table is
 * CONSTANT_UNRESOLVED.
 *
 * THE FAN-OUT MARGIN TRAP IS PINNED HERE, and it is the reason this maps gate→symbol
 * rather than merely collecting a symbol set. `M_accept` and `M_accept_x` are BOTH valid
 * table symbols, so a set membership test cannot tell them apart — yet spec:88 says
 * acceptance non-inferiority against a comparator uses `M_accept_x`, "never the fan-out
 * `M_accept`". `G-L3-accept` is the fan-out ON/OFF gate and correctly takes `M_accept`;
 * the two comparator acceptance gates correctly take `M_accept_x`. Swapping them is
 * invisible to every check except this one.
 */
export const FROZEN_GATE_THRESHOLD_SYMBOLS = Object.freeze({
  "G-J1": Object.freeze([] as const),
  // `N_sched` is G-L1's floor, but the Section 1 ladder rule states it and the gate's
  // Section 12 report line does not. This roster carries what each gate's REPORT LINE must
  // name; the N_sched floor has its own dedicated arm, which also checks its governor.
  "G-L1": Object.freeze([] as const),
  "G-L2": Object.freeze(["δ_safety", "K"] as const),
  "G-L3-accept": Object.freeze(["M_accept"] as const),
  "G-L3-budget": Object.freeze(["B[s]"] as const),
  "G-L3-cost": Object.freeze(["Γ_cost"] as const),
  "G-L3-speed": Object.freeze(["Λ_speed", "τ"] as const),
  "G-L4-accept": Object.freeze(["M_accept_x"] as const),
  "G-L4-effort": Object.freeze(["ρ_stamp"] as const),
  // `rubric_weights` is load-bearing for this gate too, but the LINK is declared table-side
  // (spec:41 "Load-bearing for `G-L4-quality[m]`, hence frozen here") rather than named in
  // the gate's own rule. Listing it here would refuse the pinned document for a defect it
  // does not have, so this roster carries only what each gate's DEFINITION must name.
  "G-L4-quality": Object.freeze(["M2_quality", "β_blind"] as const),
  "G-L4-userstudy": Object.freeze([] as const),
  "G-L5": Object.freeze(["C_min"] as const),
  "G-L5-accept": Object.freeze(["M_accept_x"] as const),
  "G-L5-cost": Object.freeze(["M_cost"] as const),
  "G-L5-effort": Object.freeze([] as const),
  "G-UI": Object.freeze(["L_UI", "tol_conf", "tol_cov"] as const),
  "G-expand": Object.freeze(["L_expand"] as const),
  "G-overhead": Object.freeze([
    "overhead_frac", "overhead_floor_s", "α_test", "π_overhead",
  ] as const),
});

/**
 * Section 0 spans spec:20-56 and declares 38 distinct symbols across 36 table rows (two
 * rows carry a pair: `tol_conf, tol_cov` and `overhead_frac, overhead_floor_s`).
 *
 * A COUNT, NOT A NAME LIST, AND DELIBERATELY SO. The table is the DEFINITION side of a
 * definition/use check whose USE side is the gate roster above, so both sides are already
 * independently anchored. What a bare set-containment check cannot catch is a table that
 * silently LOST rows along with their consumers; the transcribed count catches exactly
 * that, without a second 38-line transcription that would rot on every revision.
 */
export const FROZEN_CONSTANT_SYMBOL_COUNT = 38;

/**
 * The Section 12 report block is plain ASCII and spells the Greek-named table symbols
 * out: `Gamma_cost` there is `Γ_cost` in Section 0. Without this map every Greek-named
 * threshold reads as CONSTANT_UNRESOLVED and the audit reports twelve defects that are
 * not there.
 */
export const FROZEN_SYMBOL_ASCII_ALIASES = Object.freeze({
  Gamma_cost: "Γ_cost",
  Lambda_speed: "Λ_speed",
  Phi_stamp: "Φ_stamp",
  Theta_overhead: "Θ_overhead",
  alpha_agree: "α_agree",
  alpha_test: "α_test",
  beta_blind: "β_blind",
  delta_safety: "δ_safety",
  iota_infra: "ι_infra",
  pi_overhead: "π_overhead",
  rho_stamp: "ρ_stamp",
  tau: "τ",
} as const);

export type NiEndpointDirection = "HIGHER_IS_BETTER" | "WORSE_IS_HIGHER";
export type NiTail = "LOWER" | "UPPER";

/**
 * THE HISTORICAL SIGN INVERSION, PINNED. Spec 12.1 item 6: a higher-is-better endpoint
 * (acceptance) bounds the LOWER CI tail, a worse-is-higher endpoint (cost, failure-rate,
 * overhead) bounds the UPPER tail, and "a gate whose tail does not match its endpoint
 * direction is a freeze-blocking defect (this is the check that would have caught the
 * acceptance-gate sign inversion)". That names a defect that actually happened.
 *
 * The ENDPOINT direction is the transcribed fact; the TAIL is what the audit re-reads out
 * of the document and compares. Bounding the upper tail of acceptance would only limit
 * how much BETTER Moe is, so it can never detect Moe being worse — the gate would read as
 * passing while measuring nothing. Seven gates, all seven non-inferiority: `G-L4-effort`,
 * `G-L5-effort` and `G-L3-speed` are superiority gates and are deliberately absent.
 */
export const FROZEN_NI_TAIL_DIRECTIONS: Readonly<
  Record<string, { readonly endpoint: NiEndpointDirection; readonly tail: NiTail }>
> = Object.freeze({
  "G-L2": Object.freeze({ endpoint: "WORSE_IS_HIGHER", tail: "UPPER" } as const),
  "G-L3-accept": Object.freeze({ endpoint: "HIGHER_IS_BETTER", tail: "LOWER" } as const),
  "G-L3-cost": Object.freeze({ endpoint: "WORSE_IS_HIGHER", tail: "UPPER" } as const),
  "G-L4-accept": Object.freeze({ endpoint: "HIGHER_IS_BETTER", tail: "LOWER" } as const),
  "G-L5-accept": Object.freeze({ endpoint: "HIGHER_IS_BETTER", tail: "LOWER" } as const),
  "G-L5-cost": Object.freeze({ endpoint: "WORSE_IS_HIGHER", tail: "UPPER" } as const),
  "G-overhead": Object.freeze({ endpoint: "WORSE_IS_HIGHER", tail: "UPPER" } as const),
});

/** Spec:43 — the benchmark's independent re-run floor for `G-L1`, and its governor. */
export const FROZEN_SCHEDULE_COVERAGE_FLOOR = 10_000;

/** Spec:51 — minimum executed model-matched COMPARABLE cohort for L5. */
export const FROZEN_COMPARABLE_COHORT_FLOOR = 4;
