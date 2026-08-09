import { grantRefusal } from "../supervisor/effect-grant.js";
import {
  processRefusal,
  supervisorRefusal,
  type RunVerifierProcessInput,
  type RunVerifierProcessResult,
} from "./verifier-process-contract.js";
import { launchGateRefusal } from "./verifier-process-gate.js";
import { executeVerifierRun } from "./verifier-process-run.js";

export { createNodeProcessLauncher } from "./verifier-process-launcher.js";
export type {
  LaunchedProcess,
  ProcessLauncher,
  VerifierExitObservation,
  VerifierLaunchSpec,
} from "./verifier-process-launcher.js";
export type {
  RunVerifierProcessInput,
  RunVerifierProcessOk,
  RunVerifierProcessRefused,
  RunVerifierProcessResult,
  VerifierActivation,
} from "./verifier-process-contract.js";

/**
 * The memory a pure activation grant cannot have.
 *
 * `consumeActivationGrant` handed the same stale UNUSED record twice consumes it
 * twice, because a pure function has no memory of the first call. This map is
 * that memory: `run` is nulled once the run settles, so a replay is refused
 * rather than adopted, and no captured bytes are retained — an entry that kept
 * them would grow into an unbounded cache of every verifier's output.
 *
 * Its honest limit: this map lives as long as the process does, so it is the
 * one-use memory for THIS wrapper, never across a restart. Durable one-use
 * memory is the daemon's compare-and-set on the stored grant; this map is what
 * closes the in-process window that a pure function cannot see at all.
 */
interface RegistryEntry {
  readonly recipeSha256: string;
  run: Promise<RunVerifierProcessResult> | null;
}

const RUN_REGISTRY = new Map<string, RegistryEntry>();

function registryRefusalOrAdoption(
  entry: RegistryEntry,
  recipeSha256: string,
): Promise<RunVerifierProcessResult> | RunVerifierProcessResult {
  if (entry.recipeSha256 !== recipeSha256) {
    // The grant id derives from the intent and attempt and never covers the
    // recipe, so one grant presented with two recipes is a real collision.
    return processRefusal(
      "VERIFIER_PROCESS_GRANT_RUN_DIVERGENT",
      "REGISTRY",
      "this grant is already bound to a run of a different recipe",
    );
  }
  return (
    entry.run ??
    supervisorRefusal(
      grantRefusal("GRANT_ALREADY_CONSUMED", "GRANT", "this grant has already launched a verifier")
        .failure,
    )
  );
}

/**
 * Launches an exact verification recipe as a real child process.
 *
 * Reads top to bottom as GATE, then REGISTRY, then SPAWN. Nothing below the gate
 * runs without a coherent, unspent activation, and nothing below the registry
 * runs twice under one grant. What comes back is at most an
 * `ObservedVerifierExecution` the production evidence layer already accepted:
 * this module never builds a receipt, because every other field a receipt binds
 * — result manifest, graph, lease, effect identity, obligations — is the
 * daemon's fact rather than the process wrapper's.
 */
export async function runVerifierProcess(
  input: RunVerifierProcessInput,
): Promise<RunVerifierProcessResult> {
  const refusal = launchGateRefusal(input);
  if (refusal !== null) {
    return refusal;
  }
  const registered = RUN_REGISTRY.get(input.activation.grant.grantId);
  if (registered !== undefined) {
    return registryRefusalOrAdoption(registered, input.recipe.sha256);
  }
  // Registered before the first await, so a duplicate delivery in the same tick
  // adopts this run rather than minting a second child.
  const entry: RegistryEntry = { recipeSha256: input.recipe.sha256, run: null };
  RUN_REGISTRY.set(input.activation.grant.grantId, entry);
  const run = executeVerifierRun(input);
  entry.run = run;
  const settle = (): void => {
    entry.run = null;
  };
  run.then(settle, settle);
  return run;
}
