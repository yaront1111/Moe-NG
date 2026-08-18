/**
 * Row contract and closed vocabularies for the Claude/Codex capability shadow
 * matrix.
 *
 * NOTHING HERE DECIDES A VERDICT. Every verdict in the matrix is produced by
 * calling a shipped production surface through a bare package root; this module
 * only fences the shape a row may take, names the production vocabularies a row
 * may quote its reason from, and serialises rows canonically so two runs are
 * byte-identical. The one column that carries weight is `provenance`: it records
 * WHICH CLASS OF EVIDENCE produced the verdict, so a service that merely
 * CONSTRUCTED can never read as one that DISPATCHED.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DAEMON_FOUNDATION_ATTEMPT, FOUNDATION_ATTEMPT_CODES,
  RUNNER_WORKSPACE_LAYER, SCHEDULER_GRAPH_LAYER,
} from "@moe/daemon";
import {
  CLAUDE_CAPABILITIES, CLAUDE_OBSERVATION_ERROR_CODES, CLAUDE_PROOF_METHODS,
  CLAUDE_RECONCILED_OUTCOMES, CLAUDE_RUNTIME_OBSERVATION_VERSION,
  CODEX_CAPABILITIES, CODEX_CAPABILITY_PROFILE_VERSION, CODEX_OBSERVATION_ERROR_CODES,
  CODEX_PROOF_METHODS, CODEX_RECONCILED_OUTCOMES, CODEX_RENDERER_ENVELOPE_VERSION,
  CODEX_RENDER_ERROR_CODES, CODEX_RUNTIME_PINNING_METHODS, OBSERVATION_TRUTH_CLASSES,
} from "@moe/runner";
import type { PlatformIdentity } from "@moe/runner";

export const PROVIDERS = Object.freeze(["claude", "codex"] as const);
export type ProviderId = (typeof PROVIDERS)[number];

export const ROW_FAMILIES = Object.freeze(["CAPABILITY", "SURFACE"] as const);
export type RowFamily = (typeof ROW_FAMILIES)[number];

export const VERDICTS = Object.freeze(["PASS", "FAIL", "UNKNOWN"] as const);
export type Verdict = (typeof VERDICTS)[number];

/**
 * Closed evidence classes. `CONSTRUCTION` is deliberately NOT a launch class and
 * `REQUEST_REFUSAL` is deliberately not `CONSTRUCTION`: the first says a factory
 * returned a service, the second says that service refused caller bytes before
 * touching a store. `NOT_EXERCISED` means the surface EXISTS and was left alone;
 * `ABSENT_CALL_SITE` means it does not exist to call.
 */
export const PROVENANCES = Object.freeze([
  "ABSENT_CALL_SITE", "CONSTRUCTION", "DURABLE_READ", "NOT_EXERCISED",
  "OBSERVATION", "PROBE", "RECONCILE", "RENDER", "REQUEST_REFUSAL",
] as const);
export type Provenance = (typeof PROVENANCES)[number];

/** Why a row could not be decided. Only ever set on an UNKNOWN row. */
export const UNKNOWN_REASONS = Object.freeze([
  "DISPATCH_WRITES_AUTHORITY",
  "NO_PRODUCTION_EXECUTION_CALL_SITE",
  "NO_PROVIDER_DAEMON_SERVICE",
  "NO_PUBLISHED_RECORD_CODEC",
  "PROVIDER_ASSESSOR_WITHHELD",
  "PROVIDER_RENDERER_WITHHELD",
  "PROVIDER_STREAM_RECORDER_WITHHELD",
] as const);
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

/**
 * Every list below is IMPORTED production truth, never transcribed. A row that
 * quotes a reason must name the list it came from, and the suite checks
 * membership against that list, so a hand-typed code cannot pass as production.
 */
export const REASON_VOCABULARIES = Object.freeze({
  CLAUDE_OBSERVATION_ERROR_CODES: CLAUDE_OBSERVATION_ERROR_CODES as readonly string[],
  CLAUDE_OBSERVATION_VERSION:
    Object.freeze([CLAUDE_RUNTIME_OBSERVATION_VERSION]) as readonly string[],
  CLAUDE_PROOF_METHODS: CLAUDE_PROOF_METHODS as readonly string[],
  CLAUDE_RECONCILED_OUTCOMES: CLAUDE_RECONCILED_OUTCOMES as readonly string[],
  CODEX_CAPABILITY_PROFILE_VERSION:
    Object.freeze([CODEX_CAPABILITY_PROFILE_VERSION]) as readonly string[],
  CODEX_OBSERVATION_ERROR_CODES: CODEX_OBSERVATION_ERROR_CODES as readonly string[],
  CODEX_PROOF_METHODS: CODEX_PROOF_METHODS as readonly string[],
  CODEX_RECONCILED_OUTCOMES: CODEX_RECONCILED_OUTCOMES as readonly string[],
  CODEX_RENDERER_ENVELOPE_VERSION:
    Object.freeze([CODEX_RENDERER_ENVELOPE_VERSION]) as readonly string[],
  CODEX_RENDER_ERROR_CODES: CODEX_RENDER_ERROR_CODES as readonly string[],
  CODEX_RUNTIME_PINNING_METHODS: CODEX_RUNTIME_PINNING_METHODS as readonly string[],
  DAEMON_FOUNDATION_LAYERS: Object.freeze(
    [DAEMON_FOUNDATION_ATTEMPT, RUNNER_WORKSPACE_LAYER, SCHEDULER_GRAPH_LAYER],
  ) as readonly string[],
  FOUNDATION_ATTEMPT_CODES: FOUNDATION_ATTEMPT_CODES as readonly string[],
  OBSERVATION_TRUTH_CLASSES: OBSERVATION_TRUTH_CLASSES as readonly string[],
});
export type VocabularyId = keyof typeof REASON_VOCABULARIES;

/** The frozen rosters, keyed by provider. Row generation reads ONLY these. */
export const CAPABILITY_ROSTERS: Readonly<Record<ProviderId, readonly string[]>> = Object.freeze({
  claude: CLAUDE_CAPABILITIES as readonly string[],
  codex: CODEX_CAPABILITIES as readonly string[],
});

/**
 * The platform axis is caller-DECLARED data the production observation builder
 * fences; there is no production OS roster to derive it from. `HOSTILE_PLATFORM`
 * exists so the unsupported-platform arm reaches a real refusal on this Windows
 * host without mocking `node:os`, which would be caller-forged runtime truth.
 */
export interface PlatformCase {
  readonly id: string;
  readonly identity: PlatformIdentity;
}
export const PLATFORM_CASES: readonly PlatformCase[] = Object.freeze([
  Object.freeze({
    id: "darwin-arm64", identity: { arch: "arm64", os: "darwin", osVersion: "24.0.0" },
  }),
  Object.freeze({
    id: "linux-x64", identity: { arch: "x64", os: "linux", osVersion: "6.8.0" },
  }),
  Object.freeze({
    id: "win32-x64", identity: { arch: "x64", os: "win32", osVersion: "10.0.26200" },
  }),
]);
export const HOSTILE_PLATFORM: PlatformIdentity = Object.freeze({ arch: "", os: "", osVersion: "" });
/** Platform-independent rows say so rather than borrowing a platform they never used. */
export const PLATFORM_NEUTRAL = "ANY";

export interface ShadowRow {
  readonly caseDigest: string;
  readonly family: RowFamily;
  readonly platform: string;
  readonly provenance: Provenance;
  readonly provider: ProviderId;
  readonly reasonCode: string | null;
  readonly reasonVocabulary: VocabularyId | null;
  readonly refusedBy: string | null;
  readonly sourceCommit: string;
  readonly subject: string;
  readonly unknownBecause: UnknownReason | null;
  readonly verdict: Verdict;
}

/** The row body a digest is taken over: everything except the digest itself. */
export type RowSubject = Omit<ShadowRow, "caseDigest">;

const ROW_KEYS: readonly (keyof RowSubject)[] = Object.freeze([
  "family", "platform", "provenance", "provider", "reasonCode", "reasonVocabulary",
  "refusedBy", "sourceCommit", "subject", "unknownBecause", "verdict",
]);

/** Stable field order, no clock, no map iteration order, no per-row host read. */
export function canonicalRowBody(row: RowSubject): string {
  return JSON.stringify(ROW_KEYS.map((key) => [key, row[key]]));
}

export function digestRow(row: RowSubject): string {
  return createHash("sha256").update(canonicalRowBody(row), "utf8").digest("hex");
}

export function sealRow(row: RowSubject): ShadowRow {
  return Object.freeze({ ...row, caseDigest: digestRow(row) });
}

/** Total order over rows so serialisation never depends on generation order. */
export function canonicalMatrix(rows: readonly ShadowRow[]): string {
  const keyed = rows.map((row) => ({ body: canonicalRowBody(row), digest: row.caseDigest }));
  keyed.sort((left, right) => (left.body < right.body ? -1 : left.body > right.body ? 1 : 0));
  return JSON.stringify(keyed.map((entry) => [entry.body, entry.digest]));
}

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * The checkout's committed HEAD, read ONCE from `.git` bytes. No child process
 * is spawned; this suite launches nothing at all, provider or otherwise.
 */
export function readSourceCommit(): string {
  const head = readFileSync(join(REPO_ROOT, ".git", "HEAD"), "utf8").trim();
  if (!head.startsWith("ref: ")) return head;
  const ref = head.slice(5).trim();
  try {
    return readFileSync(join(REPO_ROOT, ".git", ref), "utf8").trim();
  } catch {
    const packed = readFileSync(join(REPO_ROOT, ".git", "packed-refs"), "utf8");
    for (const line of packed.split("\n")) {
      const [sha, name] = line.trim().split(" ");
      if (name === ref && sha !== undefined) return sha;
    }
    throw new Error(`unresolvable HEAD ref ${ref}`);
  }
}
