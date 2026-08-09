/**
 * Fingerprints a dead end by its TYPED facts and nothing else.
 *
 * The exclusion is the feature: two siblings that hit the same bug and describe
 * it in different words must land on one fingerprint, so `text`, `id`,
 * `actorId` and `occurredAt` never reach the hash.
 */
import { createHash } from "node:crypto";

import type { DeadEndJournalEntry } from "@moe/context";

import {
  BREAKER_INPUT_INVALID_REFUSAL,
  CONVERGENCE_BREAKER_SCHEMA_VERSION,
  type BreakerInputRefusal,
  type FailureFingerprint,
} from "./breaker-contract.js";

/**
 * The single source of truth for what a fingerprint covers. The hash iterates
 * this tuple and the counterexample table in breaker.test.ts is generated from
 * it, so a field added or dropped here cannot drift from its test coverage.
 */
export const FINGERPRINT_FIELDS = Object.freeze([
  "failureCode",
  "primaryScope",
  "recipeDigest",
  "baseDigest",
  "environmentDigest",
] as const);

export type FingerprintField = (typeof FINGERPRINT_FIELDS)[number];

export type FingerprintResult =
  | Readonly<{ ok: true; fingerprint: FailureFingerprint }>
  | BreakerInputRefusal;

const FINGERPRINT_DOMAIN = "moe.scheduler.convergence.failure-fingerprint";

/**
 * Written as a code point so no literal NUL byte enters the source: git would
 * classify the file as binary and stop producing reviewable diffs.
 */
const FIELD_TERMINATOR = String.fromCodePoint(0);

/**
 * Length-framed so the canonical form is injective. Without the frame,
 * ("x", "recipeDigesty") and ("xrecipeDigest", "y") produce identical bytes —
 * the interleaved field name is absorbed into the values — and a caller that
 * chooses its own `primaryScope` could steer its failure onto an unrelated
 * bug's hold. A mutation drill that removes the framing must redden
 * breaker.test.ts's collision case; if it does not, the fixture has stopped
 * testing the framing.
 */
function frame(value: string): string {
  return `${value.length}:${value}${FIELD_TERMINATOR}`;
}

/**
 * Reads an own DATA property. An accessor is never invoked: a getter on a
 * hostile entry would otherwise observe, or steer, the hash.
 *
 * Exported because `breaker.ts` validates the same hostile entry and must read
 * it the same way. One implementation, reviewed once — a second copy of a
 * security-relevant read is how the two drift apart.
 */
export function readOwnDataValue(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

export function readOwnDataString(source: object, key: string): string | null {
  const value = readOwnDataValue(source, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readTypedFacts(entry: DeadEndJournalEntry): readonly string[] | null {
  if (typeof entry !== "object" || entry === null) return null;
  const facts: string[] = [];
  for (const field of FINGERPRINT_FIELDS) {
    const value = readOwnDataString(entry, field);
    if (value === null) return null;
    facts.push(value);
  }
  return facts;
}

export function computeFailureFingerprint(entry: DeadEndJournalEntry): FingerprintResult {
  const facts = readTypedFacts(entry);
  if (facts === null) return BREAKER_INPUT_INVALID_REFUSAL;

  let canonical = frame(FINGERPRINT_DOMAIN);
  canonical += frame(String(CONVERGENCE_BREAKER_SCHEMA_VERSION));
  for (const [index, field] of FINGERPRINT_FIELDS.entries()) {
    canonical += frame(field) + frame(facts[index] ?? "");
  }

  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return Object.freeze({ ok: true, fingerprint: digest as FailureFingerprint });
}
