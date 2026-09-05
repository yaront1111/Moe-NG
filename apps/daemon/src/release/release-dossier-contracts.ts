import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";

/**
 * The durable shapes of the RELEASE DOSSIER: the evidence a goal's release
 * carries, re-measured at one git sha.
 *
 * The discipline is inherited from repository/landing-receipt-contracts.ts —
 * exact keys, a deterministic id, a decoder that refuses anything it did not
 * write — with one addition this record exists for: a citation that could not
 * be re-measured is rendered UNKNOWN and LISTED, never dropped. A dossier that
 * omits what it could not verify reads as complete evidence while being
 * incomplete, and its reader cannot tell absent from unverified.
 */

export const RELEASE_DOSSIER_PRINCIPAL_ID = "daemon:release-dossier" as const;
export const RELEASE_DOSSIER_VERSION = "moe-release-dossier/1" as const;
export const RELEASE_DOSSIER_COMMAND_KIND = "internal.release.dossier" as const;

/**
 * How a cited landing commit stands relative to the sha the dossier is built at.
 *
 * Measured at the edge by `git merge-base --is-ancestor <landingSha> <sha>`,
 * the only git plumbing that answers ancestry with an exit code: 0 => ANCESTOR,
 * 1 => NOT_ANCESTOR, anything else (128 for an unknown object, null for a spawn
 * failure or timeout) => UNMEASURABLE. UNMEASURABLE is git refusing to answer,
 * which renders UNKNOWN — it is never collapsed into NOT_ANCESTOR, because
 * "we could not check" and "we checked and it is absent" are different claims.
 */
export type AncestryVerdict = "ANCESTOR" | "NOT_ANCESTOR" | "UNMEASURABLE";

/** A sync predicate over one commit sha; the pure core never shells out itself. */
export type AncestryPredicate = (commitSha: string) => AncestryVerdict;

/** The verifier receipt facts a criterion's evidence rests on. */
export interface DossierReceiptFacts {
  /** The verifier's command — `VerifierExecutionEvidence.test`. */
  readonly command: string;
  readonly exitCode: number;
  readonly receiptId: string;
  /** The workspace sha the verifier ran against, or null when it recorded none. */
  readonly sha: string | null;
}

/** One execution-bearing node, as the dossier cites it. */
export interface DossierNodeFacts {
  /** The commit the node's work landed on, or null when nothing landed. */
  readonly landingSha: string | null;
  readonly nodeKey: string;
  /** True when this node key is carried by more than one activated plan. */
  readonly sharedAcrossPlans: boolean;
  readonly receipt: DossierReceiptFacts | null;
}

/** One approved acceptance criterion and the node that verifies it, if any. */
export interface DossierCriterionFacts {
  readonly criterionId: string;
  /** The node key that carries this criterion, or null when none does. */
  readonly nodeKey: string | null;
  readonly title: string;
}

/** One review round on a node: how it went and, when it did not, why. */
export interface DossierReviewRound {
  readonly nodeKey: string;
  readonly outcome: "ACCEPTED" | "REFUSED";
  /** The refusal's stable reason code, or null on an accepted round. */
  readonly refusalCode: string | null;
  readonly round: number;
}

/** The preview decision for the goal, when one was taken. */
export interface DossierPreviewDecision {
  readonly decidedAt: string;
  readonly decisionId: string;
  readonly outcome: string;
  readonly url: string | null;
}

/**
 * Everything the pure generator folds. Data only: no store handle, no clock,
 * no git — the three things that would make the output unreproducible.
 */
export interface DossierInput {
  readonly criteria: readonly DossierCriterionFacts[];
  readonly goalId: string;
  readonly goalTitle: string;
  readonly nodes: readonly DossierNodeFacts[];
  /** The installed policy revision, or null when the daemon measured none. */
  readonly policyRevision: string | null;
  readonly preview: DossierPreviewDecision | null;
  readonly projectId: string;
  readonly reviewRounds: readonly DossierReviewRound[];
}

export interface ReleaseDossierV1 {
  readonly dossierId: string;
  readonly goalId: string;
  readonly markdown: string;
  readonly projectId: string;
  readonly sha: string;
  readonly version: typeof RELEASE_DOSSIER_VERSION;
}

export type ReleaseDossierDecodeResult =
  | Readonly<{ readonly dossier: ReleaseDossierV1; readonly ok: true }>
  | Readonly<{ readonly code: "RELEASE_DOSSIER_INVALID"; readonly ok: false }>;

const HEX64 = /^[0-9a-f]{64}$/u;
const DOSSIER_KEYS = [
  "dossierId", "goalId", "markdown", "projectId", "sha", "version",
] as const;

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object"
    && !Array.isArray(value) && Object.getPrototypeOf(value) === null;
}

function exact(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function ref(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function hash(parts: readonly JsonValue[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      freezeDeep((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** The aggregate every release fact for a goal lands on: beside the goal, never on it. */
export function releaseDossierAggregateId(goalId: string): string {
  return `release:${goalId}`;
}

/**
 * One dossier per (project, goal, sha): re-releasing the same sha re-derives the
 * same id and replays the stored record instead of accumulating duplicates.
 */
export function releaseDossierId(projectId: string, goalId: string, sha: string): string {
  return hash([RELEASE_DOSSIER_VERSION, "dossier-id", projectId, goalId, sha]);
}

export function decodeReleaseDossierBytes(input: unknown): ReleaseDossierDecodeResult {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok || !isObject(decoded.value) || !exact(decoded.value, DOSSIER_KEYS)) {
    return { code: "RELEASE_DOSSIER_INVALID", ok: false };
  }
  const value = decoded.value;
  if (value["version"] !== RELEASE_DOSSIER_VERSION || !ref(value["projectId"])
    || !ref(value["goalId"]) || !ref(value["sha"]) || !ref(value["markdown"])
    || !HEX64.test(String(value["dossierId"]))) {
    return { code: "RELEASE_DOSSIER_INVALID", ok: false };
  }
  const dossierId = value["dossierId"] as string;
  if (dossierId !== releaseDossierId(value["projectId"], value["goalId"], value["sha"])) {
    return { code: "RELEASE_DOSSIER_INVALID", ok: false };
  }
  const dossier: ReleaseDossierV1 = {
    dossierId,
    goalId: value["goalId"],
    markdown: value["markdown"],
    projectId: value["projectId"],
    sha: value["sha"],
    version: RELEASE_DOSSIER_VERSION,
  };
  return { dossier: freezeDeep(dossier), ok: true };
}
