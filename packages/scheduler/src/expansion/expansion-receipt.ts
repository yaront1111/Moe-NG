/**
 * The closed receipt shape expansion admission derives from, and the refusal
 * vocabulary those derivations speak.
 *
 * SPLIT FROM `expansion-evidence.ts` BY RESPONSIBILITY, not by reformatting:
 * that file owns the seven derivations and the order they run in, this one owns
 * the shape they read and the words they refuse with. Both are needed to state a
 * refusal, so keeping them together pushed one file past the 400-line bar; the
 * package splits the same way (`fairness-contract.ts` beside its validators).
 *
 * # A CALLER VERDICT IS REFUSED ON SIGHT, NOT COMPARED AGAINST
 *
 * The obvious design accepts a caller-declared field and checks it against the
 * derived answer. That is weaker than it looks: it passes whenever the caller
 * happens to be RIGHT, so a caller asserting `scopeDisjoint: true` on a
 * genuinely disjoint receipt gains standing it never earned, and the day the
 * derivation stops running the assertion still holds. So a verdict key is
 * refused by its PRESENCE, with its own code, before any fact is derived.
 *
 * Unknown keys are refused too, rather than ignored. Ignoring them is how a
 * future caller verdict arrives under a name this version has never heard of.
 *
 * # UNKNOWN IS NOT A REFUSAL
 *
 * REFUSED means the value is wrong. UNKNOWN means the value is representable
 * but an input needed to classify it was never supplied, and it names that
 * input. Collapsing them lets a missing fact read as a refuted one. Neither
 * ever becomes an admission. This mirrors the disposition split the fairness
 * contract in this package already ships rather than inventing a second
 * spelling of it.
 */
import { isPlainArray, readOwnDataProperty } from "../runtime-shape.js";

/** Which derivation refused. Closed and frozen. */
export const EXPANSION_EVIDENCE_LAYERS = Object.freeze([
  "CONTAINMENT", "EVIDENCE", "FRESHNESS", "INPUT", "ORACLE", "SCOPE", "SOURCE",
] as const);
export type ExpansionEvidenceLayer = (typeof EXPANSION_EVIDENCE_LAYERS)[number];

/**
 * Stable reason codes. Every member is produced by a real path in this file;
 * `every_issue_code_the_vocabulary_declares_is_one_a_real_path_can_produce`
 * pins the set by exact equality, so an unreachable code is a failing test
 * rather than a guard this module only claims to have.
 */
export const EXPANSION_EVIDENCE_ISSUE_CODES = Object.freeze([
  "EXPANSION_CALLER_DECLARED_VERDICT", "EXPANSION_COMPLETION_NOT_CLOSED",
  "EXPANSION_CONTAINMENT_VIOLATED", "EXPANSION_EVIDENCE_MALFORMED",
  "EXPANSION_EVIDENCE_MISSING", "EXPANSION_EVIDENCE_UNKNOWN",
  "EXPANSION_INPUT_NOT_MATERIALIZABLE", "EXPANSION_ORACLE_INELIGIBLE",
  "EXPANSION_RECEIPT_STALE", "EXPANSION_SCOPE_OVERLAP",
  "EXPANSION_SOURCE_DIGEST_MISMATCH",
] as const);
export type ExpansionEvidenceIssueCode = (typeof EXPANSION_EVIDENCE_ISSUE_CODES)[number];

/**
 * Names a caller may never put on a receipt.
 *
 * Exported so the suite can sweep every one rather than transcribing a list
 * that would drift from this one silently.
 */
export const FORBIDDEN_VERDICT_KEYS = Object.freeze([
  "admissible", "capacityAvailable", "eligible", "inputsMaterialized",
  "oracleEligible", "scopeDisjoint",
] as const);

export interface ExpansionEvidenceIssue {
  readonly code: ExpansionEvidenceIssueCode;
  readonly layer: ExpansionEvidenceLayer;
  readonly message: string;
  /** Non-null exactly on an UNKNOWN or a MISSING: the input that blocks a verdict. */
  readonly missingInput: string | null;
  readonly subjects: readonly string[];
}

export interface ExpansionEvidenceRefusal {
  readonly ok: false;
  readonly disposition: "REFUSED" | "UNKNOWN";
  readonly issues: readonly ExpansionEvidenceIssue[];
}

export interface ExpansionInputFact {
  readonly inputKey: string;
  readonly digest: string;
}

/**
 * The per-child scope, oracle and input facts, in the order they were derived.
 *
 * These are the ONLY facts a consumer cannot reconstruct from the scalars
 * beside them, which is what makes a digest over them load-bearing: two
 * proposals with the same child keys but different scope keys, oracle kinds or
 * input digests are different proposals and must not share an identity.
 *
 * THE CHILD KEY IS DELIBERATELY ABSENT. It is carried once, by `childKeys`, and
 * the two lists are built in the same loop so entry `i` describes key `i`.
 * Repeating it here would bind the key set twice, and a fact bound twice can be
 * dropped from either place without any test noticing.
 */
export interface ExpansionChildFacts {
  readonly scope: readonly string[];
  readonly oracleKind: string;
  readonly completion: string;
  readonly inputs: readonly ExpansionInputFact[];
}

/** The facts the composer is allowed to rely on. Every one is DERIVED here. */
export interface DerivedExpansionEvidence {
  readonly proposalId: string;
  readonly revision: number;
  readonly goalVersion: number;
  readonly graphEpoch: number;
  readonly observedAtSequence: number;
  readonly childKeys: readonly string[];
  readonly childWidth: number;
  readonly sourceDigests: readonly string[];
  readonly childFacts: readonly ExpansionChildFacts[];
}

export type ExpansionEvidenceResult =
  | { readonly ok: true; readonly value: DerivedExpansionEvidence }
  | ExpansionEvidenceRefusal;

export const RECEIPT_KEYS = Object.freeze([
  "childScopes", "goalVersion", "graphEpoch", "horizonSequence", "observedAtSequence",
  "parentScope", "proposalId", "revision", "sourceDigests",
] as const);
export const CHILD_KEYS = Object.freeze([
  "childKey", "completion", "inputs", "oracleKind", "scope",
] as const);
export const INPUT_KEYS = Object.freeze(["digest", "inputKey", "materialization"] as const);

export const ELIGIBLE_ORACLES = Object.freeze(["DERIVED", "OBSERVED"] as const);
export const HEX_64 = /^[0-9a-f]{64}$/u;
export const MAX_ITEMS = 128;

/**
 * Stands in for a key that is not a plain data property.
 *
 * A getter or a throwing proxy trap is not a value a receipt may carry — it is
 * a way to make the same key read differently on the second look, which is
 * exactly the race a derived verdict must not be exposed to. Returning a symbol
 * rather than `undefined` means every `typeof` check below rejects it naturally
 * instead of a caller being able to forge one by supplying a literal undefined.
 */
const NOT_A_DATA_PROPERTY = Symbol("not-a-data-property");

/**
 * The own data value at `key`, read exactly once.
 *
 * `readOwnDataProperty` returns a discriminated read result rather than the
 * value, so unwrapping it here is what keeps every call site below reading a
 * plain `unknown` and never consulting the prototype chain.
 */
export function own(record: Record<string, unknown>, key: string): unknown {
  const read = readOwnDataProperty(record, key);
  if (!read.ok) return NOT_A_DATA_PROPERTY;
  return read.present ? read.value : undefined;
}

export function issue(
  code: ExpansionEvidenceIssueCode,
  layer: ExpansionEvidenceLayer,
  message: string,
  missingInput: string | null = null,
  subjects: readonly string[] = [],
): ExpansionEvidenceIssue {
  return Object.freeze({ code, layer, message, missingInput, subjects: Object.freeze([...subjects]) });
}

export function refuse(one: ExpansionEvidenceIssue): ExpansionEvidenceRefusal {
  return Object.freeze({ ok: false as const, disposition: "REFUSED" as const, issues: Object.freeze([one]) });
}

/** An input needed to classify was never supplied. Never a refusal, never a pass. */
export function unknown(missingInput: string): ExpansionEvidenceRefusal {
  return Object.freeze({
    ok: false as const,
    disposition: "UNKNOWN" as const,
    issues: Object.freeze([
      issue("EXPANSION_EVIDENCE_UNKNOWN", "EVIDENCE", "an input needed to classify is absent", missingInput),
    ]),
  });
}

export function malformed(message: string): ExpansionEvidenceRefusal {
  return refuse(issue("EXPANSION_EVIDENCE_MALFORMED", "EVIDENCE", message));
}

export function missing(path: string): ExpansionEvidenceRefusal {
  return refuse(issue("EXPANSION_EVIDENCE_MISSING", "EVIDENCE", "a required input is absent", path));
}

/**
 * Refuses any own key that is a caller verdict, then any own key the shape does
 * not declare. ORDER MATTERS: a verdict key is also an unknown key, and folding
 * the two would let the caller-verdict property be certified by a generic shape
 * guard that could later stop covering it.
 */
export function checkKeys(record: Record<string, unknown>, allowed: readonly string[], at: string):
  ExpansionEvidenceRefusal | null {
  const keys = Object.keys(record);
  for (const key of keys) {
    if ((FORBIDDEN_VERDICT_KEYS as readonly string[]).includes(key)) {
      return refuse(issue(
        "EXPANSION_CALLER_DECLARED_VERDICT", "EVIDENCE",
        "a caller-declared verdict carries no standing here", null, [`${at}${key}`],
      ));
    }
  }
  for (const key of keys) {
    if (!allowed.includes(key)) return malformed(`unknown key ${at}${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(record, key)) return missing(`${at}${key}`);
  }
  return null;
}

export function readInteger(record: Record<string, unknown>, key: string): number | null {
  const value = own(record, key);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function readKeyList(record: Record<string, unknown>, key: string): readonly string[] | null {
  const value = own(record, key);
  if (!isPlainArray(value) || value.length > MAX_ITEMS) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) return null;
    out.push(entry);
  }
  return out;
}

