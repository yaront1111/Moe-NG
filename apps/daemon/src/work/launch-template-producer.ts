/**
 * The three launch-template fields the server owns, and where each one's authority comes from.
 *
 * PER-FIELD AUTHORITY MATRIX (the split's DoD 1). No field here is caller-proposed:
 * - launchSelection — SERVER-DERIVED. All ten fields are echoed from `ProviderCapabilities`,
 *   the durable answer `resolveCurrentProviderProfile` gives after binding the current project
 *   configuration, provider probe and activation witness together. A runtime observation
 *   proves the installed BINARY; it never proves which model that binary was asked for, so
 *   model identity is never read off one.
 * - argv — SERVER-DERIVED, composed positionally from that selection plus the node mission. It
 *   names the model and effort in the exact `CLAUDE_LAUNCH_SELECTION_FLAGS` spellings the
 *   launcher's own pre-open gate demands, and carries no member of `CLAUDE_LAUNCH_RESUME_FLAGS`:
 *   a resumed session keeps the transcript's model whatever `--model` says, which would make the
 *   selection unprovable. The launcher's gate is a CHECK, not a producer — passing it does not
 *   make a caller-supplied argv server-derived.
 * - limits — SERVER-OWNED, pinned by the durable profile revision, and declared launchable by
 *   the PUBLIC `validateClaudeLaunchLimits`. These are CAPTURE ceilings (stdout/stderr/tail
 *   bytes and a timeout), not conserved budget, so no budget projection participates. The
 *   ceilings are not copied here: one authority decides a bound, and a second copy would drift.
 *
 * THE ONE RULE THIS MODULE EXISTS FOR: it takes no dispatch request and no caller-proposed
 * field on any path. The signature is the fence — a value that cannot be named cannot be
 * echoed — and the input record is exact, so an "override" key refuses instead of being
 * ignored. Do not add a proposed/override parameter for convenience.
 *
 * Every refusal carries this module's own layer. Four vocabularies can answer for one launch —
 * this one, the provider-profile reader's, the runner's limit validator's and the launcher's
 * selection gate's — so an upstream code and layer pass through untranslated rather than being
 * restamped as ours.
 *
 * TOTAL: the exported function contains its own throws. Reading an unknown record is what runs a
 * hostile trap, and a caller holding a crash instead of a verdict has been told nothing — a
 * crash is not a refusal, so the wrapper answers LAUNCH_TEMPLATE_INPUT_HOSTILE instead.
 */

import {
  CLAUDE_LAUNCH_RESUME_FLAGS,
  CLAUDE_LAUNCH_SELECTION_ENV,
  CLAUDE_LAUNCH_SELECTION_FLAGS,
  validateClaudeLaunchLimits,
} from "@moe/runner";
import type { ClaudeLaunchLimits, ClaudeLaunchSelection } from "@moe/runner";

import {
  CHAIN_TOOLS,
  CODING_BUILTIN_TOOLS,
  CODING_TOOLS,
} from "../orchestrator/agent-spawn-environment.js";
import type { RenderedContext } from "@moe/context";

import { hasExactKeys } from "../provider-profile/provider-profile-fields.js";
import {
  admitCapabilities, admitRenderedContext, boundedText, isOwnRefusal, isRefusal, refuse,
} from "./launch-template-authority.js";

export {
  LAUNCH_TEMPLATE_PRODUCER_CODES,
} from "./launch-template-authority.js";
export type {
  LaunchTemplateProducerCode,
  LaunchTemplateProducerLayer,
  LaunchTemplateRefused,
  LaunchTemplateUpstream,
} from "./launch-template-authority.js";

export interface LaunchTemplateFields {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly launchSelection: ClaudeLaunchSelection;
  readonly limits: ClaudeLaunchLimits;
  readonly ok: true;
  /** CALLER-SUPPLIED and admitted, never composed here: this producer is the carrier. */
  readonly renderedContext: RenderedContext;
}

export type LaunchTemplateResult =
  | LaunchTemplateFields
  | ReturnType<typeof refuse>;

export interface LaunchTemplateInput {
  readonly capabilities: unknown;
  readonly mission: unknown;
  /**
   * The TYPED, NAMED context slot. `unknown` here is not laxity — `admitRenderedContext` is what
   * types it, exactly as `capabilities` and `runtimeObservation` are typed by their admissions.
   * Naming the key is how this contract widens; the exact-keys gate below is never loosened.
   */
  readonly renderedContext: unknown;
  readonly runtimeObservation: unknown;
}

const INPUT_KEYS: readonly string[] = Object.freeze([
  "capabilities", "mission", "renderedContext", "runtimeObservation",
]);
const MISSION_KEYS: readonly string[] = Object.freeze([
  "instructions", "test", "title", "workspace",
]);
/** The observed-runtime FACTS record: binary evidence only, never model identity. */
const RUNTIME_FACTS_KEYS: readonly string[] = Object.freeze([
  "adapterCapabilitySchemaDigest", "platformIdentity", "reportedVersion",
]);
const RESUME_FLAGS: ReadonlySet<string> = new Set(CLAUDE_LAUNCH_RESUME_FLAGS);

/** Positional, never built by iterating a record: key iteration order is a latent instability. */
function composeArgv(selection: ClaudeLaunchSelection, coding: boolean): readonly string[] {
  const argv = ["-p", "--allowedTools", coding ? CODING_TOOLS : CHAIN_TOOLS];
  if (coding) argv.push("--tools", CODING_BUILTIN_TOOLS);
  argv.push(CLAUDE_LAUNCH_SELECTION_FLAGS.model, selection.selectedModelId);
  argv.push(CLAUDE_LAUNCH_SELECTION_FLAGS.effort, selection.reasoningEffort);
  return Object.freeze(argv);
}

function admitMission(value: unknown): Record<string, unknown> | LaunchTemplateResult {
  if (!hasExactKeys(value, MISSION_KEYS)) {
    return refuse("LAUNCH_TEMPLATE_MISSION_INVALID", "mission is not the exact node brief");
  }
  for (const key of MISSION_KEYS) {
    if (typeof value[key] !== "string") {
      return refuse("LAUNCH_TEMPLATE_MISSION_INVALID", `mission.${key} is not text`);
    }
  }
  return value;
}

function compose(input: LaunchTemplateInput): LaunchTemplateResult {
  if (!hasExactKeys(input, INPUT_KEYS)) {
    // The smuggled key is NAMED. A caller that reached for `argv`, `launchSelection` or
    // `limits` learns which field it may not propose, rather than that something was wrong.
    const offered = typeof input === "object" && input !== null ? Object.keys(input) : [];
    const unexpected = offered.filter((key) => !INPUT_KEYS.includes(key));
    return refuse("LAUNCH_TEMPLATE_INPUT_INEXACT", unexpected.length > 0
      ? `producer input may not carry ${unexpected.join(", ")}`
      : `producer input is exactly ${INPUT_KEYS.join(", ")}`);
  }
  const admitted = admitCapabilities(input.capabilities);
  if (isRefusal(admitted)) return admitted;
  const { capabilitySchemaDigest, limits, selection } = admitted;
  const admittedMission = admitMission(input.mission);
  if (isOwnRefusal(admittedMission)) return admittedMission as LaunchTemplateResult;
  // `isOwnRefusal` is a predicate over the refusal, so the negative branch is still a union;
  // `admitMission` has already proven the exact four text keys by the time we reach here.
  const mission = admittedMission as Record<string, unknown>;
  // The ONLY route context takes into a launch. `mission.instructions` is admitted as text and
  // stays text: nothing below reads it as context, so a caller that serialises a render into it
  // has written a long instruction, not supplied a context.
  const renderedContext = admitRenderedContext(input.renderedContext);
  if (isOwnRefusal(renderedContext)) return renderedContext;
  if (!hasExactKeys(input.runtimeObservation, RUNTIME_FACTS_KEYS)) {
    return refuse("LAUNCH_TEMPLATE_RUNTIME_UNOBSERVED", "the runtime was not observed");
  }
  // Runtime evidence, and ONLY runtime evidence: the installed binary must answer to the same
  // capability schema the durable profile was admitted under. Nothing about the model, the
  // effort or the profile revision is read from this record.
  if (input.runtimeObservation["adapterCapabilitySchemaDigest"] !== capabilitySchemaDigest) {
    return refuse("LAUNCH_TEMPLATE_RUNTIME_UNBOUND",
      "the observed runtime answers to another capability schema");
  }
  const admittedLimits = validateClaudeLaunchLimits(limits);
  if (!admittedLimits.ok) {
    return refuse("LAUNCH_TEMPLATE_LIMITS_INADMISSIBLE", `limit ${admittedLimits.issue.field}`,
      Object.freeze({ code: admittedLimits.issue.code, layer: admittedLimits.issue.layer }));
  }
  const argv = composeArgv(selection, (mission["workspace"] as string).length > 0);
  for (const argument of argv) {
    if (RESUME_FLAGS.has(argument)) {
      return refuse("LAUNCH_TEMPLATE_ARGV_RESUMES", "argv would attach to a prior session");
    }
    // Whitespace is refused rather than quoted: the win32 wrapper spawns through a shell that
    // concatenates argv elements unescaped, so a model id carrying a space would be shredded
    // into two arguments and the thing that launched would not be the thing this record names.
    if (boundedText(argument) === null || /\s/u.test(argument)) {
      return refuse("LAUNCH_TEMPLATE_ARGV_UNSAFE", "argv carries an unusable argument");
    }
  }
  // The environment half of the same fact. The provider lets the environment override the flag,
  // so a producer whose argv and environment disagreed would certify a model that never ran.
  const environment = Object.freeze({
    [CLAUDE_LAUNCH_SELECTION_ENV.model]: selection.selectedModelId,
    [CLAUDE_LAUNCH_SELECTION_ENV.effort]: selection.reasoningEffort,
  });
  // `renderedContext` is carried VERBATIM, not rebuilt: the renderer sealed the bytes to the
  // binding, and a copy assembled here would be a second derivation of the same fact.
  return Object.freeze({ argv, environment, launchSelection: selection,
    limits: admittedLimits.limits, ok: true as const, renderedContext });
}

export function produceLaunchTemplateFields(input: LaunchTemplateInput): LaunchTemplateResult {
  try {
    return compose(input);
  } catch {
    // A revoked proxy makes even `Object.keys` throw, and a getter can throw on any read. The
    // message is deliberately not the caught error's: it would echo the caller's own text back
    // out of a failure path.
    return refuse("LAUNCH_TEMPLATE_INPUT_HOSTILE", "producer input would not answer a plain read");
  }
}
