/**
 * The Foundation Preview journey specification, transcribed BY HAND from the
 * pinned design before any implementation was read.
 *
 * Source (read-only, epic rail 1):
 *   D:/projexts/moes/docs/plans/2026-08-05-moe-rebuild-design.md
 *   SHA-256 1D9D1EC97D3F07247FBBC088045E0BA2FD6DA8307F10A9026C55106419383191
 *
 * Every constant below is a claim the DESIGN makes. Regenerating any of them
 * from the implementation would leave the canary asserting only that the system
 * does what it does, which is why the verbatim source line is carried next to
 * each one: a reviewer can diff the quote against the design without trusting
 * this file.
 *
 * Nothing here is a test double. This module holds expectations, not behaviour.
 */

/** Verbatim design text, kept so the transcription is auditable in place. */
export const DESIGN_QUOTES = Object.freeze({
  j1: "**J1 - small Tuesday bug.** After the one-time project bootstrap journey, one causal bug remains one worker node. Per-goal happy-path human actions are exactly: (1) `goal.create`, (2) exact plan/initial-graph approval, and (3) final acceptance of the verified/reviewed result. Graph canvas is unnecessary. The UI shows exact diff/receipts and total control-plane overhead.",
  j3: "**J3 - crash recovery.** Kill agent/runner/daemon at declared boundaries. Restart shows adopted, suspect, quarantined, and reconciliation records with truth chips. Healthy continuation is one safe action or an already-approved policy action; it creates a traceable continuation/binding, not edited history.",
  j4: "**J4 - rejection and re-plan.** Findings link evidence to required changes. Delta approval shows changed hashes and invalidated/carry-forward nodes. Three-round counter is visible and escalation is explicit. Old plans, attempts, receipts, and reviews remain readable.",
  exit: "Exit: Foundation Preview passes J1, J3, J4 and hostile-client/release-handoff incident fixtures on Windows+Claude. It is explicitly not yet the graph/fan-out or \u201Cbest tool\u201D release.",
  releaseHandoff:
    "`RELEASED` additionally requires a committed safe-release handoff;",
} as const);

/** The design line each quote was transcribed from. */
export const DESIGN_LINES = Object.freeze({
  j1: 1095,
  j3: 1099,
  j4: 1101,
  rejectionRouting: 1087,
  releaseHandoff: 337,
  exit: 1324,
} as const);

/**
 * The exit condition's set, in the order line 1324 names it.
 *
 * J2, J5 and J6 are deliberately absent: the design puts them in Phase 5 and
 * Phase 6 (lines 1097, 1103, 1105, 1330, 1336). Adding one here would widen the
 * cutover gate past what the design actually requires of Foundation Preview.
 */
export const FOUNDATION_EXIT_SET = Object.freeze([
  "J1",
  "J3",
  "J4",
  "hostile-client",
  "release-handoff",
] as const);
export type FoundationExitItem = (typeof FOUNDATION_EXIT_SET)[number];

/* ------------------------------------------------------------------ J1 --- */

/**
 * "Per-goal happy-path human actions are exactly: (1) ... (2) ... (3) ..."
 *
 * EXACTLY three. A journey needing a fourth has failed the design's claim; one
 * needing fewer has skipped an approval gate. These are design concepts, not
 * command identifiers — the journey test binds them to the real daemon command
 * ids and records the binding, so the count can never be satisfied by renaming.
 */
export const J1_HUMAN_ACTIONS = Object.freeze([
  "goal.create",
  "plan.initial-graph.approve",
  "result.final.accept",
] as const);
export const J1_EXACT_HUMAN_ACTION_COUNT = 3;

/** "one causal bug remains one worker node" */
export const J1_EXECUTION_BEARING_NODE_COUNT = 1;

/** "The UI shows exact diff/receipts and total control-plane overhead." */
export const J1_REQUIRED_SURFACES = Object.freeze([
  "exact-diff",
  "receipts",
  "control-plane-overhead",
] as const);

/** "Graph canvas is unnecessary." */
export const J1_GRAPH_CANVAS_REQUIRED = false;

/* ------------------------------------------------------------------ J3 --- */

/** "Kill agent/runner/daemon at declared boundaries." */
export const J3_KILL_TARGETS = Object.freeze(["agent", "runner", "daemon"] as const);

/**
 * "Restart shows adopted, suspect, quarantined, and reconciliation records with
 * truth chips."
 *
 * Asserted by SET EQUALITY, so an unexpected recovery outcome fails rather than
 * passing unnoticed alongside the expected ones.
 */
export const J3_RECOVERY_RECORD_KINDS = Object.freeze([
  "adopted",
  "suspect",
  "quarantined",
  "reconciliation",
] as const);

/** "Healthy continuation is one safe action or an already-approved policy action" */
export const J3_MAX_CONTINUATION_ACTIONS = 1;
export const J3_CONTINUATION_ACTION_KINDS = Object.freeze([
  "safe-action",
  "already-approved-policy-action",
] as const);

/**
 * "it creates a traceable continuation/binding, not edited history."
 *
 * The second half is the one most easily lost. The journey test compares
 * pre-crash records BYTE-FOR-BYTE after recovery; asserting only that a
 * continuation record appeared would pass over a rewritten history.
 */
export const J3_HISTORY_IS_APPEND_ONLY = true;

/* ------------------------------------------------------------------ J4 --- */

/** "Findings link evidence to required changes." */
export const J4_FINDING_REQUIRES_EVIDENCE_LINK = true;

/** "Delta approval shows changed hashes and invalidated/carry-forward nodes." */
export const J4_NODE_DISPOSITIONS = Object.freeze(["invalidated", "carry-forward"] as const);

/**
 * "Three-round counter is visible and escalation is explicit."
 *
 * Tested at the boundary: rounds 1 and 2 do NOT escalate, round 3 DOES. A test
 * that only checks round 3 would pass against an implementation that escalates
 * on every round.
 */
export const J4_ESCALATION_ROUND = 3;
export const J4_NON_ESCALATING_ROUNDS = Object.freeze([1, 2] as const);

/** "Old plans, attempts, receipts, and reviews remain readable." */
export const J4_RETAINED_RECORD_KINDS = Object.freeze([
  "plans",
  "attempts",
  "receipts",
  "reviews",
] as const);

/**
 * Design line 1087, the typed rejection routing J4's delta approval rests on.
 * A human acceptance decline must choose a typed category; ambiguous "back to
 * planning" is not available.
 */
export const J4_REJECTION_ROUTES = Object.freeze([
  "implementation-only:WORK_REVIEW->EXECUTION_READY",
  "plan-requirements-dependency:hold-WORK_REVIEW+open-successor-draft",
] as const);

/* --------------------------------------------------- hostile / handoff --- */

/**
 * The hostile-client sweep.
 *
 * The design names the fixture at line 1324 but does NOT enumerate its cases, so
 * this list comes from this task's own deliverable text and must not be
 * invented elsewhere. The journey test asserts the generated case count is
 * non-zero: a sweep that silently produces nothing would otherwise pass while
 * testing nothing (epic rail 6).
 */
export const HOSTILE_CLIENT_CASE_KINDS = Object.freeze([
  "oversized-body",
  "malformed-envelope",
  "replayed-command",
  "stale-cursor",
  "subscriber-mismatch",
  "forged-authentication",
  "absent-authentication",
  "free-form-session-text-state-change",
  "free-form-terminal-text-state-change",
] as const);

/**
 * Design line 337: `RELEASED` requires a COMMITTED safe-release handoff and
 * every effect/resource proven absent or released. Otherwise the honest outcome
 * is `UNKNOWN` — never a silent `RELEASED`.
 */
export const RELEASE_HANDOFF_TERMINALS = Object.freeze([
  "FAILED",
  "CANCELLED",
  "SUPERSEDED",
  "RELEASED",
  "UNKNOWN",
] as const);
export const RELEASE_REQUIRES_COMMITTED_HANDOFF = true;
