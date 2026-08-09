import { isAbsolute } from "node:path";

import { canonicalDigest } from "../canonical.js";
import { consumeActivationGrant, validateActivationCommit } from "../supervisor/effect-grant.js";
import { inputManifestDigestInput } from "../workspace/workspace-contract.js";
import { recipeSealMatches } from "./verification-recipe.js";
import {
  processRefusal,
  supervisorRefusal,
  type RunVerifierProcessInput,
  type RunVerifierProcessRefused,
} from "./verifier-process-contract.js";

const GATE = "LAUNCH_GATE" as const;

/** A shim needs a shell to start, and this boundary is never allowed to take one. */
const UNSUPPORTED_EXTENSIONS = Object.freeze([".cmd", ".bat", ".ps1"] as const);

function manifestRefusal(input: RunVerifierProcessInput): RunVerifierProcessRefused | null {
  const manifest = input.inputManifest;
  let sealed = false;
  try {
    sealed = canonicalDigest(inputManifestDigestInput(manifest)) === manifest.sha256;
  } catch {
    sealed = false;
  }
  if (!sealed) {
    return processRefusal(
      "VERIFIER_PROCESS_INPUT_MANIFEST_STALE",
      GATE,
      "input manifest digest does not recompute",
    );
  }
  if (manifest.baseIdentity !== input.candidateBaseIdentity) {
    return processRefusal(
      "VERIFIER_PROCESS_INPUT_MANIFEST_STALE",
      GATE,
      "input manifest is sealed against a different candidate base",
    );
  }
  return null;
}

/**
 * The one-use activation check, delegated whole. Both refusals are the
 * supervisor's own and are returned verbatim: re-coding them here would hide
 * which authority actually refused, and a caller cannot act on a code that no
 * longer names its owner.
 */
function activationRefusal(input: RunVerifierProcessInput): RunVerifierProcessRefused | null {
  const { intent, attempt, grant } = input.activation;
  const coherence = validateActivationCommit(intent, attempt, grant);
  if (coherence.kind === "REFUSED") {
    return supervisorRefusal(coherence.failure);
  }
  const consumed = consumeActivationGrant(grant, input.wrapperIdentity);
  return consumed.kind === "REFUSED" ? supervisorRefusal(consumed.failure) : null;
}

function executableRefusal(argv: readonly string[]): RunVerifierProcessRefused | null {
  const file = argv[0];
  if (file === undefined || file.length === 0) {
    return processRefusal(
      "VERIFIER_PROCESS_EXECUTABLE_UNSUPPORTED",
      GATE,
      "the recipe names no executable",
    );
  }
  const lowered = file.toLowerCase();
  if (UNSUPPORTED_EXTENSIONS.some((extension) => lowered.endsWith(extension))) {
    return processRefusal(
      "VERIFIER_PROCESS_EXECUTABLE_UNSUPPORTED",
      GATE,
      "a script shim cannot be launched without a shell, which this boundary forbids",
    );
  }
  return null;
}

/**
 * Everything that must be decided while no child exists. The order is
 * load-bearing: cancellation and integrity come before the grant is spent, so a
 * refused launch never burns a one-use activation.
 */
export function launchGateRefusal(input: RunVerifierProcessInput): RunVerifierProcessRefused | null {
  if (input.signal?.aborted === true) {
    return processRefusal(
      "VERIFIER_PROCESS_CANCELLED",
      GATE,
      "the run was cancelled before anything was launched",
    );
  }
  if (!recipeSealMatches(input.recipe)) {
    return processRefusal(
      "VERIFIER_PROCESS_RECIPE_SEAL_INVALID",
      GATE,
      "the recipe digest does not re-derive from its own fields",
    );
  }
  const manifest = manifestRefusal(input);
  if (manifest !== null) {
    return manifest;
  }
  if (input.candidateRoot.length === 0 || !isAbsolute(input.candidateRoot)) {
    return processRefusal(
      "VERIFIER_PROCESS_WORKSPACE_INVALID",
      GATE,
      "the candidate workspace root must be a non-empty absolute path",
    );
  }
  const executable = executableRefusal(input.recipe.argv);
  if (executable !== null) {
    return executable;
  }
  // Conservatively EARLIER than the authoritative EXECUTION-layer check: an
  // observation that can discharge nothing is not worth an external effect.
  // The evidence layer still runs afterwards, and the two are told apart by
  // which layer names the refusal.
  if (input.runtimeObservation.truthClass !== "PROVEN") {
    return processRefusal(
      "VERIFIER_PROCESS_RUNTIME_UNPROVEN",
      GATE,
      `runtime observation truth class is ${input.runtimeObservation.truthClass}`,
    );
  }
  return activationRefusal(input);
}
