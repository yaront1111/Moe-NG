/**
 * THE PRD THIS EPIC'S FINAL ROW PROVES THE LOOP ON, and the small amount of wire shape the
 * drive needs beside it.
 *
 * PROVENANCE, because it decides whether the proof is worth anything. The PRD text below is
 * the one recorded VERBATIM on task-161b7e9d as comment-5657f450 at 2026-09-09T10:03:36Z,
 * BEFORE this session read a single line of the product pipeline. The row's description makes
 * the PRD a human input; the governor unblock of 2026-09-09T09:07Z waived that and directed
 * the worker to author one under three constraints -- written before inspecting the pipeline,
 * not tuned to what already works, recorded verbatim with a timestamp first. All three were
 * met, and this module is a TRANSCRIPTION of that comment, not a fresh draft. Editing the
 * criteria here to make a run go green would retroactively break constraint (2), so the
 * `PRD_TEXT` bytes are load-bearing: `PRD_SHA256` is what the goal binds and what the contract
 * revision cites.
 *
 * WHY THE CRITERIA ARE SHAPED LIKE THIS. A2, A5 and A6 are the three a lazy PRD leaves out,
 * and they are the reason this one is worth running: A2 pins a refusal's TEXT (not merely that
 * it refused), A5 pins the constraint at the DATABASE rather than the application, and A6 pins
 * a stable error code on a malformed input. They were chosen cold.
 */

/** The product the drive bootstraps. Directory-safe, and not a name any lane fixture uses. */
export const PRODUCT_NAME = "standup-live-proof";

/**
 * The PRD, byte for byte as recorded in comment-5657f450. Trailing newline included: the goal
 * binding records `byteLength` and `contentSha256`, so any whitespace edit here moves both.
 */
export const PRD_TEXT = [
  "# Standup",
  "",
  "A shared daily-standup log for a small team.",
  "",
  "## Problem",
  "",
  "A six-person distributed team posts standups in chat, where they scroll away. Nobody can",
  "answer \"what did Dana say she was blocked on last Tuesday?\" without scrolling back through a",
  "week of unrelated messages. They want a durable record, addressable by day.",
  "",
  "## Screens",
  "",
  "1. SIGN IN. Email and password. There is no sign-up screen in v1; accounts are seeded.",
  "2. TODAY. The current day's entries from everyone, newest first, with a composer that",
  "   UPDATES the signed-in user's entry rather than adding a second one.",
  "3. HISTORY. Pick a date, see that day's entries, read-only.",
  "",
  "## Data",
  "",
  "Exactly one PostgreSQL table, standup_entry, with UNIQUE (author_email, entry_date)",
  "enforced as a database constraint and not only as an application check.",
  "",
  "## API",
  "",
  "One REST resource, /api/entries: GET ?date=YYYY-MM-DD reads a day, PUT upserts the",
  "signed-in user's entry for today. Both require a session.",
  "",
  "## Out of scope for v1",
  "",
  "Sign-up, password reset, editing another person's entry, deleting entries, notifications,",
  "a mobile layout, and any timezone other than UTC.",
  "",
].join("\n");

/** One requirement per screen plus the two the data and API sections state. */
export const REQUIREMENTS: readonly { readonly id: string; readonly statement: string }[] =
  Object.freeze([
    { id: "req-1-signin", statement: "A team member signs in with an email and a password." },
    { id: "req-2-today", statement: "A signed-in member reads today's entries and writes their own, which updates in place." },
    { id: "req-3-history", statement: "A member picks a past date and reads that day's entries." },
    { id: "req-4-onerow", statement: "One member has at most one entry per day, enforced by the database." },
    { id: "req-5-api", statement: "The /api/entries resource reads a day and upserts today's entry, and requires a session." },
  ]);

/**
 * The eight acceptance criteria, verbatim from the comment. The `requirementId` mapping is the
 * only thing added here, because the contract wire needs each criterion parented.
 */
export const CRITERIA: readonly {
  readonly id: string; readonly requirementId: string; readonly statement: string;
}[] = Object.freeze([
  { id: "crit-a1", requirementId: "req-1-signin", statement: "A1. Signing in with seeded valid credentials reaches TODAY." },
  { id: "crit-a2", requirementId: "req-1-signin", statement: "A2. Signing in with a wrong password stays on SIGN IN and shows an error whose text is IDENTICAL to the error for an unknown email." },
  { id: "crit-a3", requirementId: "req-5-api", statement: "A3. An unauthenticated GET /api/entries returns 401. It must not return an empty list." },
  { id: "crit-a4", requirementId: "req-2-today", statement: "A4. PUT /api/entries twice in one day for one user leaves exactly ONE row, and the second body wins." },
  { id: "crit-a5", requirementId: "req-4-onerow", statement: "A5. The uniqueness in A4 holds AT THE DATABASE LEVEL: a direct second INSERT bypassing the API is rejected by the constraint." },
  { id: "crit-a6", requirementId: "req-5-api", statement: "A6. GET /api/entries?date=not-a-date returns 400 with a stable error code, not a 500 and not a silent fallback to today." },
  { id: "crit-a7", requirementId: "req-3-history", statement: "A7. HISTORY for a date with no entries renders an explicit empty state, not a blank screen and not a permanent spinner." },
  { id: "crit-a8", requirementId: "req-2-today", statement: "A8. blockers is optional: an entry saved with blockers empty round-trips and renders without a Blockers heading." },
]);

/**
 * THE CLARIFICATION, and why it is a real one rather than a prop.
 *
 * The PRD comment lists three questions it deliberately left open, and says plainly that
 * manufacturing a fake ambiguity for Gate 1 to "find" would be exactly the circularity the
 * governor's constraint (2) forbids. This is the first of those three, asked in the PRD's own
 * words. Its two options are genuinely different products: seeding by migration makes the
 * account list a schema artefact, seeding by an operator command makes it an operations act.
 */
export const CLARIFICATION_QUESTION =
  "The PRD says accounts are seeded but does not say HOW. Which is it?";

/**
 * Each option carries the CONTRACT IT WOULD PRODUCE, and core refuses the question unless the
 * two projections digest differently (`product-contract-materiality.ts:126` ->
 * PRODUCT_CONTRACT_CLARIFICATION_IMMATERIAL). That fence is why this is a real question and not
 * a prop: a clarification whose answers converge on the same contract cannot be asked at all.
 * The two futures genuinely differ -- under `opt-migration` the account list is a schema
 * artefact verified by running the migration, under `opt-operator` it is an operations act
 * verified after deploy.
 */
const seedRequirement = (statement: string): readonly Readonly<Record<string, unknown>>[] =>
  Object.freeze([...REQUIREMENTS.map((row) => ({
    requirementId: row.id, statement: row.statement, supersedesRequirementId: null,
  })), { requirementId: "req-seed", statement, supersedesRequirementId: null }]);

const seedCriterion = (statement: string): readonly Readonly<Record<string, unknown>>[] =>
  Object.freeze([...CRITERIA.map((row) => ({
    criterionId: row.id, requirementId: row.requirementId, statement: row.statement,
    supersedesCriterionId: null,
  })), {
    criterionId: "crit-seed", requirementId: "req-seed", statement,
    supersedesCriterionId: null,
  }]);

export const CLARIFICATION_OPTIONS: readonly Readonly<Record<string, unknown>>[] = Object.freeze([
  {
    label: "Seeded by the same migration that creates standup_entry.",
    optionId: "opt-migration",
    projection: {
      criteria: seedCriterion("Running the migration on an empty database leaves the seeded accounts present."),
      requirements: seedRequirement("The migration that creates standup_entry also inserts the seeded accounts."),
    },
  },
  {
    label: "Seeded by an operator command run after deploy.",
    optionId: "opt-operator",
    projection: {
      criteria: seedCriterion("After deploy, the operator seed command creates the accounts and is safe to run twice."),
      requirements: seedRequirement("An operator command run after deploy inserts the seeded accounts."),
    },
  },
]);
