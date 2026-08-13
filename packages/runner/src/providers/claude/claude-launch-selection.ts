import { deepFreeze } from "../../canonical.js";
import { snapshotExactRecord } from "../../platform/platform-contract.js";
/**
 * What a launch CLAIMS it is launching, and the pre-open check that argv agrees.
 *
 * This is deliberately separate from the runtime pin and from the profile: a
 * runtime `reportedVersion`, a pinned closure digest and a `profileRevisionId`
 * all describe the BINARY and the CONFIGURATION, never which model that binary
 * was asked for or how hard it was asked to think. Letting any of them stand in
 * would be exactly the substitution the DoD forbids, so the only thing that can
 * satisfy the model and effort fields is argv naming them EXACTLY, once.
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
/** Flag spellings live here as DATA so no CLI trivia is hardcoded inside a branch. */
export const CLAUDE_LAUNCH_SELECTION_FLAGS =
  Object.freeze({ model: "--model", effort: "--reasoning-effort" } as const);
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
 * message that quoted the offending argv element, the selected model, the effort
 * or a digest would echo the caller's configuration back out of a failure path.
 */
const MESSAGES: Readonly<Record<ClaudeLaunchSelectionCode, string>> = Object.freeze({
  CLAUDE_LAUNCH_SELECTION_MALFORMED: "the launch selection is not an exact bounded plain record",
  CLAUDE_LAUNCH_MODEL_UNPROVEN: "the launch arguments do not name the selected model",
  CLAUDE_LAUNCH_MODEL_AMBIGUOUS: "the launch arguments name a model more than once",
  CLAUDE_LAUNCH_MODEL_MISMATCH: "the launch arguments name a model this selection did not select",
  CLAUDE_LAUNCH_EFFORT_UNPROVEN: "the launch arguments do not name the selected reasoning effort",
  CLAUDE_LAUNCH_EFFORT_AMBIGUOUS: "the launch arguments name a reasoning effort more than once",
  CLAUDE_LAUNCH_EFFORT_MISMATCH:
    "the launch arguments name a reasoning effort this selection did not select",
});
const refuse = (code: ClaudeLaunchSelectionCode): ClaudeLaunchSelectionVerdict =>
  deepFreeze({ ok: false as const, code, layer: CLAUDE_LAUNCH_SELECTION_LAYER,
    message: MESSAGES[code] });
/**
 * The exact-record snapshot IS the hostile-value defence: `snapshotExactRecord`
 * length-checks the key set, reads own data descriptors only (so an accessor, a
 * prototype-borrowed value or a missing key is refused), and copies into a fresh
 * record so a proxy cannot answer differently on a later read. A revoked proxy
 * throws from the reflection itself, hence the containment.
 */
export function snapshotLaunchSelection(value: unknown): ClaudeLaunchSelection | null {
  let raw: Record<string, unknown> | null;
  try { raw = snapshotExactRecord(value, SELECTION_KEYS); } catch { return null; }
  if (raw === null) return null;
  const evidenceAbsent = raw["modelSnapshotKind"] === CLAUDE_MODEL_EVIDENCE_ABSENT;
  if (raw["provider"] !== "claude" ||
    !EXACT_TOKEN.test(String(raw["selectedModelId"])) ||
    typeof raw["selectedModelId"] !== "string" ||
    !oneOf(raw["modelSnapshotKind"], CLAUDE_MODEL_EVIDENCE_KINDS) ||
    !oneOf(raw["reasoningEffort"], CLAUDE_REASONING_EFFORTS) ||
    typeof raw["profileRevisionId"] !== "string" || !EXACT_TOKEN.test(raw["profileRevisionId"]) ||
    DIGEST_KEYS.some((key) => typeof raw?.[key] !== "string" || !HEX_64.test(String(raw[key]))) ||
    typeof raw["concurrencyCeiling"] !== "number" ||
    !Number.isSafeInteger(raw["concurrencyCeiling"]) || raw["concurrencyCeiling"] <= 0) return null;
  // Absent evidence stays absent, and present evidence may not borrow the
  // absence literal: either direction would let UNKNOWN gain authority.
  const evidence = raw["modelSnapshotEvidence"];
  if (typeof evidence !== "string" || !EXACT_TOKEN.test(evidence) ||
    evidenceAbsent !== (evidence === CLAUDE_MODEL_EVIDENCE_ABSENT)) return null;
  return deepFreeze({ ...raw } as unknown as ClaudeLaunchSelection);
}
/** argv is the caller's, so it is re-proven here rather than assumed bounded. */
function snapshotArgv(value: unknown): readonly string[] | null {
  try {
    // An own `Symbol.iterator` is refused rather than ignored: this reads argv by
    // index, but a spread-based consumer downstream would read the trap instead,
    // and two readings of one argv is precisely what the gate exists to prevent.
    if (!Array.isArray(value) || value.length > 128 ||
      Object.keys(value).length !== value.length ||
      Object.getOwnPropertyDescriptor(value, Symbol.iterator) !== undefined) return null;
    const copy: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) ||
        typeof descriptor.value !== "string" || descriptor.value.length > 4_096 ||
        descriptor.value.includes("\0")) return null;
      copy.push(descriptor.value);
    }
    return Object.freeze(copy);
  } catch { return null; }
}
/**
 * Collects every occurrence of one flag in BOTH spellings. A trailing flag and
 * an empty `--flag=` both contribute `null`: the flag is present but supplies
 * nothing, which proves nothing rather than mismatching something.
 */
function flagValues(argv: readonly string[], flag: string): readonly (string | null)[] {
  const joined = `${flag}=`;
  const found: (string | null)[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const element = argv[index] as string;
    if (element === flag) {
      const next = index + 1 < argv.length ? (argv[index + 1] as string) : null;
      found.push(next === null || next.length === 0 ? null : next);
    } else if (element.startsWith(joined)) {
      const value = element.slice(joined.length);
      found.push(value.length === 0 ? null : value);
    }
  }
  return found;
}
type ArmCodes = readonly [ClaudeLaunchSelectionCode, ClaudeLaunchSelectionCode,
  ClaudeLaunchSelectionCode];
const MODEL_CODES: ArmCodes = ["CLAUDE_LAUNCH_MODEL_UNPROVEN", "CLAUDE_LAUNCH_MODEL_AMBIGUOUS",
  "CLAUDE_LAUNCH_MODEL_MISMATCH"];
const EFFORT_CODES: ArmCodes = ["CLAUDE_LAUNCH_EFFORT_UNPROVEN", "CLAUDE_LAUNCH_EFFORT_AMBIGUOUS",
  "CLAUDE_LAUNCH_EFFORT_MISMATCH"];
/**
 * One arm. `expected === null` means the selection itself named nothing
 * provable (an UNKNOWN effort), which is unproven no matter what argv says.
 */
function verifyArm(
  argv: readonly string[], flag: string, expected: string | null, codes: ArmCodes,
): ClaudeLaunchSelectionCode | null {
  const [unproven, ambiguous, mismatch] = codes;
  if (expected === null) return unproven;
  const found = flagValues(argv, flag);
  if (found.length > 1) return ambiguous;
  const only = found.length === 1 ? found[0] : null;
  if (only === null || only === undefined) return unproven;
  return only === expected ? null : mismatch;
}
/**
 * The pre-open gate. Total by construction: it decides on every input and
 * neither throws nor rejects, so a caller cannot be made to skip it by handing
 * in something hostile.
 */
export function verifyLaunchSelection(value: unknown, argv: unknown): ClaudeLaunchSelectionVerdict {
  let selection: ClaudeLaunchSelection | null;
  try { selection = snapshotLaunchSelection(value); } catch { return refuse("CLAUDE_LAUNCH_SELECTION_MALFORMED"); }
  const args = snapshotArgv(argv);
  if (selection === null || args === null) return refuse("CLAUDE_LAUNCH_SELECTION_MALFORMED");
  const model = verifyArm(args, CLAUDE_LAUNCH_SELECTION_FLAGS.model, selection.selectedModelId,
    MODEL_CODES);
  if (model !== null) return refuse(model);
  const effort = verifyArm(args, CLAUDE_LAUNCH_SELECTION_FLAGS.effort,
    selection.reasoningEffort === "UNKNOWN" ? null : selection.reasoningEffort, EFFORT_CODES);
  if (effort !== null) return refuse(effort);
  return Object.freeze({ ok: true as const, selection });
}
