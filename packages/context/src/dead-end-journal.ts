import {
  JOURNAL_VERSION,
  MAX_JOURNAL_ENTRY_COUNT,
  MAX_JOURNAL_TEXT_CHARACTERS,
  type FactPredicate,
} from "./context-contract.js";
import {
  canonicalSha256,
  compareCodeUnits,
  deepFreeze,
} from "./canonical-digest.js";

export const DEAD_END_KINDS = Object.freeze([
  "REJECTED_HYPOTHESIS",
  "FAILED_APPROACH",
  "VERIFICATION_FAILURE",
  "TOOLING_FAILURE",
  "ENVIRONMENT_BLOCKER",
  "INVALIDATED_ASSUMPTION",
  "PARTIAL_RESULT",
] as const);

export type DeadEndKind = (typeof DEAD_END_KINDS)[number];

export interface DeadEndJournalEntry {
  readonly id: string;
  readonly kind: DeadEndKind;
  readonly failureCode: string;
  readonly primaryScope: string;
  readonly recipeDigest: string;
  readonly baseDigest: string;
  readonly environmentDigest: string;
  readonly retryPredicate: FactPredicate;
  readonly text: string;
  readonly actorId: string;
  readonly occurredAt: `${string}Z`;
}

export interface DeadEndJournal {
  readonly version: typeof JOURNAL_VERSION;
  readonly entries: readonly DeadEndJournalEntry[];
  readonly digest: string;
}

export type JournalAdmissionResult =
  | Readonly<{ kind: "ADMITTED"; journal: DeadEndJournal }>
  | Readonly<{
      kind: "REFUSED";
      code: "JOURNAL_LIMIT_REACHED";
      layer: "DEAD_END_JOURNAL";
      limit: "ENTRY_COUNT" | "TEXT_CHARACTERS";
      actual: number;
      maximum: number;
    }>;

export type RetryUnlockResult =
  | Readonly<{ kind: "UNLOCKED"; predicate: FactPredicate }>
  | Readonly<{
      kind: "REFUSED";
      code: "RETRY_PREDICATE_UNCHANGED";
      layer: "RETRY_PREDICATE";
    }>;

function clonePredicate(predicate: FactPredicate): FactPredicate {
  switch (predicate.kind) {
    case "FACT_VALUE":
      return { ...predicate };
    case "FACT_VERSION":
      return { ...predicate };
    case "FACT_DIGEST":
      return { ...predicate };
  }
}

function cloneEntry(entry: DeadEndJournalEntry): DeadEndJournalEntry {
  return {
    ...entry,
    retryPredicate: clonePredicate(entry.retryPredicate),
  };
}

function compareEntries(
  left: DeadEndJournalEntry,
  right: DeadEndJournalEntry,
): number {
  const timeOrder = compareCodeUnits(left.occurredAt, right.occurredAt);
  if (timeOrder !== 0) return timeOrder;
  const idOrder = compareCodeUnits(left.id, right.id);
  if (idOrder !== 0) return idOrder;
  return compareCodeUnits(canonicalSha256(left), canonicalSha256(right));
}

function journalRefusal(
  limit: "ENTRY_COUNT" | "TEXT_CHARACTERS",
  actual: number,
  maximum: number,
): JournalAdmissionResult {
  return deepFreeze({
    kind: "REFUSED",
    code: "JOURNAL_LIMIT_REACHED",
    layer: "DEAD_END_JOURNAL",
    limit,
    actual,
    maximum,
  });
}

export function createDeadEndJournal(
  sourceEntries: readonly DeadEndJournalEntry[],
): JournalAdmissionResult {
  if (sourceEntries.length > MAX_JOURNAL_ENTRY_COUNT) {
    return journalRefusal(
      "ENTRY_COUNT",
      sourceEntries.length,
      MAX_JOURNAL_ENTRY_COUNT,
    );
  }
  const textCharacters = sourceEntries.reduce(
    (total, entry) => total + entry.text.length,
    0,
  );
  if (textCharacters > MAX_JOURNAL_TEXT_CHARACTERS) {
    return journalRefusal(
      "TEXT_CHARACTERS",
      textCharacters,
      MAX_JOURNAL_TEXT_CHARACTERS,
    );
  }
  const entries = sourceEntries.map(cloneEntry).sort(compareEntries);
  const content = { version: JOURNAL_VERSION, entries } as const;
  const journal = { ...content, digest: canonicalSha256(content) };
  return deepFreeze({ kind: "ADMITTED", journal });
}

export function evaluateRetryUnlock(
  previous: DeadEndJournalEntry,
  candidate: FactPredicate,
): RetryUnlockResult {
  if (canonicalSha256(previous.retryPredicate) === canonicalSha256(candidate)) {
    return deepFreeze({
      kind: "REFUSED",
      code: "RETRY_PREDICATE_UNCHANGED",
      layer: "RETRY_PREDICATE",
    });
  }
  return deepFreeze({ kind: "UNLOCKED", predicate: clonePredicate(candidate) });
}
