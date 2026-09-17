import { createHash } from "node:crypto";
import type { SqliteEventStore } from "@moe/store";

/**
 * Every decision governance took in the human's place, kept durably and enumerable.
 *
 * WHY A RECORD AND NOT JUST AN ANSWER. On UnAI 2026-09-16 a node re-derived the same finding on
 * rounds 1, 2, 4 and 5. Its blocker was never a missing opinion — the node had proposed an answer
 * WITH a rationale in round 2 and shipped it — it was this sentence in its own findings: "no
 * registry review is recorded". A node needs a decision it can CITE. Guidance that exists only as
 * prompt text answers the question for one round and vanishes; the round after it asks again.
 *
 * THE PRD DECIDES FIRST (owner, 2026-09-16: "our prd should be all the clues and if its not in
 * the prd governce decide"). So a record says WHICH of the two happened, and the distinction is
 * load-bearing rather than descriptive:
 *   - `PRD_CITED` — the approved product record already answered it. Governance did not decide
 *     anything; it located the answer and must name where (`citation`). This is the preferred
 *     outcome and grants the project no new authority it did not already approve.
 *   - `GOVERNANCE_DECIDED` — the product record is genuinely silent, so governance chose, and
 *     `rationale` carries why.
 * A `PRD_CITED` record with no citation is not a citation, and is refused below.
 *
 * THE BOUND COUNTS ATTEMPTS, NOT OPINIONS — and the distinction above is deliberately NOT the
 * one it uses. `spentOn` used to count `GOVERNANCE_DECIDED` rows only, on the reasoning that
 * locating an answer already in the PRD costs the project nothing. That is true of AUTHORITY and
 * false of everything the bound exists to protect: every funded attempt spends real tokens
 * against a real repository whether the answer was cited or decided. A governor that cites the
 * PRD each round would have funded attempt after attempt for ever at `maxDecisions: 1` — roughly
 * 21 of them before the absolute round ceiling stopped it — which is precisely the runaway the
 * bound was written to make impossible. So `fundedOn` counts DISTINCT REVIEW VERSIONS governance
 * recorded against: one funded attempt moves the review version by one, and decisions are
 * recorded only after the attempt was actually funded, so distinct versions IS the attempt count.
 *
 * NOTHING HERE HAS A PENDING STATE, AND THAT IS THE POINT (owner, 2026-09-16: "but it will not
 * stop and wait for answer"). There is no status a run can block on and no approval to collect.
 * A decision is recorded and immediately spent; the node continues in the same pass. A human who
 * disagrees later records a SUPERSEDING decision, which steers the rounds that come after it and
 * never rewinds the ones already taken. That is why `supersedes` names a prior decision instead
 * of a status field being mutated: the aggregate is append-only, so the whole chain of who
 * decided what, when, and what overrode it stays readable.
 *
 * IT IS BUILT TO BE LOOKED AT. The owner's stated direction is a surface where "each major
 * decision will be visible like building blocks and we can comment on them". So each record
 * carries a stable `decisionId` derived from what it is ABOUT (subject, review version, finding)
 * rather than from when it was written, and the aggregate is one append-only stream per project.
 * A later `GovernanceDecisionCommented` event can attach to a `decisionId` with no migration and
 * — per the same instruction — must not gate anything when it does.
 */

export const GOVERNANCE_DECISION_VERSION = "moe-governance-decision/1" as const;
const DECISION_EVENT = "GovernanceDecisionRecorded";

/** Where the answer came from. `PRD_CITED` is not a decision; only the other arm spends the bound. */
export const GOVERNANCE_BASES = Object.freeze(["PRD_CITED", "GOVERNANCE_DECIDED"] as const);

export type GovernanceBasis = (typeof GOVERNANCE_BASES)[number];

/** Bounds mirroring the guidance validator: a record that cannot be stored is not a record. */
export const GOVERNANCE_TEXT_MAX_LENGTH = 4000;

export interface GovernanceDecisionInput {
  /** What was decided, in the words the node will act on. */
  readonly answer: string;
  readonly basis: GovernanceBasis;
  /** Where the product record answers it. Required for PRD_CITED, null otherwise. */
  readonly citation: string | null;
  /** The criterion the question blocks, when the finding named one. */
  readonly criterionId: string | null;
  /** The finding that raised the question, by its stable id. */
  readonly findingId: string;
  /**
   * WHAT the finding was raised against, as `KIND:locator`. A rule id is not a question: the same
   * rule fires against many subjects, and `registry-obligation-cardinality` on two different
   * contracts is two different questions with two different answers. Without this in the id they
   * collapse into one block, the second answer is silently dropped as "already recorded", and the
   * owner's list shows one decision standing for a judgement never made about the other subject.
   */
  readonly findingSubject: string;
  /** The question itself, as the finding put it. */
  readonly question: string;
  /** Why this answer. Required when governance decided; may be empty when the PRD is cited. */
  readonly rationale: string;
  /** The review ledger version the decision was taken against. */
  readonly reviewVersion: number;
  /** The node under review. */
  readonly subjectRef: string;
  /** A prior decisionId this one overrides, or null for a first answer. */
  readonly supersedes: string | null;
}

export interface GovernanceDecisionRecord extends GovernanceDecisionInput {
  readonly decisionId: string;
  readonly version: typeof GOVERNANCE_DECISION_VERSION;
}

/**
 * NULL MEANS "COULD NOT READ", AND IT IS NEVER AN EMPTY HISTORY.
 *
 * Every read below answered `[]` on a store throw and on a row that would not decode, so an
 * unreadable ledger counted as ZERO funded attempts — the bound was then never reached and
 * governance funded another attempt, and another, each one spending a real model call and real
 * repository work. The comment on the read itself already stated the rule: "a list that silently
 * drops decisions would under-count the bound and show the owner a shorter history than actually
 * happened." Returning `[]` under-counted it maximally.
 */
export interface GovernanceDecisionLedger {
  /** Keeps the decision. False when it could not be kept, could not be read, or was malformed. */
  readonly record: (input: GovernanceDecisionInput) => boolean;
  /** Every decision recorded for this project, oldest first, or null if it cannot be read. */
  readonly all: () => readonly GovernanceDecisionRecord[] | null;
  /** Every decision recorded for one node, oldest first, or null if it cannot be read. */
  readonly forSubject: (subjectRef: string) => readonly GovernanceDecisionRecord[] | null;
  /**
   * How many attempts governance has FUNDED on this node — the quantity the policy bounds. It is
   * a count of distinct review versions, not of decision rows: one attempt may answer six
   * questions at once, and that is one attempt, not six.
   *
   * NULL when the ledger cannot be read. A caller must treat that as "the bound cannot be
   * proven unspent", never as zero: funding an attempt is authority, and unverifiable evidence
   * gains none.
   */
  readonly fundedOn: (subjectRef: string) => number | null;
}

type DecisionStore = Pick<SqliteEventStore, "commit" | "getAggregateVersion" | "readEvents">;

const RECORD_KEYS = [
  "answer", "basis", "citation", "criterionId", "decisionId", "findingId", "findingSubject",
  "question", "rationale", "reviewVersion", "subjectRef", "supersedes", "version",
];
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export const governanceAggregateId = (projectId: string): string =>
  `governance-decision/${sha256(projectId)}`;

/**
 * The id is derived from what the decision is ABOUT, never from when it was taken, so the same
 * question at the same review version is the same block in the UI rather than a second one, and
 * a re-record is detectable instead of silently doubling the list.
 *
 * "The same question" takes FOUR parts, and `findingSubject` is the one that was missing: a rule
 * id names the check, not the thing checked, so two subjects failing one rule are two questions.
 */
export function governanceDecisionId(input: {
  readonly findingId: string; readonly findingSubject: string;
  readonly reviewVersion: number; readonly subjectRef: string;
}): string {
  return sha256(JSON.stringify({
    findingId: input.findingId, findingSubject: input.findingSubject,
    reviewVersion: input.reviewVersion,
    subjectRef: input.subjectRef, version: GOVERNANCE_DECISION_VERSION,
  })).slice(0, 32);
}

const bounded = (value: string): boolean =>
  value.length <= GOVERNANCE_TEXT_MAX_LENGTH && value.isWellFormed();

const stated = (value: string): boolean => value.trim().length > 0 && bounded(value);

/**
 * A well-formed decision. The two arms carry different obligations on purpose: a cited PRD must
 * say WHERE, and a governance decision must say WHY. Neither may be waved through empty, because
 * an unsourced citation and an unreasoned decision are exactly the two things a reader of the
 * building-blocks list would need and could not recover afterwards.
 */
export function validGovernanceDecision(input: GovernanceDecisionInput): boolean {
  if (!GOVERNANCE_BASES.includes(input.basis)) return false;
  if (!stated(input.answer) || !stated(input.question) || !stated(input.subjectRef)) return false;
  if (!stated(input.findingId) || !stated(input.findingSubject)) return false;
  if (!Number.isSafeInteger(input.reviewVersion) || input.reviewVersion < 0) return false;
  if (input.criterionId !== null && !stated(input.criterionId)) return false;
  if (input.supersedes !== null && !stated(input.supersedes)) return false;
  if (input.basis === "PRD_CITED") return input.citation !== null && stated(input.citation);
  // Governance decided: the product record is silent, so nothing may be cited as if it were not.
  return input.citation === null && stated(input.rationale);
}

function recordOf(payload: Uint8Array): GovernanceDecisionRecord | null {
  try {
    const value: unknown = JSON.parse(decoder.decode(payload));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== RECORD_KEYS.join(",")) return null;
    if (record["version"] !== GOVERNANCE_DECISION_VERSION) return null;
    return record as unknown as GovernanceDecisionRecord;
  } catch { return null; }
}

export function createGovernanceDecisionLedger(
  store: DecisionStore,
  projectId: string,
): GovernanceDecisionLedger {
  const aggregateId = governanceAggregateId(projectId);
  const read = (): readonly GovernanceDecisionRecord[] | null => {
    try {
      const records: GovernanceDecisionRecord[] = [];
      for (const event of [...store.readEvents(aggregateId)]
        .sort((left, right) => left.aggregateSequence - right.aggregateSequence)) {
        if (event.eventType !== DECISION_EVENT) continue;
        const decision = recordOf(event.payload);
        // An unreadable row is not skipped past: a list that silently drops decisions would
        // under-count the bound and show the owner a shorter history than actually happened.
        // NULL, not []: an empty list is itself an under-count, and the maximal one.
        if (decision === null) return null;
        records.push(decision);
      }
      return Object.freeze(records);
    } catch {
      // The store could not answer. That is not a history, and it is certainly not an empty one.
      return null;
    }
  };
  return Object.freeze({
    record(input: GovernanceDecisionInput): boolean {
      if (!validGovernanceDecision(input)) return false;
      const decisionId = governanceDecisionId(input);
      try {
        // Same question, same review version, same node: already recorded, not a second block.
        // An unreadable ledger cannot answer that question, and a write that assumes "not
        // recorded" writes the block twice — so it refuses instead.
        const existing = read();
        if (existing === null) return false;
        if (existing.some((decision) => decision.decisionId === decisionId)) return true;
        const record: GovernanceDecisionRecord = Object.freeze({
          ...input, decisionId, version: GOVERNANCE_DECISION_VERSION,
        });
        const version = store.getAggregateVersion(aggregateId);
        const commandId = `gov-${decisionId}-${String(version)}`;
        store.commit({
          aggregateId,
          commandBytes: encoder.encode(JSON.stringify({ eventType: DECISION_EVENT })),
          commandId,
          committedAt: new Date().toISOString(),
          events: [{
            eventId: `${commandId}-e1`,
            eventType: DECISION_EVENT,
            payload: encoder.encode(JSON.stringify(record)),
          }],
          expectedVersion: version,
        });
        return true;
      } catch { return false; }
    },
    all(): readonly GovernanceDecisionRecord[] | null {
      return read();
    },
    forSubject(subjectRef: string): readonly GovernanceDecisionRecord[] | null {
      const decisions = read();
      return decisions === null
        ? null
        : Object.freeze(decisions.filter((decision) => decision.subjectRef === subjectRef));
    },
    fundedOn(subjectRef: string): number | null {
      const decisions = read();
      if (decisions === null) return null;
      return new Set(decisions
        .filter((decision) => decision.subjectRef === subjectRef)
        .map((decision) => decision.reviewVersion)).size;
    },
  });
}
