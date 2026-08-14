import { types } from "node:util";

import { deepFreeze } from "../../canonical.js";
import { snapshotExactRecord } from "../../platform/platform-contract.js";
/**
 * What a launch CLAIMS it is launching, and the vocabulary the pre-open check in
 * `./claude-launch-verify.js` proves argv and the child environment agree with.
 *
 * This is deliberately separate from the runtime pin and from the profile: a
 * runtime `reportedVersion`, a pinned closure digest and a `profileRevisionId`
 * all describe the BINARY and the CONFIGURATION, never which model that binary
 * was asked for or how hard it was asked to think. Letting any of them stand in
 * would be exactly the substitution the DoD forbids, so the only thing that can
 * satisfy the model and effort fields is argv naming them EXACTLY, once, with
 * nothing in the child environment overriding what argv said.
 *
 * UNKNOWN is a member of both closed vocabularies and never gains authority:
 * unavailable snapshot evidence stays explicitly UNKNOWN rather than being
 * back-filled, and an UNKNOWN reasoning effort is unproven even when argv
 * literally spells the word.
 */
export const CLAUDE_LAUNCH_SELECTION_LAYER = "TELEMETRY_CONFIGURATION" as const;
/**
 * Model and effort refuse with SEPARATE codes on purpose. A shared code would
 * make the two mutation drills indistinguishable — breaking either comparison
 * would redden the same assertions — and the DoD requires them checked
 * independently.
 */
export const CLAUDE_LAUNCH_SELECTION_CODES = Object.freeze([
  "CLAUDE_LAUNCH_SELECTION_MALFORMED",
  "CLAUDE_LAUNCH_MODEL_UNPROVEN", "CLAUDE_LAUNCH_MODEL_AMBIGUOUS", "CLAUDE_LAUNCH_MODEL_MISMATCH",
  "CLAUDE_LAUNCH_EFFORT_UNPROVEN", "CLAUDE_LAUNCH_EFFORT_AMBIGUOUS", "CLAUDE_LAUNCH_EFFORT_MISMATCH",
] as const);
export const CLAUDE_MODEL_EVIDENCE_KINDS =
  Object.freeze(["DATED_SNAPSHOT", "BUILD_STAMP", "UNKNOWN"] as const);
export const CLAUDE_REASONING_EFFORTS =
  Object.freeze(["low", "medium", "high", "xhigh", "max", "UNKNOWN"] as const);
/**
 * Flag spellings live here as DATA so no CLI trivia is hardcoded inside a
 * branch, and they are MEASURED against the installed provider rather than
 * chosen: `claude --help` exits 0 and lists `--model <model>` and
 * `--effort <level>`, and names no `--reasoning-effort`. A frozen flag the
 * provider does not read is worse than no gate at all — it would refuse the
 * argv the CLI obeys and accept argv the CLI ignores, certifying an effort that
 * never reached the process.
 */
export const CLAUDE_LAUNCH_SELECTION_FLAGS =
  Object.freeze({ model: "--model", effort: "--effort" } as const);
/**
 * The environment half of the same fact, measured from the installed binary's
 * own strings. `CLAUDE_CODE_EFFORT_LEVEL=<level>` is documented there as
 * overriding effort for the session — it wins over the flag — and
 * ANTHROPIC_MODEL sits in the model-configuration variable group. Argv the
 * child environment then overrides proves nothing, so a conflicting override is
 * refused by the same arm that owns the flag.
 *
 * `CLAUDE_EFFORT` is deliberately absent: the binary EXPORTS that one to hook
 * commands and Bash, it does not read it, so refusing on it would refuse
 * launches the provider honours.
 */
export const CLAUDE_LAUNCH_SELECTION_ENV =
  Object.freeze({ model: "ANTHROPIC_MODEL", effort: "CLAUDE_CODE_EFFORT_LEVEL" } as const);
export const CLAUDE_MODEL_EVIDENCE_ABSENT = "UNKNOWN" as const;
export type ClaudeLaunchSelectionCode = (typeof CLAUDE_LAUNCH_SELECTION_CODES)[number];
export type ClaudeLaunchSelectionLayer = typeof CLAUDE_LAUNCH_SELECTION_LAYER;
export type ClaudeModelEvidenceKind = (typeof CLAUDE_MODEL_EVIDENCE_KINDS)[number];
export type ClaudeReasoningEffort = (typeof CLAUDE_REASONING_EFFORTS)[number];
export interface ClaudeLaunchSelection {
  readonly provider: "claude";
  readonly selectedModelId: string;
  readonly modelSnapshotKind: ClaudeModelEvidenceKind;
  readonly modelSnapshotEvidence: string;
  readonly reasoningEffort: ClaudeReasoningEffort;
  readonly profileRevisionId: string;
  readonly configurationDigest: string;
  readonly policyDigest: string;
  readonly orchestrationDigest: string;
  readonly concurrencyCeiling: number;
}
export type ClaudeLaunchSelectionVerdict =
  | { readonly ok: true; readonly selection: ClaudeLaunchSelection }
  | { readonly ok: false; readonly code: ClaudeLaunchSelectionCode;
      readonly layer: ClaudeLaunchSelectionLayer; readonly message: string };
const SELECTION_KEYS = ["provider", "selectedModelId", "modelSnapshotKind", "modelSnapshotEvidence",
  "reasoningEffort", "profileRevisionId", "configurationDigest", "policyDigest",
  "orchestrationDigest", "concurrencyCeiling"] as const;
const DIGEST_KEYS = ["configurationDigest", "policyDigest", "orchestrationDigest"] as const;
const HEX_64 = /^[0-9a-f]{64}$/u;
/**
 * No whitespace, ever. The daemon wrapper spawns with `shell: true` on win32,
 * where argv elements are concatenated unescaped — a model id carrying a space
 * would be shredded into two arguments downstream and the thing that launched
 * would not be the thing this record names.
 */
const EXACT_TOKEN = /^[!-~]{1,128}$/u;
const oneOf = (value: unknown, members: readonly string[]): boolean =>
  typeof value === "string" && members.includes(value);
/**
 * Every refusal message is a STATIC per-code string. Nothing interpolated: a
 * message that quoted the offending argv element, the selected model, the
 * effort, an environment override or a digest would echo the caller's
 * configuration back out of a failure path.
 */
const MESSAGES: Readonly<Record<ClaudeLaunchSelectionCode, string>> = Object.freeze({
  CLAUDE_LAUNCH_SELECTION_MALFORMED: "the launch selection is not an exact bounded plain record",
  CLAUDE_LAUNCH_MODEL_UNPROVEN: "the launch arguments do not name the selected model",
  CLAUDE_LAUNCH_MODEL_AMBIGUOUS: "the launch arguments name a model more than once",
  CLAUDE_LAUNCH_MODEL_MISMATCH: "the launch names a model this selection did not select",
  CLAUDE_LAUNCH_EFFORT_UNPROVEN: "the launch arguments do not name the selected reasoning effort",
  CLAUDE_LAUNCH_EFFORT_AMBIGUOUS: "the launch arguments name a reasoning effort more than once",
  CLAUDE_LAUNCH_EFFORT_MISMATCH:
    "the launch names a reasoning effort this selection did not select",
});
export const refuseSelection = (code: ClaudeLaunchSelectionCode): ClaudeLaunchSelectionVerdict =>
  deepFreeze({ ok: false as const, code, layer: CLAUDE_LAUNCH_SELECTION_LAYER,
    message: MESSAGES[code] });
/**
 * A proxy is refused BEFORE anything reflects on the value, because reflection
 * is what runs a trap and a trap that has run has already had its effect no
 * matter what the gate decides afterwards. `Object.keys`, a descriptor read and
 * even `Array.isArray` are all reflection here.
 *
 * A revoked proxy makes `types.isProxy` itself throw, so the throw is contained
 * and read as "hostile": failing closed is the only safe reading of a value
 * that will not answer whether it is a proxy.
 */
export function isHostileObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  try { return types.isProxy(value); } catch { return true; }
}
/**
 * The exact-record snapshot IS the rest of the hostile-value defence:
 * `snapshotExactRecord` length-checks the key set, reads own data descriptors
 * only (so an accessor, a prototype-borrowed value or a missing key is refused),
 * and copies into a fresh record.
 *
 * TOTAL by construction: every arm answers null, so a caller holding this
 * function alone is defended exactly as well as one holding the verifier.
 */
export function snapshotLaunchSelection(value: unknown): ClaudeLaunchSelection | null {
  if (isHostileObject(value)) return null;
  let record: Record<string, unknown> | null;
  try { record = snapshotExactRecord(value, SELECTION_KEYS); } catch { return null; }
  if (record === null) return null;
  const raw = record;
  const model = raw["selectedModelId"];
  const profile = raw["profileRevisionId"];
  const ceiling = raw["concurrencyCeiling"];
  const evidence = raw["modelSnapshotEvidence"];
  // `typeof` BEFORE any pattern test. A `String(value)` on a hostile field runs
  // that field's `toString`, which is the caller's code executing inside the
  // guard whose whole job is deciding whether to trust the caller at all.
  if (raw["provider"] !== "claude" ||
    typeof model !== "string" || !EXACT_TOKEN.test(model) ||
    !oneOf(raw["modelSnapshotKind"], CLAUDE_MODEL_EVIDENCE_KINDS) ||
    !oneOf(raw["reasoningEffort"], CLAUDE_REASONING_EFFORTS) ||
    typeof profile !== "string" || !EXACT_TOKEN.test(profile) ||
    DIGEST_KEYS.some((key) => {
      const digest = raw[key];
      return typeof digest !== "string" || !HEX_64.test(digest);
    }) ||
    typeof ceiling !== "number" || !Number.isSafeInteger(ceiling) || ceiling <= 0) return null;
  // Absent evidence stays absent, and present evidence may not borrow the
  // absence literal: either direction would let UNKNOWN gain authority.
  if (typeof evidence !== "string" || !EXACT_TOKEN.test(evidence) ||
    (raw["modelSnapshotKind"] === CLAUDE_MODEL_EVIDENCE_ABSENT) !==
      (evidence === CLAUDE_MODEL_EVIDENCE_ABSENT)) return null;
  return deepFreeze({ ...raw } as unknown as ClaudeLaunchSelection);
}
