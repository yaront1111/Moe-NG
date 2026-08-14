import { CLAUDE_LAUNCH_RESUME_FLAGS, CLAUDE_LAUNCH_SELECTION_ENV, CLAUDE_LAUNCH_SELECTION_FLAGS,
  isHostileObject, refuseSelection, snapshotLaunchSelection, type ClaudeLaunchSelection,
  type ClaudeLaunchSelectionCode, type ClaudeLaunchSelectionVerdict } from "./claude-launch-selection.js";
/**
 * The pre-open launch-selection gate.
 *
 * Two things can make a launch differ from the selection it declares, and both
 * are checked here: the arguments the process is given, and the environment it
 * is given them in. Checking only argv would certify a launch the child
 * environment then overrides — the provider's own documentation of
 * CLAUDE_CODE_EFFORT_LEVEL says it wins over the flag — so an argv-only gate
 * proves the claim, not the launch.
 */
/** argv is the caller's, so it is re-proven here rather than assumed bounded. */
function snapshotArgv(value: unknown): readonly string[] | null {
  try {
    if (isHostileObject(value)) return null;
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
 * The environment is proven the same way argv is. A null-prototype copy so a
 * later `in` cannot be answered by `Object.prototype`, and own data descriptors
 * only so an accessor cannot hand one value to this gate and another to the
 * boundary.
 */
function snapshotEnvironment(value: unknown): Readonly<Record<string, string>> | null {
  try {
    if (isHostileObject(value) || typeof value !== "object" || value === null ||
      Array.isArray(value)) return null;
    const names = Object.keys(value);
    if (names.length > 64) return null;
    const copy: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined || !("value" in descriptor) ||
        typeof descriptor.value !== "string" || descriptor.value.length > 8_192 ||
        descriptor.value.includes("\0")) return null;
      copy[name] = descriptor.value;
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
/**
 * Whether argv attaches this launch to a prior conversation.
 *
 * Matched as a WHOLE element, or as the `--flag=value` spelling — never as a
 * substring. An argv element that merely contains the word (a prompt, a session
 * display name) is not that flag, and refusing it would refuse launches the
 * provider honours, which is the same defect as accepting one it ignores.
 */
function resumesPriorSession(argv: readonly string[]): boolean {
  for (const element of argv) {
    for (const flag of CLAUDE_LAUNCH_RESUME_FLAGS) {
      if (element === flag || element.startsWith(`${flag}=`)) return true;
    }
  }
  return false;
}
type ArmCodes = readonly [ClaudeLaunchSelectionCode, ClaudeLaunchSelectionCode,
  ClaudeLaunchSelectionCode];
const MODEL_CODES: ArmCodes = ["CLAUDE_LAUNCH_MODEL_UNPROVEN", "CLAUDE_LAUNCH_MODEL_AMBIGUOUS",
  "CLAUDE_LAUNCH_MODEL_MISMATCH"];
const EFFORT_CODES: ArmCodes = ["CLAUDE_LAUNCH_EFFORT_UNPROVEN", "CLAUDE_LAUNCH_EFFORT_AMBIGUOUS",
  "CLAUDE_LAUNCH_EFFORT_MISMATCH"];
/**
 * One arm's argv half. `expected === null` means the selection itself named
 * nothing provable (an UNKNOWN effort), which is unproven no matter what argv
 * says.
 */
function verifyArgvArm(
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
 * The same arm's environment half. An override that AGREES is not a conflict —
 * this is a comparison, not a ban on ever naming the variable — but an override
 * that disagrees means the launched value is not the declared one, whichever of
 * the two the provider ends up preferring.
 *
 * Matched CASE-INSENSITIVELY on the NAME. Windows environment variable names are
 * case-insensitive and this launcher refuses every platform but win32, so
 * `Claude_Code_Effort_Level` reaches the child as exactly the same override;
 * a case-sensitive match would leave a one-keystroke bypass of the whole arm.
 * Two spellings of one name are refused as ambiguous rather than resolved —
 * which one the OS keeps is not this gate's to guess. The VALUE stays an exact
 * comparison, because a model id and an effort level are case-sensitive.
 */
function verifyEnvironmentArm(
  environment: Readonly<Record<string, string>>, name: string, expected: string, codes: ArmCodes,
): ClaudeLaunchSelectionCode | null {
  const wanted = name.toUpperCase();
  const found: string[] = [];
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === wanted) found.push(environment[key] as string);
  }
  if (found.length > 1) return codes[1];
  if (found.length === 0) return null;
  return found[0] === expected ? null : codes[2];
}
/**
 * Total by construction: it decides on every input and neither throws nor
 * rejects, so a caller cannot be made to skip it by handing in something
 * hostile. The model arm is answered in full before the effort arm, so neither
 * family can answer for the other and each can be mutated alone.
 */
export function verifyLaunchSelection(
  value: unknown, argv: unknown, environment: unknown,
): ClaudeLaunchSelectionVerdict {
  let selection: ClaudeLaunchSelection | null;
  try { selection = snapshotLaunchSelection(value); } catch {
    return refuseSelection("CLAUDE_LAUNCH_SELECTION_MALFORMED");
  }
  const args = snapshotArgv(argv);
  const env = snapshotEnvironment(environment);
  if (selection === null || args === null || env === null) {
    return refuseSelection("CLAUDE_LAUNCH_SELECTION_MALFORMED");
  }
  // Ahead of both arms, because a resumed session defeats them TOGETHER: the
  // model and the effort both come from the transcript, so answering
  // MODEL_MISMATCH here would name a comparison that is not what went wrong.
  if (resumesPriorSession(args)) return refuseSelection("CLAUDE_LAUNCH_SESSION_RESUMED");
  const model = verifyArgvArm(args, CLAUDE_LAUNCH_SELECTION_FLAGS.model,
    selection.selectedModelId, MODEL_CODES) ??
    verifyEnvironmentArm(env, CLAUDE_LAUNCH_SELECTION_ENV.model, selection.selectedModelId,
      MODEL_CODES);
  if (model !== null) return refuseSelection(model);
  const declaredEffort = selection.reasoningEffort === "UNKNOWN" ? null : selection.reasoningEffort;
  const effort = verifyArgvArm(args, CLAUDE_LAUNCH_SELECTION_FLAGS.effort, declaredEffort,
    EFFORT_CODES) ?? (declaredEffort === null ? "CLAUDE_LAUNCH_EFFORT_UNPROVEN" :
      verifyEnvironmentArm(env, CLAUDE_LAUNCH_SELECTION_ENV.effort, declaredEffort, EFFORT_CODES));
  if (effort !== null) return refuseSelection(effort);
  return Object.freeze({ ok: true as const, selection });
}
