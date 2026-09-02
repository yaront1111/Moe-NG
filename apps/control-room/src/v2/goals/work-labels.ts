import type { SurfaceStep } from "../../live/live-board-feed.js";

/**
 * The board's TRANSLATION layer: the daemon's command vocabulary rendered in the
 * owner's words, and nothing more.
 *
 * This is a deliberate MIRROR of the closed set of kinds the daemon's affordance
 * surface emits as a step - the ten BOOTSTRAP_COMMAND_KINDS, session.open /
 * session.close / session.renew, and the daemon-local node.deliver. It is a
 * mirror rather than an import because the control room must never reach across
 * into apps/daemon; work-labels.test.ts pins it against @moe/contracts' own
 * RUNTIME_COMMAND_KINDS so the mirror cannot drift unnoticed.
 *
 * HONESTY: a kind that is NOT in the map is rendered raw, exactly as the daemon
 * spelled it, and marked unknown. No label is ever invented for a command this
 * module has not been told about, and no status, count or identity is derived
 * from anything but the frame's own fields.
 *
 * NO CATEGORIES. There is deliberately no group per kind ("Project setup",
 * "Policy", "Browser sessions"...): the daemon carries no such taxonomy, and a
 * UI-invented one next to real tokens invites the reader to take it as one. The
 * only grouping the daemon states is the kind's own prefix (project., goal.,
 * session.), and that is already on every card in the raw kind @ id line.
 */

export interface WorkKindLabel {
  readonly label: string;
  /**
   * True only where the daemon mints this command's TARGET aggregate fresh on
   * every read (goal.create, affordance-read.ts:209). The id on the card is the
   * daemon's own either way; the flag exists so the board can say why the id
   * moves between polls instead of letting one command read as many.
   */
  readonly identityPerRead?: true;
}

/** The 14 kinds the surface emits as a step. `review.submit` is an offer, never a step. */
export const WORK_KIND_LABELS: Readonly<Record<string, WorkKindLabel>> = Object.freeze({
  "approval.decide": Object.freeze({ label: "Decide the plan approval" }),
  "goal.close": Object.freeze({ label: "Close the goal" }),
  "goal.create": Object.freeze({ identityPerRead: true, label: "Create a goal" }),
  "node.deliver": Object.freeze({ label: "Deliver code for a node" }),
  "plan.propose": Object.freeze({ label: "Propose the plan" }),
  "policy.install": Object.freeze({ label: "Install the policy" }),
  "policy.validate": Object.freeze({ label: "Validate the policy" }),
  "project.activate": Object.freeze({ label: "Activate the project" }),
  "project.bind_repository": Object.freeze({ label: "Bind the repository" }),
  "project.register": Object.freeze({ label: "Register the project" }),
  "provider.probe": Object.freeze({ label: "Probe the model provider" }),
  "session.close": Object.freeze({ label: "End a browser session" }),
  "session.open": Object.freeze({ label: "Open a browser session" }),
  "session.renew": Object.freeze({ label: "Keep a browser session alive" }),
});

/**
 * The daemon's own prerequisite chain (COMMAND_PREREQUISITES,
 * apps/daemon/src/bootstrap/bootstrap-sequence.ts:18-34) flattened topologically,
 * with the session and node kinds after it. The surface iterates
 * BOOTSTRAP_COMMAND_KINDS in its own array order, which is alphabetical - so the
 * Committed column opens on "approval.decide" and ends on "provider.probe", the
 * reverse of the order the work actually happened in. Presentation only: no field
 * is altered, and an unknown kind is never given a place in the chain.
 */
export const CHAIN_ORDER: readonly string[] = Object.freeze([
  "project.register",
  "project.bind_repository",
  "provider.probe",
  "project.activate",
  "policy.install",
  "policy.validate",
  "goal.create",
  "plan.propose",
  "approval.decide",
  "goal.close",
  "session.open",
  "session.renew",
  "session.close",
  "node.deliver",
]);

/**
 * One prerequisite token the daemon reports that is not a command kind.
 * A token belongs here only when the daemon actually emits it.
 */
export const MISSING_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  // affordance-read.ts - three review rounds failed; the kernel refuses more until a human
  // records escalation.decide, which the Needs-you screen offers as "Allow more attempts".
  escalation: "a human's decision to allow more review attempts (Needs you)",
  // affordance-read.ts - a delivered node awaiting the daemon's verifier.
  verification: "the daemon's verification",
  // affordance-read.ts - the verifier's standing slices this project never installed; the
  // verifier refuses VERIFICATION_AUTHORITY_UNAVAILABLE until an operator installs them.
  "verifier-calibration":
    "the reviewer calibration slice (moe-reviewer-calibration/1) an operator installs with policy.install",
  "verifier-policy":
    "the host verifier policy slice (moe-verifier-policy/1) an operator installs with policy.install",
});

export interface KindReading {
  readonly label: string;
  readonly identityPerRead: boolean;
  readonly known: boolean;
}

/** The plain reading of a kind, or the raw kind itself when it is not mirrored. */
export function labelForKind(kind: string): KindReading {
  const entry = WORK_KIND_LABELS[kind];
  if (entry === undefined) {
    return Object.freeze({ identityPerRead: false, known: false, label: kind });
  }
  return Object.freeze({
    identityPerRead: entry.identityPerRead === true,
    known: true,
    label: entry.label,
  });
}

/** One missing[] token in words; anything unmirrored stays exactly as it arrived. */
export function labelForMissing(token: string): string {
  const phrase = MISSING_TOKENS[token];
  if (phrase !== undefined) return phrase;
  const entry = WORK_KIND_LABELS[token];
  return entry === undefined ? token : entry.label;
}

/** Position in the daemon's chain; an unknown kind sorts last, order untouched. */
export function chainRank(kind: string): number {
  const at = CHAIN_ORDER.indexOf(kind);
  return at === -1 ? CHAIN_ORDER.length : at;
}

export function isIdentityPerRead(kind: string): boolean {
  return WORK_KIND_LABELS[kind]?.identityPerRead === true;
}

/**
 * What makes this card THE SAME card across two polls. For a kind whose target
 * the daemon mints per read the identity is the kind alone, so a fresh id does
 * not read as a different piece of work; every other kind keeps the aggregate the
 * daemon named, so two open sessions stay two cards.
 */
export function cardIdentity(kind: string, aggregateId: string | null): string {
  if (isIdentityPerRead(kind)) return kind;
  return `${kind}@${aggregateId ?? "-"}`;
}

export interface ColumnMeaning {
  readonly key: string;
  readonly status: SurfaceStep["status"];
  readonly title: string;
  readonly meaning: string;
  readonly empty: string;
}

/**
 * The three columns, in the order the surface's own statuses read: what the
 * daemon offers now, what it is holding back, what it has already written down.
 * The raw status token stays on the column head; the title and the meaning are
 * the owner's words for it, not a fourth state.
 *
 * The READY meaning says exactly what the token says and no more. In
 * affordance-read.ts every READY row carries missing: [] and is not yet
 * recorded; it does NOT say the daemon would accept THIS kind as a command -
 * for a node.deliver row the offer the daemon pushes is review.submit. The
 * daemon's own offers live in frame.offers; this board does not read them, so
 * it must not paraphrase them.
 */
export const COLUMN_MEANINGS: readonly ColumnMeaning[] = Object.freeze([
  Object.freeze({
    empty: "Nothing is being offered right now.",
    key: "ready",
    meaning: "The daemon says this can happen now: nothing it needs is missing.",
    status: "READY" as const,
    title: "Offered now",
  }),
  Object.freeze({
    empty: "Nothing is waiting.",
    key: "blocked",
    meaning: "Not offered yet: something this command needs has not happened.",
    status: "BLOCKED" as const,
    title: "Waiting on something",
  }),
  Object.freeze({
    empty: "Nothing recorded yet.",
    key: "committed",
    meaning: "Already written into the daemon's own record.",
    status: "COMMITTED" as const,
    title: "Already recorded",
  }),
]);

export function columnFor(status: SurfaceStep["status"]): ColumnMeaning {
  const found = COLUMN_MEANINGS.find((column) => column.status === status);
  // The three statuses are the frame reader's own closed union, so this cannot
  // miss; the throw exists so a widened union fails loudly instead of guessing.
  if (found === undefined) throw new Error(`no column meaning for status ${status}`);
  return found;
}
